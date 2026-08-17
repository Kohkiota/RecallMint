# card_tags 差分消失バグ — 機序確定と修正候補(2026-08-17 / 調査のみ・実装なし)

発端: hygiene sprint stg smoke §11.5(`docs/superpowers/sessions/2026-08-17-tag-mirror-hygiene-sprint.md`)。
本 doc は**修正 spec の入力**。裁定は OT。

確認手段は現物のみ: repo の実コード(HEAD = `a442dcf`)/ `node_modules/postgres` の実 parser / **stg DB への read-only SQL 実測**(user A = `66fb6d00-526f-4264-9691-e2e036c656f7`、`DATABASE_URL_APP` + `set_config('app.user_id')`、SELECT のみ)。

---

## 0. 結論(先出し)

1. **§11.5 の仮説「inclusive cursor + 案 a」は半分正しく、半分は誤り**。`gte` は真因ではない。真因は **PG µs → JS Date ms の切り捨てで cursor が真の max を構造的に超えられない**こと。実測で `>` に変えても同じ 5 件が返る(§1.2)。→ **案① 単独では直らない**(反証済み)。
2. **本質的欠陥は別にある**: Tag-2b 案 a は「変更 card の card_tags **全集合**を server が返す」ことを前提に client が全削除するが、**server はその全集合を返す実装を持たない**(`getCardTagsDelta` は `created_at >= since` の単純増分のみ)。**案 a は server 側半分が未実装**(§1.3)。
3. **境界 artifact が無くても発火する**。`cards.updated_at` を bump する経路には **FSRS 復習 flush が含まれる**(`session-repository.ts:295`)。つまり**カードを 1 枚復習するたび、そのカードのタグが local から消える**。実測データでは 1 card あたり平均 **5.47 行**(§1.5)。smoke で観測された「20 行・以後一定」は、たまたま復習・編集が挟まらなかった静止状態の値にすぎない。
4. **調査項目 5 の答えは NO — server DB は無傷ではない**。タグ書込 op が local mirror 由来の **whole-set replace**(`card-field-handlers.ts:290-299`)であるため、欠落した local 集合で 1 回でもタグ操作すると **server 行が実削除される**。full pull でも回復しない永久損失になる(§5)。**この 1 点で本件は「表示バグ」ではなくデータ保全の Critical**。
5. 同型パターンの他所への波及は無い。Dexie mirror の子テーブルは `card_tags` **のみ**(v5)、「別 stream の cursor に支配された削除」も pull.ts の (2)/(3) **のみ**(§2)。
6. 推奨は **案②(server が変更 card 分の card_tags 全集合を同梱)**。既存コメントが既に宣言している契約を server 側に実装するだけで、client の構造・凍結 pin に触れない(§3.2 / §4)。

---

## 1. 機序の確定

### 1.1 二つの独立した欠陥が重なっている

| | 欠陥 | 効果 |
|---|---|---|
| **Fault A** | cursor が真の max を超えられない(µs 切り捨て) | 最終更新 card 群が **毎回** delta に載る |
| **Fault B** | 削除集合(cards cursor 支配)と再構築集合(card_tags cursor 支配)が**別 cursor** | 変更 card の**古いタグが復元されない** |

Fault B が損失の本体。Fault A はそれを**毎 pull・無操作でも**発火させる増幅器。**A だけ直しても B は残る**(§1.5)。

### 1.2 Fault A: cursor は構造的に真の max へ到達できない

- server query: `lib/db/pull-delta.ts:43` — `if (since) conds.push(gte(config.cursorCol, since))`。**6 stream 全てが `gte`(inclusive)**。
- 列精度: `lib/db/schema.ts:362-365`(`cards.updated_at`)/ `:857-859`(`card_tags.created_at`)とも `timestamp(withTimezone)` で **precision 未指定 = PG 既定 µs**。
- 読取: `node_modules/postgres/src/types.js:32` `parse: x => new Date(x)` → **JS Date は ms までで sub-ms を切り捨て**(実測: `2026-08-16 12:19:12.61199+00` → `...611Z`)。
- cursor 生成: `cards-pull.ts:30` `cursorValueOf: r => r.updated_at`(= `Date.toISOString()`)→ `lib/db/max-iso.ts` の `maxIso`。つまり **cursor = floor(真の max, ms)**。
- 送り返し: `postgres/src/types.js:31` `serialize: … .toISOString()` → bind 値も ms。

**帰結**: µs 剰余が 0 でない限り `cursor < 真の max` が恒真。ゆえに **`>=` でも `>` でも最終更新行は毎回返る**。

**stg 実測(反証の核心)**

| 指標 | 実測 |
|---|---|
| `cards.updated_at` の µs 剰余 ≠ 0 | **1209 / 1209 件(100%)** |
| `card_tags.created_at` の µs 剰余 ≠ 0 | **6612 / 6612 件(100%)** |
| `max(cards.updated_at)` | `2026-08-16 12:19:12.61102+00` |
| client が持つ cursor(ms 切り捨て) | `2026-08-16 12:19:12.611+00` |
| `updated_at >= cursor` の件数 | **5** |
| `updated_at >  cursor` の件数 | **5**(← **exclusive 化しても変わらない**) |

> `.61102 > .611` なので当然。**§11.5 の「inclusive cursor だから」という帰属は誤り**であり、修正候補①をこの理由で採るのは無効。

補足: 5 件が同一 `updated_at` を共有するのは、PG `now()` が **transaction_timestamp()**(tx 開始時刻・tx 内不変)だから。実測で確認済(同 tx 内 `now()` 2 回が同値、`clock_timestamp()` は前進)。つまり **5 = 直近 1 トランザクションで更新された card 数**であり、平均値ではない。

### 1.3 Fault B: 案 a の server 側半分が存在しない

client(`lib/sync/pull.ts:306-318`):

```
(2) const changedCardIds = cards.map(c => c.id)
    db.card_tags.where('card_id').anyOf(changedCardIds).delete()   // 変更 card の全タグ削除
(3) db.card_tags.bulkPut(cardTags)                                  // delta の card_tags で再構築
```

`cardTags` の中身を決めるのは `app/api/pull/route.ts:81` → `lib/db/card-tags-pull.ts:34-52` → `getDeltaRows` で、条件は **`user_id = ? AND created_at >= since_card_tags` だけ**。**`card_id IN (changedCardIds)` という条件はどこにも無い**。

一方、コード内の宣言はこうなっている:

- `lib/db/card-tags-pull.ts:10-14`「pull 側で **cards.updated_at bump 起点の取り直し**で塞ぐ(… **当該カードぶんの新集合を upsert** する)」
- `lib/sync/pull.ts:31-35`「cards 増分で変更カードを検知 → 当該カードの card_tags を全削除 → **card_tags 増分の bulkPut で新集合を upsert**」

後者の「新集合」は **card_tags 増分**とイコールだと書かれているが、増分は cards とは無関係の cursor で切られている。**「削除する集合」と「復元する集合」が別の述語で定義されている**のが欠陥の正体。両者が一致するのは `since_card_tags` が無い **full pull のときだけ**。

**削除集合 ⊅ 復元集合 の差分 = 恒久欠落行**:

```
lost(card) = { t ∈ card_tags | t.card_id ∈ changedCards ∧ t.created_at < since_card_tags }
```

### 1.4 「20 行」の正体(実測で完全一致)

境界 5 card の per-card タグ数:

| card_id | updated_at | tags |
|---|---|---|
| `008d56b8…` | `12:19:12.61102` | 7 |
| `a93de547…` | 同 | 1 |
| `54849478…` | 同 | 0 |
| `00307261…` | 同 | 6 |
| `001cfc98…` | 同 | 6 |
| **計** | | **20** |

さらに `since_card_tags`(= `max(created_at)` の ms 切り捨て = `2026-08-15 00:00:01.169+00`)で切ると:

| | 件数 |
|---|---|
| 境界 5 card の card_tags 総数 | 20 |
| うち delta が返す(`created_at >= since_card_tags`) | **0** |
| **欠落** | **20** |

→ **6612 − 20 = 6592**。smoke の観測値と厳密一致。「20」= **直近 1 トランザクションで更新された 5 card が持つタグ総数**(境界 card 数 × タグ数の総和)。平均タグ数(5.47)× 5 ≒ 27 とはズレるので「平均 × 件数」ではない。

また `card_tags` stream 自体も同じ切り捨てで **毎回 10 行を再送**しているが、`bulkPut` が冪等なので無害(帯域のみ)。

### 1.5 境界 artifact を消しても残る本体 — 復習・編集で発火する

`cards.updated_at` を bump する経路(実コード):

| 経路 | 場所 |
|---|---|
| card field 編集全般(title / question_text / memo / images / …) | `lib/cards/card-field-handlers.ts:103`(`updateCardField` が一律 `updatedAt: sql\`now()\``) |
| **タグ付与/解除そのもの** | `lib/cards/card-field-handlers.ts:304-307` |
| card 移動 | `lib/cards/apply-card-move.ts:79` |
| **FSRS 復習 flush** | `lib/reviews/session-repository.ts:295` |

タグは通常「一度付けて以後変えない」ため、`card_tags.created_at` は `cards.updated_at` より**古いのが常態**(実測 gap = **1 日 12:19:11**)。よって:

> **カードを 1 枚復習するたび、次の delta pull でそのカードのタグが local から全消しされ、復元されない。**

実測 A のデータで 1 card あたり平均 **5.47 タグ**(1209 card / 6612 tag / タグ 0 件は 7 card のみ / 最大 7)。**100 枚のセッションを回すと約 550 行が local から消える**。smoke で「20 行で止まった」のは、その間に復習も編集も挟まらなかったから。

回復契機は **cursor 不在の full pull のみ**(purge / sweep / CAS abort / 新 user / cursor 手動削除)。通常運用ではほぼ起きない。

---

## 2. 影響範囲

### 2.1 他 stream(cards / exams / tag_categories / tag_options / tombstone)

Fault A(切り捨てによる毎回再送)は **6 stream 全部**に存在する。ただし**損失が出るのは card_tags だけ**:

| stream | 再送時の client 動作 | 損失 |
|---|---|---|
| cards / exams / tag_categories / tag_options | `bulkPut`(id-upsert・冪等) | なし |
| tombstone | `bulkDelete` + cascade purge。**削除 id は tombstone payload 自身から導出**(`pull.ts:324-354`)= 自己完結 | なし(冪等) |
| **card_tags** | **削除は cards payload 由来 / 復元は card_tags payload 由来 = 他 stream の cursor に支配される** | **あり** |

判定基準はこう言える: **「削除の根拠」と「復元の材料」が同一 payload から来ているか**。card_tags だけがこれを破っている。

### 2.2 他の子テーブル

Dexie mirror の junction / 子 store は **`card_tags` のみ**。`lib/client-db.ts` の store 定義(v1〜v7)を全数確認: `exams` / `cards` / `user_settings` / `study_sessions` / `answer_events` / `entity_mutations` / `sync_meta` / `study_days` / `tag_categories` / `tag_options` / `card_tags`。親子で「親の変更を起点に子を消す」構造を持つのは card_tags だけ(v5・`lib/client-db.ts:298-300`)。

`.anyOf(...).delete()` を使う production 経路も pull.ts の 3 箇所((2) / option cascade / card cascade)のみ。後 2 者は tombstone payload 自己完結なので安全。

### 2.3 正しい形の実例(比較対象)

`lib/sync/study-days.ts:105-107` — **owner 限定 delete + 同一 payload の bulkPut**。cursor を持たない full snapshot なので「削除集合 = 復元集合」が構造的に保証される。**card_tags が満たすべき性質を既に満たしている repo 内の working example**。

---

## 3. 修正候補(実現性の事実。裁定は OT)

### 3.1 案① cursor 境界の exclusive 化 — **単独では効かない(反証済み)**

- 変更点は `lib/db/pull-delta.ts:43` の `gte` → `gt` 1 行 + pin `lib/db/pull-delta.test.ts:100`。
- **しかし §1.2 実測のとおり `>` でも同じ 5 件が返る**。切り捨てで cursor が真の max に届かないため、比較演算子は無関係。
- **効かせるには µs 精度を end-to-end で保つ改造が要る**: ① drizzle 側で `mode: 'string'` 等に変更(cards / exams / tag_categories / tag_options / card_tags / tombstones の 6 表)② mapper と `ClientCard` 等の型 ③ `maxIso` の比較(現行は文字列辞書順。`…611020Z` と `…611Z` が混在すると誤順になる)④ client 側 cursor と `parseSince` の往復。**血の範囲が広く、凍結 pin(cursor 形式)にも触れる**。
- **同時刻更新の取りこぼしリスク**: 精度を保った上で `>` にすると、`now()` = tx 開始時刻ゆえ「早い timestamp を持つが遅くコミットする tx」の行が恒久スキップされうる(read committed の commit 順 ≠ timestamp 順)。この hazard は **`gte` + ms 切り捨てが偶然の安全マージンとして今は隠している**。exclusive 化はそのマージンを外す方向。
- **結論**: 単独で採るべきでない。Fault B を直した後の「毎回 5 件返る無駄」を削る**任意の最適化**としてのみ意味がある。

### 3.2 案② server が「変更 card 分の card_tags 全集合」を同梱 — **推奨**

コメントが既に宣言している契約(§1.3)を server 側に実装する。**最小で、既存の client 構造を変えない**。

変更点(現物ベース):

1. `lib/db/card-tags-pull.ts` に by-card-ids の取得を追加(`user_id = ? AND card_id IN (...)`、既存の `getCardTagsDelta` は温存)。
2. `app/api/pull/route.ts:73-84` の `withTenantTx` 内で、`c.rows`(cards delta)の id 群を使って 1 本 SELECT を追加し、`ct.rows` と **`[card_id, option_id]` で dedupe した union** を `card_tags` として返す。同一 tenant tx 内なので RLS 契約は不変(6 直列 await → 7 直列)。
3. **client `lib/sync/pull.ts` は無変更**。(2) の削除 → (3) の bulkPut がそのまま正しくなる。

要注意の事実:

- **cursor 逆行のリスク(必ず潰す)**: `cursors.card_tags` は `maxIso(mapped rows)` で算出される(`pull-delta.ts:48`)。union に古い行が入ると max が下がる場合があり、client は `pull.ts:384-388` で**単調性チェックなしに上書き**する。→ **`maxCreatedAt` は増分側 rows のみで算出する**(union には掛けない)。損失は起きないが放置すると delta が肥大・振動する。
- **payload サイズ**: 変更 card 数 × 平均タグ数。実測 A で通常時 5 card → 20 行。最悪ケースは一括タグ操作で 1209 card 変更 → 6612 行(= full pull と同等)。ただしその場合 cards delta 自体が 1209 件で、card_tags は 1 行 4 列と軽い。`inArray` の bind 数も PG 上限(65535)に対し余裕。
- **owner-scope**: 追加 query に `eq(cardTags.userId, userId)` を必ず置く。落とした場合、client の行検証(`pull.ts:249-252`)が **pull 全体を FAIL** させるので silent には壊れない(loud fail 側)。`pnpm test:iso` の 2 テナント統合でも検出可能。
- **タグ 0 件の card**: 変更 card がタグ 0 件なら union に何も乗らない → client は (2) で消して (3) で何も入れない = 正しい(空集合化)。案 a の元々の狙い(`[A,B] → []`)がここで初めて実際に成立する。

### 3.3 案③ wire を明示化(`card_tag_sets: [{card_id, option_ids[]}]`)

削除集合と復元集合を **1 つの構造で表現**して曖昧さを消す案。設計としては最も明快(「この card のタグはこれで全部」と wire が言う)。

- コスト: wire 契約の追加 = `PullResponse` 型 / route / client apply / route.test / pull.test を全部触る。`emptyBody`(`route.ts:42-57`)にも key 追加。
- 案②と**保証は同値**。差は「暗黙(union の意味を読む)か明示(型が語る)か」。
- 簡潔性規律(既存パターンに乗る / 最小実装)からは案②が優位。**将来 card_tags 以外の子テーブルが増えるなら**案③が効いてくるが、現時点で予定は無い(YAGNI)。

### 3.4 案④ overlap window(cursor を N 秒巻き戻して送る)— 直交・単独不可

`since` に安全マージンを引く。Fault A の「取りこぼし」hazard(§3.1)への一般解だが、**Fault B は直らない**(巻き戻し幅を超えて古いタグは復元されない)。案②と併用可能な独立トピック。単独では採れない。

### 3.5 構造的な封じ込め(別論点・OT 判断)

§5 の server 損失経路は「**local mirror から whole-set を組み立てて server に replace させる**」設計に由来する。mirror が壊れたら server も壊れる、という増幅器が常時装填されている状態。

- 現行: `use-card-tag-toggle.ts:85-90`(`buildNextTagSet(…, allAssignedOptionIds, …)`)/ `use-bulk-card-tags.ts:135` / `tag-crud.ts:532` の 3 経路すべてが `next`(全集合)を送る。
- 代案: op を **差分(add / remove の option_id)** にすれば、local の欠落は server へ伝播しない。ただし entity_mutation の op 契約・server handler・冪等性設計を触る**大きな変更**で、本 fix の scope を超える。
- **本 fix(案②)は損失の発生源を断つので、この封じ込めが無くても症状は消える。** 別 task として起票するかは OT 判断。

---

## 4. 凍結 pin との交差

### 4.1 案②が触る箇所と pin の位置関係

| 凍結 pin | 位置 | 案②の交差 |
|---|---|---|
| **capture 原則**(correctness §5.1 / pull.test.ts:702-733) | client `pullDelta` の userId capture | **無交差**(client 無変更) |
| **owner echo 4 pin**(correctness §5.1a / pull.test.ts:761-941) | `pull.ts:237-252` の tx 前検証 | **無交差**。ただし追加 rows も `user_id` 行検証の対象に入る = **保証は自動で効く**(むしろ強化) |
| **validate-before-tx 順序** | `pull.ts:196-252` が tx より前 | **無交差**(payload が増えるだけ、順序不変) |
| **cursor CAS**(hygiene §9-2 / pull.test.ts:943-1108) | tx 先頭の cursor 再読 | **無交差**(client 無変更) |
| **cursor namespace / 空 userId fail-closed**(pin ①③⑥) | sync_meta key 構成 | **無交差** |
| hygiene §9-3/4/5/7/8/9/10(不可侵集合 / allowlist / tx 原子性 / SignOutPurge / 分類 / Cache / DL gate) | local-hygiene | **無交差**(hygiene 層に一切触れない) |

**退行リスクのある pin = 実質 1 件**:

- **`lib/sync/pull.test.ts:388`「cards 増分に c1 → c1 の旧 card_tags 全削除 + 新集合 bulkPut」**
  この test は payload `card_tags: [c1:o3]` を **「c1 の完全な新集合」** として扱い、`c1:o1` / `c1:o2` が消えることを期待している。**バグの前提そのものを pin している**(= 「delta は常に変更 card の全集合を含む」という、server が満たしていない仮定)。案②ではこの前提が**真になる**ので、test は payload の意味を明示する形に書き直す必要がある(削除ではなく前提の明文化)。
  → CLAUDE.md の test-only 分岐では「保証の内容が変わる(主張の記述を正確にする)」= **red 検証 + 簡易 review** 側の扱いが妥当。分類は実装時に自己申告。

### 4.2 案①を採る場合に触れる pin(参考)

- `lib/db/pull-delta.test.ts:100` `expect(spyGte).toHaveBeenCalledWith(...)` — 直接書換。
- µs 精度化まで踏み込む場合、cursor 値の形式が変わるため **hygiene §9-4 の sync_meta allowlist / parser 境界 pin**(値ではなく key を見る pin なので直撃はしないが、cursor 値を assert している pin 群 — `pull.test.ts:280-314` 等 — は全面書換)。**血の範囲が案②と桁違い**。

### 4.3 sprint 完了 gate(案②)

`pnpm lint` / `pnpm test:iso`(**owner-scope 追加 query の検証面として本件は直球**)/ `pnpm run audit`。schema 変更・依存変更なしのため migration / build gate は追加不要。

---

## 5. server 側への影響 — **調査項目 5 の前提は成立しない**

### 5.1 pull 自体は read-only(ここは前提どおり)

`app/api/pull/route.ts` は `withReadOnlyAuth` + 6 本の `db.select()` のみ。**pull が server を壊すことはない**。

### 5.2 しかし損失は 1 回のタグ操作で server に伝播する

タグ書込 op は **local mirror から組み立てた whole-set** を送り、server は **whole-set replace** する:

| # | 場所 | 事実 |
|---|---|---|
| 1 | `exam-card-table.tsx:493` / `card-tags-section.tsx:83` | `allAssignedOptionIds` = **Dexie `card_tags` の live 値**(= 欠落済み) |
| 2 | `use-card-tag-toggle.ts:85-90` | `buildNextTagSet(category, allAssignedOptionIds, …)` → `next` = **欠落したまま**の全集合 |
| 3 | `use-card-tag-toggle.ts:114-121` | outbox に `op:'update_field', patch:{field:'tag_option_ids', value: next}` |
| 4 | `card-field-handlers.ts:290-292` | server: `DELETE FROM card_tags WHERE card_id = ? AND user_id = ?` — **その card の全行を消す** |
| 5 | `card-field-handlers.ts:295-299` | `INSERT` は受け取った `optionIds` のみ = **欠落分は復活しない** |
| 6 | `card-field-handlers.ts:304-307` | `cards.updated_at` を bump → 当該 card が次の境界 card になる |

同じ経路が `use-bulk-card-tags.ts:135`(一括付与/解除)と `tag-crud.ts:532`(option 作成即付与)にもある。**3 経路すべて whole-set**。

server 側 handler の検査(`:243-286`)は「値が uuid[] か / option が自分のものか / single カテゴリ違反か」だけで、**「既存集合より減っていないか」は見ない**(見るべきでもない — 意図的な解除と区別できないため)。

**帰結**:

> delta pull でタグが消えた card に対してユーザーがタグを 1 つでも触ると、**その card の消えていたタグが server から実削除される**。この時点で **full pull による回復も不可能**になる。

UI 上ユーザーには「タグが減っている」ようにしか見えないので、**気付かずに操作して確定させる**動線になっている。加えて欠落するのは**直近に復習・編集した card**、すなわち**ユーザーが今まさに触っている card** なので、遭遇確率は低くない。

### 5.3 現時点で server 側の実損があるかの確認は未実施

stg の A アカウントで実際に何行失われたかは、**server 側だけ見ても判別不能**(「意図的に外した」と区別する情報が無い)。判別するには操作ログか history が要るが、②-4b の非要件確定(個体履歴を保存しない)により存在しない。**prod は未リリースのため実害は stg のテストデータに限られる**、という点は別途 OT 確認事項(§6-3)。

---

## 6. 未検証の論点(spec 起草時に潰すか、明示的に受容するか)

1. **境界 card の cards 側再上書き**(未検証・仮説): 5 件の境界 card は毎 pull で `db.cards.bulkPut` により server 値で上書きされる。ここに未 flush の楽観的編集が乗っていると巻き戻る可能性がある。**本件とは独立した pre-existing race** で、`pullBack` の flush → pull 順序でどこまで守られているか未確認。card_tags 修正の scope 外だが、**同じ「境界 card が毎回返る」性質に由来する**ので記録する。
2. **`now()` = tx 開始時刻ゆえの取りこぼし**(§3.1 末尾): 長い tx が先行 timestamp で後からコミットすると、cursor 前進済みの client がその行を恒久的に取り逃す。**現行の ms 切り捨てが偶然のマージンになっている**。案② では触らずに済むが、案①/案④ を議論するなら正面から扱う必要がある。
3. **stg A アカウントの実データ被害の有無**: §5.3。prod 未リリースの確認を含め OT へ。
4. **`card_tags` stream 自体の毎回 10 行再送**(§1.4): 無害だが、案② 実装時の cursor 算出(§3.2 の逆行リスク)と同じ場所を触るので一緒に見る。

---

## 7. 推奨(裁定は OT)

**案② 単独**を推す。理由:

- **損失の発生源を断つ**(Fault B)。Fault A は残るが、案②の下では「同じ card が毎回返って毎回正しく再構築される」だけで無害化する。
- **既にコードが宣言している契約を実装するだけ**で、新しい概念・抽象・wire を増やさない(簡潔性規律)。
- **凍結 pin と交差しない**(§4.1)。書き直しが要る pin は `pull.test.ts:388` の 1 件で、しかもそれは**バグの前提を pin していた test** なので、修正すること自体が保証の改善。
- 案①は**反証済み**で単独採用不可、案③は同値でコスト高、案④は直交。

案②に**必ず添えるべき実装条件**(spec に落とす):
- `maxCreatedAt` は増分 rows のみから算出(union に掛けない)= cursor 逆行の防止。
- 追加 query に `eq(cardTags.userId, userId)` を必ず置く。
- 同一 `withTenantTx` 内に置く(RLS-P2)。

---

## 附録 A: 実測に使った SQL

`/tmp/.../scratchpad/ct-probe.sql` / `ct-probe2.sql`(session 限りの scratch)。read-only、`BEGIN; set_config('app.user_id', <A>, true); … COMMIT;` の形。要点のみ再掲:

```sql
-- µs 剰余の分布(= 切り捨ての恒常性)
SELECT count(*) FILTER (WHERE (extract(microseconds FROM updated_at)::bigint % 1000) <> 0)
FROM cards WHERE user_id = :A;          -- → 1209 / 1209

-- inclusive / exclusive の差(= 案①の反証)
WITH cur AS (SELECT date_trunc('milliseconds', max(updated_at)) c FROM cards WHERE user_id = :A)
SELECT count(*) FILTER (WHERE updated_at >= (SELECT c FROM cur)) AS ge,
       count(*) FILTER (WHERE updated_at >  (SELECT c FROM cur)) AS gt
FROM cards WHERE user_id = :A;          -- → ge = 5, gt = 5

-- 「20」の内訳と復元されない件数
--   境界 5 card の card_tags = 20 / うち delta が返す = 0 / 欠落 = 20
```

## 附録 B: 参照した現物(file:line)

- server pull: `app/api/pull/route.ts:73-104` / `lib/db/pull-delta.ts:35-49` / `lib/db/card-tags-pull.ts:34-52` / `lib/db/max-iso.ts`
- client apply: `lib/sync/pull.ts:254-400`(特に `:306-318` 削除+再構築、`:384-388` cursor write)
- schema/精度: `lib/db/schema.ts:296-370`(cards)/ `:845-866`(card_tags)
- driver: `node_modules/postgres/src/types.js:29-32`
- 書込側(updated_at bump): `lib/cards/card-field-handlers.ts:103` / `:290-309` / `lib/cards/apply-card-move.ts:79` / `lib/reviews/session-repository.ts:295`
- whole-set 経路: `use-card-tag-toggle.ts:85-121` / `use-bulk-card-tags.ts:96-135` / `lib/tags/tag-crud.ts:500-537` / `exam-card-table.tsx:486-497` / `card-tags-section.tsx:83`
- 比較対象(正しい形): `lib/sync/study-days.ts:96-108`
- store 定義: `lib/client-db.ts:259-320`
- pin: `lib/sync/pull.test.ts:388-452` / `:659-1108` / `lib/db/pull-delta.test.ts:85-101`
- 凍結 pin 定義: correctness spec §9 / hygiene spec §9(`docs/superpowers/specs/2026-08-16-…-design.md` / `2026-08-17-tag-mirror-hygiene-design.md`)
