# S1.9.4 sprint log — 並列 OCR upload guard

- 日付: 2026-05-20
- branch: `develop` → `main` (closure 時 ff merge)
- 事前調査: `docs/superpowers/sessions/2026-05-20-s1-9-4-parallel-ocr-guard-and-cascade-investigation.md`
- plan: `docs/plans/2026-05-20-s1-9-4-parallel-ocr-upload-guard.md`
- 実行方式: subagent-driven (各タスク implementer → spec review → `requesting-code-review` formal review)

## 結論

全 4 タスク完了。 build green / 348 tests pass。 同一 user の並列 OCR upload を
「1 user 1 ジョブ」 に制限。 server-side enforcement (advisory xact lock +
in-flight 行 check) を主、 `/app/upload` の UI guard を advisory 第一層とする。
migration なし・schema 変更なし・新規環境変数なし。

## commit リスト (実装 2 commit)

| commit | 種別 | 内容 |
|---|---|---|
| `aef0507` | feat(upload) [reviewed] | T1+T2: server-side 並列 guard (advisory xact lock + in-flight check) / upload-form の UPLOAD_IN_PROGRESS error 表示 |
| `d7b67fe` | feat(upload) [reviewed] | T3+T4: `hasActiveProcessingUpload` helper / `/app/upload` の UI guard 統合 + 15 分 window の定数統一 |

付随 commit: `e45d220` 事前調査 / `7ad2d2c` plan。

## タスク別完了報告

- **T1 server guard** (`process.ts` / `process.test.ts`): `processUpload` の guard 段を
  1 つの短い `db.transaction` に再構成。 (a) `pg_try_advisory_xact_lock(hashtext(userId))`
  で同時起動 (ms 窓) の race を防止、 (b) 15 分以内の `status='processing'`
  source_documents の有無で in-flight ジョブを弾く。 両 guard 失敗で新 code
  `UPLOAD_IN_PROGRESS` を return。 transaction は exam / source_documents INSERT までで
  commit、 lock を OCR 本体 (最大 600s) に持ち込まない。 review: Critical 0 /
  Important 1 (guard test の早期 return 順序 invariant、 fix) / Minor 2。
- **T2 error 表示** (`upload-form.tsx`): `UPLOAD_IN_PROGRESS` のとき `hideRetryHint` を
  立て「ファイルを変更して再試行」 サブタイトルを抑止 (ファイルの問題ではないため)。
- **T3 helper** (`source-doc-status.ts`): `hasActiveProcessingUpload(userId, now?)` を新設。
  15 分以内の `status='processing'` 行を `LIMIT 1` で存在判定。 best-effort。
- **T4 UI guard** (`upload/page.tsx`): render 時に `reconcileStaleProcessing` →
  `hasActiveProcessingUpload` を実行。 in-flight なら `<UploadForm>` を出さず
  「処理中につきお待ちください」 案内 + 試験一覧 link を描画。 T3+T4 review:
  Critical 0 / Important 1 (15 分 window の二重定義、 fix) / Minor 3。

## 設計判断の確定内容

- **2 機構併用 (advisory lock + in-flight 行 check)**: advisory xact lock 単独では
  同時起動 (ms 窓) の race しか防げず、 先行ジョブの OCR 走行中 (lock は短い tx で
  解放済) の並列起動を防げない。 in-flight 行 check が「1 ジョブ」 の実効ルール、
  advisory lock がその check+INSERT を race-free にする。 両方を server guard に実装。
- **新規 error code `UPLOAD_IN_PROGRESS`**: 既存 8 code に該当なし。 UI 分岐が明確に
  なるため新設。
- **`hasActiveProcessingUpload` は best-effort**: DB エラー時 `logger.warn` + `false`。
  UI guard は advisory な第一層で真の enforcement は server guard。 helper 失敗時は
  form を出す側に倒し user を不当にブロックしない。 同 file の既存方針と整合。
- **15 分 window を `STALE_PROCESSING_MS` 単一定数に統一**: server guard / UI guard /
  `reconcileStaleProcessing` がすべて同一定数から導出。 当初 server guard が SQL
  リテラル `interval '15 minutes'` を使っていたのを review 指摘で定数共有に修正。
  閾値 = maxDuration 600s × 1.5。 stale orphan を「in-flight」 と誤判定しない safety
  net (= 15 分は cooldown ではなく、 死んだジョブを無視する上限)。
- **lock の範囲**: advisory xact lock は exam / source_documents INSERT までの短い
  transaction に閉じ、 commit で自動解放。 OCR 本体 (最大 600s) は transaction 外。

## 不採用 (kickoff 確定)

- **案 (a) `SELECT ... FOR UPDATE`**: 「行の不在」 を guard する用途では lock 対象行が
  無く race を防げない (proxy 行 lock が必要)。 採らない。
- **案 (b) partial unique index**: migration が必要、 かつ source_documents INSERT
  時点で初めて弾くため `mode='new'` で orphan の空 exam が残る integration 難点。
  採らない。
- 採用は **案 (c) advisory xact lock** — migration 不要、 orphan 問題なし、 Neon の
  transaction-mode pooling と xact 版で安全共存。

## staging smoke 結果要約

OT が staging で確認、 すべて OK:
- 通常の OCR upload が従来どおり通る (guard が誤発火しない)
- タブ A が submitting 中にタブ B から submit 試行 → `UPLOAD_IN_PROGRESS` error
  (「処理中の OCR があります…」、 retry hint なし) を確認
- OCR 実行中に `/app/upload` を開く → 「処理中につきお待ちください」 案内が出て
  upload form が出ない

## 申し送り

- **D1 (cascade dormant)** — user 削除が soft delete のみで `DELETE FROM users` が
  存在せず FK cascade が永久に発火しない件 (削除済 user の exams / cards /
  source_documents 等が永続残存、 容量 + GDPR 観点) は、 本 sprint scope 外として
  **S1.9.5 に切り出し済**。 別 sprint で対応。 詳細は事前調査 doc §5.2。
- maxDuration 600s は Vercel dashboard 設定前提 (code 非反映)。 15 分閾値は
  maxDuration に依存するため、 maxDuration を変える場合は `STALE_PROCESSING_MS` の
  追従が必要。
