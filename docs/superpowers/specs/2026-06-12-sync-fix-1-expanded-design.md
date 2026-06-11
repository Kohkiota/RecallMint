# Sprint Y-1: Sync-fix-1 (拡大版) — Design Doc

- **起票日**: 2026-06-12
- **位置づけ**: Sprint Y-1 の設計仕様 (spec)。 audit §10.2 (a) 14 項目 + 追加 3 件の **打ち切り sprint** (Sync-fix-2/3 を不要にする)。
- **前段**: `docs/superpowers/sessions/2026-06-12-sync-fix-1-step0-investigation.md` で 3 並列 subagent 調査 + OT 14 論点回答済。 本 spec は Step 0 結論を実装契約に落とす。
- **出典**: `docs/audit/2026-06-12-repo-wide-audit.md` (Codex 統合版) §10.2 (a) 編入リスト + §10.3 (b) hardening (Y-2 へ仕分け)。
- **次段**: 本 spec の OT 承認後 `superpowers:writing-plans` で task 単位 plan を起こす。

---

## 1. 目的とスコープ

### 1.1 目的
1. audit §10.2 (a) **14 項目 + 追加 3 件** を本 sprint で一括解消、 全 optimistic 経路を共有 helper に収束する
2. production silent lost write (audit §1.1 P0 2 件) を **T1a 単独 PR で最速封じ込め** (helper 最小骨組 + reference 4 件化、 1-2 日 +/− で 1 PR)
3. **Grid-2 bulk 土台** (= N エンティティ一括口) の型安全性を `mutation-schemas.ts` discriminated union で確立
4. **Sync-fix を本 sprint で打ち切る** (Sync-fix-2/3 を不要にする、 §10 audit 突合対照表で証明)

### 1.2 スコープ (含む)
- audit §10.2 (a) 14 項目 (#1〜#14)
- 追加 3 件:
  - 追加 1 = `tags/_components/category-list.tsx:170-207 handleConfirmDelete` の cascade purge + 別 void enqueue
  - 追加 2 = `tags/_components/option-list.tsx:144-176 handleDeleteImmediate` 同形
  - 追加 3 = `card-tags-section.tsx` 4 関数の revert `.catch(...)` 握り潰し (= #12 と同件、 helper 内蔵化で消える)

### 1.3 スコープ外 (Y-2 / 別 sprint で扱う、 OT 14 論点回答済)
| 項目 | 受け入れ先 | 出典 |
|---|---|---|
| retry 意味論 (案 1 = HTTP 5xx 格上げ) | Y-2 | Step 0 §2.7 + 論点 F |
| outbox 24h cap → 30d 化 | Y-2 | 論点 H |
| `session.card_ids` / `selected_answer_ids` bound 追加 (K=2段運用) | Y-2 | 論点 K |
| dependent multi-mutation atomic group | Grid-2 設計時の別 sprint | 論点 I |
| Drizzle vs zod vs ClientX 三重定義 SSoT 化 (codex #8) | 波 3 (型安全 sprint) | Step 0 §3.5 C-1 |
| pull response zod 化 (`lib/sync/pull.ts:100`) | Phase 4 | Step 0 §3.5 C-3 |
| OPS_DISCORD_WEBHOOK_URL fail-fast / webhook secret env-aware | Y-2 任意 | audit §8.4 / §8.5 |

---

## 2. 共有 helper 設計 (`lib/sync/optimistic-mutation.ts` 新設、 案 B)

### 2.1 採用 API = pure function 3 関数

```ts
// lib/sync/optimistic-mutation.ts (新規)
import type { Table } from 'dexie'
import type { EnqueueEntityMutationInput } from '@/lib/sync/entity-mutations'

/** 既定 silent + logger.warn 1 行、 throwOnError=true で caller 通知 (rename/color 系) */
export type OptimisticMutationOptions = {
  stores: readonly Table<unknown, unknown>[] // entity_mutations は helper が自動 append
  mutate: () => Promise<void>                 // tx 内で実行する mirror write の塊
  mutations: readonly EnqueueEntityMutationInput[] // tx 内で順次 enqueueEntityMutation
  logEvent: string
  logContext?: Record<string, unknown>
  throwOnError?: boolean                       // 既定 false
}
export async function runOptimisticMutation(options: OptimisticMutationOptions): Promise<void>

export type OptimisticCreateOptions<T> = {
  userId: string                                // 空文字 fail-fast (T2 で空文字 placeholder を構造的に消す)
  buildRow: (newId: string, nowIso: string) => T
  mirrorStore: Table<T, unknown>
  buildMutation: (newId: string, nowIso: string) => EnqueueEntityMutationInput
  extraMirrorWrites?: (newId: string, nowIso: string) => Promise<void>
  extraStores?: readonly Table<unknown, unknown>[]
  logEvent: string
  logContext?: Record<string, unknown>
  throwOnError?: boolean
}
export async function runOptimisticCreate<T>(options: OptimisticCreateOptions<T>): Promise<{ id: string }>

export type OptimisticUpdateOptions<TKey, TPatch extends Record<string, unknown>> = {
  store: Table<unknown, TKey>
  rowKey: TKey
  beforeValue: TPatch                           // revert 用
  afterPatch: TPatch
  mutation: EnqueueEntityMutationInput
  logEvent: string
  logContext?: Record<string, unknown>
  isNoop?: (before: TPatch, after: TPatch) => boolean
  throwOnError?: boolean                        // rename/color 系の caller 通知用
}
export async function runOptimisticUpdate<TKey, TPatch extends Record<string, unknown>>(
  options: OptimisticUpdateOptions<TKey, TPatch>,
): Promise<void>
```

### 2.2 reference 実装契約 (helper 内部仕様)

1. `db.transaction('rw', ...stores, db.entity_mutations, async () => {...})` で mirror store + `entity_mutations` を同 tx
2. tx 内順序: mirror write (`mutate()` callback) → enqueue (`mutations` を順次 await)
3. enqueue throw → tx callback rethrow → **Dexie auto-rollback** (catch で握り潰さない)
4. try/catch は tx 外 (caller 側、 helper 内部)。 rollback 発火後に helper catch
5. catch 後 既定 silent + `logger.warn({ event: logEvent, ...logContext, err })` 1 行 (`err` は Error のまま渡し `expandError` 展開)
6. `throwOnError: true` なら catch 後 rethrow
7. **flush は helper 内蔵 fire-and-forget**: `void runGuardedEntityMutationFlush().catch(() => {})` を tx 外で。 caller は flush を渡さない
8. `runOptimisticCreate` は `userId === ''` で **空文字 fail-fast** (早期 throw + `console.error('[optimistic-create] empty user_id', ...)`)、 T2 の create form 2 件で構造的に空文字 placeholder を消す
9. `runOptimisticUpdate` の revert 失敗時 (= mirror revert で再 throw) は `logger.warn` 1 行 + silent return (案 a 取り直し)

---

## 3. 14 項目 + 追加 3 件 → task マッピング

| audit # | file:line | bucket | 適用 helper / 修正 | task |
|---|---|---|---|---|
| #1 | `inline-card-list.tsx:161-205 handleAddCard` | create flow (single store + IIFE) | `runOptimisticCreate` | **T1a** (P0) |
| #2 | `delete-card-button.tsx:36-52 onConfirmDelete` | delete (single store + IIFE) | `runOptimisticMutation` | **T1a** (P0) |
| #3 | `inline-text-field.tsx:168-189 commit` | rename/color (single store, void parallel) | `runOptimisticUpdate` | T1b |
| #4 | `inline-option-row.tsx:185-213 commit` | 同上 | `runOptimisticUpdate` | T1b |
| 追加 1 | `category-list.tsx:170-207 handleConfirmDelete` | delete cascade | `runOptimisticMutation` (multi-store) | T1b |
| 追加 2 | `option-list.tsx:144-176 handleDeleteImmediate` | 同上 | `runOptimisticMutation` (multi-store) | T1b |
| #5 | `card-tags-section.tsx:111-234` 4 関数 (handleRename* / handleSet*Color) | rename/color (部分修正済、 4 関数コピペ + revert 握り潰し残置) | `runOptimisticUpdate` (throwOnError=true) | T2 |
| 追加 3 | 上記 4 関数の revert `.catch(...)` 握り潰し (#12 と同件) | revert 内蔵化 | helper 内蔵で消える | T2 |
| #6 | `option-row.tsx:118-161` / `category-row.tsx:86-124` enqueueUpdate | rename/color/move (single store, debounce drain) | `runOptimisticUpdate` (debounce 内蔵 or caller debounce) | T2 |
| #7 | `option-create-form.tsx:65-121` / `category-create-form.tsx:49-103` | create flow (single store, void + form reset) | `runOptimisticCreate` (`userId` 必須で空文字 placeholder 構造的に解消) | T2 |
| #8 | `lib/sync/entity-mutation-flush.ts` + `review-flush.ts` + `pull.ts:310` Web Locks wrapping | infra (非 optimistic) | `lib/sync/with-web-lock.ts` 新設、 `(lockName, flushAll, logEventPrefix)` で 1 関数化 | T3 |
| #14 | `lib/sync/review-events.ts:32` + `entity-mutations.ts:25` newId | util 重複 | `lib/sync/new-id.ts` 新設、 両者共用 | T3 |
| #9 | `apply-tag-mutation.ts:188-192` tag_option dup check | server SQL 1 行 fix | WHERE 句に `ne(tagOptions.id, optionId)` 追加 | T4 |
| #10 | `apply-tag-mutation.ts:76,228,253` + `entity-mutation-registry.ts:194` tag mutation create/update zod drift | server zod 統一 | `lib/validation/tag.ts` 新設 (field schema)、 registry create patch を field schema 派生、 apply 側 if 文を field 名 → 個別 schema dispatch table 化 | T4 |
| #13 | `lib/client-db.ts:147-153 ClientEntityMutation` loose | 型投影 | `lib/sync/shared/mutation-schemas.ts` 新設 (server-only **不付**)、 `z.discriminatedUnion` で envelope 集約、 `ClientEntityMutation` を envelope 派生 | T5 |
| #11 | 23 callsite `String(err)` boilerplate (T1〜T2 完了後に grep で再集計) | logger | `logger.warnFromError(event, ctx)` 追加 + 残存箇所一括置換 | T7 |
| #12 | `card-tags-section.tsx` 4 関数 revert 握り潰し | revert 内蔵化 (追加 3 と同件) | T2 完了条件で grep 確認 | T2 内で完了 |

---

## 4. zod 化詳細 (T4 + T5)

### 4.1 T4 — `lib/validation/tag.ts` 新設

```ts
// lib/validation/tag.ts (新規、 server-only 不付)
import { z } from 'zod'

export const tagNameSchema = z.string().trim().min(1).max(100)
export const tagColorSchema = z.string().max(50).nullable()
export const tagSortKeySchema = z.string().max(100).nullable()
export const tagCategoryIdSchema = z.uuid()
```

- `entity-mutation-registry.ts` の tag_category create / tag_option create patch zod を上記 field schema 派生に書き換え
- `apply-tag-mutation.ts:75-95` (category update) と `:227-294` (option update) の `switch (patch.field)` 内 `typeof === 'string' && length > 0` を上記 field schema の `safeParse` に置換、 fail 時 `'failed'` を返す
- `apply-tag-mutation.ts:188-192` dup check の WHERE 句に `ne(tagOptions.id, optionId)` 追加 (`#9` の 1 行 fix)

### 4.2 T5 — `lib/sync/shared/mutation-schemas.ts` 新設

`lib/validation/card.ts` precedent (server-only **不付** で server + client + test 3 sink から共有) を踏襲:

```ts
// lib/sync/shared/mutation-schemas.ts (新規、 server-only 不付)
import { z } from 'zod'
// ... patch schema 群を registry から移管 (cardCreate / cardUpdateField / cardDelete /
//     tagCategoryCreate / tagCategoryUpdateField / tagCategoryDelete /
//     tagOptionCreate / tagOptionUpdateField / tagOptionDelete)

const cardMutationEnvelope = z.discriminatedUnion('op', [
  z.object({ entity_type: z.literal('card'), op: z.literal('create'), entity_id: z.string(), patch: cardCreatePatchSchema }),
  z.object({ entity_type: z.literal('card'), op: z.literal('update_field'), entity_id: z.string(), patch: cardUpdateFieldPatchSchema }),
  z.object({ entity_type: z.literal('card'), op: z.literal('delete'), entity_id: z.string(), patch: cardDeletePatchSchema }),
])
// tagCategoryMutationEnvelope / tagOptionMutationEnvelope も同形

export const entityMutationEnvelopeSchema = z.discriminatedUnion('entity_type', [
  cardMutationEnvelope,
  tagCategoryMutationEnvelope,
  tagOptionMutationEnvelope,
])
export type EntityMutationEnvelope = z.infer<typeof entityMutationEnvelopeSchema>
```

- `lib/client-db.ts:147` の `ClientEntityMutation`:
  ```ts
  export type ClientEntityMutation = EntityMutationEnvelope & {
    local_id?: number
    sync_status: SyncStatus
    last_attempted_at?: string | null
  }
  ```
- `lib/sync/entity-mutations.ts:33 EnqueueEntityMutationInput` も envelope 派生 (`Omit<z.input<...>, 'mutation_id'> & { edited_at: string }` 等)
- `lib/sync/server/entity-mutation-registry.ts` を 2 ファイルに分割: schema 部は `mutation-schemas.ts` (shared)、 apply dispatch は registry に残置 (`server-only` 付与)
- `RegistryEntry<EnvelopeT>` を generic 化 → `apply-card-mutation.ts:148` 等の `patch as z.infer<...>` cast を削除可

**T5 重要明示**: plan に **「型レベル投影のみ、 runtime 挙動変更なし」 を冒頭 1 行で契約化**。 review pass 容易性のため。

---

## 5. sprint task 構成 (T1a / T1b / T2 / T3 / T4 / T5 / T7 = 7 本)

### T1a: helper 最小骨組 + P0 hotfix (先出し PR)

- **scope**: `runOptimisticMutation` + `runOptimisticCreate` の 2 関数 (~100 行) + 単体テスト 6-8 case
- **適用**: P0 2 件 (#1 handleAddCard / #2 onConfirmDelete) を helper 経由で書き換え
- **完了条件**:
  - helper signature が §2.1 通り
  - test: main path / silent catch / multi-store rollback / create flow newId 採番 / `throwOnError` rethrow / `userId=''` fail-fast の 6 case 以上
  - P0 2 件の手動 smoke (mirror に行が残り outbox に行がない状態を作れない)
  - whole-repo `pnpm lint --max-warnings=0` exit 0
  - `superpowers:requesting-code-review` Critical 0、 [reviewed] tag
- **PR**: 1 PR
- **🛑 stop checkpoint**: T1a 完了で OT に先行 push 判断仰ぐ。 OT push 判断後は待機なしで即 T1b 着手 (日常の開発・利用が経過観察を兼ねる)

### T1b: 残り atomic 化 (#3 #4 + 追加 1 #2)

- **scope**: `runOptimisticUpdate` 追加 (~50 行) + 4 callsite 移行 (`inline-text-field` / `inline-option-row` / `category-list handleConfirmDelete` / `option-list handleDeleteImmediate`)
- **完了条件**: 4 file が helper 経由化、 旧 void enqueue + IIFE pattern が grep で 0
- **PR**: 1 PR

### T2: 4 関数統合 + 共通 hook (#5 #6 #7 + 追加 3)

- **scope**:
  - `card-tags-section.tsx` の handleRenameCategory / handleSetCategoryColor / handleRenameOption / handleSetOptionColor を `runOptimisticUpdate` (`throwOnError=true`) 経由化
  - `option-row.tsx` / `category-row.tsx` の enqueueUpdate を共通 hook or helper 直接呼び出しに集約 (debounce drain は helper 内蔵 or caller、 実装段階で決定)
  - `option-create-form.tsx` / `category-create-form.tsx` を `runOptimisticCreate` 経由化 (`userId` 必須で空文字 placeholder 構造的に解消)
- **完了条件**:
  - 8 callsite 移行完了
  - **(修正点 1)** `card-tags-section.tsx` 4 関数の revert `.catch(...)` 握り潰しが helper 内蔵化で消えていること (grep で `.catch(.*err.*logger\.warn` 残置 0 確認、 = 追加 3 と #12 の解消証明)
  - `user_id: ''` 空文字 placeholder の grep が `tags/_components/` 配下で 0
- **PR**: 1 PR

### T3: Web Locks lock runner + newId 共有化 (#8 + #14)

- **scope**:
  - `lib/sync/with-web-lock.ts` 新設、 `(lockName, flushAll, logEventPrefix)` で 1 関数化
  - `lib/sync/entity-mutation-flush.ts` / `review-flush.ts` / `pull.ts:310` を helper 経由化
  - `lib/sync/new-id.ts` 新設、 `lib/sync/review-events.ts:32` + `lib/sync/entity-mutations.ts:25` を移行
- **完了条件**: 旧 inline lock wrapping + inline newId が grep で 0
- **PR**: 1 PR

### T4: tag mutation zod 統一 + dup check 自己除外 (#10 + #9)

- **scope**:
  - `lib/validation/tag.ts` 新設 (§4.1)
  - `entity-mutation-registry.ts` tag schema を field schema 派生に書き換え
  - `apply-tag-mutation.ts` update if 文を field 名 → 個別 schema dispatch table 化
  - dup check `apply-tag-mutation.ts:191` に `ne(tagOptions.id, optionId)` 追加
- **完了条件**:
  - 既存 `apply-tag-mutation.test.ts` に case 追加: name の trim 効果 / max 効果 / category_id uuid 効果 / dup check 自己除外 race regression
  - 既存 test 全 pass
- **PR**: 1 PR

### T5: shared `mutation-schemas.ts` + ClientEntityMutation 投影 (#13)

- **scope**: §4.2 全て
- **完了条件**:
  - **plan 冒頭 1 行で「型レベル投影のみ、 runtime 挙動変更なし」 を契約化**
  - server registry の apply 関数 signature が discriminated union 経由で型強化
  - `apply-card-mutation.ts:148` 等の `patch as z.infer<...>` cast 削除
  - `entity-mutation-registry` test に envelope reject case 追加 (untrusted entity_type / op が `safeParse` で fail)
- **PR**: 1 PR

### T7: `String(err)` helper 化 + 残存一括置換 (#11)

- **(修正点 3)** **scope は T1〜T2 完了後に grep で再集計した残存 callsite のみ**。 Step 0 時点の 23 件は helper 経由化で相当数が先に消えるため、 plan の完了条件を **固定件数にしない**。
- **scope**:
  - `lib/logger.ts` に `warnFromError(event: string, ctx: Record<string, unknown>, err: unknown): void` 追加 (`err` は Error のまま `expandError` に渡す)
  - T1〜T2 完了後 grep `String\(err\)|err: String\(err\)` で再集計した残存 callsite を一括置換
- **完了条件**:
  - grep `String\(err\)` 残存 0 (lib/db/schema.ts / serialize-db-error.ts 等の意図的 String 化は対象外、 `app/(app)/app/**/_components/**` 配下のみ)
- **PR**: 1 PR

---

## 6. test 戦略

### 6.1 単体 (vitest)
- T1a で helper の 6-8 case (§5 T1a 完了条件参照)
- T4 で `apply-tag-mutation.test.ts` に field schema + dup check 自己除外 case 追加
- T5 で `entity-mutation-registry` test に envelope reject case 追加

### 6.2 既存 test 拡張
- T1b / T2 で 4 file + 4 関数の移行に伴う既存 component test (あれば) に rollback assertion を 1-2 case 追加

### 6.3 統合 stg smoke
- T1a 完了直後: 「inline 編集 N 回 → enqueue throw mock → mirror auto-rollback 確認」 を DevTools MCP で実走
- T2 完了直後: 「create form 送信 → 並走 race (同 category 内同名 option を 2 タブで同時 submit) → 偽 failed 出ない確認」

---

## 7. 完了条件 (sprint 全体)

1. audit §10.2 (a) 14 項目 + 追加 3 件すべて helper or 新規 schema 経由 (§10 audit 突合対照表で 1:1 マッピング確認、 取り残し 0)
2. audit §9 巻末「Sync-fix-1 既知合流」 4 件 (tag drift / ClientEntityMutation / newId / Web Locks lock runner) すべて消化
3. audit §1.1 P0 lost write 2 件は T1a 単独 PR で先解消
4. CLAUDE.md sprint 完了 gate:
   - whole-repo `pnpm lint --max-warnings=0` exit 0 (chat に 1 行明記)
   - 依存 / Next / Node / lockfile を触る task は無いが、 T5 で型変更が大規模なため `pnpm typecheck` exit 0 を T5 PR で必須化
5. 各 PR で `superpowers:requesting-code-review` Critical 0、 [reviewed] tag

---

## 8. リスクと緩和

- **T5 ClientEntityMutation 投影**の型変更が広範囲波及 → plan 明示で「型レベル投影のみ、 runtime 不変」 と契約化、 review pass 容易性確保 + `pnpm typecheck` exit 0 を T5 PR の必須完了条件
- **(修正点 2)** T1a 単独 merge 後の検証期間は設けない。 T1a 完了の stop checkpoint で OT が先行 push 判断、 push 後は待機なしで即 T1b 着手 (日常の開発・利用が経過観察を兼ねる)
- **共有 helper の test カバレッジ薄**で本番 lost write 残置リスク → T1a の 6-8 case で main path / silent / `throwOnError` / multi-store rollback / create flow / `userId=''` fail-fast を網羅
- **T2 4 関数 + 8 callsite 一括移行**で 1 PR scope 膨張 → review 容量で OT が判断、 必要なら T2 を T2a (card-tags-section 4 関数) / T2b (option-row + category-row + create form) に PR 分割

---

## 9. 監査メタ情報

- 起源: `docs/audit/2026-06-12-repo-wide-audit.md` §10.2 (a) 14 項目 + §10.2 (b) 既知合流 4 件
- 前段: `docs/superpowers/sessions/2026-06-12-sync-fix-1-step0-investigation.md` (3 並列 subagent 調査 + OT 14 論点回答済、 §4.3 案 Y 修正版採用)
- 採用判断: helper API = 案 B (agent A 推奨)、 zod 切り分け = 案 2 (agent C 推奨)、 retry 意味論は Y-2 分離 (agent B 推奨)、 sprint 分割 = Y 修正版 (controller 推奨 + OT 承認)
- 修正適用: OT 設計骨子 approval 時の 4 点修正 (T6 削除 + T2 grep 確認 / 検証期間削除 / T7 scope = grep 再集計のみ / spec self-review に audit 突合)

---

## 10. audit 突合対照表 (= 「Sync-fix-2 不要」 根拠)

audit §10.2 (a) 14 項目 + 追加 3 件と本 spec の task マッピングが **1:1 で取り残しゼロ** であることを示す。 本対照表が「Sync-fix-2 を起こす必要がない (= Sync-fix-1 拡大版で打ち切り)」 の証明。

| audit ref | 出典 | 本 spec で吸収する task | 解消手段 |
|---|---|---|---|
| #1 inline-card-list handleAddCard | audit §1.1 P0 [both] | **T1a** | `runOptimisticCreate` |
| #2 delete-card-button onConfirmDelete | audit §1.1 P0 [both] | **T1a** | `runOptimisticMutation` |
| #3 inline-text-field commit | audit §3 P1 [both] | T1b | `runOptimisticUpdate` |
| #4 inline-option-row commit | audit §3 P1 [both] | T1b | `runOptimisticUpdate` |
| #5 card-tags-section 4 関数 | audit §5.1 P1 | T2 | `runOptimisticUpdate` (throwOnError=true) |
| #6 option-row + category-row enqueueUpdate | audit §5.1 P1 [both] | T2 | `runOptimisticUpdate` |
| #7 option-create-form + category-create-form | audit §5.1 P1 [both] | T2 | `runOptimisticCreate` (`userId` 必須) |
| #8 Web Locks wrapping 3 file | audit §5.1 P1 [both] | T3 | `lib/sync/with-web-lock.ts` |
| #9 tag_option dup check 自己除外 | audit §3 P1 | T4 | SQL WHERE 句 `ne()` 1 行 |
| #10 tag update validation drift | audit §6 P2 [Codex-only] | T4 | `lib/validation/tag.ts` + dispatch table |
| #11 23+ String(err) boilerplate | audit §5.1 P2 | T7 | `logger.warnFromError` + 残存一括置換 |
| #12 card-tags-section revert 握り潰し | audit §5.1 P2 / §3 P2 [both] | T2 | helper 内蔵化で消滅 (T2 完了条件で grep 確認) |
| #13 ClientEntityMutation loose 型 | audit §6 P3 [Codex-only] | T5 | `mutation-schemas.ts` 新設 + envelope 派生 |
| #14 newId 重複 | audit §5.1 P3 [Codex-only] | T3 | `lib/sync/new-id.ts` 新設 |
| 追加 1 category-list handleConfirmDelete | Step 0 §1.4 (helper スコープ追加) | T1b | `runOptimisticMutation` (multi-store cascade) |
| 追加 2 option-list handleDeleteImmediate | Step 0 §1.4 (helper スコープ追加) | T1b | `runOptimisticMutation` (multi-store cascade) |
| 追加 3 card-tags-section 4 関数 revert 握り潰し | Step 0 §1.4 (= #12 と同件) | T2 | T2 完了条件で grep 確認 (#12 と統合解消) |

**取り残し 0 確認**:
- audit §10.2 (a) #1〜#14 = 14 件すべて本 spec の task に 1:1 マッピング
- Step 0 §1.4 追加 3 件すべて本 spec の task に 1:1 マッピング
- audit §9 巻末「Sync-fix-1 既知合流」 4 件 (tag drift = #10 / ClientEntityMutation = #13 / newId = #14 / Web Locks = #8) すべて消化
- → **Sync-fix-2/3 を起こす必要なし**。 本 sprint で Sync-fix シリーズを打ち切る

**spec 後の他 sprint 引継ぎ確認**:
- retry 意味論 (Y-2、 audit §10.3 (b) #11)、 24h cap 撤廃 → 30d 化 (Y-2、 audit §3 P1 [Codex-only])、 bound 追加 (Y-2、 audit §2 [Codex-only])、 dependent multi-mutation atomic group (Grid-2 設計時)、 Drizzle vs zod SSoT 化 (波 3)、 pull response zod 化 (Phase 4) は本 spec のスコープ外として §1.3 で明示済
