# S2.0.7 sprint log — OCR ステータス polling endpoint + reconcile 分離

- 日付: 2026-05-22
- branch: `develop` (commit のみ、push は OT)
- commit: `14f4e06`
- 事前調査: `docs/superpowers/sessions/2026-05-22-ocr-status-polling-and-nav-perf-investigation.md`

## 結論

試験一覧の「処理中」バッジが OCR 完了後も自動で消えない問題と、
`reconcileStaleProcessing` の無条件書き込み tx がページ遷移をブロックする問題を解消。
試験一覧バッジを polling で live 更新し、stale cleanup の経路を専用 endpoint へ移設。
schema 変更・migration・新規 npm 依存ゼロ。最終 `pnpm test` 437 / `pnpm build` pass。

## 実装内容 (plan 4 項目)

| # | 内容 |
|---|---|
| 1 | `GET /api/exams/status` 新設。owner-scoped な `source_documents` の最小 SELECT (examId / status / createdAt) を返す polling 専用 endpoint。>15 分の processing 残骸があれば `reconcileStaleProcessing` をここで実行 (DB cleanup 経路を polling へ移設) |
| 2 | `ExamStatusProvider` / `ExamStatusBadge` (client) を新設。試験一覧バッジを 5 秒 polling で live 更新、processing→完了の遷移時に `router.refresh()` を 1 回。`exam-status-poll.ts` に遷移判定の純ロジックを切り出し (unit test 付き) |
| 3 | 試験一覧 page / アップロード page から `reconcileStaleProcessing` 呼び出しを撤去。`hasActiveProcessingUpload` は 15 分 window 内蔵のため撤去後も in-flight 誤判定しない |
| 4 | `processUpload` の失敗 path 確認。3 つの catch path (file 読込 / OCR pipeline / cards INSERT) は全て `markFailed` で `status='failed'` 更新済 → コード変更なし |

## review (superpowers:requesting-code-review / general-purpose subagent)

Critical 0 / Important 3 / Minor 3。Important 3 件すべて fix:

- **Imp1**: 孤立 stale processing 行が reconcile されない gap。deriveExamStatuses が
  >15 分 processing を failed 表示に化けさせるため polling が起動せず、endpoint が
  到達不能になる → failed バッジのみの場合に mount 時 1 回だけ poll し reconcile を起動。
- **Imp2**: `initialStatuses` の object identity が server render ごとに変わり effect が
  作り直される → `useState` で初回値を凍結し effect を mount 1 回に固定。
- **Imp3**: route test に owner-scope (`eq(source_documents.user_id, …)`) の assertion 追加。
- Minor: tick 二重起動ガード (`inFlight`) を追加。他 2 件は記録のみ。

## smoke test 結果 (OT 実機観察)

- OCR 処理中に試験一覧を開き、完了後にバッジが自動で消える: **OK**
- 別ユーザーの status が `/api/exams/status` で見えない (owner-scope): **OK**
- ページ遷移が reconcile でブロックされなくなった (体感速度): **改善を確認**

## 保留 (Min4 — 別 sprint / S2.0.5 と同時対応予定)

`process.ts` の完了トランザクション (`status:'completed'` UPDATE + `upload_records`
INSERT) に try/catch が無い。throw 時 (例: Neon 瞬断) に `source_documents` が
`processing` のまま残留する。本 sprint の review で検出された pre-existing gap。
S2.0.7 scope 外のため未対応。Imp1 修正により「failed 表示時の mount poll →
reconcile」で 15 分後には間接回収されるが、完了 tx 自体の防御は別途必要。
