# Tag-2b + Tag-2c: card_tags 同期 + 書込 handler 追加 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`。 各 task の完了条件は `pnpm test` + `pnpm build` 緑。 全 task 完了後に **単一 commit** (Task 3 末尾)。 push しない (OT が stg smoke)。

**Goal:** card_tags を独立 pull stream で IDB に 1:1 mirror、 cards.updated_at bump 起点の取り直しで「関連付けのみ外す」 ケースも別端末に伝える。 card 編集 UI からの書込は CARD_FIELD_HANDLERS に `tag_option_ids` を 1 entry 追加するだけ。

**Architecture (案 a 確定、 sessions doc §4 参照):**

```
[server: handler]                    [server: pull]                   [client: pull orchestrator]
whole-set replace                    cards stream  ──────┐            (順序が重要)
  ↓                                  card_tags stream ──┐│
DELETE card_tags WHERE card_id       tombstones stream ─┐││           1. cards bulkPut (mirror 更新)
INSERT × N                                              │││           2. 変更カード集合 = pull で受け取った cards.id
cards.updated_at = now()                                ▼▼▼              → db.card_tags.where('card_id').anyOf(...).delete()
  └─ 別端末は cards 増分 pull で       ┌─────────────────┐              3. card_tags bulkPut (新集合反映)
     変更カードを検知 ────────────────►│ pull response   │ ────────►   4. tombstone cascade purge (option/card 起点)
                                       └─────────────────┘              5. cursor write
```

**Tech Stack:** TypeScript strict / Drizzle ORM / Dexie 5.x / Vitest / zod (既存依存のみ、 追加なし)。

**前提:**

- Tag-2a (commit `d10af71`) で `CARD_FIELD_HANDLERS` map + dispatch table 化が完了
- Tag-1 で `card_tags` schema (PK=`(card_id, option_id)`、 user_id 列あり)、 `tag_options` / `tag_categories` 着地済
- 設計判断: `docs/superpowers/sessions/2026-06-06-tag-2-design-decisions.md` §4 (案 a 確定) / §5 (whole-set replace + cards.updated_at bump)
- Tag-2a stg smoke 全 PASS 報告: `docs/superpowers/sessions/2026-06-06-tag-2a-stg-smoke.md`

**全 task 共通ルール:**

- TypeScript strict 維持、 全 SQL で owner-scope (`WHERE user_id=?`)
- cursor 戦略: `card_tags.created_at` ベース (INSERT only 表のため、 updatedAt 列なし)
- **案 a の取り直し経路の順序** (`lib/sync/pull.ts` の tx 内):
  1. `cards.bulkPut` → 2. **変更カード集合の card_tags 全削除** → 3. `card_tags.bulkPut` → 4. tombstone cascade purge → 5. cursor write
- 順序の意味: (2) で「変更カード分の旧 card_tags を空にしてから」、 (3) で「server が返した新集合を upsert」。 これにより「`[A,B] → []`」 (server が card_tags 0 件返す) でも IDB 側で行が残らない
- 全 task 完了後に **単一 commit** (Task 3 末で):
  ```
  feat(tag): Tag-2b card_tags 独立同期 + Tag-2c 書込 handler 追加 [no-review]
  ```

---

### Task 1: Tag-2b 実装 (card_tags 独立 pull stream + 取り直し)

**Files:**

- Create: `lib/db/card-tags-pull.ts` (~60 行: mapper + `getCardTagsDelta`)
- Create: `lib/db/card-tags-pull.test.ts` (~80 行: pure mapper test)
- Modify: `lib/sync/sync-meta.ts` (+5 行: `cardTagsCursor` key 追加)
- Modify: `app/api/pull/route.ts` (+25 行: since_card_tags 受領 / payload に card_tags + cursors.card_tags 追加)
- Modify: `app/api/pull/route.test.ts` (+40 行: card_tags stream assertion)
- Modify: `lib/client-db.ts` (+30 行: `ClientCardTag` 型 + Dexie v5 で `card_tags` store 追加)
- Modify: `lib/sync/pull.ts` (+50 行: PullResponse 拡張 + 取り直し経路 + cascade purge)
- Modify: `lib/sync/pull.test.ts` (+150 行: 取り直し test + cascade test + 空集合化 test)

**目的:** server の card_tags 独立 stream を整備し、 client は **cards 増分 pull で受け取った cardId 集合を起点に「変更カードの card_tags を全削除 → bulkPut で取り直し」** を行う。 これで「`[A,B] → []`」 も正しく別端末に伝わる (= 案 a)。

**制約:**

- `getCardTagsDelta(userId, since)`: WHERE `user_id=? AND created_at >= since` で SELECT、 戻り値 `{rows: ClientCardTag[], maxCreatedAt: string | null}` (既存 `tag-options-pull.ts` と同形)
- Dexie v5 schema は **新規 store 追加のみ** (既存 store 不変、 v4 → v5 migration コストは v3 → v4 と同等 = 安全)
- `ClientCardTag` 型: `{card_id, option_id, user_id, created_at}` (sync_status なし、 read-only mirror)
- pull.ts の tx 内順序 (再掲): cards bulkPut → **changedCardIds の card_tags 全削除** → card_tags bulkPut → tombstone cascade purge → cursor write
- cascade purge: tombstone bulkDelete 段に 2 行追加 (`db.card_tags.where('option_id').anyOf(tagOptionIds).delete()` / `.where('card_id').anyOf(cardIds).delete()`)
- 取り直し経路と cascade purge は **独立した経路**: 取り直しは「card 編集起点」、 cascade purge は「option/card 削除起点」、 両者が同一 row を消しても idempotent

**完了条件:**

- `pnpm test` 全件緑 (新規 + 既存)
- `pnpm build` 緑
- `lib/sync/pull.test.ts` に以下のシナリオ test が緑:
  - **取り直し**: cards bulkPut 対象 cardId の card_tags が全削除されてから新集合 bulkPut される
  - **空集合化** (案 a の核心): cards に変更 cardId 含む + card_tags 0 件 → IDB 該当 cardId の card_tags 行ゼロ
  - **cascade**: option_id tombstone で card_tags が消える、 card_id tombstone も同様
  - **cursor**: `cards_card_tags` cursor が `sync_meta` に保存される

---

### Task 2: Tag-2c 実装 (handler 追加 + cards.updated_at bump)

**Files:**

- Modify: `lib/cards/card-field-handlers.ts` (+60 行: `tagOptionIdsSchema` + `handleTagOptionIds` + CARD_FIELD_HANDLERS に 1 entry 追加 + drizzle / schema import 追加)
- Modify: `lib/cards/card-field-handlers.test.ts` (+150 行: handler 個別 test)
- Modify: `app/api/entity-mutations/bulk/route.test.ts` (+20 行: mock の handlers map に tag_option_ids 追加 + dispatch test 1 件)

**目的:** `CARD_FIELD_HANDLERS.tag_option_ids` を新設、 whole-set replace + `cards.updated_at` bump を 1 handler 内で完結。 registry は Tag-2a 構造でそのまま動く。

**制約:**

- `tagOptionIdsSchema = z.array(z.uuid()).max(100)` (上限 100 個、 1 card あたりタグ数の現実的上限)
- `handleTagOptionIds` の流れ:
  1. schema 検証失敗 → 'failed'
  2. 重複排除 (`[...new Set(parsed.data)]`)
  3. card 存在 + owner check (`SELECT id FROM cards WHERE id=cardId AND user_id=userId`)、 0 row → 'failed'
  4. option_id 全件の存在 + user_id 一致確認 (bulk SELECT、 `inArray(tagOptions.id, optionIds)` + `eq(tagOptions.userId, userId)`、 件数比較で 1 件でも欠ければ 'failed')
  5. `DELETE card_tags WHERE card_id+user_id`
  6. optionIds 0 件でなければ `INSERT card_tags VALUES (cardId, optionId, userId) × N`
  7. **`cards.update().set({updatedAt: sql\`now()\`}).where(...)`** を発行 (sessions doc §4.5 / §5.2 確定、 別端末への変更伝播の起点)
  8. 'applied' return
- cards.updated_at bump は handler 独自に SQL 発行 (既存 `updateCardField` helper は SET 列を必要とするため、 tag_option_ids 経路は cards 行を「touch のみ」 する独立 SQL)
- CARD_FIELD_HANDLERS に追加: `tag_option_ids: handleTagOptionIds,` の 1 行のみ。 `CardFieldName` 型は `as const satisfies` の型導出で自動拡張
- bulk endpoint test の mock の handlers map に `tag_option_ids: vi.fn(async () => 'applied')` を追加し、 「dispatch 経路が tag_option_ids handler を呼ぶ」 test を 1 件追加

**完了条件:**

- `pnpm test` 全件緑
- `pnpm build` 緑
- `card-field-handlers.test.ts` に以下が緑:
  - 正常 (空配列 → 全削除 + bump、 N 件 → N 件 INSERT + bump、 既存集合との置換)
  - 重複排除 (`[A, A, B]` を受領 → INSERT は 2 件)
  - 値検証失敗 (非 uuid、 101 件超) → 'failed' + bump なし
  - card 不在 → 'failed' + bump なし
  - 他 user option_id 混在 → 'failed' + bump なし
  - 存在しない option_id 混在 → 'failed' + bump なし
  - owner-scope eq spy gate (cards.id / cards.user_id / card_tags.card_id / card_tags.user_id / tag_options.user_id)

---

### Task 3: 統合 commit + smoke 観点書き

**Files:**

- Create: `docs/superpowers/plans/2026-06-06-tag-2b-2c-smoke-checklist.md` (~80 行: stg smoke 観点 + 手順)

**目的:** Tag-2b + Tag-2c の差分を **1 commit** にまとめ、 OT が stg smoke できる観点 list を書き起こす。

**制約:**

- commit message:
  ```
  feat(tag): Tag-2b card_tags 独立同期 + Tag-2c 書込 handler 追加 [no-review]
  ```
  - 案 a 確定の経緯、 取り直し経路の順序、 cards.updated_at bump 方針更新を要約
- smoke checklist に含める観点:
  1. Tag-2a 挙動が引き続き不変 (前回 smoke 観点 A.1〜A.6 / B.7〜B.8)
  2. Tag-2c handler 経路 (DevTools fetch 直送で `field='tag_option_ids'` mutation 送信)
     - `value=[option_uuid_A]` → IDB card_tags に 1 件 + cards.updated_at bump
     - `value=[option_uuid_B]` → 旧 A 削除 + B 追加 (whole-set replace)
     - `value=[]` → IDB card_tags 該当 cardId 行ゼロ (空集合化 = 案 a の核心)
  3. cascade purge: option を削除 (admin UI なしのため Tag-2 では unstable、 試験的に DevTools 経由 or skip)
  4. console error 0、 全 API 200、 entity_mutations pending 残らず
  5. cards.updated_at が tag mutation 後に bump されている (Network response / 次回 pull の cards 行で観測)
- **push しない** (OT が stg smoke 後判断)

**完了条件:**

- smoke checklist 作成済
- `pnpm test` + `pnpm build` 緑 (Task 1+2 で確認済、 確認のため再 run)
- 全変更 (Task 1+2+3) を **1 commit** で develop に積む

---

## Plan 完了後の OT smoke (push 前停止後)

OT 確認:

1. Tag-2b の取り直し経路: 1 端末で `[option_uuid_A]` → `[option_uuid_B]` → `[]` の whole-set replace 連続送信 → 各時点で IDB の card_tags 該当 cardId 行を観測 (順次 1 件 → 1 件 → 0 件)
2. Tag-2c handler: DevTools fetch 直送で値検証失敗ケース (存在しない option_id) を試し、 per-mutation failed が返り IDB 不変
3. cards.updated_at bump 検証: tag mutation 送信前後で `db.cards.get(cardId)` を観測、 updated_at が ISO 文字列として進む
4. 既存 Tag-2a smoke 観点 (A.1〜A.6 / B.7〜B.8 / C.9 / D.10〜D.11) を再 run、 regression なし
5. cleanup: Tag-2a smoke で残った変更 (Smoke-2a-A / sort_key=null / question_text 末尾 / opt2 正解化) + Tag-2b smoke で新規追加した card_tags を restore (最後にまとめて)

OT 緑判定後、 Tag-3 (OCR からの card_tags 書込) or Tag-4 (タグ付与 UI) の plan に着手。
