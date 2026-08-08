// Upload UI 制限値。 body size 上限は 2 段で決まる点に注意 (再発防止):
//   1. Next.js framework default = **1MB**。 `next.config.ts` の
//      `experimental.serverActions.bodySizeLimit` で明示 raise しないと、
//      Server Action 本体に到達する前に framework 層で 413 が投げられる。
//   2. Vercel platform hard limit = **4.5MB** (vercel.com/docs/functions/limitations
//      "Request body size")。 これ以上は platform 側で FUNCTION_PAYLOAD_TOO_LARGE。
// 本 client cap (4MB) は `next.config.ts` の `bodySizeLimit: '4.5mb'` と整合させた
// 値: 4MB + multipart overhead ≒ 4.1MB 弱で 4.5MB platform 上限の内側に収まる。
// Vercel Pro 関数 timeout (900s) も合わせて踏まえた client 側検証用。

// 1 file 圧縮後の目安。 画像は browser-image-compression で maxSizeMB に渡す値。
export const MAX_IMAGE_FILE_MB = 0.5
export const MAX_IMAGE_WIDTH_OR_HEIGHT = 2048

// submitUpload の FormData body 上限。 Vercel platform body 上限 4.5MB + Next.js
// `bodySizeLimit: '4.5mb'` 設定 (next.config.ts) と整合させた client cap。
// 安全マージンを取り 4MB。 ②-4b: PDF は R2 直 PUT で body を経由しない(バイトは
// FormData に載らず orderManifest でメタデータのみ運ぶ)ため、 この上限は
// **圧縮後画像 entry のみ**が対象(PDF バイトは含まない)。
export const TOTAL_UPLOAD_LIMIT_MB = 4

// 各定数の bytes 換算 (MB は 1_000_000、 1024 系統一しない 平易化重視)。
export const MB = 1_000_000
export const TOTAL_UPLOAD_LIMIT_BYTES = TOTAL_UPLOAD_LIMIT_MB * MB

// ②-4b: PDF 一時保存(R2 `src/` prefix)の per-file バイト上限(spec D7)。
// presign(reserve-pdf-upload)の Content-Length 署名 + 完了通知
// (finalize-pdf-source)の HEAD 再検証の両方で使う。 商品仕様の冊数上限ではなく
// システム保護値。 暫定 — 実測後見直し。
export const MAX_PDF_BYTES = 50 * MB

// ②-4b Task 6: PDF 直 PUT(browser → R2)の timeout。 外部 fetch は
// AbortSignal.timeout 必須の repo 慣習(lib/media/upload.ts の画像直 PUT と同型)。
// PDF は画像より大きい(≤ MAX_PDF_BYTES)ため画像 PUT と同じ値を流用(暫定)。
export const PDF_PUT_TIMEOUT_MS = 60_000

// ②-4b: PDF batch 合計(declaredBytes の Σ)上限(spec D7 r4)。 reserve と
// submit pre-tx の両方で検証する。 暫定 — 実測後見直し。
export const MAX_PDF_TOTAL_BYTES = 200 * MB

// ②-4b: pipeline render phase の webp 累計バイト上限(spec D7 r4)。 超過は
// terminal `webp_limit_exceeded`(loud) — 高エントロピー PDF が Gemini inline /
// メモリの既存 ~4-5.5MB 前提を外れるのを塞ぐ。 暫定 — 実測後見直し。
export const MAX_RENDERED_WEBP_TOTAL_BYTES = 30 * MB

// ②-4a 単一 invocation 経路(submit-upload.ts)の lease TTL。sync tx が
// `lease_expires_at = now + LEASE_TTL_MS` を発行し、live-op gate
// (isLiveUploadOperationCondition)が唯一の読者になる — 「今この upload を進めて
// いる invocation が生存している」表明。route の maxDuration(720s・page.tsx)
// + margin 180s ≤ この値(pin test で機械強制)ゆえ、1 invocation が maxDuration
// いっぱい走っても lease が先に失効することはない。
// 'use server' file は非 async の value export を許さない(SWC 71011)ため、
// 定数はこの directive 無し共有 file に置く(action / iso test の両方がここから
// import する)。
export const LEASE_TTL_MS = 15 * 60 * 1000

// ②-4a 単一 invocation 経路(submit-upload.ts → upload-pipeline.ts)の統合 time
// budget(spec 2026-08-04 §11)。 起点は **action 入口時刻**(sync tx の消費分も
// 予算内)。 route の maxDuration(720s・page.tsx)より 60s 短い。
//
// **この 60s 差だけでは超過を防げない**(canonical review I-1・実際の算術):
// 1 回の Gemini call は最悪 `GEMINI_TIMEOUT_MS`(220s)、`callImageCropWithRetry` は
// 初回 + 2 retries = 3 attempts で backoff は Retry-After 有りなら最大 60s×2 /
// 無しなら 5s + 20s(+ jitter 最大 7s)。 ゆえに Gemini phase 単体の最悪値は
//   Retry-After 有り: 3×220 + 2×60 = **780s**(maxDuration 720s すら超える)
//   Retry-After 無し: 3×220 + 25〜32 = **685〜692s**(本予算 660s を超える)
// で、呼出直前の残余チェック 1 回では防げない(pre-call 時点では残余が足りている)。
// → 実効的な歯止めは `callImageCropWithRetry` の `deadlineAt`(retry ループの内側で
// 「残余 < GEMINI_TIMEOUT_MS なら次の attempt を始めない」)。 本定数はそこへ渡す
// 予算の起点であり、60s 差は「最後の attempt が timeout 一杯まで走っても
// maxDuration に届かない」ための余白ではなく、terminal 化 + log の書込に要する余白。
//
// **暫定値 — cutover 後の実測で見直す**(2026-08-02 OT 方針: 時間予算の精緻化は
// 測定前に決め打ちしない。phase 別所要時間を logger.warn で出しているのが材料)。
export const UPLOAD_PIPELINE_BUDGET_MS = 660 * 1000

// ②-4a 単一 invocation S-4: upload page の完了検知 poll(/api/exams/status の
// `docStatuses`)。 5 秒間隔は spec 2026-08-04 §5 の確定値。
export const DOC_STATUS_POLL_INTERVAL_MS = 5 * 1000

// poll の縮退条件 1: 連続で fetch に失敗した回数(ネットワーク断 / 5xx)。到達したら
// poll を止めて「試験一覧で確認」へ倒す(既存 kick session の「error で無限 poll」を
// 再現しない)。
export const DOC_STATUS_POLL_MAX_FETCH_FAILURES = 6

// poll の縮退条件 2: 絶対上限。 `processing` が返り続ける hard-death ケース
// (after() の callback が死に、lease 失効 → reconciler 収束を待つ間)で poll が
// 無限に続くのを防ぐ(Codex #7)。 **暫定値**(時間予算と同じく実測後に見直す)。
export const DOC_STATUS_POLL_LIMIT_MS = 20 * 60 * 1000

// ②-4a 単一 invocation S-4: upload の現況をユーザーに伝える**公開文言**。 spec 論点 A の
// 確定事項どおり、下の 2 本とも **待ち時間の数値を書かない / 試験の削除を案内しない**。
//
// I-3(b)(仕様変更 2026-08-05): S-4 完了時点では 1 本を 3 面共通で当てていたが、
// その根拠(「ユーザーから見て failed と in_progress は区別できず、次の行動も同じ」)は
// S-4 の after() 化で両方とも崩れたため、**確定した失敗**と**未確定(処理中)**に割った:
//   ・次の行動が同じでない — in_progress の間は live-op gate が submit を弾くので、
//     「再度お試しください」は**実行できない行動**の案内になる。
//   ・支配的ケースが逆転した — 以前は離脱すると処理が止まった。 after() 化後は離脱が
//     正常系で、戻ってきたユーザーの operation はたいてい健全に実行中。
//   ・自己矛盾 — submit 直後の banner は「この画面を閉じても処理は続きます」と離脱を
//     勧めており、そのとおりにして戻った人が「中断された可能性があります」を見る。
//
// hard-death(after() の callback が platform kill された)のユーザーは最大 15 分
// (LEASE_TTL_MS)「処理中」を見てから failed に変わるが、**これは正直な表示**である —
// 生きているか死んでいるか区別できない間は「区別できない」と言い、確定してから
// 「失敗した」と言う。 lease 失効後は live-op gate も開くため、**再試行の案内は
// 実行可能になったタイミングでのみ出る**。

// 失敗が確定した面(operation は terminal 化済み = 再試行が実行可能)。
//   ① upload page の poll が `failed` を返したとき
//   ② result page の失敗パネル(S-3 で導入)
export const UPLOAD_INTERRUPTED_NOTICE =
  '処理が中断された可能性があります。 しばらく待ってから再度お試しください。 処理状況は試験一覧で確認できます。'

// まだ確定していない面。**中断を主張しない / 再試行を勧めない**中立文言。
// 3 面が共有するのは「**結果が未確定である**」ことだけで、判定の実体は面ごとに違う —
// 「lease が生きている」と一括りに述べない(canonical I-1: 遠隔の不変条件に依存する
// 主張をコメントに置かない):
//   ① `submitUpload` が `in_progress` を返したとき — live-op gate が **lease を評価**
//      している(別 op が valid lease を保持)
//   ② `/app/upload` 再訪時の「処理中」カード(hasLiveUploadOperation)— S-5b 以降は
//      ① と **同一の述語**(非終端 + valid lease)を読む
//   ③ result page の処理中パネル — `source_documents.status` ベース(こちらは lease を
//      読まない。 同じ状況を別の言い方で説明しないための共有)
// 中立文言の根拠は上の設計判断のとおり「区別できない間は区別できないと言う」であり、
// どの面でも lease の生死に依存しない。
export const UPLOAD_PENDING_NOTICE =
  '処理中です。 完了すると試験一覧に反映されます。'

// ②-4a T16-a: result page の成功面が出す**取り込み内訳の公開文言**。 spec §13
// 「loud failure over silent zero」— 除外が起きたことを画面に出さないと、11 問取れた
// ときと 0 問のときが同じ見た目になる。
//
// I-3(b) の規律: 各関数は**常に独立した 1 文**を返し、述語として文中に連結しない
// (連結すると文言の書換が他面では正しいまま この面だけ壊れた日本語になり、誰も
// 気付かない)。 件数だけを変数として埋め、文の骨格はここに持つ。
// 理由コード(crop_failed 等)は画面に出さない — 束に畳んだ言い方だけを持つ。
export function uploadFiguresAttachedNotice(count: number): string {
  return `図版 ${count} 件を取り込みました。`
}
export function uploadFiguresFailedNotice(count: number): string {
  return `${count} 件の図版は取り込めませんでした。`
}
export function uploadFiguresCappedNotice(count: number): string {
  return `${count} 件の図版は上限のため省略しました。`
}
export function uploadCardsExtractedNotice(
  extracted: number,
  total: number,
): string {
  return `${total} 問中 ${extracted} 問を取り込みました。`
}

// crop 1 件を新たに試みるために要求する最低残り予算(spec §11「crop 最低予算」・
// soft pre-crop gate)。 暫定値 — cutover 後の実測で見直す(2026-08-02 OT 確定:
// 時間予算の精緻化は測定前に決め打ちしない)。
export const CROP_MIN_REMAINING_MS = 5 * 1000

