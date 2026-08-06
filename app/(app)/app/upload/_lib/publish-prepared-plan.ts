// ②-4a Task 12: publish の純粋な決定ロジック(figure disposition → card images /
// 除外集計 / publish 条件 / card row 組立 / result_summary)。 spec:
// docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md §8(publish)/
// §13-14(除外理由・result_summary)。
//
// directive 無し共有 module(stage-prepared-payload.ts と同じ理由 — 'use server'
// file から参照されつつ、 crop / DB / R2 の重い依存や tx を一切持たない純関数に
// 閉じて単体 test しやすくする)。
//
// crop-and-store.ts(sharp/R2/drizzle を引き込む server-only module)を本 file に
// import しない: 呼出側(upload-pipeline.ts の crop phase)が各 figure の raw
// crop outcome を `FigureDisposition` へ翻訳して渡す。 これにより本 planner は
// crop の外部依存を一切持たず、 disposition だけを見る純粋な決定器になる
// (`CropAndStoreOutcome` は type-only import ではなく参照すらしない)。

import { cards, type CardImage, type CardOption } from '@/lib/db/schema'
import { imagesSchema } from '@/lib/validation/card'
import type { PreparedCard, PreparedPayloadV1 } from '@/lib/ocr/prepared-schema'

// ---------------------------------------------------------------------------
// figure disposition(crop phase の呼出元が raw crop outcome から翻訳して渡す)
//
// - attach: crop 成功('stored'/'reused')— 当該 figure は card image になる。
// - exclude: この figure は最終的に取り込めない(crop 失敗の terminal outcome)。
//   spec §13 の「crop 失敗」相当として計上し、 それでも text card は publish する(§8.3)。
// - retryable: 一時的失敗(R2 の技術的失敗等)。 1 件でもあれば publish せず
//   operation 全体を再試行に回す(§8.3)。
// - not_ours: crop 中に operation が 'prepared' でなくなった(takeover/完了)。
//   この worker は stale — publish を中止する。
//   **S-5(旧経路撤去)以降、`retryable` / `not_ours` を生成する呼出元は居ない**
//   (単一 invocation 経路は retry も takeover も持たない)。純関数側の分岐は
//   契約破れの検出用に残してあり、到達したら呼出元(upload-pipeline.ts)が
//   catch-all へ送る。
// - deadline_excluded: crop フェーズの time budget が尽きたため、この figure
//   (以降の残り figure すべて)は crop を試みずに除外した(spec §11 deadline・
//   §13 reason g)。 呼出元が crop を呼ぶ前に直接この disposition を割り当てる —
//   raw crop outcome からの翻訳ではない。
// - orientation_unsupported: source の EXIF orientation が 1 でも undefined でも
//   ない(spec §4.5 の「向き未対応」・§13 reason e)。 deadline_excluded と同じく
//   呼出元が crop を呼ぶ**前に**割り当てる。 **これはユーザーのための除外ではなく
//   前提破綻の検知**で、通常発火しない(client の canvas 再エンコードで EXIF は
//   剥がれる = spec §4.3)。 発火したらその前提が壊れている — 本命の signal は
//   pipeline の `logger.warn` で、この計上はその副次。
//   判定は decode 時に確定し attach 時に効くため、normalize 時の tally
//   (`figureExclusionTalliesSchema`)ではなく crop/publish 層のここに置く。
// ---------------------------------------------------------------------------
export type FigureDisposition =
  | 'attach'
  | 'exclude'
  | 'retryable'
  | 'not_ours'
  | 'deadline_excluded'
  | 'orientation_unsupported'

export type FigureExclusionCounts = {
  // crop の terminal 失敗 + source race(spec §13 の「crop 失敗」に集約)。
  crop_failed: number
  // images ≤ 10 超過で決定順の先頭 10 件のみ採用し、 溢れた分(§13 の
  // image_limit_exceeded)。
  image_limit_exceeded: number
  // crop フェーズの time budget 枯渇で crop を試みなかった figure(spec §13
  // reason g・§11 deadline)。
  deadline_excluded: number
  // source の EXIF orientation が 1 でも undefined でもないため crop を試みなかった
  // figure(spec §13 reason e「向き未対応」)。 通常 0 のまま — 0 でない値が出たら
  // spec §4.3 の前提が壊れている(FigureDisposition の説明を参照)。
  orientation_unsupported: number
}

// crop フェーズの残り予算が最低予算を下回ったか判定する純関数(spec §11
// deadline)。 呼出側(upload-pipeline.ts の crop loop)が各 figure の crop を
// 試みる直前に呼ぶ。 nowMs/deadlineAtMs は呼出側が注入する(この関数自体は
// Date.now() を読まない・iso/unit test で決定論的に検証できる)。
export function isCropBudgetExhausted(
  nowMs: number,
  deadlineAtMs: number,
  minRemainingMs: number,
): boolean {
  return deadlineAtMs - nowMs < minRemainingMs
}

export type PublishDecision =
  | { decision: 'stale' }
  | { decision: 'retryable' }
  | {
      decision: 'publish'
      // card ID → 採用した card image(crop 成功 figure・≤10 cap 後)。
      cardImagesByCardId: Record<string, CardImage[]>
      // publish tx の保護 UPDATE 対象(採用 image の asset key・昇順・重複排除)。
      expectedReadyAssetIds: string[]
      figuresAttached: number
      figureExclusions: FigureExclusionCounts
    }

// imagesSchema(card.ts)の `.max(N)` が per-card 画像上限の SSoT。 数値 N を本 file
// で再宣言せず imagesSchema 自体を「上限判定器」として compose する: 全件が通れば
// 截断なし、 通らなければ末尾から 1 件ずつ削り最長 prefix を採る。 figure 由来の
// image entry は個別には必ず imagesSchema を通る(assetId は preparedFigureSchema で
// UUIDv4 検証済 = imageEntrySchema の asset key 判定を満たし、 target は
// question_text / explanation_text / option:<uid> のいずれかで target 形式検証も
// 満たす・alt は string)ため、 唯一の不通過要因は件数超過であり、 末尾削りは
// image_limit_exceeded の判定に一致する。
function capImagesToSchemaLimit(images: CardImage[]): { kept: CardImage[]; excess: number } {
  if (imagesSchema.safeParse(images).success) return { kept: images, excess: 0 }
  let kept = images.slice()
  while (kept.length > 0 && !imagesSchema.safeParse(kept).success) {
    kept = kept.slice(0, -1)
  }
  return { kept, excess: images.length - kept.length }
}

/**
 * crop 済みの各 figure disposition から publish の決定を下す(spec §8.3)。
 *
 * 優先順位: not_ours(operation 横取り)→ stale / retryable が 1 件でも → retryable /
 * それ以外 → publish(attach=image、 exclude=crop 失敗計上、 ≤10 超過は
 * image_limit_exceeded 計上)。 deadline_excluded / orientation_unsupported は
 * **この優先順位に影響しない**(publish を止めず、理由別に計上するだけ)。
 *
 * @param cards 保存済み payload の card 群(publisher は再正規化しない・spec §5.4)。
 * @param dispositionByAssetId figure.assetId → disposition。 呼出側が全 figure を
 *   crop した結果を翻訳して渡す(全 figure が map に存在する前提)。
 */
export function planPublish(
  preparedCards: readonly PreparedCard[],
  dispositionByAssetId: ReadonlyMap<string, FigureDisposition>,
): PublishDecision {
  // 優先順位判定(全 figure を 1 度走査)。 not_ours が最優先(operation がもう
  // 自分のものでない ⇒ 何も書かず stale)、 次に retryable。
  let hasRetryable = false
  for (const card of preparedCards) {
    for (const figure of card.figures) {
      // 呼出側が全 figure を crop する契約ゆえ通常 undefined にならない。
      // 防御的に undefined は retryable 扱い(crop 結果欠落のまま publish して
      // 画像を silent に落とさない)。
      const disp = dispositionByAssetId.get(figure.assetId) ?? 'retryable'
      if (disp === 'not_ours') return { decision: 'stale' }
      if (disp === 'retryable') hasRetryable = true
    }
  }
  if (hasRetryable) return { decision: 'retryable' }

  const cardImagesByCardId: Record<string, CardImage[]> = {}
  const expectedReadyAssetIds = new Set<string>()
  let figuresAttached = 0
  const figureExclusions: FigureExclusionCounts = {
    crop_failed: 0,
    image_limit_exceeded: 0,
    deadline_excluded: 0,
    orientation_unsupported: 0,
  }

  for (const card of preparedCards) {
    const candidates: CardImage[] = []
    for (const figure of card.figures) {
      const disp = dispositionByAssetId.get(figure.assetId) ?? 'retryable'
      if (disp === 'attach') {
        candidates.push({
          key: figure.assetId,
          target: figure.target,
          alt: figure.label ?? '',
        })
      } else if (disp === 'deadline_excluded') {
        // crop フェーズの time budget 枯渇(spec §11・§13 reason g)。
        figureExclusions.deadline_excluded += 1
      } else if (disp === 'orientation_unsupported') {
        // EXIF≠1(spec §4.5・§13 reason e)。 crop を試みていない以上 crop 失敗では
        // ないので混ぜない — 混ぜると前提破綻が平凡な crop 失敗に埋もれる。
        figureExclusions.orientation_unsupported += 1
      } else {
        // exclude(terminal crop 失敗 / source race)。 retryable / not_ours は
        // 上の優先順位で既に return 済みのため、 ここに来る非 attach/非
        // deadline_excluded/非 orientation_unsupported は exclude のみ。
        figureExclusions.crop_failed += 1
      }
    }
    const { kept, excess } = capImagesToSchemaLimit(candidates)
    figureExclusions.image_limit_exceeded += excess
    figuresAttached += kept.length
    cardImagesByCardId[card.cardId] = kept
    for (const img of kept) expectedReadyAssetIds.add(img.key)
  }

  return {
    decision: 'publish',
    cardImagesByCardId,
    expectedReadyAssetIds: Array.from(expectedReadyAssetIds).sort(),
    figuresAttached,
    figureExclusions,
  }
}

// PreparedOption(camelCase isCorrect)→ DB CardOption(snake_case is_correct)の
// 唯一の変換点(spec §8.2「型変換境界を 1 箇所に固定」)。 uid は prepared schema で
// UUIDv4 必須ゆえ常に存在する。
function toCardOption(o: PreparedCard['options'][number]): CardOption {
  const co: CardOption = { id: o.id, uid: o.uid, text: o.text, is_correct: o.isCorrect }
  if (o.explanation !== undefined) co.explanation = o.explanation
  return co
}

/**
 * 保存済み payload の card を cards テーブルの INSERT 行へ組み立てる(publisher は
 * 再正規化せず payload の値をそのまま使う・spec §5.4)。 images は planPublish が
 * 決めた採用 image(crop 成功・≤10 cap 後)。 option は camelCase→snake_case 変換。
 */
export function buildCardRows(
  preparedCards: readonly PreparedCard[],
  cardImagesByCardId: Record<string, CardImage[]>,
  ctx: { userId: string; examId: string; sourceDocumentId: string | null },
): Array<typeof cards.$inferInsert> {
  return preparedCards.map((card) => ({
    id: card.cardId,
    userId: ctx.userId,
    examId: ctx.examId,
    sourceDocumentId: ctx.sourceDocumentId,
    title: card.title,
    sortKey: card.sortKey,
    questionText: card.questionText,
    options: card.options.map(toCardOption),
    correctAnswerIds: card.correctAnswerIds,
    explanationText: card.explanationText,
    memo: card.memo,
    images: cardImagesByCardId[card.cardId] ?? [],
  }))
}

/**
 * result_summary(spec §14)を組み立てる。 raw OCR / card 本文全文 / 署名 URL は
 * 含めない(§14)。 除外理由別件数(§13)= normalize 時の figure 集計 + crop 時の
 * crop_failed / image_limit_exceeded を統合する。
 */
export function buildResultSummary(
  payload: PreparedPayloadV1,
  plan: Extract<PublishDecision, { decision: 'publish' }>,
  ctx: { operationId: string; examId: string; sourceDocumentId: string | null },
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    operationId: ctx.operationId,
    examId: ctx.examId,
    sourceDocumentId: ctx.sourceDocumentId,
    cardsExtracted: payload.cards.length,
    cardsTotal: payload.cardsTotal,
    cardsExcluded: payload.cardsExcluded,
    // 除外理由の内訳(A・2026-08-06)。 figure 側と同じく **DB には残すが画面には
    // 出さない**(表示は T16-a の 3 束のまま・本 sprint の scope 外)。
    // figuresExcluded と違いキーを個別に書き写さないのは、card 側は **単一 source**
    // (normalize 層のみ・crop/publish からの合流が無い)で、値は既に
    // `cardExclusionTalliesSchema` を通っており余計なキーを持ち得ないため。
    // そのまま透過すれば将来 4 つ目の区分が黙って落ちる drift も生まれない。
    cardsExcludedReasons: payload.cardsExcludedReasons,
    figuresAttached: plan.figuresAttached,
    figuresExcluded: {
      // normalize 時(T8a・spec §13 a/b)
      coordinate_null: payload.figuresExcluded.coordinate_null,
      source_id_invalid: payload.figuresExcluded.source_id_invalid,
      malformed: payload.figuresExcluded.malformed,
      asset_id_invalid: payload.figuresExcluded.asset_id_invalid,
      // crop フェーズ(spec §13 c/e/f/g)。 c(crop_failed)だけが raw crop outcome の
      // 翻訳で「成功以外は crop 失敗に集約」される。 e / g は crop outcome が生まれる
      // 前に(= crop を呼ばずに)割り当てられ、f は crop 後の ≤10 cap で決まる。
      crop_failed: plan.figureExclusions.crop_failed,
      image_limit_exceeded: plan.figureExclusions.image_limit_exceeded,
      deadline_excluded: plan.figureExclusions.deadline_excluded,
      orientation_unsupported: plan.figureExclusions.orientation_unsupported,
    },
    cardsPreview: payload.cards.map((c) => ({
      id: c.cardId,
      title: c.title,
      questionSnippet: c.questionText.slice(0, 80),
      optionCount: c.options.length,
    })),
  }
}
