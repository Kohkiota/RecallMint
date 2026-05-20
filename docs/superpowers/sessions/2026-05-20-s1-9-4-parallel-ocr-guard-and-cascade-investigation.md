# S1.9.4 事前調査 — 並列 OCR upload guard + schema cascade 網羅確認

- 日付: 2026-05-20
- 種別: 事前調査 (trace + 設計選択肢列挙のみ、 実装変更 0、 doc 1 file)
- branch: `develop` (`main` = `develop` 同期済の `a25c89c` から開始)
- **本 doc は修正方針を提示しない**。 各設計選択肢は trade-off 込みで列挙、 採用案 selection は claude.ai + OT が後段で決定する。

## 背景

S1.9.3 staging 実機確認で「処理中 2 件並走」 を OT が実証。 同一 user が複数タブ /
連打で並列 OCR を起動できる。 利用枠二重消費 (ai_usage 2 倍) / Vercel function
並列課金 / DB 整合リスク。 launch 前 user 0 では実害なしだが launch 即問題化。
S1.9.4 で「1 user 1 ジョブ」 guard を実装する前提の事前 trace。

---

## 0. エグゼクティブサマリ (期待発見ポイントへの回答)

| # | 確認事項 | 結論 |
|---|---|---|
| 1 | 並列 guard の有無 | **無し**。 `processUpload` に「current user の processing source_documents」 check は存在しない。 plan-limits / GEMINI_DAILY_LIMIT guard はあるが並列防止ではない。 |
| 2 | partial unique index の migration 要否 | 案 (b) を採るなら **要** (次番 `0006`)。 現状 `source_documents` に該当 index なし。 案 (a)/(c) は migration 不要。 |
| 3 | `/app/upload` の Server Component 化 | **不要**。 `app/(app)/app/upload/page.tsx` は既に Server Component。 fetch + 条件分岐を足すだけ。 |
| 4 | schema cascade の漏れ | **FK 定義側に漏れなし** (user_id FK は全て `cascade`)。 ただし **致命的発見 D1**: user 削除経路が soft delete のみで `DELETE FROM users` を一切実行しないため、 **cascade が永久に発火しない**。 |

**追加の重要発見**:

- **D1 (最重要)**: Clerk `user.deleted` webhook (`app/api/webhooks/clerk/route.ts`) は
  `UPDATE users SET deleted_at = now()` の **soft delete のみ**。 `DELETE FROM users`
  が codebase 全体に存在しない (`grep` 確認)。 → 全 user_id FK が `cascade` でも
  **cascade が起動せず**、 exams / cards / source_documents / upload_records /
  reviews / study_days / ai_usage_users / contact_messages が **アカウント削除後も
  Postgres に永続残存**。 容量浪費 + GDPR「消去権」 観点のリスク。
- **D2**: kickoff が想定した `lib/users/delete.ts` は **存在しない**。 user 削除
  ロジックは clerk webhook route に inline。
- **D3**: R2 / S3 ストレージは **未使用**。 OCR ファイルは inline base64 で Gemini
  に渡すのみ (schema コメント「R2 非経由」 と一致)。 → R2 prefix 削除経路は不要 /
  不在。 item 5 の「R2 削除経路確認」 は「そもそも R2 を使っていない」 が結論。

---

## 1. 現状の guard 有無 trace

### 1.1 `processUpload` の guard 構成 (`app/(app)/app/upload/_actions/process.ts`)

早期 return / guard の順序:

1. `getCurrentUser` 認証 (なければ `AUTH` return)
2. formData parse (`mode` / `examId` / `files`、 不正なら `INVALID_INPUT`)
3. `pdfPageCount` で `totalPages` 算出
4. **plan-limits guard** `canRunOcr(user.id, plan, totalPages)` — 月次ページ上限超過で
   `QUOTA_EXCEEDED` return (exam / source_documents INSERT 前)
5. **GEMINI_DAILY_LIMIT guard** `getTodayAiUsageGlobal()` ≥ limit で
   `GEMINI_DAILY_LIMIT_EXCEEDED` return
6. exam 確定 (`mode='new'` は `exams` INSERT)
7. `source_documents` INSERT (`status='processing'`)
8. OCR pipeline → cards INSERT → 完了 transaction

### 1.2 並列 guard の不在

**「current user に既に `status='processing'` の `source_documents` が存在するか」
を見る check は processUpload に一切存在しない** (`grep` で `FOR UPDATE` /
`forUpdate` / `advisory` / 既存 processing 行の SELECT いずれも不在)。

plan-limits guard (4) と GEMINI_DAILY_LIMIT guard (5) は存在するが、 これらは
「月次ページ量」「サービス全体の日次 call 数」 を見るもので、 **同一 user の
同時実行ジョブ数は一切制御しない**。 → 並列起動は完全に素通り。

→ item 1 の「存在する場合の race 耐性」 は **該当なし** (guard 自体が無いため)。

---

## 2. server-side race 防止の設計選択肢 (列挙のみ)

前提: いずれの案も「check + `source_documents` INSERT」 を **短い transaction**
に収めること。 OCR 本体 (最大 600s) を lock / transaction 内に入れてはならない
(長時間 lock 保持は致命的)。 lock は check+INSERT のミリ秒だけ保持し、 commit 後に
OCR を実行する構造になる。

### 案 (a) — transaction + 行ロック (`SELECT ... FOR UPDATE`)

- **重要な落とし穴**: `source_documents` を `WHERE status='processing' FOR UPDATE`
  しても、 **processing 行が 0 件のとき lock 対象行が無く 2 transaction が同時に
  「0 件」 を見て両方 INSERT に進む** (phantom)。 「行の不在」 を guard する用途で
  `FOR UPDATE` を素朴に使うと race を防げない。
- 成立させるには **常に存在する proxy 行をロックする**: `SELECT id FROM users
  WHERE id = ? FOR UPDATE` で users 行を mutex 化 → source_documents の processing
  を SELECT → 0 件なら INSERT → COMMIT。 users 行 lock が同一 user の 2 transaction
  を直列化する。
- trade-off: migration 不要。 ただし「users 行を OCR 制御の mutex に流用する」 のは
  意味的にやや不透明 (users 行更新と競合する可能性)。 transaction を check+INSERT に
  厳密に限定する規律が要る。

### 案 (b) — partial unique index

- `CREATE UNIQUE INDEX ON source_documents (user_id) WHERE status = 'processing'`
  (drizzle: `uniqueIndex(...).on(t.userId).where(sql\`status = 'processing'\`)`)。
- 2 件目の `status='processing'` INSERT が DB 制約で弾かれ unique violation →
  processUpload が catch して「処理中」 error を返す。
- **race window ゼロ** (DB が INSERT 時点で atomic に保証)。
- trade-off:
  - **migration 要** (次番 `0006`)。 現状 `source_documents` の index は
    `source_docs_user_exam_idx` / `source_docs_status_idx` のみ、 partial unique
    なし。
  - **integration の難点**: 現状 processUpload は exam INSERT (step 6) → source_
    documents INSERT (step 7) の順。 案 (b) では source_documents INSERT で初めて
    弾かれるため、 `mode='new'` の場合 **exam INSERT は成功済 → orphan の空 exam が
    残る**。 回避には「exam INSERT と source_documents INSERT を 1 transaction 化し
    violation で両方 rollback」 か「INSERT 順を入れ替え」 か「明示 pre-check 併用」 が
    要る (現場発見)。
  - stale processing 行 (15 分 orphan、 cleanup 前) が partial index を占有し新規
    upload を弾く → item 4 の reconcile を先行させる必要 (後述)。

### 案 (c) — PostgreSQL advisory lock (`pg_try_advisory_xact_lock`)

- transaction 内で `SELECT pg_try_advisory_xact_lock(hashtext(<user_id>))`。
  取得失敗 (= 別 upload が同時進行) なら abort。 `xact` 版は transaction 終了で
  自動解放。
- trade-off:
  - migration 不要、 軽量。
  - **Neon serverless 整合**: `pg_try_advisory_xact_lock` は **transaction スコープ**
    のため pgbouncer の transaction-mode pooling と安全に共存する (session スコープ
    の `pg_advisory_lock` は pooling で危険、 xact 版なら可)。
  - `hashtext(uuid::text)` は int4 を返し衝突可能性は理論上あるが、 衝突しても
    「無関係な 2 user が稀に直列化する」 だけで correctness バグではない (minor)。
  - raw SQL (`sql\`...\``) が要る。

### 全案共通の論点

- **既存 guard との順序**: 案 (a)/(c) は明示 check なので exam INSERT (step 6) より
  **前** に置ける → 弾かれた並列起動で orphan exam を作らない。 案 (b) は弾きが
  source_documents INSERT 時点 = exam INSERT より後 → 上記 orphan exam 問題。
- plan-limits / GEMINI_DAILY_LIMIT guard との前後: 並列 guard を最前段に置けば
  「並列起動は最安の check で fail-fast」。 後段に置く判断もありうる (列挙のみ)。
- どの案も「processing 行の判定」 が stale orphan を含むか否かで挙動が変わる →
  item 4 と密結合。

---

## 3. UI-side guard 設計

### 3.1 `/app/upload` の現状 (`app/(app)/app/upload/page.tsx`)

**既に Server Component**。 `getCurrentUser` → `Promise.all([getActiveExamsForUser,
getCurrentMonthOcrPages])` を取得し `<UploadForm>` に props で渡す。 → item 3 が
懸念した「Server Component 化」 は **不要**、 既に SC。 fetch を 1 本足して条件分岐
する形になる。

### 3.2 UI guard の構成 (設計選択肢)

render 時に「current user に processing の source_documents があるか」 を判定し、
あれば `<UploadForm>` の代わりに「処理中のため完了までお待ちください」 案内 +
試験一覧への link を出す。 status 取得経路の選択肢:

- **案 U1 — 既存 `getExamStatusMap` を流用**: `lib/exams/source-doc-status.ts` の
  `getExamStatusMap(userId)` は `Map<examId, 'processing'|'failed'>` を返す。
  `[...map.values()].includes('processing')` で判定可能。
  - 長所: 既存関数の再利用、 `deriveExamStatuses` が **15 分超 processing を
    'failed' 扱い** にする derivation を内包するため、 stale orphan で誤発火しない。
  - 短所: 当該 user の `source_documents` 全件を fetch + exam 単位集計する。
    「processing が 1 件でもあるか」 だけ知りたい用途には重い。
- **案 U2 — 専用軽量 query 新設**: `hasProcessingUpload(userId)` のような
  `SELECT 1 FROM source_documents WHERE user_id=? AND status='processing'
  [AND created_at >= now()-15min] LIMIT 1` を新設。
  - 長所: 最小コスト。 `source_docs_status_idx (user_id, status)` 直撃。
  - 短所: 15 分 fallback を query に明示的に書く必要 (U1 は derivation 内包)。
- UI guard は **防御の第一層 (advisory)** に過ぎない点に注意。 既に 2 タブ開いて
  いる user は古いタブの form から submit できる → 実効的な enforcement は §2 の
  server guard が担う。

---

## 4. 15 分越え cleanup との race

### 4.1 現状の `reconcileStaleProcessing` 呼び出し経路

S1.9.3 で `lib/exams/source-doc-status.ts` に実装。 **現状の呼び出し元は
`app/(app)/app/exams/page.tsx` (試験一覧 render) のみ**。 `/app/upload` page でも
`processUpload` でも呼ばれていない。

### 4.2 guard 誤発火のリスク

§2 / §3 の guard が「processing 行の存在」 で判定する以上、 **前回 OCR の死骸
(Vercel kill / markFailed UPDATE 失敗で 15 分以上 'processing' のまま残った行)
が cleanup 前に残っていると、 新規 upload を誤って弾く**。 ユーザーは試験一覧を
踏むまで永久に upload 不能になりうる。

### 4.3 reconcile 先行実行の設計選択肢

- `/app/upload` page render の冒頭で `reconcileStaleProcessing(user.id)` を
  await してから UI guard の status を fetch する (試験一覧 page と同じ pattern)。
- `processUpload` 冒頭 (server guard の前) で `reconcileStaleProcessing(user.id)` を
  await する。
- 両方 (UI と server の二重防御)。
- 加えて、 guard の「processing 判定 query」 自体に `created_at >= now()-15min` を
  付け、 **reconcile が best-effort で失敗しても stale 行で誤発火しない** ように
  する案 (deriveExamStatuses の C4 fallback と同じ思想)。

### 4.4 reconcile 二重実行の安全性

`reconcileStaleProcessing` は **best-effort + idempotent**: UPDATE は
`WHERE status='processing' AND created_at < threshold` で gate され、 2 回目は
0 行 UPDATE → `RETURNING` 空 → `upload_records` への failed 行 append もスキップ。
→ 試験一覧 page と /app/upload page のどちらを先に踏んでも、 また両方が並走しても
**二重 append は起きない** (S1.9.3 review で確認済の idempotency)。 reconcile は
古い行 (>15 分) しか触らず、 並列 guard が見る新鮮な processing 行 (<15 分) とは
対象が排他なので、 reconcile と guard の間の race も発生しない。

---

## 5. schema cascade 網羅確認

### 5.1 `users.id` を FK 参照する全 table の `onDelete` (`lib/db/schema.ts`)

| table | user_id FK | onDelete |
|---|---|---|
| `reviews` | `references(() => users.id)` | `cascade` |
| `ai_usage_users` | 〃 | `cascade` |
| `exams` | 〃 | `cascade` |
| `cards` | 〃 | `cascade` |
| `source_documents` | 〃 | `cascade` |
| `upload_records` | 〃 | `cascade` |
| `study_days` | 〃 | `cascade` |
| `contact_messages` | 〃 (nullable) | `cascade` |
| `deletion_failures` | `user_id uuid` だが **FK 制約なし** | — (audit table、 意図的) |
| `ai_usage` / `stripe_events` / `clerk_events` | user_id 列なし | — |

→ **user_id FK の onDelete 定義に漏れは無い**。 全て `cascade`。 `'set null'` は
`cards.source_document_id` (source_documents → cards) のみで、 これは user_id FK
ではない (OCR 元削除でも抽出 card を残す設計)。

### 5.2 致命的発見 D1 — cascade が起動しない

FK 定義は完璧だが、 **cascade を発火させる `DELETE FROM users` が codebase に
存在しない**:

- Clerk `user.deleted` webhook (`app/api/webhooks/clerk/route.ts` の
  `handleUserDeleted`) は `UPDATE users SET deleted_at = now()` の **soft delete
  のみ** + Stripe subscription cancel。
- 在アプリのアカウント削除 (`settings/delete-button.tsx`) は Clerk `user.delete()`
  を呼ぶ → Clerk が `user.deleted` webhook を発火 → 上記 handler に合流 →
  結局 soft delete のみ。
- `grep "delete(users)" / "DELETE FROM users"` → **0 件**。 soft-deleted user を
  後で物理削除する cron / 定期ジョブも無い (Vercel cron 未設定、 S1.9.3 で確認済)。

→ アカウント削除後、 `users` 行は `deleted_at` が立つだけで残り、 **その user の
exams / cards / source_documents / upload_records / reviews / study_days /
ai_usage_users / contact_messages は cascade されず Postgres に永続残存**。

schema コメントは「他 table は hard delete」「全 user_id FK は cascade」 と書くが、
これは **「users を hard delete すれば cascade する」 という設計意図** の記述で
あり、 現状の削除経路は users を hard delete しないため意図が **dormant (休眠)**。

### 5.3 影響

- **容量**: 削除済 user の OCR 抽出データ (cards の question_text 等) が無期限に残る。
- **GDPR / 個人情報保護**: 「消去権」 観点で、 アカウント削除依頼後も個人の学習
  コンテンツ (アップロードした試験問題由来の MCQ) が DB に残存。 schema コメントが
  `contact_messages` に「個人情報削除依頼対応のため hard delete」 と書くが、 その
  hard delete も users の hard delete 経由でしか起きないため同様に dormant。
- soft delete 採用理由 (schema コメント「Stripe / audit retention」) は users 行
  自体には妥当だが、 **子テーブルまで永続保持される副作用** は設計意図と乖離して
  いる可能性 (要 OT 判断)。

### 5.4 R2 / ストレージ削除経路 (D3)

- `grep "R2|S3|aws-sdk|@aws|S3Client|presigned|cloudflare"` → ストレージ実装は
  **0 件** (唯一の hit は `ensure-user.ts` のコメント "R2 webhook-only sync" =
  設計ラウンド名であり Cloudflare R2 ではない)。
- OCR ファイルは `processUpload` で inline base64 化し Gemini に渡すのみ、
  永続化しない (schema コメント「アップロードファイル自体は inline base64 で
  Gemini に渡すのみで永続化しない (R2 非経由)」 と一致)。
- → **R2 / 外部ストレージは未使用**。 「R2 prefix 削除経路」 は存在せず、 不要。
  user 削除時に消すべき外部オブジェクトは現状ない。

---

## 6. 未解決 / 要 OT 確認事項

| ID | 事項 | 区分 |
|---|---|---|
| §2 | server guard を (a) users 行 FOR UPDATE / (b) partial unique index / (c) advisory xact lock のどれにするか | 設計判断 |
| §2 | 案 (b) 採用時の「orphan 空 exam」 回避 (exam+source_doc を 1 transaction 化 等) | 設計判断 |
| §2 | 並列 guard を plan-limits / daily-limit guard の前段に置くか | 設計判断 |
| §3 | UI guard の status 取得を U1 (getExamStatusMap 流用) / U2 (専用軽量 query) のどちらにするか | 設計判断 |
| §4 | reconcileStaleProcessing を /app/upload page / processUpload / 両方 のどこで先行実行するか | 設計判断 |
| **D1** | **soft delete のみで cascade が dormant。 user hard delete (cascade 起動) を実装するか、 retention 後 purge を入れるか。 GDPR 観点で要対応か** | **要 OT 判断・S1.9.4 scope 外の可能性** |

D1 は本 sprint (並列 guard) のスコープと独立した別問題だが、 schema cascade 調査の
相乗りで判明したため記録する。 対応要否・優先度・別 sprint 化は OT 判断。

以上。 各案の selection・修正方針は claude.ai + OT が後段で決定する。
