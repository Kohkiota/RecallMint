# Users schema を auth provider から decouple した sprint の知見

> **Source**: plan00 Phase 1 F (F-1 〜 F-5、users schema 二段構造化)。Next.js + Drizzle +
> Clerk + Postgres (Neon) の SaaS template 化前提で得た知見。後続の SaaS template
> repo に転記して再利用する想定。

## 1. 背景

plan00 は MVP 着手時、`users.clerk_id text PRIMARY KEY` を採用し、全 FK table
(`words` / `reviews` / `ai_examples` / `ai_usage_users`) が `clerk_id` を text 型で
直接参照していた。この設計は実装速度では正しかったが、**template 化 (auth provider
を Clerk から WorkOS / Auth0 / Supabase Auth 等に差し替え可能にする)** を進める段階
で以下の問題を抱えた:

- auth provider を差し替えると **全 FK table の column 型・index・migration を全部
  書き換える必要があり**、template 利用者の改修コストが線形に膨らむ
- `clerk_id` が「内部 user 識別子」と「Clerk side user 参照」の 2 役を兼ねており、
  layer 分離されていない
- multi-provider 対応 (Apple Sign In / 独自 SSO の追加) の余地がない

Phase 1 F sprint で `users.id uuid PRIMARY KEY` (内部 identity) + `users.clerk_id
UNIQUE NOT NULL` (Clerk connector) の二段構造に再構築。FK 4 table すべてを
`users.id` 参照に切替、application code を user.id ベースに書換、deletion_failures
audit table を Option A (uuid + clerk_id 両保持) で更新。real user 32 名が稼働する
production を維持したまま、5 step (F-1 spec / F-2 schema 拡張 / F-3-4 FK 切替 /
F-5 webhook 整合 / F-6 deploy verify) で完遂した。

本 lesson は同 sprint で得た 7 つの学びを記録する。

---

## 2. 学び 1: PG の FK 依存先 constraint は自動 switch しない

F-1 amend で「新しい UNIQUE 制約を旧 PK と同じ列に追加すれば、既存 FK が新 UNIQUE
制約に依存先を引き継いでくれる」と誤判断した。実機 probe で発覚した PG の実挙動:

```sql
-- 期待していた DDL (動かない)
ALTER TABLE users ADD COLUMN id uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_clerk_id_unique UNIQUE (clerk_id);
ALTER TABLE users DROP CONSTRAINT users_pkey;  -- ← ここで失敗
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
```

3 行目で:

```
cannot drop constraint users_pkey on table users because other objects depend on it
```

PG は **FK が参照している constraint (= `users_pkey`) を drop できない**。新しく
UNIQUE 制約を同列に張っても、既存 FK の依存先 constraint は自動的に switch しない。

正解は FK を一旦 drop → PK swap → 同名・同振る舞いで再 create する 12 statement の
migration:

```sql
ALTER TABLE users ADD COLUMN id uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_clerk_id_unique UNIQUE (clerk_id);
-- FK 4 件を一旦 drop
ALTER TABLE words DROP CONSTRAINT words_user_id_users_clerk_id_fk;
ALTER TABLE reviews DROP CONSTRAINT reviews_user_id_users_clerk_id_fk;
-- ... 他 2 table も同様
ALTER TABLE users DROP CONSTRAINT users_pkey;
ALTER TABLE users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
-- FK を同名・同振る舞いで再 create (内部 dependency が users_clerk_id_unique に switch)
ALTER TABLE words ADD CONSTRAINT words_user_id_users_clerk_id_fk
  FOREIGN KEY (user_id) REFERENCES users(clerk_id) ON DELETE NO ACTION ON UPDATE NO ACTION;
-- ... 他 3 table も同様
```

drizzle-kit migrate は暗黙 transaction で全 statement を実行するため、外部から
「FK 不在状態」の窓は不可視 (atomic)。外部から見える FK は制約名・参照先 column・
on action 完全保持、内部 catalog dependency のみ switch する。

### 教訓

- **schema migration の DDL 順序は実機 probe で検証する**。documentation の理解
  だけでは PG の catalog dependency を読み切れない。dev DB で同 SQL を transaction
  内 + ROLLBACK で probe → 動作確認後に migration ファイル化する手順を組み込む。
- 「論理的に動くはず」を信じて production migration を流すと、FK 制約名再利用 +
  data loss + rollback path 喪失の 3 重障害を起こす可能性がある。

---

## 3. 学び 2: 一時列方式 backfill pattern

F-3 で 4 FK table の `user_id` を `text` → `uuid` に変更し、参照先を
`users.clerk_id` → `users.id` に切替た。直接 `ALTER COLUMN ... SET DATA TYPE uuid`
は **既存 row の Clerk userId text (`user_xxx...`) を uuid format に cast 不可**で
失敗するため、一時列方式で段階移行した。

```sql
-- 1. 一時列追加 (4 table 各々)
ALTER TABLE words ADD COLUMN user_id_uuid uuid;
-- 2. backfill: clerk_id → users.id lookup
UPDATE words SET user_id_uuid = u.id FROM users u WHERE u.clerk_id = words.user_id;
-- 3. NOT NULL 化 (orphan があればここで failover)
ALTER TABLE words ALTER COLUMN user_id_uuid SET NOT NULL;
-- 4. 旧 FK drop
ALTER TABLE words DROP CONSTRAINT words_user_id_users_clerk_id_fk;
-- 5. 旧列に依存する補助 schema を drop (composite PK / index)
DROP INDEX IF EXISTS words_user_due_idx;
ALTER TABLE ai_usage_users DROP CONSTRAINT ai_usage_users_user_id_date_pk;
-- 6. 旧 user_id 列 drop
ALTER TABLE words DROP COLUMN user_id;
-- 7. user_id_uuid → user_id rename
ALTER TABLE words RENAME COLUMN user_id_uuid TO user_id;
-- 8. 新 FK create (users.id 参照)
ALTER TABLE words ADD CONSTRAINT words_user_id_users_id_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION ON UPDATE NO ACTION;
-- 9. ai_usage_users 複合 PK 再 create
ALTER TABLE ai_usage_users ADD CONSTRAINT ai_usage_users_user_id_date_pk PRIMARY KEY (user_id, date);
-- 10. words index 再 create
CREATE INDEX words_user_due_idx ON words USING btree (user_id, deleted_at, due);
```

特殊扱い:
- **ai_usage_users 複合 PK** は `user_id` 列に依存しているため、列 drop の前に PK
  drop / 列変更後に PK 再 create が必要 (drizzle auto-generate は出さないので手書き)
- **words の compound index `(user_id, deleted_at, due)`** も同様に旧列依存、
  drop / 再 create が必要
- **deletion_failures は対象外**: FK 制約なし audit table、F-5 で別途 Option A 適用

step 3 (NOT NULL) が **orphan 検出を兼ねる**: もし backfill で残った NULL row が
あれば NOT NULL 制約違反で migration 全体が rollback。FK で防ぐ前に orphan を弾く
構造的 safeguard。

### 教訓

- **列型変更は cast 失敗時の rollback path を確保するため一時列方式が安全**。
  `ALTER COLUMN ... SET DATA TYPE` 直接式は cast 失敗 + 既存 data 損失のリスクが高い。
- 一時列方式は drizzle-kit auto-generate しない (`ALTER COLUMN ... USING ...` を
  出すだけ)。**生成 SQL は破棄し、手書きで再構築する**。
- 補助 schema (composite PK / index) が旧列に依存していれば、列 drop の前後で
  drop / 再 create が必要。drizzle-kit はこれも出さない。

---

## 4. 学び 3: 互換性保持型 migration の段階分け

F sprint 全体を「F-2 (無風段階) + F-3-4 (atomic 段階)」の 2 つに分割した:

- **F-2 (無風段階)**: users に id (UUID) を生やすだけ。`clerk_id` は UNIQUE NOT NULL
  に降格するが application code は無変更で動き続ける。production を止めずに schema
  拡張だけする「無風 migration」。
- **F-3 + F-4 (atomic 段階)**: 4 FK table の user_id を uuid 化 + application code
  を user.id ベースに書換。schema と code が同時に切り替わる必要があるため、
  **同一 PR / 同一 deploy unit** で出して機能停止窓を最小化 (5-30 秒)。

F-2 で users に id を先に生やしておくことで、F-3 の backfill (clerk_id → id lookup)
が実現可能になる。**無風段階で「lookup の足場」を先に作る**ことが鍵。

### 教訓

- **大規模 schema 変更は「無風段階」と「atomic 段階」に分けると risk 分散できる**。
  無風段階で問題が起きれば即 rollback / 再開、production への影響は最小。
- 無風段階の作業: 新 column 追加 / index 追加 / backfill source 整備。既存 code が
  読まない要素のみを足す。
- atomic 段階で初めて「既存 column を drop」「FK 参照先を変える」「code が新 column
  を読み始める」など破壊的変更を一括で実行。同一 deploy unit で schema + code を
  揃える。

---

## 5. 学び 4: deletion_failures Option A (uuid + clerk_id 両持ち) audit table 設計

F-5 で deletion_failures (Stripe sub cancel 失敗の audit table、FK 制約なし) を
**Option A (user_id を uuid 化 + clerk_id text 列を新設、両保持)** に切り替えた。
代替案として Option B (text のまま + uuid を別列追加) / Option C (text のまま無変更)
があったが、Option A を採用した理由:

- **internal user_id (uuid)**: template 一貫性。F-3 で他 FK table と同じ user.id
  軸で grouping 可能、auth provider 抽象としては UUID 中心が一貫。
- **clerk_id (text)**: audit context 維持。Clerk Dashboard で grep する従来運用、
  users 行が削除済 (deleted_at set) でも Clerk 側 user 識別子で照合可能。
- **両方持つ**: 内部処理は uuid 軸で扱い、人間が log を読むときは clerk_id で追える。

FK 制約はあえて張らない: users 未同期エッジケース (user.created webhook 未到達 +
user.deleted 受信の順序逆転) でも audit table への書き込みは可能であるべき。
ただし F-5 fix-up で「users 未同期 → uuid 不在 → audit 不可」path だけは silent skip
させず notifyOps で観測性確保 (学び 5 参照)。

### 教訓

- **audit table は「内部整合性 (template 軸)」と「外部 grep 用途 (運用軸)」両方を
  要求する**。どちらか片方だけでは template 利用者 / OT 運用のいずれかが困る。
- **両方の値を別 column に持たせる**のが template 一貫性最高。column 増加は冗長だ
  が、semantic が明確になり template 利用者が読み解きやすい。
- FK 制約なし audit table の意義 = 障害観測のラストリゾート。FK 違反で audit に
  書けない設計は「障害を観測する目的」と矛盾する。

---

## 6. 学び 5: silent skip vs notifyOps 観測性原則

F-5 fix-up で Clerk webhook の `user.deleted` ハンドラに以下を追加した:

```typescript
if (!internalUserId) {
  // users 未同期 (user.created 未到達 + user.deleted 受信の順序逆転)
  await notifyOps('user.deleted received but users row not synced', {
    clerkUserId: userId,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown',
    timestamp: new Date().toISOString(),
  })
  return
}
```

当初の F-5 part 2 では `if (!internalUserId || !customerId) return` の合算 early
return path で **silent skip** していた。code-reviewer が指摘:

> users 未同期 + user.deleted webhook 受信のケースは silent skip になる。これは
> spec §6.2 Option A 採用時に「Clerk userId だけは clerk_id 列に書ける状態」になっ
> ており、audit 余地がある。silent skip は audit table の存在意義に反する (削除
> 失敗を観測する目的)。

修正方針:
- `!internalUserId` (users 未同期) と `!customerId` (Free プラン削除等) を別 branch に分離
- `!internalUserId` のみ notifyOps で OT 通知
- `!customerId` は元通り silent return (通常 path、通知不要)

既存 helper (notifyOps) を活用するだけで Discord 通知が走り、Clerk webhook 配送
順序の異常を OT が検知できるようになる。

### 教訓

- **観測性ゼロの skip は設計矛盾**。audit table を「障害観測」目的で設置している
  のに skip path で観測しないのは目的と矛盾する。
- **edge case こそ通知すべき**。正常 path はいくら通知しても情報量がないが、edge
  case は 1 回の発生で根本問題を示唆する。
- 既存 notification helper (notifyOps / Sentry / Datadog) を流用すれば 1 行追加で
  済む。silent skip は「将来増えれば直す」と先送りすると、increment ごとに観測性が
  劣化する。**最初から通知する方が運用コスト低い**。

---

## 7. 学び 6: real user 0 個人開発の判断軸

F sprint 中、いくつかの「慎重さ」を **状況依存で省略** した:

- **F-2**: Neon Branch dry-run を実施 (慣れの意味も含めて、初回の break 検証)
- **F-3 + F-4**: dry-run skip 判断 (real user 0、dev DB のみで検証 → 即 production 適用)
- **F-3 + F-4**: 機能停止窓 5-30 秒許容 (深夜帯実施不要、real user が触れていない
  時間帯に limited)

real user (= production で日常的に登録 + 使う user) が 0 名の状況では、過剰な慎重さ
は時間コストに直結する。逆に real user が 100+ 名いる状況で同じ判断をしたら破綻する。

### 教訓

- **慎重さは状況依存**。「production = 必ず慎重」ではなく、「real user 規模 / 使用
  頻度 / 機能停止許容度」で慎重度を調整する。
- **real user 0 = 個人開発 / template 検証段階** では、Neon Branch dry-run / 深夜
  帯実施 / 段階 deploy などの「教科書的慎重さ」は時間コスト > 価値になりがち。
- ただし「real user 0」を判断軸に使うのは migration / deploy までで、**コード品質
  / 型安全 / test coverage / spec 整合性** には適用しない。これらは将来 real user
  が増えた瞬間に効いてくるため、初期から維持。

---

## 8. 学び 7: 段階的検証 SQL の重要性

各 migration step 直後に検証 SQL を実行する手順を spec に組み込んだ:

```sql
-- F-2 後
SELECT COUNT(*) FROM users WHERE id IS NULL;  -- 期待: 0
SELECT clerk_id, COUNT(*) FROM users GROUP BY clerk_id HAVING COUNT(*) > 1;  -- 期待: 0 row
SELECT conname FROM pg_constraint WHERE confrelid = 'users'::regclass AND contype = 'f';
-- 期待: 既存 FK 4 件全て *_user_id_users_clerk_id_fk

-- F-3 後
SELECT COUNT(*) FROM <each FK table> x WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = x.user_id);
-- 期待: 各 table 0 件 (新 FK の orphan check)

-- F-5 後
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'deletion_failures' AND column_name IN ('user_id', 'clerk_id');
-- 期待: user_id = uuid, clerk_id = text
```

検証 SQL の効用:

- **「migration 成功」と「期待通り動作」は別物**。drizzle migrate の exit 0 は SQL
  syntax 通過のみで、column 型・FK 参照先・row 整合性は別 SQL で確認しないと確信
  できない。
- orphan check は FK 制約があれば論理上不要だが、**保険として実行**することで FK
  制約自体のバグ (制約名 typo / 参照列 mismatch) も検出できる。
- spec §7.3 として SQL を文字列で組み込んでおくと、**dev DB / Neon Branch / 本番
  すべてで同じ検証** が再利用できる。新規 migration 設計時もこの section を copy
  + 改変するだけで検証手順が揃う。

### 教訓

- **migration 後の検証 SQL を spec に組み込む**。後から思い出しで実行すると検証
  漏れが起きる。spec に書けば dry-run / 本番 verify の両方で機械的に再利用できる。
- 検証 SQL は **構造 (column 型 / 制約) + data (row count / orphan / NULL) の両軸**
  を扱う。片方だけだと別軸の bug を見落とす。

---

## 9. 関連 spec / commit

### Spec

- `docs/superpowers/specs/2026-04-30-phase-1-f-users-schema-decoupling.md`
  (Phase 1 F sprint design 全体)

### 主要 commit (時系列)

| commit | subject |
|---|---|
| `118d339` | docs(phase1): F-1 spec for users schema decoupling [no-review] |
| `29de016` | docs(phase1): amend F-1 spec — fix DDL order, deploy window, F-5 ambiguity [no-review] |
| `e9a1cb1` | docs(phase1): amend F-1 spec — fix §7.2 DDL via FK drop/recreate, document PG constraint [no-review] |
| `4c54bcd` | feat(db): add users.id UUID PK, demote clerk_id to UNIQUE [reviewed] |
| `1459d16` | feat(db): switch FK tables to users.id UUID reference (F-3 part 1/3) [reviewed] |
| `60b7e84` | feat(app): switch user lookup from clerk_id to users.id UUID (F-3 part 2/3) [reviewed] |
| `9805bd0` | test: update fixtures for users.id UUID reference (F-3 part 3/3) [reviewed] |
| `1eb69c7` | feat(db): apply Option A to deletion_failures (uuid user_id + clerk_id) (F-5 part 1/2) [reviewed] |
| `29532c0` | feat(webhook): integrate deletion_failures Option A schema (F-5 part 2/2) [reviewed] |
| `94c6e8e` | fix(webhook): notify ops on user.deleted received before user.created (F-5 fix-up) [reviewed] |

### 関連 lesson

- `docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md` (webhook 整合の前提)
- `docs/superpowers/lessons/2026-04-30-clerk-env-validation-environment-dependent.md` (Phase 1 E-2、Clerk env 切替の前例)

---

## 10. Template 転記候補

devcontainer-template / 後続の `nextjs-saas-template` 等に転記する価値がある汎用
要素を以下に明記。実際の転記は OT が host 側で別途実施 (plan00 固有の固有名詞を
generic に置換する作業も含む)。

### 転記対象 (汎用、template 価値高)

- **学び 1 (PG FK 依存先 switch)**: PG を扱う全 template に共通する DDL 落とし穴。
  事前検証 procedure として記載。
- **学び 2 (一時列方式 backfill)**: text → uuid に限らず列型変更全般で再利用可能な
  pattern。drizzle-kit auto-generate を信用しない判断軸も含めて転記。
- **学び 3 (段階分け方針: 無風 + atomic)**: 大規模 schema 変更の risk 分散戦略。
  auth provider 抽象に限らず、column rename / table 分割等で再利用可能。
- **学び 7 (段階的検証 SQL の spec 組み込み)**: migration 設計の universal best
  practice。spec template の「§検証 SQL」section として標準化候補。

### 転記しない (plan00 固有)

- **学び 4 (deletion_failures Option A)**: plan00 固有の audit table 設計。汎化
  すれば「audit table の column 設計原則」になるが、現状は plan00 固有のまま記録。
- **学び 5 (notifyOps の観測性原則)**: notifyOps helper は plan00 固有 (Discord
  webhook 直接実装)。Sentry / Datadog 等を使う template では別実装。観測性原則
  自体は普遍だが、helper 名 + Discord payload format は転記不可。
- **学び 6 (real user 0 個人開発の判断軸)**: 個人開発の状況依存判断。team 開発 /
  large-scale SaaS template には適用すべきではない。

### 転記先 path 候補 (OT 手動)

- `~/projects/devcontainer-template/docs/lessons/<date>-pg-schema-migration-patterns.md`
  (学び 1, 2, 3, 7 を統合)

転記時の置換作業:
- `plan00` → `<template-name>`
- `Clerk` → `<auth-provider>` (汎用例として記載 or 「auth provider」と抽象化)
- 具体的 commit hash → 削除 (template 利用者には無関係)
- 具体的 SQL は維持 (再利用価値高)

---

## 11. References

- 公式 PG documentation: ALTER TABLE / Foreign Key の依存関係
  (`https://www.postgresql.org/docs/current/sql-altertable.html`)
- drizzle-kit limitations: PK rename / FK 切替の auto-generate 不可
- 関連 spec: `docs/superpowers/specs/2026-04-30-phase-1-f-users-schema-decoupling.md`
- 関連 lesson: 上記 §9 参照
