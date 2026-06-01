# 選択肢 id 編集と正答突き合わせの安全性調査 (read-only)

- 日付: 2026-06-01
- 種別: 調査 (no code change)
- 発端: OT 報告 — 「しけ編集画面で選択肢の ABC にあたる部分を編集で消すと `(id)` と
  表示される。複数選択肢が `(id)` のまま保存できることも確認した。正解を id で
  取っているのか？ `(id)` を正解として文字列一致で取っていたら必ずバグる」

## 結論 (TL;DR)

1. **正答突き合わせは選択肢 id (`opt.id`) の集合一致**。ラベル文字列でも `(id)`
   placeholder 文字列でもない。OT が恐れた「`(id)` 文字列を正解として一致」という
   バグは**構造的に発生しない**。
2. ただし **OT が見ている「ABC にあたる部分」= `opt.id` そのもの**であり、これは
   inline 編集で**ユーザー編集可能**かつ**採点キー**。ここが本当の弱点。
3. id 空 / id 重複は **server が両経路で reject** (canonical DB は守られる)。
4. しかし **client 楽観 mirror は text 空しか sanitize せず id を見ない**ため、
   空/重複 id が一旦 Dexie mirror に書かれる。**reject 後の revert 機構が無く**、
   **演習は Dexie mirror 優先で読む**ため、編集端末では次の pull まで誤採点が起こりうる
   (過渡的・ローカル限定。サーバー正本は無傷)。

## データフロー裏取り

### 正答判定の方式 (最重要)

`app/(app)/app/study/smart/_components/session-runner.tsx:201-209`
```ts
const correctIds = options.filter((o) => o.is_correct).map((o) => o.id)
const correct = equalSet(selectedIds, correctIds)   // id 配列の集合一致 (順序非依存)
```
- `selectedIds` はボタンクリックで `opt.id` を push (同 file 内 toggleOption)。
- `equalSet` (`_lib/equal-set.ts`) は `Set` 化して要素一致を見るだけ。
- → 判定は **id only**。テキスト/ラベル/`(id)` placeholder は一切参照しない。

### 「ABC にあたる部分」の正体

`session-runner.tsx:456` で選択肢ラベルは `{opt.id}` を直接描画 (A/B/C 変換は無く、
`a`/`1`/`opt-1` 等の id がそのまま出る)。
→ **OT が編集している「ABC 部分」は装飾ラベルではなく `opt.id` フィールド本体**。
これを消すと id が空になり、表示が `(id)` placeholder になる
(`_components/inline-option-row.tsx:379` の `placeholder="(id)"`、空時に
`inline-option-row.tsx:552-565` で placeholder 表示)。

### server 側 validation (canonical DB は守られる)

`lib/cards/apply-card-mutation.ts:69-75` (update_field 経路) と
`app/api/card-mutations/bulk/route.ts:99-105` (create 経路) の双方:
```ts
z.array(optionSchema)
  .min(1).max(50)
  .refine((opts) => new Set(opts.map((o) => o.id)).size === opts.length,
    { message: '選択肢の id が重複しています' })
```
- `optionSchema.id = z.string().min(1)` (`lib/validation/card.ts:15`) → **空 id 拒否**。
- 上記 refine → **重複 id 拒否**。
- reject 時 `buildSetClause` が `ok:false` → `processMutation` が `'failed'` →
  `failed[]` で 200 返却、**DB 未保存**
  (`bulk/route.ts:276-280`, `351-373`)。
- `correct_answer_ids` は client 入力を信用せず `is_correct` から server 再生成
  (`apply-card-mutation.ts:129-134`)。

→ **サーバー正本には空 id / 重複 id は決して入らない**。

### client 楽観 mirror の穴 (実害の経路)

`inline-option-row.tsx:166-209` `commit()`:
```ts
const sanitized = target.filter((o) => o.text.trim().length > 0)  // text のみ判定、id を見ない
...
getClientDb().cards.update(cardId, { options: sanitized, correct_answer_ids })  // 楽観書込
enqueueCardMutation({ ..., patch: { field: 'options', value: payload } })       // outbox
```
- text さえあれば空/重複 id の row も Dexie `cards` mirror に書かれ、outbox に積まれる。
- server flush 失敗時 (`lib/sync/card-mutations.ts:295-301`):
  失敗分は `pending` 残置で再試行されるのみ。**楽観 mirror を revert する処理は無い**。
- 楽観値が消えるのは次回 `pull.ts:120-123` の `bulkPut` で server 値が上書きするまで
  (しかも since cursor 範囲に当該 card が入る前提で、保証は弱い)。

### 演習は mirror 優先で読む

`app/(app)/app/study/smart/_components/study-session-host.tsx:56-63`
```ts
let chosen: Card[] = serverCards
const dexieCards = await getDueCardsFromDexie(userId, sessionLimit)
if (dexieCards.length > 0) chosen = dexieCards   // Dexie が 1 件でもあれば server 値を破棄
```
→ 編集端末で Dexie に空/重複 id が残っていると、その options がそのまま `SessionRunner`
に渡り `equalSet` 採点に乗る。

## 誤採点の具体像 (Dexie に残った場合)

- **全選択肢 id を空 `""` に**: `correctIds=[""]`, どのボタンも `opt.id=""` →
  `selectedIds=[""]` で常に正解扱い (Set が潰れる)。
- **2 択の id が重複**: 正解選択肢と同 id の不正解を選んでも id 一致で誤って正解。

## 影響範囲の確度

- サーバー正本: **無傷** (validation で reject)。他端末・再 pull 後は正常。
- 編集端末のローカル: 楽観 mirror に残る間だけ誤採点しうる (**過渡的**)。
- `(id)` 文字列そのものが採点に混入する経路: **無し** (OT の元の懸念は杞憂)。

## 改修候補 (判断待ち、本セッションでは未実施)

- A. `commit()` の sanitize で id 空/重複の row も除外 (text と同様に楽観段階で弾く)。
- B. そもそも inline 編集で `opt.id` を編集可能にしない (採点キーを user 編集対象から外す)。
  ラベル表示が必要なら id とは別の表示用 label を持つか、id は read-only 化。
- C. flush failed 時に該当 card の楽観 mirror を server 値へ即 revert。
- 最小実効は B (採点キーを編集不能化) か A。詳細設計は brainstorming/spec で。
