# Tag-2a: apply 層を field handler registry に分解 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 各 task の完了条件は `pnpm test` + `pnpm build` 緑 + Critical 0。 全 task 完了後に **単一 commit** (Task 3 末尾)。 push しない (OT が stg smoke)。

**Goal:** card mutation の `update_field` op を、 単一 switch (`buildSetClause`) から **field 名 → handler 関数の dispatch table** に分解する。 挙動不変、 既存 test 緑、 Tag-2c で `tag_option_ids` を 1 entry 追加するだけで済む構造に。

**Architecture:** `lib/cards/card-field-handlers.ts` を新設し、 6 個の cards 列 field を独立 handler 関数として実装。 registry の `applyCardUpdateField` は `CARD_FIELD_HANDLERS` map を引いて呼ぶ thin dispatcher に簡素化。 旧 `buildSetClause` / `applyCardFieldUpdate` / `UpdateCardFieldName` / `ApplyCardFieldUpdateResult` export は撤去。

**Tech Stack:** TypeScript strict / Drizzle ORM / Vitest / zod (既存依存のみ、 追加なし)。

**前提:**
- chore commit (7df0a93) で dead `applyCardCreate` (placeholder 採番版) 撤去済
- 設計判断は OT 承認済 (案 Y 採用、 sessions doc は Task 3 で起こす)
- production caller の grep verify 完了 (`lib/sync/server/entity-mutation-registry.ts` のみ、 `app/api/entity-mutations/bulk/route.test.ts` は mock import)

**全 task 共通ルール:**
- TypeScript strict 維持、 既存 owner-scope (`WHERE id AND user_id`) を全 handler で必須
- 各 handler は `(tx: DbExecutor, cardId: string, userId: string, value: unknown) => Promise<ApplyResult>` 統一 signature
- 値検証 zod は各 handler 内に閉じる (registry envelope は `field: z.string().min(1)` に緩和、 unknown field は dispatch 段 'failed')
- 0 row return / 値検証失敗 → 'failed'、 1 row return → 'applied'
- 既存挙動不変: `cards.updatedAt = now()` bump / '' → null 正規化 (sort_key / explanation_text / memo) / correct_answer_ids 再生成 (options)
- 既存 owner-scope (`eq(cards.id, cardId)` + `eq(cards.userId, userId)`) を全 handler の eq spy で gate
- 完了条件は各 task 個別に。 最終 commit は Task 3 末で 1 つだけ

---

### Task 1: field handler registry 実装 + registry dispatch 移行

**Files:**
- Create: `lib/cards/card-field-handlers.ts` (~200 行)
- Create: `lib/cards/card-field-handlers.test.ts` (~200 行)
- Modify: `lib/sync/server/entity-mutation-registry.ts` (`cardUpdateFieldPatchSchema` 緩和、 `applyCardUpdateField` を CARD_FIELD_HANDLERS dispatch に、 旧 import 撤去)
- Modify: `lib/cards/apply-card-mutation.ts` (`buildSetClause` / 値 schema 群 / `UpdateCardFieldName` / `applyCardFieldUpdate` / `ApplyCardFieldUpdateResult` 撤去、 関連 import 整理)
- Modify: `lib/cards/apply-card-mutation.test.ts` (buildSetClause / applyCardFieldUpdate test を `card-field-handlers.test.ts` に移植、 残置は applyCardCreateWithId / applyCardDelete + 共有 helper のみ)

**目的:** 6 cards 列 field (title / sort_key / question_text / explanation_text / memo / options) を独立 handler に分解、 `CARD_FIELD_HANDLERS` map に登録、 registry dispatch から引かせる。

**制約:**
- 各 handler の挙動は既存 `buildSetClause + applyCardFieldUpdate` と一字一句一致 (既存 test の fixture / assertion を card-field-handlers.test.ts に同値移植)
- options handler は correct_answer_ids 再生成 (client 改竄耐性) を必ず維持
- sort_key / explanation_text / memo の '' → null 正規化は handler 内で完結
- registry envelope 緩和 `field: z.string().min(1)` + dispatch 段 `if (!handler) return 'failed'` の組合せで「未知 field → failed」 を確保 (envelope 早期 reject 喪失の代替 gate を test で必ず追加)
- 旧 export 撤去: `bulk/route.test.ts` の mock import は Task 2 で対応。 本 task では bulk/route.test.ts の一時 fail を許容

**完了条件:**
- `card-field-handlers.test.ts` に 6 handler × (正常 / 値検証失敗 / 0 row / owner-scope eq spy / updatedAt bump) + dispatch (未知 field → failed) が緑
- `apply-card-mutation.test.ts` の applyCardCreateWithId / applyCardDelete テストは無傷で緑
- `pnpm build` 緑
- `bulk/route.test.ts` は Task 2 完了まで一時 fail を許容 (本 task の完了条件ではない)

---

### Task 2: bulk/route.test.ts の mock を CARD_FIELD_HANDLERS dispatch 形に書き換え

**Files:**
- Modify: `app/api/entity-mutations/bulk/route.test.ts` (update_field 系 5〜6 件の mock を差し替え + 未知 field test 1 件追加)

**目的:** Task 1 で `buildSetClause` / `applyCardFieldUpdate` 撤去によって壊れる mock import を、 新方式 (`CARD_FIELD_HANDLERS` 内の特定 handler を spy 化) に書き換える。

**制約:**
- 既存 test 意図 (registry dispatch / log INSERT 有無 / per-mutation failed) を変えない、 mock 対象だけ差し替え
- 新 mock: `vi.mock('@/lib/cards/card-field-handlers', ...)` で `CARD_FIELD_HANDLERS.title` 等を spy 化、 戻り値 ('applied' | 'failed') を test ごとに制御
- 既存 `applyCardCreateWithId` / `applyCardDelete` の mock 経路は無傷 (Task 1 で撤去していない)
- 新規 1 件: 「update_field with unknown field name → per-mutation failed、 log INSERT なし、 他 mutation には影響なし」 (envelope 緩和の代替 gate)
- buildSetClause 文言を含む既存 it 名は handler dispatch 文言に rename

**完了条件:**
- `bulk/route.test.ts` 全件緑、 update_field 系 assertion が新 mock 経由で同等担保
- `pnpm test` 全件緑
- `pnpm build` 緑

---

### Task 3: コメント文言更新 + sessions doc + 統合 commit

**Files:**
- Modify: `app/(app)/app/exams/[id]/_components/inline-text-field.tsx` (line 63, 147: 「server 側 buildSetClause が '' → null」 → 「server 側 handler が '' → null」 + 具体 handler 名 / 参照 path 併記)
- Modify: `app/(app)/app/exams/[id]/_components/inline-option-row.tsx` (line 12, 50: buildSetClause 参照を `CARD_FIELD_HANDLERS.options` (applyOptionsUpdate) 参照に修正)
- Create: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` (Tag-2 全体設計判断 + 技術負債メモ、 ~200 行想定)

**目的:** code 動作には影響しないコメント参照の drift を解消 + Tag-2 全体の設計判断 (案 Y 採用 / handler registry / card_tags 独立 stream / cascade purge 方式) を sessions doc に固定 + apply-tag-mutation の手書き check 整流を技術負債としてメモ。

**制約:**
- コメント文言は handler 名と source path を具体的に書く (例: `lib/cards/card-field-handlers.ts` の `applySortKeyUpdate`)
- sessions doc 必須節:
  1. Tag-2 採用設計 (案 Y、 2a/2b/2c 分解の意図)
  2. Tag-2a: field handler registry 化の構造判断 (envelope zod 緩和 / 未知 field は dispatch 段 'failed' / 旧 export 撤去)
  3. Tag-2b: card_tags 独立 pull stream + tombstone 経由 client 自前 purge (cards.updated_at bump 不要の意思決定根拠)
  4. Tag-2c: registry に field='tag_option_ids' 追加、 handler 内で card_tags whole-set replace
  5. 技術負債: `apply-tag-mutation.ts` の `applyTagCategoryUpdate` / `applyTagOptionUpdate` の手書き type check を将来 handler registry + zod 化で整流 (Tag-2 scope 外、 次に registry を触る sprint で同時対応)
- sessions doc は実装中の判断記録、 設計書 (`docs/design.md`) ではない (実装書き換えなし)

**完了条件:**
- コメント文言 4 箇所修正済 (inline-text-field 2 + inline-option-row 2)
- sessions doc 作成済
- `pnpm test` 全件緑 (コメントのみで test 影響なし、 確認のため最終 run)
- `pnpm build` 緑
- 全変更 (Task 1+2+3 の差分 + sessions doc + chore で消した差分は含まれない) を **1 commit**:
  ```
  feat(tag): Tag-2a apply 層を field handler registry に分解 [no-review]
  ```
- **push しない** (OT が stg smoke 後判断)

---

## Plan 完了後の OT smoke (push 前停止後)

OT 実機確認:
- stg deploy 後、 既存 card 編集 (title / options / 作成 / 削除) が従来通り動作
- inline-text-field / inline-option-row の値クリア + 空文字 → null 正規化が破綻していない
- Network 観測で `POST /api/entity-mutations/bulk` の update_field 経路が registry → handler 流れで applied=N を返す
- (任意) 不正 field 名混入時の per-mutation failed が UI に伝播 (実用上は client が unknown field を送らない、 server defensive のみ)

OT 緑判定後、 Tag-2b + Tag-2c の plan に着手。
