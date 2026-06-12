# Sprint Y-1: Sync-fix-1 (拡大版) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (本 sprint の既定実装方式、 CLAUDE.md 明示) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** audit §10.2 (a) 14 項目 + 追加 3 件を打ち切り解消、 全 optimistic 経路を共有 helper (`lib/sync/optimistic-mutation.ts`) に収束、 production silent lost write 2 件を T1a 単独 PR で先出し封じ込め。 Sync-fix-2/3 を不要にする。

**Architecture:** 案 B (pure function 3 関数 helper) + tag mutation zod 統一 (`lib/validation/tag.ts`) + ClientEntityMutation discriminated union 投影 (`lib/sync/shared/mutation-schemas.ts`、 server-only 不付)。 T1a 先出し PR で P0 hotfix、 以降 T1b〜T7 continuous。

**Spec:** `docs/superpowers/specs/2026-06-12-sync-fix-1-expanded-design.md` (1d37fbd)。 本 plan は spec §3 マッピング + §5 task 構成を実装契約に落とす。

**Tech Stack:** Next.js 16 / TS strict / Drizzle / Dexie (IndexedDB) / vitest / zod / pnpm 10。

---

## 全体ルール (各 task 冒頭で参照、 個別 task で再掲しない)

1. **TDD**: 各 task は test 先行。 既存 test を壊さない。 helper 系は new test、 既存 file 修正系は既存 test に case 追加 + regression 確認。
2. **atomic 性契約**: helper 内部は `db.transaction('rw', ...stores, db.entity_mutations, async () => {...})`、 enqueue throw → tx callback rethrow → Dexie auto-rollback。 catch は tx **外** で 1 回のみ (silent + `logger.warn` 1 行、 `throwOnError: true` で rethrow)。
3. **debounce drain は caller 側**: helper は atomic write 契約に純化、 呼ぶタイミングは caller 責務 (case 1 reflection)。
4. **flush は helper 内蔵 fire-and-forget**: `void runGuarded*Flush().catch(() => {})` を tx 外で。 caller は flush を渡さない。
5. **userId は引数必須**: 空文字 placeholder 禁止、 `runOptimisticCreate` は空文字で fail-fast (`console.error` + 早期 throw)。 既存の `user_id: ''` は T2 で構造的に消える。
6. **CLAUDE.md 絶対ルール**: Stripe / Clerk / AI 既知 + sprint 完了 gate (whole-repo `pnpm lint --max-warnings=0` exit 0) + commit `[reviewed]` tag。
7. **review 経路**: 各 task PR 直前 `superpowers:requesting-code-review` skill canonical (template + general-purpose subagent + 厳格 prompt)、 改変禁止。
8. **stop checkpoint**: T1a 完了で OT 先行 push 判断、 以降 T1b〜T7 は continuous (報告のみ)。 **stop 条件**: (a) spec/audit と矛盾する判断要、 (b) grep 再集計が想定と大幅乖離 (T7)、 (c) 既存 test の想定外 fail。

**File Structure** (新規 / 主要 modify):
- 新規 `lib/sync/optimistic-mutation.ts` (T1a/T1b)
- 新規 `lib/sync/with-web-lock.ts` (T3)
- 新規 `lib/sync/new-id.ts` (T3)
- 新規 `lib/validation/tag.ts` (T4)
- 新規 `lib/sync/shared/mutation-schemas.ts` (T5)
- modify 多数 (詳細は各 task)

---

### Task T1a: helper 最小骨組 + P0 hotfix (先出し PR)

**Files:**
- Create: `lib/sync/optimistic-mutation.ts`、 `lib/sync/optimistic-mutation.test.ts`
- Modify: `app/(app)/app/exams/[id]/_components/inline-card-list.tsx` (handleAddCard L161-205)、 `app/(app)/app/exams/[id]/_components/delete-card-button.tsx` (onConfirmDelete L36-52)

- [ ] **目的**: `runOptimisticMutation` + `runOptimisticCreate` の 2 関数 (~100 行) を helper 骨組として実装し、 P0 lost write 2 件 (#1 #2) を helper 経由で書き換える。 silent data loss を最速封じ込め。
- [ ] **制約**: spec §2.1 signature 通り (引数名 / 型 / 戻り型を厳密に守る)。 reference 実装は `card-tags-section.tsx handleToggle:611-661` + `lib/tags/reorder-handlers.ts`。 全体ルール 1-5 + 7 全件。 `userId` 必須引数で空文字 fail-fast。
- [ ] **完了条件**: helper test 6 case (main path / silent catch / `throwOnError` rethrow / multi-store rollback / create flow newId 採番 / `userId=''` fail-fast)。 P0 2 file が helper 経由化 (旧 `void enqueueEntityMutation(...).catch(...)` pattern を grep で 0)。 whole-repo `pnpm lint --max-warnings=0` exit 0、 `pnpm typecheck` exit 0、 Critical 0、 [reviewed] tag。 stg smoke = 「inline 編集 N 回 → enqueue throw mock → mirror auto-rollback」 1 case DevTools MCP 実走 (CC 担当)。
- [ ] **🛑 T1a 完了 = stop checkpoint**: chat に「whole-repo lint exit 0 確認済 / Critical 0 / smoke 結果」 を 1 メッセージ報告、 OT 先行 push 判断仰ぐ。

---

### Task T1b: 残り atomic 化 (#3 #4 + 追加 1 2)

**Files:**
- Modify: `lib/sync/optimistic-mutation.ts` (`runOptimisticUpdate` 追加、 ~50 行)、 `lib/sync/optimistic-mutation.test.ts` (case 追加)、 `app/(app)/app/exams/[id]/_components/inline-text-field.tsx` (commit L168-189)、 `app/(app)/app/exams/[id]/_components/inline-option-row.tsx` (commit L185-213)、 `app/(app)/app/tags/_components/category-list.tsx` (handleConfirmDelete L170-207)、 `app/(app)/app/tags/_components/option-list.tsx` (handleDeleteImmediate L144-176)

- [ ] **目的**: `runOptimisticUpdate` を追加 + #3 #4 + 追加 1 2 (cascade delete 2 件) を helper 経由化、 残る lost write/atomic 経路を全消化。
- [ ] **制約**: 全体ルール 1-5 + 7。 `runOptimisticUpdate` の revert 失敗時は `logger.warn` 1 行 + silent return (案 a 取り直し)。 cascade delete は `stores=[card_tags, tag_options, tag_categories]` の multi-store rw tx。
- [x] **T1a 引継ぎ既知 issue — 決着済 (2026-06-12): 仕様誤認、 実挙動が正**。 経緯: (1) T1a smoke #4 で「2 連続追加で両方 auto-edit」 を期待値として 3/3 FAIL → 「race」 と切り分け本 task の前段とした。 (2) 実装側 fix を 2 回試行 (fa4aa7b sync 採番先発火、 63f6b98 newCardId Set 化 + functional updater) したがいずれも実環境で 3/3 FAIL、 jsdom test は false-green を出していた。 (3) OT 実機検証 (1 枚目 textarea focus 状態で 2 秒以上待ち → 「+ カードを追加」 click → 1 枚目 display 復帰 + 新カードに focus) で **タイミング無関係 = race ではなく button click による blur-commit という構造的挙動**と確定、 「両方 auto-edit」 仕様自体を撤回 (前の編集が確定して閉じ、 新カードに focus 移行 = UX として正しい)。 commit 63f6b98 の Set 化は将来仮想化 (Grid-1) + 複数 pending id 追跡基盤として維持。 test 側 (`inline-card-list.test.tsx:450-478`) は現実仕様 (枚数 +2 + 編集状態は新カードのみ) に書き直し済 + jsdom 限界の註明記。
- [ ] **完了条件**: 4 file 移行完了、 旧 void enqueue + IIFE pattern が対象 file の grep で 0。 helper test に update case 2-3 件追加 (revert 成功 / revert 失敗 silent / `isNoop` 早期 return)。 `pnpm lint`/`typecheck` exit 0、 Critical 0、 [reviewed]。 **加えて T1a 引継ぎ既知 issue (上記) の切り分け結論 (test 環境限定 or 実環境発生) と対処を記録**。

---

### Task T2: 4 関数統合 + 共通 hook (#5 #6 #7 + 追加 3)

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` (handleRenameCategory / handleSetCategoryColor / handleRenameOption / handleSetOptionColor L111-234)、 `app/(app)/app/tags/_components/option-row.tsx` (enqueueUpdate L118-161)、 `app/(app)/app/tags/_components/category-row.tsx` (enqueueUpdate L86-124)、 `app/(app)/app/tags/_components/option-create-form.tsx` (handleSubmit L65-121)、 `app/(app)/app/tags/_components/category-create-form.tsx` (handleSubmit L49-103)

- [ ] **目的**: card-tags-section 4 関数 + enqueueUpdate 2 file + create form 2 file の計 8 callsite を helper 経由化、 `user_id: ''` 空文字 placeholder を構造的に消す。
- [ ] **制約**: 全体ルール 1-7。 **debounce drain は helper に入れず caller 側で保持** (`option-row.tsx` の既存 500ms debounce 構造を維持、 helper 呼出は debounce 後)。 rename/color 系は `throwOnError: true` (caller が UI 通知)、 create form は `userId` 引数で空文字 fail-fast。 **PR 分割は事前に決めず、 T2 着手時 diff 規模 (touch ファイル数 / +/- 行数) を実測 → OT に T2a/T2b 分割提案 → OT 判断後着手** (case 2 reflection)。
- [ ] **完了条件**: 8 callsite 移行完了。 **`card-tags-section.tsx` 4 関数の revert `.catch(...)` 握り潰しが helper 内蔵化で消えていること** (grep `\.catch\(.*err.*logger\.warn` を `card-tags-section.tsx` 配下で 0、 追加 3 と #12 の解消証明)。 `user_id: ''` を `tags/_components/` 配下で grep して 0。 `pnpm lint`/`typecheck` exit 0、 Critical 0、 [reviewed]。 stg smoke = 「create form 並走 race (同 category 内同名 option を 2 タブ同時 submit) → 偽 failed 出ない」 1 case (CC 実走)。

---

### Task T3: Web Locks lock runner + newId 共有化 (#8 + #14)

**Files:**
- Create: `lib/sync/with-web-lock.ts`、 `lib/sync/new-id.ts`、 各 test ファイル
- Modify: `lib/sync/entity-mutation-flush.ts` (runGuardedEntityMutationFlush L31-88)、 `lib/sync/review-flush.ts` (runGuardedFlush L33-120)、 `lib/sync/pull.ts` (runGuardedPull L300+)、 `lib/sync/review-events.ts` (newId L32 削除 + import)、 `lib/sync/entity-mutations.ts` (newId L25 削除 + import)

- [ ] **目的**: Web Locks wrapping を `lib/sync/with-web-lock.ts` に 1 関数化 (`lockName` / `flushAll` / `logEventPrefix`)、 newId を `lib/sync/new-id.ts` に集約。
- [ ] **制約**: 全体ルール 1, 6, 7。 `MinimalLockManager` 型 + `resolveLocks` 解決 pattern は helper 内に閉じ込め。 既存 3 file の挙動を変えない (logger event 名 / lock 取得失敗時の outcome 値 / 既存 retry 連動を維持)。
- [ ] **完了条件**: 旧 inline lock wrapping + inline newId が repo 内 grep で 0 (helper file 内のみ残る)。 既存 lock 関連 test 全 pass + helper 単体 test 2-3 case (lock 取得成功 / lock-busy / flush throw)。 `pnpm lint`/`typecheck` exit 0、 Critical 0、 [reviewed]。

---

### Task T4: tag mutation zod 統一 + dup check 自己除外 (#9 + #10)

**Files:**
- Create: `lib/validation/tag.ts`
- Modify: `lib/sync/server/entity-mutation-registry.ts` (tag_category / tag_option create / update_field patch schema L187-249)、 `lib/tags/apply-tag-mutation.ts` (update if 文 L75-95 + L227-294、 dup check L188-192)、 `lib/tags/apply-tag-mutation.test.ts` (case 追加)

- [ ] **目的**: tag mutation の create / update zod drift を `lib/validation/tag.ts` field schema 集約で統一、 `apply-tag-mutation.ts:191` dup check に `ne(tagOptions.id, optionId)` を追加して mutation_id race 起源の偽 failed を解消。
- [ ] **制約**: 全体ルール 1, 6, 7。 field schema 名は `tagNameSchema` / `tagColorSchema` / `tagSortKeySchema` / `tagCategoryIdSchema` (spec §4.1)。 apply 側 update if 文を field 名 → 個別 schema dispatch table 化 (`card-field-handlers.ts` の structure を参照)。 dup check fix は SQL WHERE 句に `ne(tagOptions.id, optionId)` 1 行追加のみ、 同 file の rename path / category_id move path は既に自己除外済 = 触らない。
- [ ] **完了条件**: 既存 test 全 pass + case 追加 4 件 (name trim 効果 / name max 効果 / category_id uuid 効果 / dup check 自己除外 race regression)。 `pnpm lint`/`typecheck` exit 0、 Critical 0、 [reviewed]。

---

### Task T5: shared `mutation-schemas.ts` + ClientEntityMutation 投影 (#13)

**Files:**
- Create: `lib/sync/shared/mutation-schemas.ts`
- Modify: `lib/sync/server/entity-mutation-registry.ts` (schema 部を shared へ移管、 apply dispatch + `server-only` 残置)、 `lib/client-db.ts` (ClientEntityMutation L147-157)、 `lib/sync/entity-mutations.ts` (EnqueueEntityMutationInput L33-40 + 周辺 cast 削除)、 `lib/sync/server/entity-mutation-registry.test.ts` (envelope reject case 追加)、 `lib/cards/apply-card-mutation.ts` (L148 等 `patch as z.infer<...>` cast 削除)

- [ ] **目的**: server registry の patch zod を `lib/sync/shared/mutation-schemas.ts` (server-only 不付、 `lib/validation/card.ts` precedent 踏襲) に移管、 `z.discriminatedUnion('entity_type', [...])` + 各 envelope 内 `z.discriminatedUnion('op', [...])` で集約。 `ClientEntityMutation` / `EnqueueEntityMutationInput` を envelope から派生、 client/server 型を SSoT 連動化。 Grid-2 bulk 土台 = N エンティティ一括口の型安全性を確立。
- [ ] **制約**: **plan / commit message 冒頭 1 行で「型レベル投影のみ、 runtime 挙動変更なし」 を契約化** (CLAUDE.md review pass 容易性)。 全体ルール 1, 6, 7。 envelope の wire format は変えない (failed / applied の客観挙動が変わらないこと)。 server registry を 2 ファイルに分割: schema 部 = shared (server-only 不付)、 apply dispatch = registry (server-only 残置)。 generic `RegistryEntry<EnvelopeT>` で apply 関数 signature と patch 型を連動。 **task 内の各 commit 後に `pnpm typecheck` を回す** (型投影の連鎖 error を早期検出、 case 3 reflection)。
- [ ] **完了条件**: envelope reject test 2 case 追加 (untrusted `entity_type` / `op` が `safeParse` で fail)。 `apply-card-mutation.ts:148` 等の `patch as z.infer<...>` cast を削除 (grep で残置 0)。 runtime 挙動変更なし (= 既存 test 全 pass、 新規 case のみ追加)。 `pnpm lint`/`typecheck` exit 0、 `pnpm build` exit 0 (型変更が広いため build まで通す)、 Critical 0、 [reviewed]。

---

### Task T7: `String(err)` helper 化 + 残存一括置換 (#11)

**Files:**
- Modify: `lib/logger.ts` (`warnFromError` 追加)、 `lib/logger.test.ts` (case 追加)、 T1〜T2 完了後に grep で再集計した残存 callsite (file 一覧は T7 着手時に確定)

- [ ] **目的**: `lib/logger.ts` に `warnFromError(event, ctx, err)` を追加し、 `String(err)` inline 文字列化の残存 callsite を一括置換。 `err` を Error のまま `expandError` に渡し、 name/message/stack/cause/code を構造化保持。
- [ ] **制約**: 全体ルール 1, 6, 7。 **scope は T1〜T2 完了後に grep `String\(err\)` / `err: String\(err\)` で再集計した残存 callsite のみ** (T1〜T2 で helper 経由化により相当数が先に消えるため、 plan の完了条件を**固定件数にしない**、 case 3 / 修正点 3 reflection)。 対象は `app/(app)/app/**/_components/**` 配下に限定 (`lib/db/serialize-db-error.ts` / `lib/logger.ts` 内部の意図的 String 化は対象外)。 helper signature: `warnFromError(event: string, ctx: Record<string, unknown>, err: unknown): void`。
- [ ] **完了条件**: 対象 scope の grep `String\(err\)` 残存 0 (chat に grep 出力を 1 行貼って明示)。 `pnpm lint`/`typecheck` exit 0、 Critical 0、 [reviewed]。

---

## Self-Review (spec 突合 + placeholder + 型一貫性)

**1. Spec 突合**: spec §3 マッピング表 (14 + 追加 3 件) に対し本 plan task 対応 — #1 #2 = T1a / #3 #4 + 追加 1 2 = T1b / #5 #6 #7 + 追加 3 = T2 / #8 #14 = T3 / #9 #10 = T4 / #13 = T5 / #11 = T7 / #12 = T2 内で grep 確認。 **取り残し 0** (Sync-fix-2 不要、 spec §10 対照表と一致)。
**2. Placeholder scan**: TBD / TODO / 「適宜」 / 「同上」 無し。 各 task で完了条件を具体化。
**3. 型一貫性**: helper API 名 (`runOptimisticMutation` / `runOptimisticCreate` / `runOptimisticUpdate`)、 schema 名 (`tagNameSchema` 等 / `entityMutationEnvelopeSchema`)、 ファイル名 (`optimistic-mutation.ts` / `with-web-lock.ts` / `new-id.ts` / `validation/tag.ts` / `sync/shared/mutation-schemas.ts`) を全 task で統一。

self-review pass。

---

## 行数報告

CLAUDE.md sprint 規律: plan 完成時点で最終行数を報告すること。 本 plan **約 165 行** (上限 250、 余裕あり)。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-12-sync-fix-1-expanded.md`。

CLAUDE.md 既定 = `superpowers:subagent-driven-development` (本 sprint も既定方式)。 task 単位 fresh subagent + task 間 review で実装。 OT が明示しない限り `executing-plans` (inline 一括) は使わない。

OT 承認後、 subagent-driven-development で T1a から実装開始。
