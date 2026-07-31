// prepared-schema — ②-4a の prepared card / payload の executable contract
// SSoT。 spec: docs/superpowers/specs/2026-07-30-ocr-2-4a-image-figure-crop-design.md
// §5.4(2026-07-31 改訂・T8a 収束設計)。
//
// 根本原因(§5.4): `PreparedCard` を TS 型で手書きしていたため実行時検証 schema
// が無く、normalize が publisher の card 検証を field ごとに部分模倣するしか
// なく、両者の一致保証がどこにも無かった(uid→cardId→assetId→option bounds の
// whack-a-mole・複数回検出)。→ **単一 runtime schema を SSoT 化**し、
// normalize(produce・`lib/ocr/normalize-prepared.ts`)と publisher(consume・
// T12・未実装)が**同じ schema object**を共有することで構造的に収束させる。
//
// leaf 境界値(文字数上限・必須/nullable・配列個数・uid v4 等)は
// `lib/validation/card.ts` の既存 schema を**そのまま**(値のコピーでなく
// 参照の共有)compose する — 再定義しない。card レベル(title/sortKey/
// questionText/explanationText/memo)と option(id/uid/text/isCorrect/
// explanation)は publisher の manual 編集 schema と完全に同一の schema object
// を使う(drift が構造的に起きない)。figure(assetId/sourceId/box_2d/target/
// label)は publisher に前例が無い新規領域(OCR/検出ドメイン語彙)のため本 file
// で新規定義する。
//
// **統一しないもの(spec §5.4 範囲の線引き)**: OCR raw schema(Gemini 出力形状
// 検証・`lib/ocr/normalize-prepared.ts` の rawCardSchema 等)/ manual card
// schema(UI 入力検証・本 file が compose する側)/ DB schema は目的が異なる
// ため統一しない。DB 文脈検証(asset の owner/ready/hash・exam/source 存在・
// fencing)は **publisher(T12)専用**のまま — 本 file は element isolation の
// 契約(prepared card の shape/bounds)のみを扱う。

import { z } from 'zod'
import {
  titleSchema,
  sortKeySchema,
  questionTextSchema,
  explanationTextSchema,
  memoSchema,
  optionSchema,
  optionsSchema,
} from '@/lib/validation/card'

// ---------------------------------------------------------------------------
// option(publisher の optionSchema を verbatim 再利用)
// ---------------------------------------------------------------------------

// コピーでなく同一 schema object を re-export する。 prepared option の実体は
// 「manual 編集で書き込める option」と全く同じ形状・境界(id min1・text
// max1000+非空・uid v4 必須・explanation max2000 optional・isCorrect
// camelCase)。 raw Gemini 出力は snake_case `is_correct` のため、 normalize 側
// (`lib/ocr/normalize-prepared.ts`)が候補 option を組み立てる時点で 1 回だけ
// camelCase へ変換する(型変換境界を 1 箇所に固定・spec §8.2)。
export const preparedOptionSchema = optionSchema
export type PreparedOption = z.infer<typeof preparedOptionSchema>

// v4 uuid 形状チェックを cardId/assetId で共有する(`isAssetKey`
// (lib/validation/card.ts)と同一判定域 = `z.uuid({ version: 'v4' })`)。
const uuidV4Schema = z.uuid({ version: 'v4' })

// ---------------------------------------------------------------------------
// figure(publisher に前例なし・本 file で新規定義)
// ---------------------------------------------------------------------------

export const preparedFigureSchema = z.object({
  assetId: uuidV4Schema,
  sourceId: z.string(),
  // box_2d は Gemini/検出ドメインの語彙(snake_case)をそのまま維持する — card
  // ドメインの camelCase 変換対象に含めない(T10 crop 層がこのキーをそのまま
  // 消費する想定・スコープを広げない)。
  box_2d: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  // 解決済み target: 'question_text' | 'explanation_text' | `option:${uid}`
  // (`option:${uid}` は動的な値のため literal union にしない・spec §13)。
  target: z.string(),
  // 正規形(spec §5.4 ①): キー必須・値は null(undefined にしない)。
  label: z.string().nullable(),
})
export type PreparedFigure = z.infer<typeof preparedFigureSchema>

// ---------------------------------------------------------------------------
// figure 除外理由の集計 — spec §13 が定義する理由のうち、この layer(要素隔離)
// が判定できるものに限る(crop_failed / image_limit_exceeded / 向き未対応 /
// deadline_excluded は T10/T14/T16 の責務・ここで fabricate しない)。
// ---------------------------------------------------------------------------

export const figureExclusionTalliesSchema = z.object({
  coordinate_null: z.number().int().nonnegative(),
  source_id_invalid: z.number().int().nonnegative(),
  // figure 要素そのものが schema 形状として壊れているケース(spec §13 の公式
  // 語彙にはない追加区分・Gemini 出力側の問題)。
  malformed: z.number().int().nonnegative(),
  // 発行された assetId が v4 shape でない、または既出 assetId と衝突する
  // ケース(同じく公式語彙外・injected id-factory 側の問題。健全な
  // `randomUUID` factory では本来発生しない安全網)。
  asset_id_invalid: z.number().int().nonnegative(),
})
export type FigureExclusionTallies = z.infer<typeof figureExclusionTalliesSchema>

// ---------------------------------------------------------------------------
// card(publisher の card-field schema を compose)
// ---------------------------------------------------------------------------

export const preparedCardSchema = z.object({
  cardId: uuidV4Schema,
  title: titleSchema,
  // sortKeySchema は既に `.nullable()`(lib/validation/card.ts で manual 編集用
  // に確立済 — undefined でなく null が既存慣習。 spec §5.4 ①「既存 manual
  // schema と整合」はこの既存慣習をそのまま指す)。
  sortKey: sortKeySchema,
  questionText: questionTextSchema,
  // 個数境界(1-50)+ id 一意 + uid 一意 + uid v4 shape を全て `optionsSchema`
  // 側で検証する(count/uniqueness/bounds の手書き再実装をしない — これが
  // whack-a-mole を閉じる本 file の中心的な効果)。
  options: optionsSchema,
  // is_correct/isCorrect から導出済みの値をそのまま保持する(導出は normalize
  // 側の責務・このレベルでは形状のみ確認)。
  correctAnswerIds: z.array(z.string()),
  explanationText: explanationTextSchema,
  // OCR 抽出に memo という概念は無いが、 manual 作成 card との形状統一のため
  // 保持する(normalize は常に null を設定する)。
  memo: memoSchema,
  figures: z.array(preparedFigureSchema),
  // 正規形(spec §5.4 ②): `.optional()` にしない — optional だと候補構築側の
  // 転記忘れが schema を素通りし「静かな欠落」が残る(タグは既存機能・OCR
  // 経路だけ欠落は退行)。raw に無ければ normalize 側が `{}` を渡す責務を負う。
  customProps: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
})

// `PreparedCard` は手書きせず schema から導出する(spec §5.4 の実装条件)。
export type PreparedCard = z.infer<typeof preparedCardSchema>

// ---------------------------------------------------------------------------
// payload(spec §5.4 ③・§9: version 固定・discriminated union で dispatch)
// ---------------------------------------------------------------------------

export const preparedPayloadV1Schema = z.object({
  schemaVersion: z.literal(1),
  cards: z.array(preparedCardSchema),
  // spec §13「カード N/M 不可」の M / N。
  cardsTotal: z.number().int().nonnegative(),
  cardsExcluded: z.number().int().nonnegative(),
  figuresExcluded: figureExclusionTalliesSchema,
})
export type PreparedPayloadV1 = z.infer<typeof preparedPayloadV1Schema>

// 将来の schema 変更は V1 を書き換えず V2 を追加してここに列挙する(旧デプロイが
// 保存した V1 payload を新 publisher が reject しないよう、 最大 retry 保持
// 期間(7 日・spec §11)以上 V1 を残す運用ルール・spec §5.4③・§9)。
// dispatch の正は payload 内の `schemaVersion`(DB `prepared_schema_version`
// 列は query/monitoring 用の外出しに過ぎない・spec §9)。
export const preparedPayloadSchema = z.discriminatedUnion('schemaVersion', [
  preparedPayloadV1Schema,
])
export type PreparedPayload = z.infer<typeof preparedPayloadSchema>
