# Sprint A-2 計画ドラフト: vocab drop + mcq 新規テーブル migration

> status: **DRAFT — OT 判断待ち**。§3 冒頭の [要確認 #1] (greenfield vs incremental)
> を OT が決めるまで実装着手不可。
> 作成: 2026-05-13 / Phase: Sprint A-2 (DB migration)

## 0. 調査で読んだファイル (透明性)

- `lib/db/schema.ts` (現行 Drizzle schema, source of truth)
- `lib/db/index.ts` (Drizzle client singleton)
- `drizzle/migrations/0000_flawless_squadron_supreme.sql` + `meta/_journal.json`
- `drizzle.config.ts` / `package.json` (db:generate / db:migrate / db:studio)
- `docs/02-tech-spec.md` §2 全体 (2.1-2.10 該当部) / §13.1 / §13.2 / §13.7 / §13.23 / §13.24 / §14 見出し
- `docs/superpowers/lessons/2026-04-30-users-schema-decoupling.md`
- `.env.example`
- 実 DB introspect (node + @neondatabase/serverless で `pg_tables` / `pg_class.relrowsecurity` / `pg_policies` / row count)
- grep: `contact_messages` / `pgPolicy|enableRLS|ROW LEVEL` / `SET LOCAL|app.current_user|set_config` (全 repo)

---

## 1. 現状 schema baseline

### 1.1 重大発見: 実 DB は空

`DATABASE_URL` (Sprint A-1a 更新済 `.env.local`) の実 DB を introspect した結果:

- **public スキーマのテーブル 0 件**。`words` / `reviews` も `relation does not exist`。
- migration 0000 は**未適用**。CLAUDE.md「Sprint A 着手前」と整合 — mcq-platform 用に
  新規プロビジョンされた空の Neon DB。

→ plan00 由来テーブルを実 DB から「drop する」対象は**物理的に存在しない**。
migration history (`drizzle/migrations/0000...`) だけが plan00 schema を記述している。
これが §3 の実装方針を分岐させる ([要確認 #1])。

### 1.2 migration history / schema.ts 上の baseline (9 テーブル)

`0000_flawless_squadron_supreme.sql` と `schema.ts` は完全一致。§2.2 と照合:

| テーブル | §2.2 区分 | 付随 index / PK |
| --- | --- | --- |
| `users` | 流用 (変更なし) | PK=id uuid, UNIQUE(clerk_id), UNIQUE(stripe_customer_id) |
| `ai_usage` | 流用 (変更なし) | PK=date |
| `ai_usage_users` | 流用 (変更なし) | **複合 PK (user_id, date)**, FK→users.id |
| `clerk_events` | 流用 (変更なし) | PK=event_id |
| `stripe_events` | 流用 (変更なし) | PK=event_id |
| `deletion_failures` | 流用 (変更なし) | PK=id, FK なし (audit table) |
| `reviews` | 流用 (**word_id → card_id**) | PK=id, FK→users.id + FK→words.id, idx `reviews_user_reviewed_idx` |
| `words` | **drop** | PK=id, FK→users.id, idx `words_user_due_idx` (user_id, deleted_at, due) |
| `ai_examples` | **drop** | PK=id, FK→users.id + FK→words.id, idx `ai_examples_word_created_idx` |

新規追加 (§2.5): `exams` / `cards` / `source_documents` / `study_days` — schema.ts に未定義。

### 1.3 想定外 [要確認]

- **[要確認 #1]**: 実 DB 空 (§1.1)。§3 で詳述。
- **[要確認 #2]**: `contact_messages` が repo に**完全不在** — migration / schema.ts / コード
  すべてに 0 hit。§13.1 は「memory に I-J 完了」を根拠に存在可能性を示唆していたが、
  本 repo (devcontainer-template 由来) には移植されていない。§2 で詳述。
- **[要確認 #3]**: RLS が**完全不在** — `pgPolicy` 定義 0 / migration の RLS 文 0 /
  `current_setting` 使用 0 / `SET LOCAL app.current_user_id` 0。`lib/db/index.ts` は
  per-request user context を注入しない素の singleton。§2.7 の「Drizzle ミドルウェアで
  自動化（plan00 既存実装を流用）」は**本 repo に該当実装が存在しない**。§2 で詳述。

---

## 2. Open Question への回答

### 2.1 §13.1 — contact_messages テーブルの有無

**不存在 (確定)**。repo 全 grep で 0 hit。§13.1 の判定フロー「不存在 → 仮構造で新設」に従う。

- §2.3.7 の仮構造 (id / user_id nullable FK / email / category / subject / body /
  status / created_at) で新設する migration 案は §3 に含められる。
- **[要確認 #2a]**: ただし contact form 機能自体が **Sprint A-2 スコープか**は不明。
  本タスク指示は「vocab drop + mcq 新規 4 テーブル」とのみ。contact_messages を
  Sprint A-2 に含めるか、contact form 実装 Sprint まで遅延するかは OT 判断。
  → デフォルトは「§3 では一旦スコープ外、新設するなら option として併記」。

### 2.2 §13.2 — vocab 関連 drop 対象の完全リスト

**`words` と `ai_examples` の 2 つのみ (確定)**。9 テーブル全件 introspect 済、他に
vocab 専用テーブルなし。付随する補助 schema:

- `words_user_due_idx` (user_id, deleted_at, due) — words に付随、words drop で消滅
- `ai_examples_word_created_idx` (word_id, created_at) — ai_examples に付随、同上
- FK: `words_user_id_users_id_fk` / `ai_examples_user_id_users_id_fk` /
  `ai_examples_word_id_words_id_fk` / `reviews_word_id_words_id_fk`
- `ai_usage_users` の複合 PK は **vocab 無関係**、流用テーブルとして保持
  (lessons/2026-04-30 §3 で言及される複合 PK 再 create はこの PK のことだが、
  今回は触らない)

### 2.3 §13.7 — 流用テーブルの RLS 設定

**全 7 テーブル RLS 未設定 (確定)**。

| 流用テーブル | RLS enabled | policy |
| --- | --- | --- |
| users / ai_usage / ai_usage_users / clerk_events / stripe_events / deletion_failures / reviews | すべて **未設定** | **なし** |

`pg_class.relrowsecurity` も実 DB 上 false (そもそもテーブル不在)。

**[要確認 #3]**: §2.7 は新規 4 テーブルに RLS を ENABLE + policy を貼る前提だが、
適用には `SET LOCAL app.current_user_id` を実行する DB middleware が必要。
これが repo に存在しない。提言:

- **選択肢 A**: Sprint A-2 で新規 4 テーブル + 流用 7 テーブルに RLS policy 追加 +
  `lib/db/index.ts` に per-request user context 注入 middleware を**新規実装**
- **選択肢 B**: RLS は Sprint A-2 スコープ外。アプリ層 `WHERE user_id = ?` 認可で
  対応 (CLAUDE.md「全テーブル user_id 必須、クエリは WHERE user_id」と整合)。
  RLS + middleware は後続 Sprint で別途
- 個人開発 / real user 0 段階では選択肢 B が時間コスト的に妥当
  (lessons/2026-04-30 学び 6)。**OT 判断必要**。

---

## 3. migration 実装プラン

### [要確認 #1] greenfield か incremental か — 実装着手前に OT 判断必須

実 DB が空 (§1.1) のため、本タスク指示 §3 が前提していた「reviews rename → cards 作成 →
FK 付け替え → words drop → …」という incremental 手順は、適用先テーブルが存在せず
**そのままでは破綻する** (空 DB に ALTER をかけられない)。2 案:

- **Approach A (greenfield 再生成 / 推奨)**: `schema.ts` を mcq-platform 最終形に書き換え、
  旧 migration 0000 + meta を破棄、`drizzle-kit generate` で新 0000 を再生成。
  全テーブルが `CREATE TABLE` のみ。reviews rename / words drop / FK 付け替え /
  一時列方式はすべて**不要**。手書き SQL は RLS 採用時のみ。
- **Approach B (history 継続)**: 0000 保持 + 0001 で ALTER/DROP/rename。だが実 DB が
  空なので「0000 を流して plan00 schema を作る → 即 0001 で mcq schema に migrate」
  という無意味な往復になる。migration history を残す価値は、その history を適用済の
  DB が存在して初めて生じる — 本件には存在しない。

**推奨 = Approach A**。根拠: 実 DB 空 + real user 0 + 適用済 DB なし →
history 断絶のデメリットが存在しない。lessons/2026-04-30 学び 6 (real user 0 では
教科書的慎重さは時間コスト超過)。以降 §3.1-3.3 は Approach A 前提。Approach B を
選ぶ場合の差分は §3.4。

### 3.1 (Approach A) migration ファイル構成

- **1 ファイルで十分**。空 DB への新規 CREATE なので「無風段階 + atomic 段階」分割
  (lessons/2026-04-30 学び 3) は不要 — 機能停止窓の概念がない。
- 旧 `0000_flawless_squadron_supreme.sql` + `meta/_journal.json` +
  `meta/0000_snapshot.json` を削除 → `pnpm db:generate` で新 0000 を再生成。

### 3.2 (Approach A) schema.ts 最終形の構成

`schema.ts` を以下 11 テーブル (contact_messages 含むなら 12) に書き換える。
**実装コードは Generator が TDD で書く** — ここでは構成と制約のみ:

- **流用・変更なし (6)**: `users` / `ai_usage` / `ai_usage_users` / `clerk_events` /
  `stripe_events` / `deletion_failures` — schema.ts 既存定義をそのまま維持
- **流用・改変 (1)**: `reviews` — `word_id` を `card_id` (uuid) として定義、
  FK 先を `cards.id`、index `reviews_user_reviewed_idx` 保持 + `reviews_card_idx`
  (card_id, reviewed_at) 追加
- **新規 (4)**: `exams` / `cards` / `source_documents` / `study_days` — §2.5 の
  TypeScript 定義に従う。FSRS カラム命名は plan00 踏襲 (`state` integer /
  `difficulty` real / `last_review` 等、リネーム禁止 §2.1-11)
- **(option) contact_messages**: [要確認 #2a] が「含む」なら §2.3.7 仮構造で追加

制約 (CLAUDE.md / §2.1):

- timestamp は `timestamp with time zone` 統一、date 型は `mode: 'string'`
- 新規 4 テーブルは `user_id` 必須 + `users.id` 参照
- soft delete: exams / cards に `deleted_at` (source_documents / study_days は持たない)
- jsonb default は `sql\`'[]'::jsonb\`` / `sql\`'{}'::jsonb\``

### 3.3 (Approach A) FK / index / 手書き SQL

- **FK onDelete**: 新規テーブルは §2.5 指定通り (`exams`→users cascade /
  `cards`→users cascade・→exams cascade・→source_documents set null /
  `source_documents`→users/exams cascade / `study_days`→users cascade)。
  **[要確認 #4]**: `reviews.card_id` の FK を §2.3.4 は `ON DELETE CASCADE` と明示。
  だが現行 schema.ts 冒頭コメントは「all FKs use NO ACTION」。spec 優先で CASCADE と
  するなら、schema.ts のそのコメントも更新が必要 — OT 確認。
- **複合 PK**: `study_days` (user_id, day) 新規。`ai_usage_users` は据え置き。
- **index**: §2.8 の全 index を schema.ts に定義 → drizzle-kit が `CREATE INDEX` を生成。
  GIN index `cards_props_gin_idx` は drizzle の `index().using('gin', ...)` で表現
  (生成 SQL は要確認、context7 で drizzle-kit GIN サポートを確認してから着手)。
- **手書き SQL が必要な部分**: RLS ([要確認 #3] が選択肢 A の場合のみ)。
  drizzle-orm の `pgPolicy` / `pgTable(...).enableRLS()` が migration 出力に
  反映されるかは context7 で要確認。出ないなら生成後の SQL に手書き追記。
- **DOWN migration**: drizzle-kit は down を生成しない。空 DB greenfield なので
  rollback = 全テーブル DROP もしくは Neon branch 破棄で足りる。専用 down 不要。

### 3.4 (Approach B を選ぶ場合の差分)

OT が history 継続を選んだ場合の順序 (本タスク指示 §3 準拠):

1. 0000 を実 DB に適用 (plan00 schema を一旦作る)
2. 0001 で: `reviews.word_id` → `card_id` **rename** (型は uuid のまま、
   lessons の一時列方式は型変更用 — 今回は不要、単純 rename + FK drop/recreate)
3. `cards` 作成 (reviews の新 FK 先)
4. `reviews` の FK を `words.id` → `cards.id` に付け替え (drop + recreate)
5. `words` drop CASCADE → `ai_examples` drop CASCADE
6. `exams` / `source_documents` / `study_days` 作成
7. RLS policy 追加 ([要確認 #3])
- 一時列方式 (lessons/2026-04-30 学び 2) は型変更がないため**不要**。
- composite PK 再 create も不要 (`ai_usage_users` PK は無関係、`words` の index は
  CASCADE で消える)。

---

## 4. 想定リスクと対処

- **実 DB 空での適用**: Approach A はリスクほぼゼロ (新規 CREATE のみ、cast 失敗 /
  orphan / 停止窓なし)。唯一のリスクは migration history 破棄 → [要確認 #1] と紐づく。
- **drizzle-kit の落とし穴**:
  - `$type<>()` / `$onUpdate` は SQL に出ない (app-level、既存 users で確認済) — 想定内
  - jsonb default の `sql\`...\`` は drizzle-kit が生成可
  - GIN index / `pgPolicy` の生成可否は **context7 で要確認** (§3.3)
  - Approach B の一時列方式・複合 PK 再 create は本件では発生しない
- **reviews が空でない場合の rename 戦略**: 実 DB の reviews は 0 行 (テーブル不在)。
  Approach A では rename 概念自体が消える。Approach B でも rename は row 数非依存で安全。
- **schema.ts コメントとの矛盾**: [要確認 #4] (reviews FK cascade vs NO ACTION)。

---

## 5. 検証方法

lessons/2026-04-30 学び 7 (構造 + データ 両軸の検証 SQL を spec に組み込む) に準拠:

- **構造確認**: `psql` で `\dt` (全テーブル列挙、期待 11 or 12) / `\d cards` 等で
  列・型・FK・index を確認。`information_schema.columns` で `reviews.card_id` が
  uuid であること、`information_schema.table_constraints` で FK 先が `cards` であること。
- **drizzle 整合**: migration 適用後に `pnpm db:generate` を再実行し **diff 0**
  (schema.ts と migration が一致) を確認。
- **RLS 動作確認** ([要確認 #3] 選択肢 A の場合): `SET app.current_user_id` を
  user X に設定 → user Y の行が SELECT で見えないことを確認。
- **smoke test (新規テーブル CRUD + cascade)**:
  - exams / cards / source_documents / study_days の INSERT / SELECT / soft-delete
  - cascade: exam 削除 → 紐づく cards 消滅 / card 削除 → 紐づく reviews 消滅
    ([要確認 #4] 次第) / user 削除 → 全関連行消滅
  - `source_document` 削除 → cards.source_document_id が NULL になる (set null)
- AI API は叩かない (本 Sprint は schema のみ、該当なし)。

---

## OT 判断が必要な論点 (実装着手前)

- **[要確認 #1]** migration 方式: Approach A (greenfield 再生成) / B (history 継続)。推奨 A
- **[要確認 #2 / #2a]** contact_messages を Sprint A-2 で新設するか / 後続 Sprint に回すか
- **[要確認 #3]** RLS: 選択肢 A (Sprint A-2 で RLS + middleware 新規実装) /
  B (アプリ層認可、RLS は後続)。推奨 B (real user 0 段階)
- **[要確認 #4]** `reviews.card_id` FK を CASCADE にするか (spec §2.3.4) /
  NO ACTION 維持か (schema.ts 既定コメント)。CASCADE 採用なら schema.ts コメント更新も
