# Stage 1 (試験詳細 local-first 書込化) — stg smoke 手順

- 日付: 2026-05-31
- 対象: `POST /api/card-mutations/bulk` (新設、Stage 1)
- 実施: OT (本 endpoint は Clerk セッション + 実 DB 書込を伴うため)
- 完了後: 問題なければ各 Stage 1 commit に `[reviewed]` を amend (削除 op / 外部副作用を含むため CLAUDE.md「重要 Fix の裏取り」に従い OT 実機確認後に付与)

## 前提 / 認証 hand-off

- endpoint は `middleware` 非保護 (`/api` 素通し) だが、handler 内 `getCurrentUser()` でセッション必須。未認証は 401 (`unauthenticated` / `user_not_synced`)。
- **最も簡単な認証 hand-off**: stg アプリにテストユーザーで**ログインした状態**で、ブラウザ DevTools Console から `fetch('/api/card-mutations/bulk', ...)` を叩く。Clerk セッション cookie が自動で乗る (手動トークン抽出不要)。
- まだ client 配線 (Stage 2) はないので、本 smoke は **REST レベルのみ**。
- **破棄前提のテスト用 exam / card** で実施 (実 DB を書き換える)。

## 事前に用意する値

- `EXAM_ID`: テストユーザー所有の試験 id (試験詳細 URL `/app/exams/<id>` or DB から)。
- `CARD_ID`: 同試験の既存 card id (**update_field 専用**)。DB or 詳細画面から。
- `DELETE_CARD_ID`: 同試験の**別の**既存 card id (**delete 専用の捨て card**)。**`CARD_ID` と必ず別の card にする** — 同一 card を update してから delete すると観点1/観点2 の判定が混ざる (例: update した card が消えて title 変更を確認できない、delete 用 card の有無が update 観点に干渉する) ため、update 用と delete 用は最初から別 card に分ける。
- `NEW_CARD_ID`: create 用に **client 生成** する uuid (`crypto.randomUUID()`)。
- `mutation_id` は各 op ごとに `crypto.randomUUID()` で採番。
- `edited_at` は `new Date().toISOString()`。

## Console スニペット (ログイン済み stg タブで実行)

```js
const post = (mutations) =>
  fetch('/api/card-mutations/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mutations }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

const EXAM_ID = '<exam-uuid>'
const CARD_ID = '<existing-card-uuid>'          // update_field 専用
const DELETE_CARD_ID = '<another-existing-card-uuid>' // delete 専用の別 card (CARD_ID と別物にする)
const NEW_CARD_ID = crypto.randomUUID()         // create 用 client 生成 id
const now = () => new Date().toISOString()

// --- update_field: 既存 card の title を変更 ---
const mUpd = {
  mutation_id: crypto.randomUUID(), card_id: CARD_ID, op: 'update_field',
  patch: { field: 'title', value: 'smoke更新タイトル' }, edited_at: now(),
}
// --- create: client 生成 id で新 card ---
const mCreate = {
  mutation_id: crypto.randomUUID(), card_id: NEW_CARD_ID, op: 'create',
  patch: {
    exam_id: EXAM_ID, title: 'smoke新規card', sort_key: null,
    question_text: 'smoke問題文',
    options: [{ id: '1', text: '選択肢1', isCorrect: true }],
    explanation_text: null, memo: null,
  }, edited_at: now(),
}
// --- delete: 既存 card を削除 (DELETE_CARD_ID = CARD_ID とは別の捨て card。必須) ---
const mDel = {
  mutation_id: crypto.randomUUID(), card_id: DELETE_CARD_ID, op: 'delete',
  patch: {}, edited_at: now(),
}

await post([mUpd, mCreate, mDel])   // → { status: 200, body: { ok:true, applied:3, failed:[] } } を期待
```

## 観点と期待結果

### 1. 新規適用 (1 回目 POST)
- 前提: `CARD_ID`(update_field 用)と `DELETE_CARD_ID`(delete 用)は**別の card**。同一 card にすると判定が混ざる(下記 cards 確認が成立しない)ため必ず分ける。
- response: `{ ok:true, applied:3, failed:[] }` (3 op とも適用)。
- DB:
  - `cards`: `CARD_ID.title = 'smoke更新タイトル'` (update した card は残存) / `NEW_CARD_ID` の行が存在 (title='smoke新規card', `correct_answer_ids = ['1']` ← server が options.is_correct から再生成) / `DELETE_CARD_ID` の行が消えている。
  - `exams.card_count`: 当該 exam で +1 - 1 = 差し引き 0 (create で +1、delete で -1)。create のみ/delete のみで個別確認するとより明確。
  - `card_mutations`: `mUpd` と `mCreate` の mutation_id 行が存在し `applied_at` 非 NULL。**`mDel` の行は存在しない** (delete は log を書かない設計 — FK cascade で永続不可、自然冪等で担保)。
  - `tombstones`: `DELETE_CARD_ID` の `entity_type='card'` 行が 1 つ。

### 2. 冪等再送 (まったく同じ payload を 2 回目 POST)

> ⚠️ **誤判定注意: 再送の期待 response は `applied:0` ではなく `applied:1`(delete のみ)。**
> `applied:0` を期待して `1` を見て fail 判定しないこと。理由:
> - **update_field / create** は `card_mutations` の `mutation_id` 冪等 gate で skip され、`applied` に**乗らない**(2 回目は同 mutation_id が既存のため apply 経路に入らない)。
> - **delete** は log を持たない設計(FK cascade で永続不可)のため `mutation_id` 冪等 gate を**通らず apply 経路を通る**。card は既に不在なので `applyCardDelete` は no-op だが、route 上は「適用した」とカウントするため `applied` に **delete 分の 1 が乗る**。これが正しい挙動。
> - **PASS 判定の本質は `applied` の値ではなく「DB が 1 回目から不変」**(二重 insert なし / `card_count` drift なし / 重複 tombstone なし)。`applied:1` でも下記 DB が不変なら PASS。

- response: update_field/create は gate で skip → `applied` に入らない。delete は自然冪等で再適用 (no-op) → `applied` に 1 計上。→ **`applied:1`**(delete のみ)、`failed:[]`。
- DB が 1 回目から **変化しない**こと (← これが本観点の PASS 判定の核):
  - `cards`: title 二重変更なし / `NEW_CARD_ID` 重複 insert なし。
  - `exams.card_count`: **変化なし** (create 再 INSERT は ON CONFLICT で弾かれ card_count 非加算 / delete 再実行も GREATEST guard + card 既不在で no-op)。
  - `card_mutations`: `mUpd`/`mCreate` 行は **1 つのまま** (重複なし)。
  - `tombstones`: `DELETE_CARD_ID` 行は **1 つのまま** (onConflictDoNothing)。

### 3. 異常系 (任意)
- exam 不在 create (`patch.exam_id` を他人/存在しない uuid) → その mutation のみ `failed:[<mutation_id>]`、他は適用。
- patch 不正 (create で `question_text` 欠如 等) → その mutation のみ `failed`、batch 全体は 400 にならない。
- envelope 不正 (`mutation_id` 非 uuid / `mutations` 1000 超) → **400** (全体 reject)。
- 未認証 (ログアウト状態で POST) → **401**。

## DB 確認手段
- Supabase SQL editor or `pnpm db:studio` (drizzle studio)。
- 例: `SELECT id,title,correct_answer_ids FROM cards WHERE exam_id='<EXAM_ID>';` / `SELECT * FROM card_mutations WHERE user_id='<uid>' ORDER BY created_at DESC;` / `SELECT card_count FROM exams WHERE id='<EXAM_ID>';` / `SELECT * FROM tombstones WHERE entity_id='<DELETE_CARD_ID>';`

## smoke 後
- 全観点 PASS → Stage 1 の 3 feat/refactor commit (`6c5a69b` / `c75ea16` / `2fc6a60`) に `[reviewed]` を amend (chore `5b291aa` は対象外)。
- 旧 server action 直叩き path (UI 既存編集) は無改修・非回帰 — 詳細画面の従来編集が引き続き動くことも併せて確認するとよい。
