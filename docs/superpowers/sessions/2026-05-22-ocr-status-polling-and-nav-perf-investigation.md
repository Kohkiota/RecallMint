# OCR ステータス自動更新 + ナビゲーション重さ — 調査 (2026-05-22)

ステータス: **調査のみ完了 / 修正は未着手**。
別タスク進行中のため、その完了後に本修正を挟む予定。spec → plan は方針確定後に着手。

---

## 1. 症状

アップロード後にその場を離れ、試験一覧で「処理中」バッジが出ている状態で
OCR が裏で成功しても、

- 一覧の「処理中」バッジが自動で消えない
- 「成功」表示にもならない
- 手動フルリロード (F5) でのみ「処理中」が消える

## 2. 根本原因

### ① 処理中バッジが自動で消えない

試験一覧 `app/(app)/app/exams/page.tsx` は純粋な Server Component。
サーバで 1 回 render されたら画面は凍結し、client 側に
polling / `router.refresh()` / SWR / SSE が一切ない。

- 一覧着地時に OCR がまだ走っていれば `status='processing'` を 1 回読んで
  「処理中」を描画 → 以後固定。
- 裏で OCR 完走 → DB `source_documents.status` は `completed` になる。
- `processUpload` の `finally` が `revalidatePath('/', 'layout')` を呼ぶが、
  これはサーバキャッシュを stale 化するだけで、表示中の画面には何も push しない。
  さらに revalidate の client Router Cache 無効化信号は「server action を
  呼んだ画面 = アップロード画面」に返るが、ユーザーは既に離脱済みなので
  信号は宙に浮き、一覧には届かない。
- 結果、F5（Router Cache 貫通 → SSR 再実行）でのみ最新化される。

(註: 一覧 page は `getCurrentUser()` = Clerk `auth()` で dynamic render 確定。
Full Route Cache は効かない。真因は「server-rendered スナップショットに
client 更新手段がない」こと。)

### ② 「成功」と表示されない

設計どおり。`deriveExamStatuses` (source-doc-status.ts:69-72) と
page.tsx:57 で `completed` は Map に entry を作らない = バッジを出さない。
「成功 / 完了」バッジはコード上に存在しない。完了 = 処理中バッジがただ消える。

## 3. polling 方式の比較（重さ）

`router.refresh()` 連打は最重量。試験一覧 route 全体（layout + page）が
毎 tick 丸ごと再走する:

| 処理 | コスト |
|---|---|
| `getCurrentUser()` | `users` SELECT 1 本 |
| `reconcileStaleProcessing()` | 書き込みトランザクション (BEGIN+UPDATE…RETURNING+COMMIT)。stale 0 件でも毎回 |
| `getActiveExamsWithCardCount()` | `cards` LEFT JOIN + GROUP BY count |
| `getExamStatusMap()` | `source_documents` SELECT |

**推奨（最軽量）**: 専用 Route Handler `GET /api/exams/status` を新設。
中身は `source_documents` の最小 SELECT 1 本のみ
（`examId / status / createdAt` 3 列、owner-scope、既存 index
`source_docs_status_idx` 直撃）。client はこれを polling して
バッジだけ client state で差し替え、`router.refresh()` は
「処理中→完了」へ変わった瞬間に 1 回だけ（カード件数同期用）。

エンドポイントが叩くのは `auth()` + `users` SELECT + `source_documents`
SELECT の計 2 本のみ。reconcile の書き込み tx / JOIN+GROUP BY /
layout 再 render を polling から完全に外せる。

追加の軽量化:
- 初回 render で処理中行 0 件なら polling を開始しない
- 間隔 5〜10 秒（OCR は数十秒〜数分）
- `document.visibilityState === 'hidden'` 中は停止

## 4. 別件: 「全体的に重い」の主因（polling とは独立）

試験一覧・アップロード両ページが render のたびに
`reconcileStaleProcessing()` の書き込みトランザクションを無条件実行
（exams page.tsx:25 / upload page.tsx:33）。stale 行ゼロでも
BEGIN/UPDATE/COMMIT で Neon に複数往復 → ボタン押下時の体感遅延の主因。

各ページは `await getCurrentUser()` → `await reconcileStaleProcessing()`
→ `await Promise.all(...)` と直列。upload は `hasActiveProcessingUpload`
が挟まり 4 段直列。

表示の正しさは `deriveExamStatuses`（15分超 processing を表示上 failed に
倒す）が担保済 → reconcile は描画クリティカルパスから外せる。改善余地:
- reconcile を「軽い SELECT 1本で stale 有無確認 → 在るときだけ tx」に変更
- または reconcile を render の await から外す（best-effort、結果を待つ必要なし）

## 5. 未決の論点（修正着手前に OT 判断）

1. polling 実装: A) 専用軽量エンドポイント（推奨）/ B) `router.refresh()` 連打
2. 「成功」表示: A) 処理中の自動消去のみ / B) 「完了」バッジも新設
   （新設なら 常時表示 / 直近完了のみ transient のどちら）
3. 「全体的に重い」も同時対応するか / polling だけ先行するか
4. reconcile 改善: A) SELECT ガード後に条件付き tx / B) await から外す / C) 今回触らない

## 6. 主要ファイル

- `app/(app)/app/exams/page.tsx` — 一覧 Server Component、バッジ描画 57-67 行
- `lib/exams/source-doc-status.ts` — status 判定 / `reconcileStaleProcessing` 139-196 行
- `lib/exams/list.ts` — `getActiveExamsWithCardCount`（LEFT JOIN + GROUP BY）
- `app/(app)/app/upload/page.tsx` — reconcile 無条件実行 33 行
- `app/(app)/app/upload/_actions/process.ts:117-119` — `revalidatePath('/', 'layout')` のみ
- `lib/db/index.ts` — Neon serverless WebSocket Pool
