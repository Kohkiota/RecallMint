# Sync-1 stg smoke (entity_mutations 汎用化) — 2026-06-05

S-sync-1 (commit 0773b42) を stg にデプロイ後の動作確認。 Playwright MCP で
ブラウザ自動操作 + Dexie / Network 直接観察。 目的は「card 編集の挙動が汎用化前と
完全に不変か」 の検証。

## 前提

- stg URL: https://stg.recallmint.nekotest.net/app
- account: komail9server+clerk_test@gmail.com (Clerk dev、 OTP=424242)
- 試験: `Sync1 Smoke Exam` (id `08ec7835-db67-4e45-b402-db776ba93048`)
- card: 手動 create → id `1f4a1cc7-bed0-4d6b-aad1-bffcbe1dc245`

## 前提確認

- [x] `/api/card-mutations/bulk` → **404** (旧 endpoint 撤去)
- [x] `/api/entity-mutations/bulk` → 200 (empty payload で `{ok:true, applied:0, failed:[]}`)
- [x] Dexie store 一覧に `entity_mutations` 存在、 旧 `card_mutations` 消失
- [x] `entity_mutations` の secondary index に `[entity_type+entity_id]`, `mutation_id`, `sync_status` (schema v3 と一致)

## 観点別 PASS/FAIL

### 観点 1: card 編集の基本 (title / question_text / explanation / memo / options)

**PASS**

各 field 編集ごとに `/api/entity-mutations/bulk` POST、 payload に
`entity_type:"card"` + `entity_id:<card uuid>` + `op:"update_field"` + `patch:{field, value}`。

| field | mutation_id | applied | failed | value |
|-------|-------------|---------|--------|-------|
| title | 8ed1f366 | 1 | 0 | "Smoke Title" |
| question_text | (略) | 1 | 0 | "Smoke question text" |
| explanation_text | (略) | 1 | 0 | "Smoke explanation" |
| memo | 0ec98be4 | 1 | 0 | "Smoke memo" |
| options (whole-array) | 3496d461 | 1 | 0 | `[{id:'1',text:'(選択肢1)',isCorrect:true}]` |

options は immediateDrain (checkbox toggle、 debounce なし即 POST)、 他は 500ms
debounce 後 1 POST。 旧 card-mutations と同挙動。

### 観点 2: card 追加 → create mutation

**PASS**

「＋ カードを追加」 click で 1 mutation POST:
```json
{
  "mutation_id": "655b352c-6e1f-4ec8-a4f4-5eaa9b2cc676",
  "entity_type": "card",
  "entity_id": "1f4a1cc7-bed0-4d6b-aad1-bffcbe1dc245",
  "op": "create",
  "patch": { "exam_id": "08ec7835-...", "title": "新規カード 1", "sort_key": "1",
             "question_text": "(問題文を入力してください)",
             "options": [{"id":"1","text":"(選択肢1)","isCorrect":false}],
             "explanation_text": null, "memo": null }
}
```
response: `applied:1`、 Dexie cards に行追加 + sync_status='synced'。

### 観点 3: card 削除 → delete mutation + skipLog 慣習

**PASS** (skipLog は code path 確定)

削除 confirm → POST:
```json
{
  "mutation_id": "f6f48233-...",
  "entity_type": "card",
  "entity_id": "1f4a1cc7-...",
  "op": "delete",
  "patch": {}
}
```
response: `applied:1`、 Dexie cards 0 件 (mirror 削除済)。

skipLog 慣習 (server 側 entity_mutations 行を作らない) の **直接観測** はブラウザ
からは不可 (server table を読む経路なし)。 ただし P1-P3 unit test
(`app/api/entity-mutations/bulk/route.test.ts`) で `delete 正常系: log INSERT
なし` を fake-tx の `mutationInsertValues === null` で検証済、 registry
(`lib/sync/server/entity-mutation-registry.ts:160-171`) で `skipLog: true` 明示
設定。 stg 上は applied:1 の正常応答だけ確認。

### 観点 4: 連打 coalesce

**PASS**

(a) 同 card 同 field 連続編集 (`Burst 1` → `Burst 12` → `Burst 123` → `Burst 1234`、 80ms 間隔):
- POST 数: 1 (合計 1 POST、 4 ではない)
- payload の mutation 数: 1
- patch.value: 最終値 `"Burst 1234"` のみ
- → 同 field 4 入力が 1 mutation に畳まれた

(b) 複数 field 編集 (title / question_text / explanation / memo):
- 各 field 1 POST × 1 mutation = 4 POST に分散 (field ごとに別 coalesce key)
- 各 POST の patch.field が異なる
- → field ごとに 1 mutation の挙動を確認

### 観点 5: 冪等 (二重送信なし)

**PASS** (capture wrapper artifact 1 件あり、 server 視点では二重なし)

- 全 mutation の `mutation_id` unique (6 POST × 1 mutation = 6 unique UUID、 duplicates=0)
- server response 全件 `applied:1, failed:[]` (server 側 UNIQUE 制約は機能)
- in-flight Set + Web Locks の二重防衛は code path で確定済

オフライン復帰時に capture wrapper が 2 重 install されたアーティファクトで
record が 2 件出たが、 server response の `applied:1` × 2 から判断: 実 POST は
1 回、 record が 2 倍だっただけ (server に同 mutation_id が 2 回届いていれば
2 回目は skipped で applied:0 になる; 実際は 2 回とも applied:1 = 1 POST + 計測 2 重)。

### 観点 6: オフライン復帰

**PASS**

手順:
1. `window.fetch` を `/api/entity-mutations/bulk` で TypeError throw に差し替え (offline 模擬)
2. memo 編集 (`Offline memo edit`) → Tab で blur
3. Dexie 観察: `mutation_id=aeec820e, sync_status='pending', last_attempted_at=14:37:07.979Z` 残置
4. fetch 復元 + `window.dispatchEvent(new Event('online'))` で controller kick
5. 2 秒後 観察: 同 `mutation_id=aeec820e` で再 POST → applied:1 → `sync_status='synced'`、 pending 0

→ 失敗時 pending 残置 + online 復帰で同一 mutation_id 再送 = 冪等担保で再適用。

### 観点 7: pull の rename 巻き込み事故なし

**PASS**

`browser_navigate` で page reload 後の Dexie 確認:
- cards 行: 編集内容が全て反映 (`title:"Burst 1234"`, `question_text:"Smoke question text"`, `explanation_text:"Smoke explanation"`, `memo:"Offline memo edit"`, `options[0].is_correct:true`, `correct_answer_ids:["1"]`)
- `sync_meta.cards_cursor`: 最新編集時刻 (`2026-06-05T14:37:36.678Z`) に更新
- console error なし

→ pull は今回未改修だが、 rename / dispatch 化で巻き込まれていない。

### 観点 8: Dexie entity_mutations の sync_status

**PASS**

全 9 行 (create 1 + update_field 7 + delete 1) すべて `sync_status:'synced'`、
pending 0。 entity_type は全て `'card'`。 flush 後の状態は完全に synced。

```
{ totalRows: 9, byStatus: { synced: 9 }, pendingCount: 0,
  entityTypesPresent: ['card'] }
```

---

## 全 PASS

Sync-1 stg smoke 全 PASS。 旧 card_mutations から汎用 entity_mutations への
作り変えは、 card 編集の挙動 (IDB 直書き / debounce / coalesce / 冪等 /
Web Locks / 失敗時 pending 残置 / pull 反映) を完全に不変で維持している。

## 補足注記

- Playwright headless で Cloudflare Turnstile に 1 度ブロック (sign-up 時)。 OT が手動で account 作成して回避済。 sign-in flow は Turnstile 通過 OK。
- fetch wrapper 二重 install (online 復帰時) は smoke 計測アーティファクト。 production 経路は無影響。
- server 側 `entity_mutations` table の row content は browser から直接確認不可。 skipLog 慣習は unit test (P1-P3) と code path に依拠。
