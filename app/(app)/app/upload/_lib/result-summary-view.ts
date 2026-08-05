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
  // 既存 7 キーは必須。 欠けたキーを 0 と読み替えると「除外は無かった」と嘘をつく
  // ことになるため、欠けたら丸ごと表示しない側へ倒す(T12 以降どの producer も
  // この 7 キーを必ず書いている = 欠けていたら本当に壊れた行)。
  // 理由キーを producer に足すときは本 schema と下の束分けを**同 commit で**更新する
  // (片方だけだと z.object が未知キーを strip して parse は成功し、新理由が
  // どちらの束にも入らず静かに過少計上される)。 drift pin が CI で赤くする —
  // **その pin は required/optional でなく「各 producer key がちょうど 1 束に入るか」を
  // 見ているので、下の `.default(0)` で弱まらない**(runtime は寛容 / CI は厳格)。
  figuresExcluded: z.object({
    coordinate_null: count,
    source_id_invalid: count,
    malformed: count,
    asset_id_invalid: count,
    crop_failed: count,
    image_limit_exceeded: count,
    deadline_excluded: count,
    // **新設キーだけ `.default(0)`**(T16-b)。 本 deploy 前に書かれた行はこのキーを
    // 持たず、必須にすると過去 doc の内訳ブロックが丸ごと消える = T16-a が潰した
    // silent zero の再発になる。 0 と読むのが嘘にならないのは、**旧 deploy には
    // EXIF 検知の機構自体が存在せず**、旧行の実値が推定でなく事実として 0 だから。
    // **sunset 条件**: T16-b deploy 前に書かれた `result_summary` 行が出尽くしたら
    // (= 旧 op が 7 日 retention で terminal 化 + stg リセットで消えたら)`.default(0)`
    // を外して他 7 キーと同じ必須へ戻せる。 寛容さを恒久化しないための条件。
    orientation_unsupported: count.default(0),
  }),
})

export type UploadResultSummaryView = {
  cardsExtracted: number
  cardsTotal: number
  cardsExcluded: number
  /** 取り込めた図版。 */
  figuresAttached: number
  /** 取り込めなかった図版(検出座標不正 / crop 失敗 / 向き未対応 = 扱えなかった分)。 */
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
  // `orientation_unsupported`(EXIF≠1)を**失敗束に入れる**(OT 決定・T16-b):
  // 「上限のため」は嘘になる — こちらが上限を決めて打ち切ったのではなく**扱えなかった**
  // から。 回転が入力側の性質なのは事実だが、ユーザーから見れば「上げた画像が使われ
  // なかった」であり、原因の帰属より扱えなかったことが伝わるべき。 仕様上の打ち切りと
  // 混ぜると除外の意味が薄まる。
  const figuresFailed =
    fx.coordinate_null +
    fx.source_id_invalid +
    fx.malformed +
    fx.asset_id_invalid +
    fx.crop_failed +
    fx.orientation_unsupported
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
