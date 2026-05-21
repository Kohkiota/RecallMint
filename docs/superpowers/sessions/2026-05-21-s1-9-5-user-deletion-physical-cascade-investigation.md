# S1.9.5 事前調査 — user 削除時の関連データ物理削除 (cascade dormant 解消)

- 日付: 2026-05-21
- 種別: 事前調査 (trace + 設計選択肢列挙のみ、 実装変更 0、 doc 1 file)
- branch: `develop` (S1.9.4 closure 済の `63dc17f` から開始)
- **本 doc は修正方針を提示しない**。 各設計選択肢は trade-off 込みで列挙、 採用案 selection は claude.ai + OT が後段で決定する。

## 背景

S1.9.4 事前調査で発見 **D1**: user 削除経路が soft delete のみで FK cascade が
永久に発火しない。 削除済 user の OCR 由来 個人コンテンツ
(exam / card / source_document / review / study_day / contact_message) が Postgres
に永続残存。 容量浪費 + GDPR 消去権の観点で launch 前必須対応。

設計確定 (claude.ai + OT 合意済、 本 doc の前提):

- **users 行は soft delete 維持** (Stripe webhook 遅延発火 / audit retention)
- **物理削除対象**: `exams` / `contact_messages` / `study_days`
  - `exams` DELETE → FK cascade で `cards` / `source_documents` / `reviews` 連動削除
- **保持**: `upload_records` (不正追跡) / `ai_usage_users` (同) / `users`
- **経路**: Clerk `user.deleted` webhook の `handleUserDeleted` に統合
- **reliability**: 削除失敗時の `deletion_failures` 記録 + Discord 通知 + retry を本 sprint に含める

---

## 0. エグゼクティブサマリ (期待発見ポイントへの回答)

| # | 確認事項 | 結論 |
|---|---|---|
| 1 | `handleUserDeleted` の現状処理 | `UPDATE users SET deleted_at` (唯一の DB mutation) + Stripe sub cancel ループのみ。 **子データ DELETE は皆無**。 |
| 2 | FK cascade 経路 | `DELETE FROM exams WHERE user_id` で cards / source_documents / reviews が確実に cascade。 `deleteExam` が本 pattern を実証済。 cascade 漏れ / overshoot とも無し。 |
| 3 | `deletion_failures` 再利用可否 | **再利用可**。 `failure_kind` は CHECK 制約なし text → 新 kind は code-only。 `resolved_at` は provisioned 済だが **完全に dormant** (writer 不在) → retry marker に転用可。 |
| 4 | Discord 通知の既存経路 | `lib/ops.ts` の `notifyOps` / `notifyWebhookError` が存在、 削除フローで使用済。 **そのまま流用可**。 |
| 5 | retry 機構 | (a) 即時 / (b) 記録のみ+手動 / (c) Vercel cron / (d) 外部 queue の 4 案。 (c) は `resolved_at` 列が元々その用途。 (d) は CLAUDE.md ライブラリ事前相談ルール抵触。 |
| 6 | plan00 流用 | webhook *アーキテクチャ* は流用可。 ただし **plan00 も soft delete のみで「物理 cascade delete」 の前例は無い** (kickoff の前提を要訂正)。 |
| 7 | transaction 境界 | 1 transaction / 段階 commit / 子削除先行 の 3 案。 Stripe 呼び出しは transaction 外必須。 |
| 8 | Stripe との順序 | 現状「DB soft-delete → Stripe」。 rollback 機構なし (forward-only + record-failure)。 子削除を入れる位置で 3 案。 |

**追加の重要発見**:

- **F1 (kickoff 前提の訂正)**: plan00 が確立したのは webhook *駆動アーキテクチャ*
  (Svix 検証 / idempotency / always-200 / Stripe cancel) であって、 **「webhook-driven
  cascade delete」 ではない**。 plan00 の `user.deleted` も `deleted_at = now()` の
  soft delete のみ (lesson §3.3)。 → 物理 purge 経路は **RecallMint で新規に確立** する
  ことになり、 流用できる「proven 実装」 は無い。 唯一の proven pattern は
  単文 `DELETE FROM exams` → FK cascade (`deleteExam`)。
- **F2 (D2 再確認)**: kickoff が前提する `handleUserDeleted` は実在するが、 独立 file
  (`lib/users/delete.ts`) は不在。 削除ロジックは webhook route に inline (S1.9.4 D2)。
- **F3 (spec 所在)**: code コメントが参照する `docs/superpowers/specs/2026-04-27-
  account-deletion-redesign.md` (§6.3 / §8.x) は **repo に存在しない**
  (`docs/superpowers/specs/` ディレクトリ自体なし)。 spec は Obsidian 管理
  (CLAUDE.md: ロードマップ / 改訂履歴は Obsidian)。 実装者は Obsidian から取得要。

---

## 1. 現状の user 削除経路 完全 trace (調査項目 1)

### 1.1 settings UI → Clerk (`app/(app)/app/settings/delete-button.tsx`)

`DeleteAccountButton` (client component)。 phase: `idle → confirm → deleting → polling → error`。

- L37 `deleteAccount = useReverification(() => user?.delete())` — Clerk client SDK
  `user.delete()`。 自前 UI のため Clerk の session reverification を `useReverification`
  で wrap (詳細: lesson `2026-05-19-clerk-self-delete-requires-reverification.md`)。
- L39-69 `onConfirmDelete`: `user.id` を memorize → phase `deleting` → `deleteAccount()`
  await → 成功で phase `polling`。
- L74-117 polling effect: `/api/me/deletion-status?userId=<clerkId>` を 1 秒間隔 ×
  最大 30 回 polling。 `completed` / `not_found` 検知で
  `window.location.replace('/sign-out-deleted')` (hard nav、 Router Cache / BFCache bypass)。

→ Clerk が user を削除 → Clerk (Svix) が `user.deleted` webhook を発火。
**註**: Clerk Dashboard からの管理者削除も同じ `user.deleted` を発火する。
`handleUserDeleted` に purge を集約すれば self-serve / 管理者削除 両方をカバーする。

### 1.2 webhook handler POST (`app/api/webhooks/clerk/route.ts:38-101`)

| step | 行 | 内容 |
|---|---|---|
| 0a | L39-46 | `CLERK_WEBHOOK_SECRET` 検証 (prod 未設定は 500、 dev は 200 skip) |
| 0b | L48-53 | svix headers (`svix-id` / `-timestamp` / `-signature`) 存在検証、 欠落は 400 |
| 1 | L57-67 | **Svix 署名検証** `new Webhook(secret).verify(...)`。 不正は 400 |
| 2 | L73-80 | **idempotency**: `INSERT INTO clerk_events (event_id=svix-id, type) ON CONFLICT DO NOTHING RETURNING`。 0 行 = 重複 → 200 `"duplicate"` 即 return |
| 3 | L86-88 | `handleEvent(evt)` を try、 成功で 200 `"ok"` |
| 4 | L89-100 | outer catch → `notifyWebhookError({handler:'clerk',...})` → 200 `"handler error swallowed"` |

- 署名検証: **あり** (svix `Webhook.verify`)。 svix ライブラリは署名検証のみ担当。
- 冪等性: **svix-id を PK とする自前 `clerk_events` table** (svix ライブラリ機能ではない)。
- 200 強制: handler error / 重複とも 200 で返し Clerk リトライループを抑止。

### 1.3 `handleEvent` (`route.ts:103-120`)

`user.created` → `users` INSERT ON CONFLICT DO NOTHING。
`user.deleted` → `handleUserDeleted(data.id)`。 その他 type は no-op。

### 1.4 `handleUserDeleted` (`route.ts:122-191`) ← 本 sprint の改修主体

1. **L130-134 (唯一の DB mutation)**: `UPDATE users SET deleted_at = now()
   WHERE clerk_id = <id> RETURNING {id, stripeCustomerId}`。
   **子テーブルの DELETE は一切なし。 これが D1 の実体**。
2. L142-149: `internalUserId` 不在 (users 行未同期 = `user.created` が `user.deleted`
   より遅着の順序逆転) → `notifyOps('user.deleted received but users row not synced')`
   して return。
3. L150: `customerId` 不在 (Stripe 連携なし = free プラン) → return。
4. L155-176: `for await (sub of stripe.subscriptions.list({customer, status:'all'}))`
   — `CANCEL_TARGETS` (`active`/`trialing`/`past_due`) のみ `cancelWithRetry(sub.id)`。
   per-sub 失敗は `recordFailure({kind:'cancel'})` して loop 継続。
5. L177-190: list 全体の失敗 → `recordFailure({kind:'list'|'customer_missing'})`。

→ **`UPDATE users SET deleted_at` 以外にしているのは Stripe subscription cancel のみ**。

### 1.5 `recordFailure` (`route.ts:202-229`)

`INSERT INTO deletion_failures` → `notifyOps('stripe sub cancel failure during
deletion', {...})` の順 (DB audit = 真実 → Discord = best-effort)。

### 1.6 二重発火時の現状挙動

- **同一 webhook message の Clerk 再配信** (= 同一 svix-id): step 2 の `clerk_events`
  ON CONFLICT で 0 行 → 200 `"duplicate"`、 handler 不到達。 → **デデュープ済**
  (`route.test.ts:147` で実証)。
- **同一 user の別 svix-id イベント 2 通** (Clerk が通常やらない病的ケース):
  両方が clerk_events gate を通過し `handleUserDeleted` が 2 回走る。 ただし
  `UPDATE deleted_at` 再実行は無害、 Stripe cancel は `canceled` を `CANCEL_TARGETS`
  から除外するため skip。 → 操作自体が冪等なので実害なし。
- → 本 sprint で追加する子削除も `DELETE ... WHERE user_id` の冪等操作にすれば
  二重発火に自然耐性 (2 回目は 0 行)。

---

## 2. FK cascade 経路の実証 (調査項目 2)

### 2.1 FK 参照グラフ (`lib/db/schema.ts`)

**`users.id` を `onDelete` 付きで参照する table** (全て `cascade`):
`reviews` (L120) / `ai_usage_users` (L153) / `exams` (L212) / `cards` (L241) /
`source_documents` (L321) / `upload_records` (L380) / `study_days` (L410) /
`contact_messages` (L427、 nullable)。

**`exams.id` を参照**: `cards.exam_id` cascade (L244) / `source_documents.exam_id`
cascade (L324)。
**`cards.id` を参照**: `reviews.card_id` cascade (L123)。
**`source_documents.id` を参照**: `cards.source_document_id` **SET NULL** (L247)。
**FK なし**: `deletion_failures` (user_id 列はあるが `.references()` なし、 audit table
意図的) / `ai_usage` / `stripe_events` / `clerk_events` (user_id 列なし)。

### 2.2 `DELETE FROM exams WHERE user_id = X` の cascade 実証

- exams 削除 → `cards` (exam_id cascade) + `source_documents` (exam_id cascade) 削除。
- cards 削除 → `reviews` (card_id cascade) 削除。
- `cards.source_document_id` SET NULL は **moot**: その cards は exam_id cascade で
  どのみち削除されるため。 Postgres は recursive cascade を子処理順に依存せず解決し、
  この単文 pattern は `deleteExam` (`app/(app)/app/exams/_actions/delete-exam.ts:43-46`)
  で review 済 + 本番稼働中。 → **proven**。

### 2.3 cascade の網羅性 (漏れ確認)

- `cards.exam_id` NOT NULL → 全 card は exam に属す。
- `source_documents.exam_id` NOT NULL → 全 source_document は exam に属す。
- `reviews.card_id` NOT NULL → 全 review は card に属す。
- → **user の全 exam を消せば その user の card / source_document / review は
  漏れなく消える**。 orphan は構造的に発生しない。
- 註: child 行の `user_id` は app の owner-scoping により常に親と一致する前提。
  `DELETE FROM exams WHERE exams.user_id = X` は exams.user_id で選択し、 cascade は
  exam_id / card_id を辿るため、 通常データモデルでは厳密に一致する。

### 2.4 cascade overshoot (意図せず他データが消える) 確認

`exams` / `cards` / `source_documents` / `reviews` を inbound FK で参照する table は
§2.1 で列挙した 4 本のみ。 これら以外に参照元はない → **exams 削除で
cards / source_documents / reviews 以外が連動削除されることはない**。 overshoot なし。

### 2.5 削除順序: exams → study_days → contact_messages

- 三者は相互に FK を持たない (各々 `users.id` および `cards.id` のみ参照)。
  → **どの順でも FK 違反は起きない**。 kickoff の指定順は安全、 実は順不同で安全。
- cascade (cards / source_documents / reviews) は `DELETE FROM exams` 単文内で
  atomic に処理される。
- `reviews` は `user_id`→users cascade と `card_id`→cards cascade の二重 FK を持つが、
  users は削除しないため reviews は **card_id 経由でのみ** 消える (設計意図通り)。

### 2.6 明示 DELETE が必要な table

| table | exams cascade で消えるか | 本 sprint の扱い |
|---|---|---|
| `cards` / `source_documents` / `reviews` | **消える** (exam_id / card_id cascade) | exams DELETE で自動 |
| `study_days` | 消えない (FK は user_id→users のみ、 users 不削除) | **明示 `DELETE WHERE user_id`** |
| `contact_messages` | 消えない (同上、 user_id は nullable) | **明示 `DELETE WHERE user_id`**。 user_id NULL の匿名問い合わせは対象外で正しい |
| `upload_records` | 消えない (users 不削除) | **保持** (設計通り、 no-op で達成) |
| `ai_usage_users` | 消えない (users 不削除) | **保持** (同上) |

---

## 3. `deletion_failures` table の現状と再利用可否 (調査項目 3)

### 3.1 DDL (`drizzle/migrations/0000` + `schema.ts:188-201`)

```
id            uuid    PK default gen_random_uuid()
user_id       uuid    NOT NULL          -- 内部 users.id
clerk_id      text    NOT NULL          -- Clerk user_id (Dashboard grep 用)
sub_id        text    NULL              -- Stripe sub id (cancel 以外の失敗は NULL)
failure_kind  text    NOT NULL          -- TS 上 'list'|'cancel'|'customer_missing'
error_message text    NOT NULL
created_at    timestamptz NOT NULL default now()
resolved_at   timestamptz NULL
```

- `failure_kind` は **DB 上は plain `text`、 CHECK 制約なし** (0000 migration に CHECK
  0 件を確認)。 Drizzle `$type<>()` は compile-time のみ。 → 新 kind
  (例 `'data_deletion'`) の追加は **TS union を広げる code-only 変更**、 migration 不要。
- `sub_id` は nullable → データ削除失敗 (NULL) で問題なし。

### 3.2 既存 read / write 経路

- write: `recordFailure` (`route.ts:210-216`) の **INSERT のみ**。 UPDATE 経路なし。
- read: **皆無** (`grep` で schema.ts / route.ts / route.test.ts のみ hit、 SELECT 不在)。
- → **`resolved_at` 列は完全に dormant** (writer も reader も不在)。 0000 で resolution
  追跡用に provisioned されたが、 現状 consumer がいない。

### 3.3 再利用可否

- table 本体は **再利用可**。 データ削除失敗を `failure_kind='data_deletion'` 等で記録。
- `resolved_at` は retry 成功 marker (`UPDATE resolved_at = now()`) に転用可能 —
  S1.9.5 の retry 経路が初の writer になる。
- 実装者向け 設計選択肢 (列挙のみ):
  - どの子 table の削除が失敗したかを `error_message` 自由文に埋めるか、 構造化列を足すか。
  - retry 回数を bound / flapping 観測するため `retry_count` 列を足すか (足すなら
    migration `0006`、 現状の最新は `0005`)。
  - `failure_kind` の粒度: 単一 `'data_deletion'` か、 table 別 kind か。

---

## 4. Discord 通知の既存経路 (調査項目 4)

`lib/ops.ts`:

- `notifyOps(subject, context)` (L18-58): `OPS_DISCORD_WEBHOOK_URL` に POST。
  未設定環境 (local / preview) は no-op。 fetch 失敗は `logger.warn` のみで呼び出し元を
  巻き込まない。 3 秒 `AbortSignal` timeout。 1900 char truncate。 Sentry 差し替え可能設計。
- `notifyWebhookError({handler, eventId, eventType, err, userId?, customerId?})`
  (L71-91): webhook outer-catch 専用、 `notifyOps` を内側で呼び `environment` /
  `timestamp` を自動付与。

削除フローでの使用実績: `recordFailure` (L220) が `notifyOps('stripe sub cancel
failure during deletion', ...)`、 users 未同期分岐 (L143) が `notifyOps('user.deleted
received but users row not synced', ...)`。

→ **削除失敗通知は既存経路をそのまま流用可**。 新規に
`notifyOps('user data deletion failure', {userId, clerkId, failedTables, error,
environment, timestamp})` を 1 本足すだけで、 `recordFailure` と同じ pattern に収まる。
新規 infra 不要。 `environment` / `timestamp` を inline 注入する慣習は `recordFailure`
(L226-227) が確立済。

---

## 5. retry 機構の設計選択肢 (調査項目 5)

| 案 | 概要 | 長所 | 短所 |
|---|---|---|---|
| (a) 即時 retry | `handleUserDeleted` 内で失敗 DELETE を N 回 retry | 最小、 infra 不要、 列追加なし | webhook `maxDuration` 60s (vercel.json)。 transient DB 障害は秒内に回復しない。 handler crash / Vercel kill を生存できない。 後続の Clerk 再配信は `clerk_events` gate で skip され「2 度目の機会」 が来ない。 微小 transient 以外は信頼性低 |
| (b) 記録のみ + 手動 retry | `deletion_failures` 記録 + Discord 通知、 OT が手動再実行 | infra ゼロ、 既存経路流用、 OT は Discord で即認知 | 人手依存。 **admin UI / admin route が現状不在** → 手動 retry は当面 ad-hoc SQL / script。 回復 latency = OT 反応速度 |
| (c) Vercel cron | cron route が `deletion_failures WHERE resolved_at IS NULL` を sweep し再実行、 成功で `resolved_at` set | 自動、 handler crash 後も回復、 成功まで retry 継続。 `resolved_at` 列は元々この用途 | **`vercel.json` に `crons` 追加が必要** (現状 cron 未設定、 S1.9.3 + 本調査で再確認) + cron route 新設 + shared-secret guard (`CRON_SECRET`、 新規 env → `.env.example`)。 Hobby は cron 頻度制限あり (Pro は可)。 cron route 自身も冪等 + owner-scoped 必須 |
| (d) 外部 job queue | Inngest / QStash 等にジョブ投入、 queue が retry / backoff | durable な retry / backoff / 可観測性が標準装備 | **新規外部依存 → CLAUDE.md「ライブラリ導入時は事前相談」 抵触**。 新 env / secret / 運用面。 launch 段階 (user 0) には過剰、 現実的に v1.x 検討 |

trade-off の framing (launch 視点):

- (a) 単独は弱い。 (b) は「失敗が記録され OT 通知される」 最低ラインで launch 可、
  ただし回復は手動。 (c) は最も安価な *自動* 案で、 `resolved_at` 列は元々その目的。
  (d) は post-launch。
- (b) と (c) は合成可能 (記録は常に行い、 cron が drain する)。

---

## 6. plan00 (vocab) との比較 (調査項目 6)

### 6.1 plan00 知見の所在

`docs/superpowers/lessons/2026-04-26-clerk-nextjs-webhook-architecture.md` が
plan00 Bug 2 / Bug 3 サイクルの design baseline。 他に
`2026-05-19-clerk-self-delete-requires-reverification.md` 等。 → **参照可能** (repo 内)。

### 6.2 kickoff 前提の訂正 (F1)

kickoff は「plan00 で確立した webhook-driven cascade」 を流用可能と想定するが、
lesson §3.3 の plan00 `user.deleted` handler は `deleted_at = now()` の **soft delete
のみ**。 → plan00 が確立したのは:

- webhook *アーキテクチャ*: Svix 署名検証 / `clerk_events`・`stripe_events` 冪等性 /
  always-200 / Stripe cancel auto-pagination + `status:'all'` (§3.7)。

であって、 **「物理 cascade delete」 ではない**。 schema の FK `cascade` 定義は
*意図* (「users を hard delete すれば children が cascade」) を符号化しているだけで、
plan00 / RecallMint とも `DELETE FROM users` を発行しない。 → 物理 purge 経路は
**S1.9.5 で新規確立**。 流用できる proven 実装は無く、 唯一の proven pattern は
単文 `DELETE FROM exams` → FK cascade (`deleteExam`)。

### 6.3 plan00 落とし穴の RecallMint 再発確認

| 落とし穴 | RecallMint 現状 | S1.9.5 で再発するか |
|---|---|---|
| Clerk 60 秒 JWT cache → 削除済 user で `clerkClient.getUser()` 404 | 緩和済: `getCurrentUser` (`lib/auth/ensure-user.ts`) は純 DB lookup、 `clerkClient.users.getUser()` 不使用 | **再発しない**。 S1.9.5 (server-side 子削除) は `clerkClient` 呼び出しを増やさない |
| `signOut()` SDK hang (削除済 user) | 緩和済: `delete-button.tsx` は `window.location.replace`、 `sign-out-deleted/page.tsx` は素の `<Link>` (`<SignOutButton>` 不使用) | **再発しない**。 S1.9.5 は server webhook のみ改修、 client sign-out 経路に触れない |

両落とし穴とも client / session 側の問題で、 S1.9.5 のスコープ (server 側子削除) と
直交する。

### 6.4 RecallMint と plan00 webhook の差分

- RecallMint は `user.deleted` 内に Stripe subscription cancel を持つ
  (`cancelWithRetry` + `deletion_failures` + `notifyOps`)。 plan00 lesson §3.7 は
  pattern を記すのみ。
- RecallMint の self-delete は自前 UI + `useReverification` 必須 (plan00 は prebuilt
  `<UserProfile/>`)。 S1.9.5 と直交。
- RecallMint は mcq ドメインの子 table が多い (exams / cards / source_documents /
  upload_records / study_days)。 plan00 の vocab table は drop 済。

### 6.5 要注意 gap (F3 再掲)

code コメントが参照する `docs/superpowers/specs/2026-04-27-account-deletion-redesign.md`
(§6.3 / §8.x) / `2026-04-26-webhook-only-user-sync-design.md` は **repo に存在しない**。
spec は Obsidian 管理。 実装者は account-deletion spec を Obsidian から取得すること。

---

## 7. transaction 境界の設計選択肢 (調査項目 7)

S1.9.5 の DB mutation: `DELETE exams` (+cascade) / `DELETE study_days` /
`DELETE contact_messages` + 既存 `UPDATE users SET deleted_at`。
(`upload_records` / `ai_usage_users` は意図的に触らない。)

**前提**: Stripe cancel ループは外部 HTTP 呼び出し → **DB transaction 内に入れない**
(長時間 await が lock / pooled connection を保持。 S1.9.4 の「OCR を transaction に
入れない」 と同原則)。 transaction 境界の議論は DB 操作のみが対象。

| 案 | 構成 | 長所 | 短所 |
|---|---|---|---|
| (T-a) 単一 transaction | DB 4 操作 (`UPDATE deleted_at` + 3 DELETE) を 1 transaction、 Stripe は外 | atomic — user soft-delete と子 purge が all-or-nothing。 中間状態なし | cascade DELETE (大量 cards / reviews) を含む大きめの write transaction。 1 user 分の volume なら通常問題ないが現状の単 `UPDATE` より大きい単位。 失敗時は soft-delete も成立せず → deletion-status が `pending` のまま、 `/app` zombie net も retry 成功まで起動しない |
| (T-b) 段階 commit | `UPDATE deleted_at` を先に commit (現状通り)、 子 DELETE を別 transaction (or table 別) | soft-delete (zombie net redirect + deletion-status `completed` の駆動源) が即座 / 独立に成立。 子 purge 失敗が「アカウント削除済」 UX を阻害しない。 transaction が小さい | partial-success window が現実に存在 — soft-delete 済だが子データ残存 (= 今の D1 状態を *記録付き* で再現)。 収束は retry (項目 5) 依存 |
| (T-c) 子削除先行 | 子 DELETE → `UPDATE deleted_at` の順 (1 transaction or 段階) | 全成功なら end state がクリーン | 子 DELETE 成功 + `UPDATE deleted_at` 失敗 → **「active user (deleted_at NULL) かつ子データ皆無」**。 user は `/app` zombie net (`layout.tsx:36`) を通過し「機能するが空のアカウント」 を見る。 kickoff が明示的に懸念する状態。 (T-b) の逆より悪い |

partial-success マトリクス (列挙のみ、 判断しない):

- soft-delete 済 + 子残存 → UX 正常、 purge 未完 → retry で drain ((T-b) の失敗モード)
- active + 子消失 → UX 破綻 (空の live アカウント) → 回避すべき ((T-c) の失敗モード)
- all-or-nothing → 最もクリーン、 transaction 最大 ((T-a))

横断論点: `deletion-status` の `computeStatus`
(`app/api/me/deletion-status/route.ts:49-59`) は現状 `completed` =「`deleted_at` set
+ Stripe 完了」 で、 **子データ purge を考慮しない**。 polling UX を子 purge 完了まで
待たせるか、 purge を fire-and-forget の背景処理として扱う (purge が retry 待ちでも
status は `completed`) かは関連設計判断。

---

## 8. Stripe 削除との順序 (調査項目 8)

### 8.1 現状の順序 (`handleUserDeleted`)

1. `UPDATE users SET deleted_at` (DB) — **1 番目**
2. Stripe `subscriptions.list` + `cancelWithRetry` ループ — **2 番目**
3. Stripe 失敗 → `recordFailure` (`deletion_failures` INSERT + `notifyOps`)

→ 現状は **DB soft-delete → Stripe**。 Stripe 失敗時の **rollback は無い** —
soft-delete はそのまま、 Stripe 失敗は `deletion_failures` に記録し手動 / retry 回復
(best-effort + audit モデル、 plan00 lesson §3.7)。 Stripe cancel は冪等
(Idempotency-Key 自動付与、 429 は `cancelWithRetry` で 1 retry)。

### 8.2 子データ DELETE を入れる位置 (列挙)

| 案 | 順序 | 特徴 |
|---|---|---|
| (S-1) | DB purge (子削除) → Stripe | 現状の「DB → Stripe」 と対称。 Stripe 失敗時 DB は purge 済、 Stripe 失敗は従来通り記録 |
| (S-2) | Stripe → DB purge (子削除) | 課金停止 (user-critical な効果) を先に確定。 purge 失敗時は データ purge のみ retry すればよい |
| (S-3) | DB soft-delete → Stripe → DB 子 purge | 現状の `UPDATE deleted_at` 先頭を維持し、 子 purge を Stripe の後に append |

並列 (Stripe ループ ‖ DB purge) も可能だが、 launch volume に対し failure-handling
複雑度が増すだけで利得が薄い (列挙のみ、 優先度低)。

### 8.3 rollback 戦略

現状 rollback 機構なし。 かつ Stripe cancel は **不可逆** (この経路で subscription を
「un-cancel」 できない) ため、 真のクロスリソース transaction / rollback は土俵に
乗らない。 確立済モデルは **forward-only + record-failure + retry**。 子データ purge も
これに合わせるのが整合的。 → 順序の論点は実質「どの失敗を安価に回復させたいか」:
Stripe 失敗は既に手動回復、 子 purge 失敗は項目 5 の retry 機構が引き受ける。

---

## 9. 未解決 / 要 OT 判断事項

| ID | 事項 | 区分 |
|---|---|---|
| §5 | retry 機構を (a) 即時 / (b) 記録+手動 / (c) Vercel cron / (d) 外部 queue のどれにするか。 (b)+(c) 合成も可 | 設計判断 |
| §5 / §3 | retry のため `deletion_failures` に `retry_count` 等の新列を足すか (足すなら migration `0006`) | 設計判断 |
| §7 | transaction 境界を (T-a) 単一 / (T-b) 段階 / (T-c) 子先行 のどれにするか。 partial-success の許容形を選ぶこと | 設計判断 |
| §7 | `deletion-status` の `completed` 判定に子 purge 完了を含めるか (polling を待たせるか) | 設計判断 |
| §8 | 子削除を (S-1) Stripe 前 / (S-2) Stripe 後 / (S-3) soft-delete と Stripe の後 のどこに置くか | 設計判断 |
| §3 | `failure_kind` の粒度 (単一 `'data_deletion'` か table 別か)、 失敗 table の記録方法 | 設計判断 |
| §5(c) | (c) 採用時、 Hobby/Pro どちらの cron 制約で運用するか + `CRON_SECRET` 導入 | 外部設定 (要人間) |
| F3 | account-deletion spec (Obsidian) を実装フェーズ前に取得・整合確認 | 段取り |

以上。 各案の selection・修正方針は claude.ai + OT が後段で決定する。
