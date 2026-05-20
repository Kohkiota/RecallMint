# S1.9.3 sprint log — OCR long-running + 試験一覧 status 表示 + 削除 UI 前倒し

- 日付: 2026-05-20
- branch: `develop` (push 待ち、 main 反映は OT 主導)
- 事前調査: `docs/superpowers/sessions/2026-05-20-s1-9-3-ocr-long-running-and-status-display-investigation.md`
- plan: `docs/plans/2026-05-20-s1-9-3-ocr-long-running-and-status-display.md`
- 実行方式: subagent-driven (各タスク implementer → spec review → `requesting-code-review` formal review)

## 結論

全 6 タスク完了。 build green / 346 tests pass。 OCR は client timeout 撤廃で
長時間完走可能化、 試験一覧で processing/failed exam を可視化、 exam 削除 UI を
S2 から先取り。 exam 削除は「削除を伴う変更」 のため OT staging 実機確認後に
`[reviewed]` を付与済。

## commit リスト (実装 4 commit)

| commit | 種別 | 内容 |
|---|---|---|
| `314faf5` | fix(upload) [reviewed] | T1: client 90秒 timeout 撤廃 + 90秒「閉じてよい」案内 banner + 離脱ガード解除 + processUpload throw handling |
| `dffabbf` | fix(upload) [reviewed] | T2: result page「破棄して再アップロード」button 廃止、 result-actions を Server Component 化 |
| `a6aaacd` | feat(exams) [reviewed] | T3+T4: 試験一覧に processing/failed status badge + 15分越え processing の best-effort cleanup |
| `4a54e44` | feat(exams) [reviewed] | T5+T6: discardUpload → deleteExam 転用 + 試験一覧に削除 UI (inline confirm 2段) |

付随 commit: `ebdbfc9` 事前調査 / `fd46bac` plan / `73eacf7` docs(upload) process.ts コメント整理 [no-review]。

## タスク別完了報告

- **T1 OCR long-running** (`upload-form.tsx`): `setTimeout`→error 化を撤廃。 90秒経過で
  `longRunning` state を立て、 banner 文言を「閉じても試験一覧で確認できる」 旨へ切替、
  `beforeunload`/`popstate` 離脱ガードを解除。 `runProcess` に try-catch を追加し
  `processUpload` throw 時は「試験一覧で確認を」 案内 (retry hint 非表示)。
  review: Critical 0 / Important 2 (banner 逆戻り flash・矛盾サブタイトル、 両 fix) / Minor 2。
- **T2 破棄 button 廃止** (`result-actions.tsx` / `result/.../page.tsx`): 破棄 button +
  client hook + amber 注意 banner を削除、「保存して試験一覧へ」 1本に縮約。
  review: Critical 0 / Important 0 / Minor 2。
- **T3 status helper** (`lib/exams/source-doc-status.ts` 新規): 純関数
  `deriveExamStatuses` + `getExamStatusMap` + `reconcileStaleProcessing`。 9→10 unit test。
- **T4 status 表示統合** (`exams/page.tsx`): render 冒頭で reconcile → status fetch、
  各 exam 行に badge 描画。 T3+T4 review: Critical 0 / Important 1 (`getExamStatusMap`
  best-effort 化、 fix) / Minor 3。
- **T5 delete-exam 転用** (`exams/_actions/delete-exam.ts` 新規): `deleteExam(examId)` =
  owner-scoped 単一文 DELETE + FK CASCADE。 `discard.ts`/`discard.test.ts` 削除。
- **T6 削除 UI** (`exams/_components/delete-exam-button.tsx` 新規): inline confirm 2段。
  T5+T6 review: Critical 0 / Important 1 (`delete-exam.test.ts` の owner-scope 述語検証
  追加、 mutation test で実証) / Minor 3。

## 設計判断の確定内容

- **status tag = 案 B (正確な最新判定)**: `getExamStatusMap` は status filter せず
  当該 user の source_documents 全件を `(examId,status,createdAt)` 射影で取得し、
  exam ごとに真の最新行で判定。 「古い失敗 + 新しい成功」 の exam に stale な失敗 tag
  が出る問題を回避 (R4 リテラル案の既知不正確を排除)。
- **Clerk reverification 不要**: exam 削除は自前 DB の server action のみで Clerk の
  sensitive call (`user.delete()` 等) を含まないため。 account 削除が `useReverification`
  を使うのは Clerk API 側要求であり exam 削除には非該当。 inline confirm のみで担保。
- **削除 UI = inline confirm 2段**: `settings/delete-button.tsx` の idle→confirm→deleting
  パターン踏襲。 phase は `idle/confirm/deleting/error` の 4状態、 error は confirm へ
  復帰 (再確認させる保守的 UX)。
- **`STALE_PROCESSING_MS = 900_000` (15分)**: maxDuration 600s × 1.5 のマージン。
  `reconcileStaleProcessing` で DB を failed 化しつつ、 `deriveExamStatuses` でも
  「15分超 processing は表示上 failed」 を内包 (cleanup UPDATE 失敗時の表示 fallback)。

## staging 実機確認の結果要約

OT が staging で下記を確認、 すべて OK:
- exam 削除フロー (confirm → 削除 → 一覧から除去)
- cascade (cards / source_documents / reviews の連動削除)
- revalidate (`/app/exams` + `/app/upload` 投入先 dropdown への即反映)
- processing / failed status badge の表示

確認完了を受け `4a54e44` に `[reviewed]` を amend 付与済。

## 不採用 / 範囲外 (本 sprint で touch せず)

- **D4** (GEMINI_FAILED 時の Flash 200 OK cost 取りこぼし): 保留。
- **§7.2** (`thoughtsTokenCount` の cost 未計上): 保留。
- **ai_usage / ai_usage_users**: 一切非変更。

いずれも事前調査 doc に詳細記録済。 後続 sprint で要否を再判断。

## 残課題 / 申し送り

- maxDuration 600s は Vercel dashboard の project 設定前提 (code 非反映)。 事前調査
  D1 の通り、 OT が dashboard 設定の実態を継続確認すること。
- `getExamStatusMap` / `reconcileStaleProcessing` の DB 関数は単体テスト無し
  (plan scope 内、 既存 precedent と整合)。 純関数 `deriveExamStatuses` のみ unit test。
