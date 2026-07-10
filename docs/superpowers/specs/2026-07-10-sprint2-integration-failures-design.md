# Sprint 2 spec: `integration_failures` 統一記録テーブル + Discord dual-write

- 日付: 2026-07-10 / branch `develop`
- 前提 doc: `docs/audit/2026-07-10-reconciliation-infra-factfinding.md`(fact-finding 完了済み・追加調査なし)
- 位置づけ: reconciliation program の Sprint 2(= fact-finding の Phase B1 相当)。Sprint 1(clear decouple, `cb7ce29`)で correctness は解消済み。本 sprint は**記録配線のみ(additive)**。

## 1. 目的

課金系・外部連携の失敗が現状 Discord notify のみで SQL で引けない。失敗を DB テーブルにも残し、
手動 SQL / tsx script で棚卸し・回収できる記録基盤を additive に作る。回収の自動化(cron)はしない。

## 2. 前提(OT 確定判断・再議論しない)

1. 統一テーブル `integration_failures` 新設(kind 判別子 + 型付き ref 列 + payload jsonb + retry_count / next_retry_at / resolved_at)。既存 `deletion_failures` は吸収・廃止(zero-users ゆえ移行コード不要)。`source_documents.status` / `entity_mutations` は別目的の状態機械ゆえ統合しない。
2. cron は作らない。DB 記録 + Discord dual-write まで。resolved_at / next_retry_at はスキーマに持たせるが**回収ロジックは実装しない**(手動 SQL / tsx script)。
3. 記録対象は中核のみ = 課金整合(orphan 残余 / gate mismatch)・Clerk sync・削除失敗。全 anomaly の台帳化はしない(price anomaly 等の一過性はノイズゆえ除外)。
4. Sprint 2 は additive。Sprint 1 の best-effort release catch(seam コメント済み `handle-stripe-event.ts:277`)を dual-write の挿入点とする。
5. 手本 = `deletion_failures`(resolved_at 付き設計)+ `handle-clerk-event.ts` の forward-only + notifyOps 併用パターン(`recordFailure`)を踏襲。

## 3. スコープ / 非スコープ

**In**: schema 変更(新テーブル + `deletion_failures` DROP)/ 記録 helper 新設 / 4 系統の配線(§6)/ 既存 test の追随 + 新規 unit test。

**Out**(将来 kind 追加・cron 導入で additive に足せる形は維持する):
- 回収ロジック・cron route・`vercel.json` crons(fact-finding Phase B2)
- S4(A-3 drift)/ S6(unlinked customer)/ S5(unresolved)/ S7(price anomaly)/ S3(current_phase null)/ C2(user.deleted 未同期)— 現状どおり notifyOps のみ
- 既存挙動の変更(W)。Discord 通知の subject / payload は正常経路 byte 不変(例外は §5 の台帳書込失敗フラグのみ)
- Sprint 1 golden test が pin した clear / release 順序への干渉

## 4. スキーマ設計

`lib/db/schema.ts` に追加(`deletion_failures` の一般化。text + `$type<>` union は既存パターン踏襲):

```ts
export const integrationFailures = pgTable('integration_failures', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind')
    .$type<
      | 'stripe_release'            // S1 残余: clear 済み後の best-effort release (detach) 失敗
      | 'stripe_gate_mismatch'      // S2: release gate の sub.schedule ≠ DB scheduleId
      | 'clerk_sync'                // C1: Clerk publicMetadata sync 失敗
      | 'deletion_cancel'           // D1: 削除時 per-sub cancel 失敗(旧 'cancel')
      | 'deletion_list'             // D1: 削除時 subscriptions.list 失敗(旧 'list')
      | 'deletion_customer_missing' // D1: 削除時 customer 不在(旧 'customer_missing')
      | 'deletion_data'             // D1: data deletion tx 失敗(旧 'data_deletion')
    >()
    .notNull(),
  // 型付き ref 列(手動 SQL の WHERE/JOIN 用)。kind により埋まる列が異なるため全て nullable。
  userId: uuid('user_id'),
  clerkId: text('clerk_id'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  scheduleId: text('schedule_id'),
  targetPriceId: text('target_price_id'),
  payload: jsonb('payload').notNull(),   // notifyOps context をそのまま保存
  errorMessage: text('error_message'),   // 例外由来 kind のみ。anomaly 検知系(gate_mismatch)は NULL
  retryCount: integer('retry_count').notNull().default(0),          // Sprint 2 では読み書きしない(dormant)
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),  // 同上
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),     // 手動回収の完了印(SQL で UPDATE)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

- **FK なし**(`deletion_failures` 踏襲・lessons/2026-04-30-users-schema-decoupling.md)。user 削除後も audit 行として残置(clerk_id 残置も既存 precedent と同一 tradeoff)。
- **`user_id` nullable** は「全 table に user_id 必須」ルールからの意図的逸脱: S1/S2 は webhook 文脈に userId が無く customerId が同定キー。user データ table でなく ops/audit table(`stripe_events` / `clerk_events` と同類)であることが根拠。→ §10 論点 1。
- **index は PK のみ**(YAGNI)。手動 SQL + zero-users 規模で不要。cron 導入時に partial index(`WHERE resolved_at IS NULL`)を足す。
- `deletion_failures` は schema から削除。migration は `pnpm db:generate` で 1 本(`CREATE integration_failures` + `DROP deletion_failures`)。zero-users ゆえ destructive 可・データ移行なし。

## 5. 記録 helper `recordIntegrationFailure`

新規 file `lib/integration-failures.ts`(`lib/ops.ts` と同階層)。
`handle-clerk-event.ts` の `recordFailure`(DB 書込 = 真実 → notifyOps = 通知、の順)を一般化する。
server 境界は `@/lib/db` の既存 `import 'server-only'` が保証(直接付与しない)。`backfill-clerk-metadata.ts`(tsx script)は既に `@/lib/db` を直接 import して運用実績があるため、site 3 経由で helper が script に入っても新制約は生じない。

契約:

1. **入力**: `kind` / 型付き ref 群(全て optional)/ `errorMessage?` / `subject`(Discord 件名)/ `context`(notifyOps に渡す payload)。`payload` 列には `context` を verbatim 保存。
2. **順序**: ① `integration_failures` INSERT → ② `notifyOps(subject, context)`。
3. **throw-safe(INSERT 側)**: INSERT 失敗は握って `logger.error`(event: `integration_failures.insert_failed`)し、②へ進む。このとき **context に台帳書込失敗の印(例: `ledgerWriteError: <msg>`)を追記**して Discord 側で台帳欠落を可視化する(正常経路の Discord payload は byte 不変)。自 table への再帰記録はしない。
4. **notifyOps の throw semantics は不変**: production で `OPS_DISCORD_WEBHOOK_URL` 未設定時の fail-fast throw(既存契約)は helper で握らず伝播させる。呼び出し元の挙動(webhook 200 不変条件・outer catch)は現状と同一。
5. helper は Sprint 2 の 4 系統(§6)からのみ呼ぶ。他 site への展開は将来 sprint。

## 6. 配線点(4 系統)

各 site の既存 `notifyOps(...)` 呼び出しを `recordIntegrationFailure(...)` に置換する(subject / context は byte 不変で helper に渡す)。

| # | site | kind | ref 列 | errorMessage |
| - | ---- | ---- | ------ | ------------ |
| 1 | `lib/stripe/handle-stripe-event.ts:274-287` autorelease failed catch(**Sprint 1 seam**) | `stripe_release` | stripeCustomerId / stripeSubscriptionId(=sub.id)/ scheduleId(=dbScheduleId)/ targetPriceId | caught err |
| 2 | `lib/stripe/handle-stripe-event.ts:234-243` release gate `mismatch` case | `stripe_gate_mismatch` | stripeCustomerId / stripeSubscriptionId(=sub.id)/ scheduleId(=dbScheduleId) | NULL(payload に subScheduleId) |
| 3 | `lib/auth/clerk-metadata.ts:61-67` sync 失敗(404 silent skip の後段) | `clerk_sync` | clerkId / userId(=input.dbUserId があれば) | caught err |
| 4 | `lib/clerk/handle-clerk-event.ts:217-248` `recordFailure` 全体 | `deletion_*`(kind 対応表 §4) | userId / clerkId / stripeSubscriptionId(=subId) | 既存 errorMessage |
|   | → #4 は `recordFailure` の中身を helper 呼び出しに置換し、`deletionFailures` 参照を全廃(schema / handle-clerk-event / clerk webhook route+test) | | | |

- site 1 は seam コメント(`// Sprint 2: この catch が integration_failures dual-write の挿入点。`)を消化・削除する。
- site 3 の `syncClerkPublicMetadata` は throw せず `ok:false` を返す既存ポリシを維持(helper 呼出も await するだけで戻り値契約は不変)。404 silent skip は記録対象外(end-state 一致 = 失敗でない)。
- site 2 の同 switch 内 `clear_direct` / `skip`、および `reservation missing target price`(:252)は対象外(§3 Out)。

## 7. 不変条件(レビュー観点)

1. webhook handler は常に 200(既存不変条件)。helper 追加でこの経路に新しい throw を持ち込まない(§5-3/5-4)。
2. Sprint 1 の clear→release 順序・golden test に触れない(catch 内部への 1 呼び出し追加のみ)。
3. Discord 通知は subject / payload とも正常経路 byte 不変(dual-write は「追加」であり「変更」でない)。
4. `retry_count` / `next_retry_at` を読むコード・書くコード(default 以外)を作らない。
5. 新規 env なし(`.env.example` 変更なし)。

## 8. テスト戦略

- **helper unit(新規)**: INSERT 内容(kind / ref / payload verbatim)/ INSERT→notifyOps 順序 / INSERT 失敗時の throw-safe + `ledgerWriteError` 付き notifyOps 継続 / notifyOps throw の伝播。DB / notifyOps は mock(既存 route.test.ts パターン踏襲)。
- **配線 test(既存拡張)**: 4 site それぞれで「失敗発火 → integration_failures 行 + Discord 呼び出し(subject 不変)」を assert。既存 `deletionFailures` 前提の test(clerk webhook route.test.ts 等)は `integrationFailures` + 新 kind 名に追随。
- **stg smoke**: 失敗経路の実発火は stg で誘発困難ゆえ unit test を正とし、smoke は ① migration 適用確認(table 存在)② 正常経路 regression(subscription 更新 / user 削除フローが従来どおり)に限定する — この代替は plan に 1 行明記(CLAUDE.md 規律)。

## 9. Migration / deploy

1. schema 変更 → `pnpm db:generate` で migration 生成(0022 相当)→ `pnpm db:migrate`(dev / stg は OT 運用どおり)。
2. zero-users ゆえ `DROP TABLE deletion_failures` は無条件で安全(データ移行・後方互換コードなし)。
3. 決済経路に触れる fix 扱い: canonical review + Codex 協調 + [reviewed] 規律は通常どおり(dual-write 自体は additive ゆえ Test Clock 実機は不要見込み、plan で確定)。

## 10. 論点(OT 判断)

1. **`user_id` nullable の逸脱承認**(§4): ops/audit table として `stripe_events` / `clerk_events` と同類に置く整理で良いか。
2. **`error_message` nullable**(§4): anomaly 検知系(gate_mismatch)に合成エラー文字列を作らず NULL とする(payload に詳細)。deletion_failures の NOT NULL からの変更点。
3. **kind 命名**(§4 の 7 値): 旧 deletion_failures の kind 4 値に `deletion_` prefix を付けて統一 namespace 化。Discord subject は不変のため運用上の見え方は変わらない。

## 11. 参照

- fact-finding: `docs/audit/2026-07-10-reconciliation-infra-factfinding.md`(item 1 棚卸し表 / item 3 設計 3 案 / item 6 既存パターン)
- 手本: `lib/db/schema.ts:214-227`(deletion_failures)/ `lib/clerk/handle-clerk-event.ts:217-248`(recordFailure)/ `lib/ops.ts:23-79`(notifyOps)
- seam: `lib/stripe/handle-stripe-event.ts:277`(Sprint 1 が残したコメント)
