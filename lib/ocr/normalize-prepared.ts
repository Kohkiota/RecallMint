// normalize-prepared — ②-4a 探索 OCR response (T7 統合 schema 出力) を、
// 要素隔離 + 正規化 + UUIDv4 stage 発行を経た PreparedCard[] へ変換する OCR
// 境界+正規化 layer。 spec: docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md
// §5.3(要素隔離)/ §5.4(prepared schema = executable contract SSoT・本 file の
// 中心設計)/ §13(target vocab + 除外理由)/ §D・§15(UUIDv4 stage 発行)。
// Task 8 は 8a(本 file)/ 8b(stage save action・Gemini 呼出 + R2 + DB atomic
// 保存)に分割(brief 参照)。 8b は本 file を消費するのみ。
//
// 配置(`lib/ocr/` = 非 domain): 本 module は未検証の生 Gemini JSON を受け取り
// 検証する OCR 境界層である。 既存 domain purity 規約(F3 spec §3.2/§3.4・
// lib/cards|reviews|stripe|tags|media の domain module に eslint 適用済)は
// 「domain/ は zod-free、 zod による境界検証は domain/ の外側に置く」— 前例:
// `lib/validation/card.ts`(zod 純粋 validation module)/
// `lib/cards/card-field-handlers.ts`(zod で受けてから domain 関数へ渡す
// orchestration)/ `lib/ai/ocr.ts`(本番 OCR pipeline 自身が `cardSchema` /
// `optionSchema` / `responseSchema` で境界検証する precedent)。 本 file は
// その「zod を使う側」の役割を担うため、 domain/ の外(`lib/ocr/`)に置く。
//
// PURE 制約 (I/O 純度・domain/ 外でも維持): DB / R2 / Gemini 呼出なし。
// `crypto.randomUUID()` を直接呼ばない・`Date.now()` を呼ばない — 非決定要素は
// 全て呼び出し側が注入する `IdFactory` 引数 1 点に集約する(同一入力 + 同一
// factory 呼出列 → 同一出力、 spec §D の retry 再利用契約を成立させる基盤)。
//
// **設計収束(spec §5.4・2026-07-31 改訂)**: card の正規化後検証は、
// title/question/explanation/options 個数/option 境界/uid 等を本 file が
// field ごとに手書き再実装する(= whack-a-mole・複数回の見落としを誘発した)
// のをやめ、 `./prepared-schema.ts` の `preparedCardSchema` **1 個への
// safeParse** に一本化した。 本 file が担うのはそれでも表現できない 2 点のみ:
// ① response 全体で JSON が壊れている場合の要素単位隔離(card/figure ごとの
// loose 構造 safeParse・spec §5.3)② response 全体を跨ぐ一意性(cardId/assetId
// は 1 card だけを見る schema では判定不能・cross-card accumulator が必要)。

import { z } from 'zod'
import { isAssetKey } from '@/lib/validation/card'
import {
  preparedCardSchema,
  type PreparedCard,
  type PreparedOption,
  type PreparedFigure,
  type FigureExclusionTallies,
  type CardExclusionTallies,
  type CardExclusionReason,
} from './prepared-schema'

// ---------------------------------------------------------------------------
// id-factory injection (spec §D)
// ---------------------------------------------------------------------------

/**
 * card ID / option uid / asset ID の発行元。 prod は `crypto.randomUUID`、 test は
 * 決定的 counter を渡す(旧 retry 経路の「保存済み payload の同 ID 再利用」は
 * 1 invocation 化で消滅)。 呼出順は本 module 内で card →
 * options(配列順)→ figures(配列順、隔離後の生存要素のみ)に固定する — 同一入力 +
 * 同一 factory 呼出列で同一出力を保証するのに必要な決定性の根拠。
 */
export type IdFactory = () => string

// ---------------------------------------------------------------------------
// 入力境界 schema(loose・型形状のみ。 長さ/個数/一意性/option 境界等の業務規則
// は一切ここに持たせない — `preparedCardSchema`(§5.4)への safeParse に一本化
// したため、 本 layer の責務は「型として最低限パース可能か」だけに縮小した。
// spec §5.3「入力境界用と正規化後用で schema を分ける」を体現)
// ---------------------------------------------------------------------------

// 生 option(Gemini 出力そのまま・snake_case is_correct・T7/本番 optionSchema
// (lib/ai/ocr.ts) と同形。 uid はまだ無い(stage 前))。
const rawOptionSchema = z.object({
  id: z.string(),
  text: z.string(),
  is_correct: z.boolean(),
  explanation: z.string().optional(),
})

// 生 card。 `images`/`custom_props` は本番 JSON Schema で required/optional。
// `images`(markdown 画像記法系・②-3)は ②-4a の figure_regions 経路では未使用
// (値を検証も転記もしない・別契約)。 `custom_props` は形状だけ緩く確認して
// タグとして保持する(下記 looseCustomPropsSchema・spec §5.4②)。
// `correct_answer_ids` は受理するが値は信用しない(options の isCorrect から
// 再導出する)。 `figure_regions` は本 schema に含めない — 要素ごとに独立して
// safeParse する対象のため、 raw card object から直接読み出す(下記
// resolveFigures 参照)。
const rawCardSchema = z.object({
  title: z.string(),
  sort_key: z.string().optional(),
  question_text: z.string(),
  options: z.array(rawOptionSchema),
  correct_answer_ids: z.unknown().optional(),
  explanation_text: z.string().optional(),
  images: z.unknown().optional(),
  custom_props: z.unknown().optional(),
})

// 生 figure_regions 要素(T7 `FigureRegion` 型と同形・box_2d nullable 必須)。
const rawFigureSchema = z.object({
  source_id: z.string(),
  box_2d: z.union([
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
    z.null(),
  ]),
  target: z.string(),
  label: z.string().optional(),
  page: z.number().optional(),
})

// custom_props の緩い形状確認 + 正規化(spec §5.4②: raw に無ければ / 形状が
// 崩れていれば `{}` に正規化する。 `applyOcrTags` が既に名称・値を防御選別する
// ため、 本 layer の責務は形状確認 + 保持のみに留める — タグ 1 件の不正で
// card 全体を drop しない、 figure 同様の「壊れた部分だけ無害化」の考え方)。
const looseCustomPropsSchema = z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .catch({})

// ---------------------------------------------------------------------------
// 図版除外理由の集計 helper(型は prepared-schema.ts の SSoT を再利用)
// ---------------------------------------------------------------------------

function zeroFigureExclusions(): FigureExclusionTallies {
  return { coordinate_null: 0, source_id_invalid: 0, malformed: 0, asset_id_invalid: 0 }
}

function addFigureExclusions(
  a: FigureExclusionTallies,
  b: FigureExclusionTallies,
): FigureExclusionTallies {
  return {
    coordinate_null: a.coordinate_null + b.coordinate_null,
    source_id_invalid: a.source_id_invalid + b.source_id_invalid,
    malformed: a.malformed + b.malformed,
    asset_id_invalid: a.asset_id_invalid + b.asset_id_invalid,
  }
}

function zeroCardExclusions(): CardExclusionTallies {
  return { malformed: 0, invariant_failed: 0, card_id_invalid: 0 }
}

// ---------------------------------------------------------------------------
// target 解決(spec §13・2 段変換)
// ---------------------------------------------------------------------------

/**
 * figure の生 target 文字列を、 card 用の解決済み target(question_text /
 * explanation_text / option:<uid>)へ写像する。
 *
 * - 'question' → 'question_text' / 'explanation' → 'explanation_text'
 * - 'option_{id}' → 2 段変換: id 抽出 → 同 card の options[].id と一致する要素を
 *   検索 → 見つかれば `option:${matchedOption.uid}`
 * - 上記のどれにも解決できない(未知 vocab・`option_{id}` で id 不一致含む)場合は
 *   すべて 'question_text' にフォールバックする(OT 決定・spec §13「ambiguous/
 *   未マッピング → question_text」。 target 起因で図版を silent に drop しない)。
 */
function resolveTarget(
  rawTarget: string,
  options: Pick<PreparedOption, 'id' | 'uid'>[],
): string {
  if (rawTarget === 'question') return 'question_text'
  if (rawTarget === 'explanation') return 'explanation_text'
  const match = /^option_(.+)$/.exec(rawTarget)
  if (match) {
    const matched = options.find((o) => o.id === match[1])
    if (matched) return `option:${matched.uid}`
  }
  return 'question_text'
}

// ---------------------------------------------------------------------------
// figure_regions の要素隔離処理(spec §5.3)。 figure レベルの除外(malformed /
// source_id_invalid / coordinate_null / asset_id_invalid)は card レベルの
// `preparedCardSchema` 一本化の対象外のまま維持する — 1 figure の不備で card
// 全体を drop すると隔離の意味が無くなるため(1 要素破損 → その要素だけ除外、
// という §5.3 の原則そのもの)。
// ---------------------------------------------------------------------------

function resolveFigures(
  rawFigureRegions: unknown,
  validSourceIds: ReadonlySet<string>,
  options: PreparedOption[],
  nextId: IdFactory,
  // assetId は最終的に assets table の PK になる想定(spec §7.2) — 一意性は
  // card 内ではなく response 全体で見る必要がある。 **読み取り専用**: この card
  // の figure が既出 assetId と衝突していないかの確認にのみ使う。 ここでは
  // mutate しない(reserve-after-validate・下記 localAssetIds 参照)。
  seenAssetIds: ReadonlySet<string>,
): { figures: PreparedFigure[]; excluded: FigureExclusionTallies; localAssetIds: Set<string> } {
  const excluded = zeroFigureExclusions()
  // この card 内で生存確定した figure の assetId(グローバルへはまだ merge
  // しない)。 呼び出し元(normalizePreparedCard)が card 全体の
  // `preparedCardSchema` 検証を通過した後にのみ `seenAssetIds` へ merge する
  // (reserve-after-validate。 OT 再レビュー Important 修正: card 単位の
  // schema 検証前に assetId をグローバルへ足すと、 その card が後で drop
  // されても assetId が「予約済み」のまま残り、 後続の別 card が同じ assetId
  // を正当に再利用しようとしても誤って重複扱いされるリークになる)。
  const localAssetIds = new Set<string>()
  if (!Array.isArray(rawFigureRegions)) {
    // figure_regions が配列でない(欠落・型不正) = 図版なしとして扱う。
    // optional field なので「card 破損」には数えない(spec §5.1 の isolation)。
    return { figures: [], excluded, localAssetIds }
  }

  const figures: PreparedFigure[] = []
  for (const rawFigure of rawFigureRegions) {
    const parsed = rawFigureSchema.safeParse(rawFigure)
    if (!parsed.success) {
      excluded.malformed += 1
      continue
    }
    const { source_id: sourceId, box_2d, target, label } = parsed.data

    // 判定順(2 つとも不成立な figure は 1 件のみカウント・source_id を優先):
    // クロップ元 source が特定できなければ座標があっても無意味なため、
    // source_id 解決を先に評価する。
    if (!validSourceIds.has(sourceId)) {
      excluded.source_id_invalid += 1
      continue
    }
    if (box_2d === null) {
      excluded.coordinate_null += 1
      continue
    }

    // assetId 発行 + 防御的検証(壊れた/衝突する factory 出力を信用しない)。
    // この check は `preparedFigureSchema` 単体では表現できない cross-figure
    // (他 card の figure・同一 card 内の他 figure の両方を含む)一意性のため、
    // 引き続き normalize 側で明示的に行う(figure 1 件だけを除外し、 他の
    // figure・card 全体を道連れにしない)。 グローバル(seenAssetIds・他 card)
    // とローカル(localAssetIds・同一 card 内の既に生存確定した figure)の
    // 両方と照合する — ローカル check が無いと同一 card 内の 2 figure が同じ
    // assetId を得た場合を見逃す。
    const assetId = nextId()
    if (
      !isAssetKey(assetId) ||
      seenAssetIds.has(assetId) ||
      localAssetIds.has(assetId)
    ) {
      excluded.asset_id_invalid += 1
      continue
    }
    localAssetIds.add(assetId)

    figures.push({
      assetId,
      sourceId,
      box_2d,
      target: resolveTarget(target, options),
      // 正規形(spec §5.4①): キー必須・値は null(undefined にしない)。
      label: label ?? null,
    })
  }

  return { figures, excluded, localAssetIds }
}

// ---------------------------------------------------------------------------
// normalizePreparedCard — 1 card 単位の正規化 + 検証。
// publish 層は本関数を呼ばない(spec §5.4: publisher は組み立て時に 1 回
// `preparedPayloadSchema.parse()` 済みの in-memory payload を消費するのみ・
// ID 再発行/再正規化しない)。
// ---------------------------------------------------------------------------

/**
 * 3 分岐が同一の戻り値を返していたため呼び出し元から理由を判別できず、除外理由が
 * どの層にも残らなかったのを埋める(figure 側との非対称の解消)。
 *
 * **discriminated union にしている理由**: 「除外なら必ず区分がある / 生存なら区分は
 * 存在しない」を **型で強制**するため。単一 object + `reason: R | null` だと
 * ①将来 4 つ目の除外経路が区分を付け忘れても型が通る ②生存 card に区分を載せても
 * 型が通る、の 2 つが doc コメントでしか守られない。union なら両方が compile error
 * になり、呼び出し側の `if (result.excludedReason !== null)` 握りも不要になる。
 */
export type NormalizePreparedCardResult =
  | {
      /** 検証を通過した正規化済み card。 */
      card: PreparedCard
      figuresExcluded: FigureExclusionTallies
    }
  | {
      /** hard invariant 不成立 or 構造破損で除外された。 */
      card: null
      /** どの分岐で落ちたかを 1 区分で表す(除外時は必ず存在する)。 */
      excludedReason: CardExclusionReason
      figuresExcluded: FigureExclusionTallies
    }

export function normalizePreparedCard(
  rawCard: unknown,
  validSourceIds: ReadonlySet<string>,
  nextId: IdFactory,
  // cardId/assetId の一意性は単一 card では判定できない(response 全体の
  // 他 card と衝突しうる — spec の cardId/assetId は response 内グローバル
  // identity。 `preparedCardSchema` は 1 card しか見えないため表現不能 = 本
  // 関数が normalize-level accumulator として引き続き担う・spec §5.4 の
  // 「統一しないもの」の一部)。 normalizePrepared が全 card 間で共有する Set を
  // 渡して蓄積する。 単体呼出時はデフォルトの空 Set で「この呼出だけで閉じた」
  // 一意性判定になる。
  seenCardIds: Set<string> = new Set(),
  seenAssetIds: Set<string> = new Set(),
): NormalizePreparedCardResult {
  // 1. 構造境界(loose): 型形状が壊れている card は丸ごと除外(spec §5.3
  //    「card 本体破損 → card 除外」)。 figure_regions はここでは見ない
  //    (対象外・下で raw object から直接読む)。 factory を 1 度も呼ばずに
  //    判定する(dropped card は id を消費しない)。
  const parsed = rawCardSchema.safeParse(rawCard)
  if (!parsed.success) {
    return {
      card: null,
      excludedReason: 'malformed',
      figuresExcluded: zeroFigureExclusions(),
    }
  }
  const data = parsed.data

  // 2. UUIDv4 stage 発行(spec §D): cardId → options[].uid(配列順)。
  //    options は preparedOptionSchema(= publisher の optionSchema・camelCase
  //    isCorrect)の形へ直接組み立てる — これが「型変換境界を 1 箇所に固定」の
  //    当該箇所(spec §8.2): 生 Gemini 出力の snake_case is_correct を、
  //    persist する prepared 表現(camelCase・publisher の manual 編集形状と
  //    同型)へここで 1 回だけ変換する。 個数/一意性/文字数上限等の検証は
  //    一切ここでしない(§3 の schema 一本化 safeParse に委ねる)。
  const cardId = nextId()
  const options: PreparedOption[] = data.options.map((o) => ({
    id: o.id,
    uid: nextId(),
    text: o.text,
    isCorrect: o.is_correct,
    explanation: o.explanation,
  }))

  // 3. correct_answer_ids は入力を信用せず isCorrect から再導出する。
  //    `lib/cards/domain/card-rules.ts` の `deriveCorrectAnswerIds` と同じ
  //    規則(is_correct な option の id を順序保存)だが、 options がここでは
  //    camelCase(persist 表現)のため同関数(snake_case CardOption 専用)は
  //    再利用できない — シェイプが違うだけの同一規則をこの 1 行に閉じる。
  const correctAnswerIds = options.filter((o) => o.isCorrect).map((o) => o.id)

  // 4. figure_regions の隔離 + target 解決(spec §5.3・§13)。 raw card object
  //    から直接読む(rawCardSchema は figure_regions を検証しない・意図的)。
  //    `seenAssetIds` は読み取り専用で渡す(resolveFigures は mutate しない)。
  //    生存確定した figure の assetId は `localAssetIds` に集め、 この card が
  //    `preparedCardSchema` を通過した後にのみグローバルへ merge する(下記)。
  const rawFigureRegions = (rawCard as Record<string, unknown>).figure_regions
  const {
    figures,
    excluded: figuresExcluded,
    localAssetIds,
  } = resolveFigures(rawFigureRegions, validSourceIds, options, nextId, seenAssetIds)

  // 5. custom_props(タグ)の保持(spec §5.4②: 必須 + 空オブジェクト正規形)。
  const rawCustomProps = (rawCard as Record<string, unknown>).custom_props
  const customProps = looseCustomPropsSchema.parse(rawCustomProps)

  // 6. 候補を組み立て、 `preparedCardSchema` 1 個への safeParse で検証する
  //    (spec §5.4「実装条件」: parsed 結果でなく candidate を後続で使わない
  //    ため `result.data` を返す・candidate 自体は返さない)。
  //    正規形(spec §5.4①): sortKey/explanationText はキー必須・値 null
  //    (undefined にしない)。 memo は OCR 抽出に無い概念のため常に null。
  const candidate: z.output<typeof preparedCardSchema> = {
    cardId,
    title: data.title,
    sortKey: data.sort_key ?? null,
    questionText: data.question_text,
    options,
    correctAnswerIds,
    explanationText: data.explanation_text ?? null,
    memo: null,
    figures,
    customProps,
  }

  const result = preparedCardSchema.safeParse(candidate)
  if (!result.success) {
    // card 自体が drop されるため、 この card に属していた figure の除外理由は
    // 結果に反映しない(「生存した card に属する figure」だけを集計対象とする
    // — dropped card の内部事情は response 全体の集計には現れない)。
    return {
      card: null,
      excludedReason: 'invariant_failed',
      figuresExcluded: zeroFigureExclusions(),
    }
  }

  // 7. cardId の cross-card 一意性(schema は他 card を見えないため、 ここで
  //    のみ判定可能)。 reserve-after-validate: この card が
  //    `preparedCardSchema` を通過し切った後にのみ予約する — 先に予約すると、
  //    本 card がここで drop された場合でも cardId が「予約済み」のまま残り、
  //    後続の別 card が同じ cardId を正当に再利用しようとしても誤って重複
  //    扱いされる(OT 再レビュー Important 修正で確定した discipline)。
  if (seenCardIds.has(result.data.cardId)) {
    return {
      card: null,
      excludedReason: 'card_id_invalid',
      figuresExcluded: zeroFigureExclusions(),
    }
  }

  // 8. 本 card は完全に生存確定した(schema 通過 + cardId 重複なし)。 ここで
  //    初めて cardId + この card の figure の assetId(localAssetIds)を
  //    グローバル accumulator へ merge する(reserve-after-validate を
  //    cardId・assetId の両方に一貫して適用・OT 再レビュー Important 修正)。
  //    この行より前で return した経路(schema 失敗・cardId 重複)は
  //    localAssetIds を一切 merge しない = drop された card は何も予約しない。
  seenCardIds.add(result.data.cardId)
  for (const assetId of localAssetIds) {
    seenAssetIds.add(assetId)
  }

  return { card: result.data, figuresExcluded }
}

// ---------------------------------------------------------------------------
// normalizePrepared — response 全体(cards[])に対する orchestrator。
// T8b がこの関数を Gemini 応答の JSON.parse 結果に対して直接呼ぶ想定。
// ---------------------------------------------------------------------------

export type NormalizePreparedResult = {
  cards: PreparedCard[]
  /** 入力 cards[] の総数(spec §13「カード N/M 不可」の M)。 */
  cardsTotal: number
  /** hard invariant 不成立 or 構造破損で除外された card 数(同 N)。 */
  cardsExcluded: number
  /**
   * `cardsExcluded` の理由別内訳。総和は必ず `cardsExcluded` に一致する
   * (3 分岐すべてが区分を返し、区分を返さない除外経路が存在しないため)。
   */
  cardsExcludedReasons: CardExclusionTallies
  figuresExcluded: FigureExclusionTallies
}

/**
 * ②-4a 探索 OCR response(T7 統合 schema 出力・JSON.parse 済み)を正規化する。
 * JSON 全体が parse 不能な場合(truncate 等)は呼び出し側(T8b)の retryable
 * failed 関心であり、 本関数は「既に JSON.parse 済みの値」を受け取る前提
 * (spec §5.3)。 `raw` 自体が object でない/`cards` が配列でない場合は例外を
 * 投げず cards=0 の結果を返す(要素隔離の考え方をトップレベルにも適用・
 * 呼び出し側の adversarial 入力に対しても純関数として安全に振る舞う)。
 *
 * @param raw 探索 OCR response の JSON.parse 済み値(未検証 unknown)。
 * @param validSourceIds この operation に属する source_asset の source_id 集合
 *   (figure の source_id 解決/拒否に使う・spec §5.2)。
 * @param nextId 非決定 ID 発行元の注入(spec §D)。 呼出順は
 *   card → options(配列順)→ figures(配列順、隔離後の生存要素のみ)を
 *   cards[] の入力順に固定 — 同一 raw + 同一 nextId 呼出列で同一出力を保証する。
 */
export function normalizePrepared(
  raw: unknown,
  validSourceIds: ReadonlySet<string>,
  nextId: IdFactory,
): NormalizePreparedResult {
  const rawCards: unknown[] =
    raw !== null &&
    typeof raw === 'object' &&
    Array.isArray((raw as Record<string, unknown>).cards)
      ? ((raw as Record<string, unknown>).cards as unknown[])
      : []

  const cards: PreparedCard[] = []
  let cardsExcluded = 0
  const cardsExcludedReasons = zeroCardExclusions()
  let figuresExcluded = zeroFigureExclusions()
  // response 全体で共有する accumulator(cardId は他 card と、 assetId は他
  // card の figure とも衝突しないことを見る必要がある — spec の cardId/assetId
  // はどちらも response 内グローバル identity)。
  const seenCardIds = new Set<string>()
  const seenAssetIds = new Set<string>()

  for (const rawCard of rawCards) {
    const result = normalizePreparedCard(
      rawCard,
      validSourceIds,
      nextId,
      seenCardIds,
      seenAssetIds,
    )
    figuresExcluded = addFigureExclusions(figuresExcluded, result.figuresExcluded)
    if (result.card === null) {
      cardsExcluded += 1
      // union の narrowing により `excludedReason` はここで必ず存在する。
      // 区分を付け忘れた除外経路は compile error になるため guard は要らない。
      cardsExcludedReasons[result.excludedReason] += 1
      continue
    }
    cards.push(result.card)
  }

  return {
    cards,
    cardsTotal: rawCards.length,
    cardsExcluded,
    cardsExcludedReasons,
    figuresExcluded,
  }
}
