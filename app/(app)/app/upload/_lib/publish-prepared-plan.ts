// ②-4a Task 12: publish の純粋な決定ロジック(figure disposition → card images /
// 除外集計 / publish 条件 / card row 組立 / result_summary)。 spec:
// docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md §8(publish)/
// §13-14(除外理由・result_summary)。
//
// directive 無し共有 module(stage-prepared-payload.ts と同じ理由 — 'use server'
// file である publish-prepared.ts から参照されつつ、 crop / DB / R2 の重い依存や
// tx を一切持たない純関数に閉じて単体 test しやすくする)。
//
// crop-and-store.ts(sharp/R2/drizzle を引き込む server-only module)を本 file に
// import しない: 呼出側(publish-prepared.ts の orchestrator)が各 figure の raw
// crop outcome を `FigureDisposition` へ翻訳して渡す。 これにより本 planner は
// crop の外部依存を一切持たず、 disposition だけを見る純粋な決定器になる
// (`CropAndStoreOutcome` は type-only import ではなく参照すらしない)。

import { cards, type CardImage, type CardOption } from '@/lib/db/schema'
import { imagesSchema } from '@/lib/validation/card'
import type { PreparedCard, PreparedPayloadV1 } from '@/lib/ocr/prepared-schema'

// ---------------------------------------------------------------------------
// figure disposition(orchestrator が raw crop outcome から翻訳して渡す)
//
// - attach: crop 成功('stored'/'reused')— 当該 figure は card image になる。
// - exclude: この figure は最終的に取り込めない(crop 失敗の terminal outcome、
//   または source が race で消えた 'source_not_ready')。 spec §13 の「crop 失敗」
//   相当として計上し、 それでも text card は publish する(§8.3)。
// - retryable: 一時的失敗(R2 の技術的失敗等)。 1 件でもあれば publish せず
//   operation 全体を再試行に回す(§8.3)。
// - not_ours: crop 中に operation が 'prepared' でなくなった(takeover/完了)。
//   この worker は stale — publish を中止する。
// ---------------------------------------------------------------------------
export type FigureDisposition = 'attach' | 'exclude' | 'retryable' | 'not_ours'

export type FigureExclusionCounts = {
  // crop の terminal 失敗 + source race(spec §13 の「crop 失敗」に集約)。
  crop_failed: number
  // images ≤ 10 超過で決定順の先頭 10 件のみ採用し、 溢れた分(§13 の
  // image_limit_exceeded)。
  image_limit_exceeded: number
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
 * image_limit_exceeded 計上)。
 *
 * @param cards 保存済み payload の card 群(publisher は再正規化しない・spec §5.4)。
 * @param dispositionByAssetId figure.assetId → disposition。 orchestrator が
 *   全 figure を crop した結果を翻訳して渡す(全 figure が map に存在する前提)。
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
      // orchestrator が全 figure を crop する契約ゆえ通常 undefined にならない。
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
  const figureExclusions: FigureExclusionCounts = { crop_failed: 0, image_limit_exceeded: 0 }

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
      } else {
        // exclude(terminal crop 失敗 / source race)。 retryable / not_ours は
        // 上の優先順位で既に return 済みのため、 ここに来る非 attach は exclude のみ。
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
    figuresAttached: plan.figuresAttached,
    figuresExcluded: {
      // normalize 時(T8a・spec §13 a/b)
      coordinate_null: payload.figuresExcluded.coordinate_null,
      source_id_invalid: payload.figuresExcluded.source_id_invalid,
      malformed: payload.figuresExcluded.malformed,
      asset_id_invalid: payload.figuresExcluded.asset_id_invalid,
      // crop 時(spec §13 c/f)。 source race(source_not_ready)は crop 失敗に集約。
      crop_failed: plan.figureExclusions.crop_failed,
      image_limit_exceeded: plan.figureExclusions.image_limit_exceeded,
    },
    cardsPreview: payload.cards.map((c) => ({
      id: c.cardId,
      title: c.title,
      questionSnippet: c.questionText.slice(0, 80),
      optionCount: c.options.length,
    })),
  }
}
