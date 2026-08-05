// ②-4a T16-a: `upload_operations.result_summary`(jsonb)を result page の表示用へ
// 畳み込む pure 層。 producer(`publish-prepared-plan.ts` の `buildResultSummary`)は
// 変更しない — **既にある集計を読むだけ**。
//
// なぜ読み手側で検証するか: `result_summary` の TS 型は `Record<string, unknown>` で
// **何も保証しない**(jsonb 列は shape を強制しない・schema.ts の方針)。 旧 deploy が
// 書いた行や手で書き換えられた行が来ても result page を落とさないため、narrow に
// safeParse し、通らなければ「表示しない」(null)に倒す。 throw しない。
//
// なぜ理由コードを畳むか: `crop_failed` / `coordinate_null` 等はユーザーに意味が無い。
// 「こちらの都合で取り込めなかった」群と「仕様上の打ち切り」群では、ユーザーが取れる
// 行動が違う(前者は再アップロードで直りうる / 後者は分割すれば入る)ので、その 2 つに
// だけ分ける。 運用調査向けの理由別内訳は `result_summary` を直接引けるので UI で
// 重複させない。

import { z } from 'zod'

const count = z.number().int().nonnegative()

// 必要な field だけを narrow に取る(`schemaVersion` / `cardsPreview` 等は z.object が
// strip する)。 `schemaVersion` は敢えて pin しない — 将来 additive に V2 が出たとき、
// 版数だけを理由に表示が消えるのは避けたい。 契約の実体は下の shape。
const resultSummarySchema = z.object({
  cardsExtracted: count,
  cardsTotal: count,
  cardsExcluded: count,
  figuresAttached: count,
  // 7 キーすべてを必須にする。 欠けたキーを 0 と読み替えると「除外は無かった」と
  // 嘘をつくことになるため、欠けたら丸ごと表示しない側へ倒す。
  // T16-b で `orientation_unsupported` を足すときは producer と本 schema と下の
  // 束分けを同時に更新すること(片方だけだと新理由が静かにどちらの束にも入らない)。
  figuresExcluded: z.object({
    coordinate_null: count,
    source_id_invalid: count,
    malformed: count,
    asset_id_invalid: count,
    crop_failed: count,
    image_limit_exceeded: count,
    deadline_excluded: count,
  }),
})

export type UploadResultSummaryView = {
  cardsExtracted: number
  cardsTotal: number
  cardsExcluded: number
  /** 取り込めた図版。 */
  figuresAttached: number
  /** 取り込めなかった図版(検出座標不正 / crop 失敗など、こちらの都合)。 */
  figuresFailed: number
  /** 上限で省いた図版(枚数上限 / 時間予算切れ)。 */
  figuresCapped: number
}

/**
 * `result_summary` を表示用 view に畳む。 **出すものが何も無ければ null** を返す
 * (「取り込めなかった 0 件」を毎回見せると、本当に出た日に読まれなくなる)。
 * 契約外の入力も null(表示しない)。
 */
export function buildUploadResultSummaryView(
  raw: unknown,
): UploadResultSummaryView | null {
  const parsed = resultSummarySchema.safeParse(raw)
  if (!parsed.success) return null

  const { cardsExtracted, cardsTotal, cardsExcluded, figuresAttached } = parsed.data
  const fx = parsed.data.figuresExcluded
  const figuresFailed =
    fx.coordinate_null +
    fx.source_id_invalid +
    fx.malformed +
    fx.asset_id_invalid +
    fx.crop_failed
  const figuresCapped = fx.image_limit_exceeded + fx.deadline_excluded

  if (
    figuresAttached === 0 &&
    figuresFailed === 0 &&
    figuresCapped === 0 &&
    cardsExcluded === 0
  ) {
    return null
  }

  return {
    cardsExtracted,
    cardsTotal,
    cardsExcluded,
    figuresAttached,
    figuresFailed,
    figuresCapped,
  }
}
