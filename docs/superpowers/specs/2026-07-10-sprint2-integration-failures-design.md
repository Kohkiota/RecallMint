# Sprint 2 spec: `integration_failures` 統一記録テーブル + Discord dual-write

- 日付: 2026-07-10 / branch `develop`
- 前提 doc: `docs/audit/2026-07-10-reconciliation-infra-factfinding.md`(fact-finding 完了済み・追加調査なし)
- 位置づけ: reconciliation program の Sprint 2(= fact-finding の Phase B1 相当)。Sprint 1(clear decouple, `cb7ce29`)で correctness は解消済み。本 sprint は**記録配線のみ(additive)**。
- 改訂 2026-07-10: 分類モデルを「kind 単一 union(7 値)」から「**4 軸判別列 + コード側 catalog**」に変更(GPT cross-check + claude.ai 統合判断)。分類軸を kind 文字列に圧縮すると集計が文字列規約(`LIKE 'deletion_%'`)依存になるため、独立に検索・集計する軸は独立列にする。組合せ安全は DB CHECK でなくコード catalog で enforce(kind 追加 = catalog 1 entry のみ・DDL 不要)。

## 1. 目的

課金系・外部連携の失敗が現状 Discord notify のみで SQL で引けない。失敗を DB テーブルにも残し、
手動 SQL / tsx script で棚卸し・回収できる記録基盤を additive に作る。回収の自動化(cron)はしない。

## 2. 前提(OT 確定判断・再議論しない)

1. 統一テーブル `integration_failures` 新設(**4 軸判別列 service / operation / workflow / failure_code** + 型付き ref 列 + context jsonb + retry_count / next_retry_at / resolved_at / resolution_note)。既存 `deletion_failures` は吸収・廃止(zero-users ゆえ移行コード不要)。`source_documents.status` / `entity_mutations` は別目的の状態機械ゆえ統合しない。
2. cron は作らない。DB 記録 + Discord dual-write まで。resolved_at / next_retry_at はスキーマに持たせるが**回収ロジックは実装しない**(手動 SQL / tsx script)。
3. 記録対象は中核のみ = 課金整合(orphan 残余 / gate mismatch)・Clerk sync・削除失敗。全 anomaly の台帳化はしない(price anomaly 等の一過性はノイズゆえ除外)。
4. Sprint 2 は additive。Sprint 1 の best-effort release catch(seam コメント済み `handle-stripe-event.ts:277`)を dual-write の挿入点とする。
5. 手本 = `deletion_failures`(resolved_at 付き設計)+ `handle-clerk-event.ts` の forward-only + notifyOps 併用パターン(`recordFailure`)を踏襲。
6. 4 軸の切り方は固定(service = 相手先 / operation = 業務的操作名・ドット階層可 / workflow = 発生文脈・nullable / failure_code = 失敗分類)。組合せの妥当性は DB CHECK でなくコード側 catalog(§5)で enforce。operation / workflow / failure_code の正確な値は各配線点の実コードの意味に合わせて確定済み(§5 catalog)。

## 3. スコープ / 非スコープ

**In**: schema 変更(新テーブル + `deletion_failures` DROP)/ failure catalog + 記録 helper 新設 / 4 系統の配線(§6)/ 既存 test の追随 + 新規 unit test。

**Out**(将来 catalog 追加・cron 導入で additive に足せる形は維持する):
- 回収ロジック・cron route・`vercel.json` crons(fact-finding Phase B2)
- S4(A-3 drift)/ S6(unlinked customer)/ S5(unresolved)/ S7(price anomaly)/ S3(current_phase null)/ C2(user.deleted 未同期)— 現状どおり notifyOps のみ
- 既存挙動の変更(W)。Discord 通知の subject / payload は正常経路 byte 不変(例外は §5 の台帳書込失敗フラグのみ)
- Sprint 1 golden test が pin した clear / release 順序への干渉
- `resolution_note` を読み書きするアプリコード(手動 SQL 専用列)

## 4. スキーマ設計

`lib/db/schema.ts` に追加(`deletion_failures` の一般化):

```ts
export const integrationFailures = pgTable('integration_failures', {
  id: uuid('id').primaryKey().defaultRandom(),
  // 4 軸判別列。語彙と組合せの妥当性は DB CHECK でなくコード側 catalog(§5)で enforce
  service: text('service').notNull(),          // 'stripe' | 'clerk' | 'db'
  operation: text('operation').notNull(),      // 業務的操作名。ドット階層 = 名前空間(例 'subscription_schedule.release')
  workflow: text('workflow'),                  // 発生文脈(例 'scheduled_downgrade' / 'user_deletion')。文脈不定の site は NULL
  failureCode: text('failure_code').notNull(), // 'external_api_error' | 'state_mismatch' | 'db_error'
  // 型付き ref 列(手動 SQL の WHERE/JOIN 用)。組合せにより埋まる列が異なるため全て nullable。
  userId: uuid('user_id'),
  clerkId: text('clerk_id'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  scheduleId: text('schedule_id'),
  context: jsonb('context').notNull(),   // notifyOps context をそのまま保存(targetPriceId 等 WHERE で引かない診断情報を含む)
  errorMessage: text('error_message'),   // 例外由来のみ。anomaly 検知系(state_mismatch)は NULL
  retryCount: integer('retry_count').notNull().default(0),          // Sprint 2 では読み書きしない(dormant)
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),  // 同上
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),     // 手動回収の完了印(SQL で UPDATE)
  resolutionNote: text('resolution_note'),                          // 手動回収の作業メモ(SQL で UPDATE、アプリコードなし)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

- **4 軸列に `$type<>` union を付けない**(既存 `deletion_failures.failureKind` パターンからの意図的逸脱): 語彙の SSoT を catalog 一箇所にするため。catalog entry 追加時に schema edit も migration も不要(`$type` は compile-time のみだが二重更新点になる)。DB CHECK 制約も作らない(同理由)。
- **FK なし**(`deletion_failures` 踏襲・lessons/2026-04-30-users-schema-decoupling.md)。user 削除後も audit 行として残置(clerk_id 残置も既存 precedent と同一 tradeoff)。
- **`user_id` nullable**(確定): S1/S2 は webhook 文脈に userId が無く customerId が同定キー。user データ table でなく ops/audit table(`stripe_events` / `clerk_events` と同類)。「全 table に user_id 必須」ルールの対象外。
- **`error_message` nullable**(確定): anomaly 検知系(gate mismatch)に合成エラー文字列を作らない(詳細は context に保持)。
- `target_price_id` は独立列にしない(WHERE で引かない診断情報 → context jsonb 内)。
- **index は PK のみ**(YAGNI)。手動 SQL + zero-users 規模で不要。cron 導入時に partial index(`WHERE resolved_at IS NULL`)を足す。
- `deletion_failures` は schema から削除。migration は `pnpm db:generate` で 1 本(`CREATE integration_failures` + `DROP deletion_failures`)。zero-users ゆえ destructive 可・データ移行なし。

## 5. コード側 catalog + 記録 helper `recordIntegrationFailure`

新規 file `lib/integration-failures.ts`(`lib/ops.ts` と同階層。catalog と helper を同居させる)。
`handle-clerk-event.ts` の `recordFailure`(DB 書込 = 真実 → notifyOps = 通知、の順)を一般化する。
server 境界は `@/lib/db` の既存 `import 'server-only'` が保証(直接付与しない)。`backfill-clerk-metadata.ts`(tsx script)は既に `@/lib/db` を直接 import して運用実績があるため、site 3 経由で helper が script に入っても新制約は生じない。

### failure catalog(4 軸語彙の SSoT)

```ts
export const INTEGRATION_FAILURE_CATALOG = {
  stripe_release:            { service: 'stripe', operation: 'subscription_schedule.release',   workflow: 'scheduled_downgrade', failureCode: 'external_api_error' },
  stripe_gate_mismatch:      { service: 'stripe', operation: 'subscription_schedule.reconcile', workflow: 'scheduled_downgrade', failureCode: 'state_mismatch' },
  clerk_sync:                { service: 'clerk',  operation: 'user.public_metadata.sync',       workflow: null,                  failureCode: 'external_api_error' },
  deletion_cancel:           { service: 'stripe', operation: 'subscription.cancel',             workflow: 'user_deletion',       failureCode: 'external_api_error' },
  deletion_list:             { service: 'stripe', operation: 'subscription.list',               workflow: 'user_deletion',       failureCode: 'external_api_error' },
  deletion_customer_missing: { service: 'stripe', operation: 'subscription.list',               workflow: 'user_deletion',       failureCode: 'state_mismatch' },
  deletion_data:             { service: 'db',     operation: 'user.data.delete',                workflow: 'user_deletion',       failureCode: 'db_error' },
} as const
export type IntegrationFailureKey = keyof typeof INTEGRATION_FAILURE_CATALOG
```

- catalog key はコード内 handle(DB には入らない。DB に入るのは 4 軸値のみ。現 7 entry の 4 軸 tuple は全て相異なる)。
- 写像確定の根拠(実コード確認済):
  - `deletion_list` / `deletion_customer_missing` は**同一 API call**(`stripe.subscriptions.list`)の失敗態様違い — page fetch 失敗 = `external_api_error`、customer `resource_missing`(DB が指す customer が Stripe に不在)= `state_mismatch`。operation を共有し failure_code で判別。
  - `deletion_data` は外部 service でなく**自 DB transaction**(soft delete + 子テーブル削除)の失敗 → service = 'db'、failure_code = 'db_error'(語彙に追加)。
  - `clerk_sync` の workflow は **null**: 記録 site(`clerk-metadata.ts`)は user.created 初期 sync / Stripe plan sync の複数文脈から呼ばれ、site 単独で文脈を特定できない(誤った固定値を書くより NULL)。workflow nullable の使用例。

### helper 契約

1. **入力**: catalog key(`IntegrationFailureKey`)/ 型付き ref 群(全て optional)/ `errorMessage?` / `subject`(Discord 件名)/ `context`(notifyOps に渡す payload)。**4 軸値は catalog から引く**(呼び出し側が自由文字列で 4 軸を渡せない = nonsense な組合せが compile-time で作れない)。`context` 列には `context` を verbatim 保存。
2. **順序**: ① `integration_failures` INSERT → ② `notifyOps(subject, context)`。
3. **throw-safe(INSERT 側)**: INSERT 失敗は握って `logger.error`(event: `integration_failures.insert_failed`)し、②へ進む。このとき **context に台帳書込失敗の印(例: `ledgerWriteError: <msg>`)を追記**して Discord 側で台帳欠落を可視化する(正常経路の Discord payload は byte 不変)。自 table への再帰記録はしない。
4. **notifyOps の throw semantics は不変**: production で `OPS_DISCORD_WEBHOOK_URL` 未設定時の fail-fast throw(既存契約)は helper で握らず伝播させる。呼び出し元の挙動(webhook 200 不変条件・outer catch)は現状と同一。
5. helper は Sprint 2 の 4 系統(§6)からのみ呼ぶ。他 site への展開は将来 sprint。

## 6. 配線点(4 系統)

各 site の既存 `notifyOps(...)` 呼び出しを `recordIntegrationFailure(...)` に置換する(subject / context は byte 不変で helper に渡す)。

| # | site | catalog key | ref 列 | errorMessage |
| - | ---- | ----------- | ------ | ------------ |
| 1 | `lib/stripe/handle-stripe-event.ts:274-287` autorelease failed catch(**Sprint 1 seam**) | `stripe_release` | stripeCustomerId / stripeSubscriptionId(=sub.id)/ scheduleId(=dbScheduleId) | caught err |
| 2 | `lib/stripe/handle-stripe-event.ts:234-243` release gate `mismatch` case | `stripe_gate_mismatch` | stripeCustomerId / stripeSubscriptionId(=sub.id)/ scheduleId(=dbScheduleId) | NULL(context に subScheduleId) |
| 3 | `lib/auth/clerk-metadata.ts:61-67` sync 失敗(404 silent skip の後段) | `clerk_sync` | clerkId / userId(=input.dbUserId があれば) | caught err |
| 4 | `lib/clerk/handle-clerk-event.ts:217-248` `recordFailure` 全体 | `deletion_*` 4 key(旧 kind 対応は §5 catalog) | userId / clerkId / stripeSubscriptionId(=subId) | 既存 errorMessage |
|   | → #4 は `recordFailure` の中身を helper 呼び出しに置換し、`deletionFailures` 参照を全廃(schema / handle-clerk-event / clerk webhook route+test) | | | |

- site 1 は seam コメント(`// Sprint 2: この catch が integration_failures dual-write の挿入点。`)を消化・削除する。targetPriceId は独立列にせず context 内に verbatim 残存(§4)。
- site 3 の `syncClerkPublicMetadata` は throw せず `ok:false` を返す既存ポリシを維持(helper 呼出も await するだけで戻り値契約は不変)。404 silent skip は記録対象外(end-state 一致 = 失敗でない)。
- site 2 の同 switch 内 `clear_direct` / `skip`、および `reservation missing target price`(:252)は対象外(§3 Out)。

## 7. 不変条件(レビュー観点)

1. webhook handler は常に 200(既存不変条件)。helper 追加でこの経路に新しい throw を持ち込まない(§5 契約 3/4)。
2. Sprint 1 の clear→release 順序・golden test に触れない(catch 内部への 1 呼び出し追加のみ)。
3. Discord 通知は subject / payload とも正常経路 byte 不変(dual-write は「追加」であり「変更」でない)。
4. `retry_count` / `next_retry_at` を読むコード・書くコード(default 以外)、`resolution_note` を読み書きするコードを作らない。
5. 4 軸値の書込は catalog 経由のみ(自由文字列の 4 軸を helper 入力に持たない)。
6. 新規 env なし(`.env.example` 変更なし)。

## 8. テスト戦略

- **helper unit(新規)**: catalog key → **4 軸値が catalog どおり INSERT される** / INSERT 内容(ref / context verbatim)/ INSERT→notifyOps 順序 / INSERT 失敗時の throw-safe + `ledgerWriteError` 付き notifyOps 継続 / notifyOps throw の伝播。DB / notifyOps は mock(既存 route.test.ts パターン踏襲)。
- **配線 test(既存拡張)**: 4 site それぞれで「失敗発火 → integration_failures 行 + Discord 呼び出し(subject 不変)」を assert。既存 `deletionFailures` 前提の test(clerk webhook route.test.ts 等)は `integrationFailures` + catalog key 前提に追随。
- **stg smoke**: 失敗経路の実発火は stg で誘発困難ゆえ unit test を正とし、smoke は ① migration 適用確認(table 存在)② 正常経路 regression(subscription 更新 / user 削除フローが従来どおり)に限定する — この代替は plan に 1 行明記(CLAUDE.md 規律)。

## 9. Migration / deploy

1. schema 変更 → `pnpm db:generate` で migration 生成(0022 相当)→ `pnpm db:migrate`(dev / stg は OT 運用どおり)。
2. zero-users ゆえ `DROP TABLE deletion_failures` は無条件で安全(データ移行・後方互換コードなし)。
3. 決済経路に触れる fix 扱い: canonical review + Codex 協調 + [reviewed] 規律は通常どおり(dual-write 自体は additive ゆえ Test Clock 実機は不要見込み、plan で確定)。

## 10. 参照

- fact-finding: `docs/audit/2026-07-10-reconciliation-infra-factfinding.md`(item 1 棚卸し表 / item 3 設計 3 案 / item 6 既存パターン)
- 手本: `lib/db/schema.ts:214-227`(deletion_failures)/ `lib/clerk/handle-clerk-event.ts:217-248`(recordFailure)/ `lib/ops.ts:23-79`(notifyOps)
- seam: `lib/stripe/handle-stripe-event.ts:277`(Sprint 1 が残したコメント)
- 分類モデル改訂の根拠: GPT cross-check + claude.ai 統合判断(2026-07-10 セッション)
