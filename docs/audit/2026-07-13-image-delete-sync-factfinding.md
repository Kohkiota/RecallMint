# 画像削除の同期経路 事実確認 — 削除がサーバーにどう伝わるか

- **日付**: 2026-07-13(記録)/ 調査 HEAD = `develop` `bd0d1f2`
- **性質**: read-only 調査のみ。実装 / migration / 変更なし。
- **目的**: 「カードから画像を外す / カードを削除」の削除がサーバーへどう伝わるかを実コードで確定し、GC の主機構を「削除イベント駆動(tombstone or diff)」にできるかの分岐点を判定する。
- **裏取り**: 全て現 HEAD の実ファイル / 関数 / 行で確認(prior fact-finding を再導出せず、該当箇所を直接 Read)。

---

## Q1. カードの画像削除は tombstone に乗るか

**結論: 乗らない。画像外し編集は `cards.images` の whole-array replace(`update_field`)として届くのみ。カード削除は card 単位の tombstone + 物理削除で届くが、tombstone は画像情報を持たない。**

### tombstone の値域に image/asset は無い

`tombstones.entityType` = `$type<'exam' | 'card' | 'tag_category' | 'tag_option'>()`(`lib/db/schema.ts:786-788`)。**`'image'` / `'asset'` は存在しない**。grep(`entity_type.*image|asset`・`op.*'delete'.*image`)= **image/asset が tombstone / delete-op の対象になる箇所ゼロ**。画像 / asset は sync entity ではなく、card の jsonb フィールド(`cards.images`)+ server-only の `assets` table(outbox 同期対象外)。

### 画像外し編集 = update_field 上書き(tombstone なし)

`removeImageFromCard`(`lib/media/upload.ts:838-851`):
```ts
const before = await readCardImages(cardId, [])
const after  = before.filter((i) => i.key !== assetId)   // :845 該当 key を配列から除く
await commitImages(cardId, before, after)                 // :846
```
`commitImages`(`upload.ts:488-511`)が emit する mutation:
```ts
mutation: { entity_type: 'card', entity_id: cardId, op: 'update_field',
            patch: { field: 'images', value: after } }   // :498-503
```
→ **削除された assetId は「新配列から消えている」だけ**。tombstone も delete op も発生しない。server へ届くのは `value: after`(新配列)のみ。関数コメントも「asset/R2 object は残す」(`upload.ts:829-830`)と明記 = 画像外しは意図的に asset を残す操作。

### カード削除 = card tombstone + 物理削除(patch 空)

client emit(単票 `delete-card-button.tsx:43-49` / bulk `use-bulk-card-delete.ts:59-64`)は同一 shape:
```ts
{ entity_type: 'card', entity_id: cardId, op: 'delete', patch: {} }
```
**`patch: {}` = 画像情報を一切運ばない**。server apply `applyCardDelete`(`lib/cards/apply-card-mutation.ts:131-168`)は tombstone INSERT(entityType='card', entityId=cardId のみ)→ `cards DELETE` → `bumpExamCardCount(-1)`。tombstone は cardId しか持たず、その card がどの assetId を参照していたかは記録しない。

## Q2. サーバーは「消えた assetId」を知れるか

**結論: 現状の apply では知れない(旧値が payload にも無く、更新前 SELECT もしない)。ただし更新前 SELECT を 1 回足せば diff 可能で、client 側は既に消えた assetId を保持している。**

### 旧値は mutation payload に無い

- update_field images の payload は `value: after`(新配列)のみ(Q1)。旧配列は送らない。
- delete の payload は `patch: {}`(Q1)。

### server apply は更新前 images を SELECT しない

- `handleImages`(`lib/cards/card-field-handlers.ts:168-190`): 新配列を zod 検証 → 新 UUID key の ready 実在を assets への IN query で確認(:176-187)→ `updateCardField(tx, cardId, userId, { images })`(:189)で **images 列を wholesale SET**。**現 `cards.images` を SELECT する行は無い**(grep 上、apply 層で `from(cards)` するのは `apply-card-mutation.ts:139` の `SELECT {examId}` と `card-field-handlers.ts:220` の handleTagOptionIds の存在確認のみ。**handleImages には cards SELECT が無い**)。
- `updateCardField`(`card-field-handlers.ts:93-105`)は `.returning({ examId })`。Postgres の UPDATE RETURNING は **新値**を返すため、これでも旧 images は取れない(かつ返すのは examId のみ)。
- `applyCardDelete` は `SELECT { examId }` のみ(`apply-card-mutation.ts:137-140`)。物理 DELETE 前に images を読まない。

→ server 単独では「どの assetId が参照から抜けたか」を**知り得ない**(FF §B2 の再確認)。

### 更新前 SELECT を足せば diff できるか = できる(ただし穴あり)

- **update_field images**: `handleImages` の SET 直前に `SELECT images FROM cards WHERE id=? AND user_id=?` を 1 回足せば `old − new` で「抜けた key」を算出可能。
- **card delete**: `applyCardDelete` の SELECT に `images` を加える(or DELETE に `.returning({ images })`)ば、消える card の全 key を取得可能。
- **client 側は既に diff を保持**: `removeImageFromCard(p.assetId)` は消す assetId そのものを引数で受ける(`upload.ts:840`)。card 削除も削除前に mirror の `card.images` を保持している。**つまり diff 情報は client 側に確実に存在するが、server へ伝播していない**(commitImages の `before` は optimistic rollback 用の `beforeValue` にのみ使われ、mutation payload には載らない・`upload.ts:496-503`)。

### diff が届かない構造的な穴(重要)

更新前 SELECT で diff できるのは **registry apply を通る 2 経路(image-remove / 単票・bulk card delete)のみ**。以下は apply を**通らない**:
- **exam 削除**: `delete-exam.ts` が `exams DELETE` → FK cascade で子 cards が消える(`schema.ts:300-302`)。`applyCardDelete` を経由せず per-card apply が走らないため、**pre-SELECT diff の口が無い**。
- **user 削除**: `handle-clerk-event.ts` の cascade。同上。

→ diff 方式は cascade を構造的に取りこぼす(FF §B1 と一致)。

## Q3. 経路別の棚卸し

| 経路 | 実装 | sync 形 | tombstone | server が消えた key を知れるか |
|---|---|---|---|---|
| 画像外し編集(card 残存) | `removeImageFromCard`(`upload.ts:838-851`)→ `commitImages` | `update_field` images 全置換 | **なし** | 現状不可(pre-SELECT で可能・client は保持) |
| 単票 card 削除 | `delete-card-button.tsx:40-54` → `runOptimisticMutation` | `delete`(patch 空)→ `applyCardDelete` | card tombstone | 現状不可(pre-SELECT/RETURNING で可能) |
| bulk card 削除 | `use-bulk-card-delete.ts:59-75` → 1 tx で N 件 enqueue | per-card `delete`(patch 空)×N | card tombstone ×N | 単票と同じ |
| exam 削除(cascade) | `delete-exam.ts` `exams DELETE` → FK cascade | 子 card は **apply 非経由** | exam tombstone(+ 事前に子 card tombstone を明示 INSERT)| **不可**(per-card apply が走らない) |
| user 削除(cascade) | `handle-clerk-event.ts` cascade + `assets` 行明示 DELETE | apply 非経由 | — | 不可(かつ assets 行ごと消え R2 orphan)|

補足: 画像外しの mutation は coalesce key `card:<cardId>:update_field:images`(`entity-mutations.ts:47-52`)で同 card 同 field が最新値に畳まれる = 途中経過の「どの key をいつ外したか」は残らず、**最終配列のみが server に届く**(diff 方式が「apply 時点の old→new」しか見られない一因)。

---

## CC 暫定所見 — 削除イベント駆動 GC は成立するか

### agree(事実が支持)
- **tombstone 直結方式 = 不成立**。理由:(1)画像外し編集は tombstone を一切出さない(update_field 上書き)ため、tombstone を trigger にすると **image-remove 経路を丸ごと取りこぼす**。(2)card tombstone は cardId しか持たず、その card の image key を含まない。かつ card は物理削除済で事後に images を引けない。→ tombstone を見ても「どの asset が参照を失ったか」に到達できない。
- **diff 方式(更新前 SELECT)= 部分的に成立するが scan を代替しない**。image-remove(handleImages に pre-SELECT)と card delete(applyCardDelete に images SELECT/RETURNING)の 2 経路は 1 query 追加で diff 化できる。**しかし exam/user 削除の FK cascade は per-card apply が走らず diff の口が無い**(構造的な穴)。この穴を埋めるには結局 cascade 経路にも別処理か scan backstop が要る → **diff だけでは経路網羅にならない**。
- 従って **spec の scan-based 選択(経路非依存に cards.images を読み直す)は妥当**。scan は image-remove / card delete / exam cascade / user cascade を一律に「生存 cards から参照ゼロを再計算」で吸収する。

### disagree / caution
- 「削除イベント駆動は不可能」ではない — **client 側には diff 情報が確実にある**(`removeImageFromCard` の assetId 引数 / 削除前 mirror の card.images)。これは spec §4.7 の**ローカル Cache blob 即時回収**が既に活用している経路(client が消えた key を知っているので即 `deleteAssetBlob`)。すなわち「削除イベント駆動」は **local best-effort 掃除の最適化層としては成立・既に採用済**。
- 成立しないのは **server 権威の R2/DB 回収**を削除イベント駆動だけで完結させること(cascade 穴 + LWW 全置換下での apply 時 diff の順序依存)。ここは scan が要る。

### 不明
- diff 方式を仮に採るなら、LWW 全置換の下で「apply 時点の old(= 別端末の直近 write かもしれない)→ new」の diff が multi-device で正しい参照増減を与えるかは未検証(順序前後で二重減算 / 取りこぼしの懸念)。scan はこの問題を持たない(毎回真値再計算)ため、本 sprint では検証不要。将来 diff 最適化を入れる場合の要検証項目として記録。

**総括**: 削除イベント駆動 GC は **tombstone 直結=不成立 / diff 方式=2 経路のみ部分成立(cascade 穴あり)**。よって server 権威の GC は scan-based(spec 確定どおり)を軸にすべき。削除イベント(client 側 diff)は **local Cache 即時掃除の最適化**として使うのが正しい役割分担(spec §4.7 と整合)。
