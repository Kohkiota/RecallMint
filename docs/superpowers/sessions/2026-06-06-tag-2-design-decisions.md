# Tag-2 設計判断記録 (2026-06-06)

タグ機能 (3 entity: `tag_categories` / `tag_options` / `card_tags`) の同期配線
sprint「Tag-2」 全体の設計判断を、 実装着手前の brainstorming + Tag-2a 実装中
に確定したものとして固定する。 本 doc は実装中の判断記録であり、 設計書
(`docs/design.md`) の書換ではない (= 仕様変更ではなく既存仕様に対する実装方式
の選定根拠)。

---

## 1. 経緯 / 採用設計

### 1.1 Tag-1 の到達点

Tag-1 (commit `24f8c0f`) で以下が既に着地している:

- schema: `tag_categories` / `tag_options` / `card_tags` 3 表を CREATE、
  `cards.custom_props` / `cards.tags` 2 列を DROP
- マスター書込: `lib/tags/apply-tag-mutation.ts` で
  `applyTagCategoryCreate/Update/Delete` + `applyTagOptionCreate/Update/Delete`
- pull: `lib/db/tag-categories-pull.ts` / `lib/db/tag-options-pull.ts` を
  追加して `/api/pull/route.ts` の stream に並べた
- registry: `entity-mutation-registry.ts` に `tag_category` / `tag_option`
  entry を追加 (bulk endpoint は無修正で受ける)

Tag-1 では **マスター (categories / options) のみ** 同期が通る状態。
`card_tags` (card と option の junction) の同期、 および card 編集 UI からの
書込経路は **Tag-2** の責務に切り出した。

### 1.2 当初 brief (案 X) と懸念

最初の brief は「`cards.tag_option_ids text[]` derived 配列列を cards に埋め、
既存 card outbox/pull に相乗り」 案 (= 案 X、 集約案)。 実装コストは最小だが
以下を再発させる:

- 将来 card に画像 (image attachments、 多対多) を載せるとき同じ問題を踏む
- 既存 pull stream (`tag_categories` / `tag_options` / `exams`) は独立 stream
  + Dexie 1:1 mirror なのに、 card_tags だけ集約だと形式が異質になる
- whole-array replace で「options 全件 + card_tags whole-set」 2 段 replace
  の衝突 race を握り込む

### 1.3 採用案 (案 Y)

`docs/superpowers/sessions/2026-06-05-tags-feasibility-investigation.md`
§11 (3 案比較: cards 集約 / 独立 stream / 既存相乗り) と §14 (push 汎用化)
の議論を踏まえ、 以下を採用:

1. apply 層を **field handler registry** に分解 (Tag-2a、 refactor、 挙動不変)
2. `card_tags` を **独立 pull stream + Dexie 1:1 mirror** で扱う (Tag-2b)
3. 書込は **既存 card outbox に相乗り** (Tag-2c)、 entity_type='card' /
   op='update_field' に field='tag_option_ids' を 1 entry 追加するだけ

各 sprint が薄く独立して進む (Tag-2a=refactor / Tag-2b=読出経路追加 /
Tag-2c=registry 1 entry 追加 + Tag-2b の cascade purge と連携)。

---

## 2. Tag-2 の sprint 分解

### Tag-2a (本 doc 起票時点で実装完了)

- 単一 switch (`buildSetClause` + `applyCardFieldUpdate`) を field 名 →
  handler 関数の dispatch table (`CARD_FIELD_HANDLERS`) に分解
- 挙動不変、 既存 test 同値移植、 `pnpm test` 1383/1383 緑
- 後続 Tag-2c で `tag_option_ids` field を 1 entry 追加するだけで済む構造

### Tag-2b (次 sprint)

- server: `lib/db/card-tags-pull.ts` 新設 (既存 `tag-options-pull.ts` と
  同形)、 `/api/pull/route.ts` の stream に追加
- client: Dexie v5 で `card_tags` store 追加 (PK=`[card_id+option_id]`、
  index `card_id` / `option_id` / `user_id`)、 `pull.ts` orchestrator で
  bulkPut + cursor write
- 削除 cascade = **client 自前 purge**: option/card tombstone 受領時に
  `db.card_tags.where('option_id').anyOf(...).delete()` /
  `.where('card_id').anyOf(...).delete()` を発行 (`cards.updated_at` bump
  不要 / 削除も last-write-wins に統一)
- UI 表示: cards + card_tags を `useLiveQuery` で join 表示

### Tag-2c (次々 sprint)

- `CARD_FIELD_HANDLERS` に `tag_option_ids` (value=`uuid[]`) 新 handler を
  1 entry 追加 (registry は Tag-2a の dispatch 構造でそのまま動く)
- handler 内: option_id の owner-scope 検証 → `DELETE card_tags WHERE
  card_id+user_id` → INSERT 新集合 (whole-set replace、 last-write-wins)
- bulk endpoint / 冪等 / coalesce / 部分失敗ポリシは無修正

---

## 3. Tag-2a: field handler registry の構造判断

### 3.1 dispatch table 化

- 旧: `buildSetClause(field, value)` が単一 switch で 6 列 (title / sort_key /
  question_text / explanation_text / memo / options) を分岐、
  `applyCardFieldUpdate` が呼ぶ
- 新: `lib/cards/card-field-handlers.ts` で各列を個別 handler 関数に分解し、
  `CARD_FIELD_HANDLERS` map (field 名 → handler) に登録。 統一 signature は
  `(tx: DbExecutor, cardId, userId, value: unknown) => Promise<ApplyResult>`
- 値検証 (zod) + 正規化 + cards owner-scoped UPDATE を **1 関数で完結**
  (旧 buildSetClause は値検証が外に出ていた構造の解消)

### 3.2 envelope zod の緩和と未知 field のガード

- 旧: `cardUpdateFieldPatchSchema` で field を `z.enum([...])` で固定
- 新: envelope は `field: z.string().min(1)` に緩和、 値検証は各 handler 内に
  閉じる。 未知 field の早期 reject 喪失分は **dispatch 段** で代替ガード
  (`applyCardUpdateField` 内 `if (!handler) return 'failed'`)。 gate の test
  は `app/api/entity-mutations/bulk/route.test.ts` に追加済
- 狙い: 新 field 追加時に envelope enum と handler の 2 箇所書換になる drift
  を避ける (envelope は形だけ、 内容は handler に閉じる)

### 3.3 撤去した export

- `buildSetClause` (lib/cards/apply-card-mutation.ts)
- `applyCardFieldUpdate` (同上)
- `UpdateCardFieldName` 型 export
- `ApplyCardFieldUpdateResult` 型 export
- `lib/cards/apply-card-mutation.ts` の値検証 zod 6 件 (handler に移植済)

### 3.4 前段 chore (commit 7df0a93)

Tag-2a 着手前に、 dead `applyCardCreate` (placeholder 採番版、
`applyCardCreateWithId` 移行後の置き忘れ) を撤去済。 Tag-2a の diff から
無関係 dead code を切り離すための前洗い。

### 3.5 挙動不変の保証

- owner-scope (`eq(cards.id, cardId)` + `eq(cards.userId, userId)`) を全 handler
  で維持、 `cards.updatedAt = sql\`now()\`` bump も全 handler で維持
- `'' → null` 正規化 (sort_key / explanation_text / memo) を handler 内で完結
- options handler は `correct_answer_ids` を `is_correct=true` から再生成
  (client 改竄耐性、 tech-spec §2.5.2 デノーマ)
- `card-field-handlers.test.ts` に 6 handler × (正常 / 値検証失敗 / 0 row /
  owner-scope eq spy / updatedAt bump) + dispatch (未知 field → failed) を網羅

---

## 4. Tag-2b: card_tags 独立 pull stream + cards.updated_at bump 起点の取り直し (案 a 確定 2026-06-07)

### 4.1 cards に derived 配列を埋めない判断 (案 X 却下)

§1.2 の通り cards.derived_array 案は将来の画像追加で再発する。 既存の
`tag_categories` / `tag_options` / `exams` の独立 stream + Dexie 1:1 mirror
形式に card_tags も合わせ、 pull / store / cursor の形を一律化する。

### 4.2 同期穴の発見と案 a 確定

当初 (本 doc 初版、 Tag-2a 完了時点) は「card_tags の created_at 増分
pull + option/card tombstone 起点の client 自前 purge」 だけで完結する想定
だった。 ところが Tag-2b 着手前の brainstorming (2026-06-07) で
**「関連付けのみ外す」** ケース ── card / option 双方とも生存、 card_tags
の行だけ消す (whole-set replace で `[A,B] → [A]` や `[A,B] → []`) ── が、
同期 2 軸 (変更/追加 = updated_at/created_at 増分、 削除 = tombstone) の
どちらにも乗らない **同期穴** であることが判明した。

理由:

- option / card 自体は削除されていないため、 どの tombstone も発生しない
- card_tags の created_at 増分 pull は INSERT 行しか拾えないため、
  「DELETE のみ」 や 「DELETE → 新集合 INSERT」 のうち「外れた option_id」
  を別端末に伝えられない (減少が検知できない)

確定方針 (**案 a**): 「card_tags をカードの属性として、 `cards.updated_at`
起点で取り直す」。

- **読み取り**: card_tags は独立 stream で IDB に 1:1 mirror (created_at
  増分 + bulkPut)。 client は cards + card_tags + tag_options を
  `useLiveQuery` で突き合わせて表示
- **書き込み**: タグ編集は card への操作として扱う (entity_type='card' /
  op='update_field' / field='tag_option_ids' / value=`uuid[]`)。 handler は
  card_tags を whole-set replace (全 DELETE → 新集合 INSERT、 差分計算
  なし)
- **変更伝播**: whole-set replace の後に **`cards.updated_at` を bump**。
  別端末は cards 増分 pull で「変更カード」 を検知 → そのカードの
  card_tags を IDB から全削除 → card_tags 増分 pull の bulkPut で取り直す。
  これにより「関連付け外し」 (減少) も伝わる
- **削除伝播 (option / card 自体の削除)**: 既存の option / card tombstone
  を client が受け取り、 道連れの card_tags を purge (option_id / card_id
  で該当行削除)。 これは Tag-1 / 案 Y で既定の経路を踏襲

### 4.3 却下した代替案: card_tags 専用 tombstone

card_tags に独自 `id uuid PK` を振り (現在の複合 PK `[card_id, option_id]`
→ 単一 PK)、 削除を card_tags 専用 tombstone (entity_type='card_tag') で
伝える案。 一貫性 (全テーブルを独立エンティティとして同 2 軸に揃える) は
高いが却下:

1. whole-set replace のたびに「DELETE 行 − INSERT 行 = 外れた分」 を
   差分計算して tombstone に書く処理が server handler に必要 (書き込みが
   複雑化、 バグ源)
2. card_tags への id 追加というスキーマ変更 (migration コスト + 既存複合
   PK の置き換え)
3. 付け替えのたびに tombstone 量産 (UI 1 操作 = 1 行外す → tombstone 1 件)、
   tombstone 表の肥大化

案 a は書き込みを **「全消し全入れ + updated_at bump」** に保ち、 複雑さを
読み込み側の **「取り直し」** (これも全消し全入れで素朴) に寄せる。 両側
とも差分を考えない素朴な操作で統一できる。

### 4.4 一貫性の整理 (将来のため)

案 a の一貫性の軸 = **「junction (結びつき表) は親エンティティにぶら下げる」**。
card_tags は card の属性として cards 同期 (`cards.updated_at` 起点) に従う。

将来の画像添付 (card ↔ image の結びつき = card_tags と同構造) も同じ
**型紙** で実装する:

- image を新しく付け / 外す → `cards.updated_at` bump
- `card_images` は独立 pull stream + 「変更カードの card_images を全削除 →
  取り直し」
- junction 系は **全てこのパターン** で拡張する (= 将来 entity 追加時に
  毎回 brainstorm し直さなくて済む)

### 4.5 cards.updated_at bump の方針更新 (前回判断の巻き戻し)

当初の sessions doc (本 doc 初版、 Tag-2a 完了時点) では:

> 案 Y の利点: cards.updated_at bump が不要 (card 編集と無関係な option
> 削除で card 行を bump しなくて済む)

と書いていたが、 §4.2 の同期穴判明により判断を更新:

- **タグ変更で `cards.updated_at` を bump する** が確定方針
- タグは card の属性なので、 意味的にも自然 (= derived field の bump では
  なく、 card の状態変化を表す bump)
- option 自体の削除 (`tag_option` の DELETE) は **依然として
  `cards.updated_at` を bump しない** (option 削除は card 編集ではない、
  §4.2 「削除伝播」 経路で別途処理)

つまり「card 編集経路 = bump」 / 「option / card の削除 cascade =
bump しない」 で書き分ける。

### 4.6 実装の骨子 (詳細は Tag-2b plan に展開)

- server: `lib/db/card-tags-pull.ts` 新設 (`getCardTagsDelta(userId, since)`)、
  `/api/pull/route.ts` の stream に追加
- client: Dexie v5 で `card_tags` store 追加 (PK=`[card_id+option_id]`、
  index `card_id` / `option_id` / `user_id`)
- pull orchestrator (`lib/sync/pull.ts`): cards bulkPut で **変更カード
  集合** を検知 → そのカードの card_tags を **事前に全削除** → card_tags
  bulkPut で取り直し (= 案 a の核心)
- 削除 cascade = client 自前 purge (option / card tombstone 受領時に
  card_tags 該当行を delete)、 これは §4.2 と独立した経路

---

## 5. Tag-2c: 書込は card outbox 相乗り

### 5.1 entity_type を新設しない判断

- card 編集 UI から「タグ option を付け外し」 する操作は、 user 体験としては
  「card の 1 属性編集」 と等価
- 既存 card outbox / bulk endpoint / coalesce 機構をそのまま使いたい
- Tag-2a の handler registry 構造によって、 `field='tag_option_ids'` を 1
  entry 追加するだけで dispatch が成立する

### 5.2 whole-set replace の挙動

- value=`uuid[]` を受け、 option_id 全件の owner-scope 検証 (欠ければ
  per-mutation failed) → `DELETE card_tags WHERE card_id+user_id` →
  `INSERT (card_id, option_id, user_id)` × N
- **whole-set replace 後に `cards.updated_at = sql\`now()\`` を bump**
  (§4.5 確定)。 別端末は cards 増分 pull で変更カードを検知 → そのカード
  の card_tags を IDB から全削除 → card_tags 増分 pull で取り直す経路に
  乗る (= 案 a 起点)
- coalesce: 同一 card_id の `tag_option_ids` は最新 value で上書き (既存
  update_field と同方針、 last-write-wins)
- 冪等: 同一 value 再送も DELETE → INSERT は等価結果。 並走衝突は registry
  の in-flight Set + mutation_id UNIQUE で除外

---

## 6. 技術負債 (Tag-2 scope 外)

### 6.1 apply-tag-mutation の手書き check 整流

`lib/tags/apply-tag-mutation.ts` の `applyTagCategoryUpdate` /
`applyTagOptionUpdate` は Tag-1 着地時点の **手書き type check** (zod 不使用、
if-else で field 名分岐) のまま。 card 側は Tag-2a で field handler registry
+ zod 化に整流したが、 同一 sprint で全部触ると diff が膨らむため tag 側は
据え置き。

**次に registry を触る sprint** (Tag-3 系のタグ UI 拡張、 もしくは別 entity
追加時) で `apply-tag-mutation.ts` も整流する:

- `TAG_CATEGORY_FIELD_HANDLERS` / `TAG_OPTION_FIELD_HANDLERS` map を新設、
  各 handler は `(tx, entityId, userId, value) => Promise<ApplyResult>` 統一
  signature + 値検証 zod を内側に閉じる
- registry envelope を `field: z.string().min(1)` に緩和、 未知 field は
  dispatch 段で 'failed' (card 側 §3.2 と同方針)
- test 構造も card 側と一致させる (`card-field-handlers.test.ts` を reference)

関連 file: `lib/cards/card-field-handlers.ts` (reference 実装) /
`lib/sync/server/entity-mutation-registry.ts` (tag_category / tag_option entry
の envelope を緩和する場所)

### 6.2 inconsistency の許容期間

card 側と tag 側で apply 層の形式が異なる状態が次の registry 触り sprint
まで残る。 どちらも `EntityApplyFn` signature を満たすため design.md /
02-tech-spec.md には影響なし、 残コストは開発時の mental load 増のみ。

---

## 7. 参照

- 設計調査: `docs/superpowers/sessions/2026-06-05-tags-feasibility-investigation.md`
  (§1 LocalSync 書込経路 / §8 Feasibility 判定 / §11 junction 表現比較 /
  §14 push 汎用化 / §15 pull 整理 / §16 sprint 順序)
- Tag-2a plan: `docs/superpowers/plans/2026-06-06-tag-2a-field-handler-registry.md`
- 前段 chore commit `7df0a93` (dead `applyCardCreate` placeholder 撤去) /
  Tag-1 着地 commit `24f8c0f` (schema + 同期配線)
- 参照のみ (実装によって書き換えない): `docs/02-tech-spec.md` §2.5.2 (cards
  デノーマ / correct_answer_ids 再生成) / `CLAUDE.md` (user_id 必須 / owner-scope)
