# Grid-3 設計: カードの試験間移動(集約 MoveCards op + UI 4 入口 + 試験名 inline 編集 + undo)

- 日付: 2026-08-14
- 対象 sprint: Grid-3(Order-1 → **Grid-3** → 行 DnD の 3 sprint の第 2 段)
- 種別: feat(新 mutation 語彙 + migration + server apply + UI 機能追加 + toast 基盤)
- 状態: **確定・凍結**(2026-08-14 OT 承認。**§12 の確認点 10 件も承認済み**。承認時指示で §11 に patch 上限超過の残余リスク 1 項を追記した上で凍結)。**以後、本 spec は実装フェーズで書き換えない** — 仕様判断が必要になった時点で停止し OT に相談する。
- 入力: OT kickoff(確定 9 決定・2026-08-14)/ Order-1 spec r3(`docs/superpowers/specs/2026-08-14-order-1-base-order-design.md`、凍結 — 以下「Order-1 §n」)/ Order-1 session doc §8 Grid-3 handoff 5 項(`docs/superpowers/sessions/2026-08-14-order-1-base-order.md`)/ 現物調査 3 本(2026-08-14 同日: sync 機構・cards 順序 domain・UI 表面。事実の根拠 file:line は本 spec に設計へ効く箇所のみ再掲)
- 前提: Order-1 実装完了(commit `01f96b9` まで・未 push)。本 spec は Order-1 の順序契約(§2)を消費する。**Order-1 spec は書き換えない** — 凍結契約が定義しない領域(§2.3-2 の非停止域)への終端規則追加は本 spec が定義し、§12 で OT 裁定を仰ぐ。

## 0. 目的

カードを試験(exam)間で移動できるようにする。内部操作は 1 つ — **MoveCards(対象カード群, 移動先 exam, 挿入位置)** — で、UI 4 入口(一括バー「移動」/「切り出し」/ 行メニュー「ここに取り込む」/ 試験一覧「結合」)はすべてその言い換え。同一 exam 内の位置移動も同じ操作。あわせて試験名 inline 編集(現状改名 UI ゼロ)と、移動完了トースト + undo の最小基盤を導入する。

Order-1 が凍結した順序契約(`base_order` + `(base_order, id)` 全順序、位置挿入・再採番の計算式)の**未実装部分(§2.3-2/3)の実装と wire 表現**は本 spec が確定する。行 DnD(次 sprint)は本 spec の書込チャネルをそのまま消費する(DnD 用に別チャネルを作らない)。

## 1. 決定事項

### 1.1 OT 確定(kickoff 9 決定 — 本 spec の前提)

1. 内部操作は MoveCards の 1 つ。挿入位置 = 末尾 / 先頭 / 指定カードの直後。移動対象の相対順(base_order 順)は移動後も保持。同一 exam 内移動も同じ操作。
2. UI 入口 4 つ: a. 一括バー「移動」(主操作)/ b. 「切り出し」(新規 exam shortcut・「無題の試験」自動作成)/ c. 行メニュー「ここに取り込む」(pull 型・少数枚用)/ d. 試験一覧「結合」(全カード合流・元 exam は空で残す)。
3. 試験名 inline 編集を scope に含める。
4. 同期は集約 move op(1 mutation に全カード + 移動先 + 順序、server 1 tx)。entity_mutations の CHECK 拡張 migration 先行。cascadeLike の扱いは spec 判断(→ §2.6)。
5. base_order の書込チャネルは本 spec で最終決定(→ D-3)。Order-1 §2.3-2/3 の実装と wire 表現も本 spec の対象。
6. undo = 完了トースト「N 枚を移動しました [元に戻す]」。元の (exam_id, base_order) を控え、逆方向 MoveCards を絶対値で発行(補償 mutation 機構は作らない)。toast 表示中のみ・reload で消える・前提変化時は失敗 + 理由。切り出し undo 後の空 exam は残す。toast 基盤は新規。
7. ソート・フィルタ適用中は位置指定系を無効化 + 理由表示。末尾/先頭は許可。ソート中の移動は基準順で並ぶ(表示順ではない)。
8. 不変条件: MoveCards は `cards.exam_id` と `base_order`(+ `updated_at` / `content_version`)以外に一切触れない。answer_events / FSRS 列 / card_tags / 画像 / 本文 / source_document_id は不変(前提確認 2026-08-14: 学習系に exam_id 依存ゼロを実証済)。
9. 移動先 exam の存在 + owner 検証は server 適用時に必須(card.create の examNotFound 相当)。

### 1.2 spec が確定する設計判断(→ §12 に OT 確認点として集約)

- D-1 **wire = 新 entity_type `'card_move'` + 新 op `'move'`、entity_id = client 生成の op instance uuid**(代表 card id 方式は不採用 — §2.1)
- D-2 **挿入位置は client で絶対値化して送る**(anchor 送信 + server 解決は不採用 — §2.2)。step=0 の再採番は**同一 mutation に畳む**(§2.3)
- D-3 **base_order の書込チャネル = create 経路 + card_move op の 2 つのみ**。update_field handler は追加しない(併用も不採用 — §2.4)。DnD も card_move を消費
- D-4 **削除済カードは skip して残りを適用**(1 枚でも欠けたら全体 fail、は不採用 — §4.2)。all-or-nothing は「存在する対象への適用」に対して成立
- D-5 **cascadeLike: true**(複数行書込は per-entity 並列 group key で表現できないため serial fallback に倒す — §2.6)
- D-6 **content_version は触らない**(全既存書込経路で bump ゼロの dead 列。伝播は updated_at bump が担う — §4.1)
- D-7 **Order-1 §2.3-2 の非停止域(k ≥ S)の終端規則 = 合成列一括再採番**(§2.3)
- D-8 **exam 系書込(切り出しの新規作成・改名)は server action 経路**(mutation 化しない — 「outbox は exam を運ばない」既存不変条件を維持。§6)
- D-9 **(c) の picker は 1 操作 = 1 source exam に限定**(undo が常に単一 exam への逆移動になる wire 前提 — §5.4)
- D-10 **getCardsForSourceDocument の順序 = `(exam_id, base_order, id)` に再裁定**(handoff ② への応答 — §4.4)

## 2. 集約 move op の契約

### 2.1 wire 表現(D-1)

```
entity_type: 'card_move'
op:          'move'
entity_id:   <client 生成 uuid — この移動操作 instance の識別子>
patch: {
  exam_id: <uuid>,                            // 移動先(全 card 共通)
  cards: [ { id: <uuid>, base_order: <int ≥1> }, ... ]   // 絶対値の割当列
}
```

- `patch.cards` は「card id → (exam_id, base_order) の絶対値割当」の集合。**移動カードの新位置**と、step=0 時の**移動先 exam 常駐カードの再採番値**(§2.3)を同じ形で運ぶ(区別しない — どちらも割当)。
- 検証(zod・`lib/sync/shared/mutation-schemas.ts` に追加): `exam_id: z.uuid()` / `cards: z.array({ id: z.uuid(), base_order: z.number().int().min(1) }).min(1).max(10_000)`(card id の重複は refine で invalid)。`base_order` 値の重複は**許容**(Order-1 §2.1 の重複容認と同型 — undo が元値を復元するとき元値が重複していることがある)。上限 10,000 は「1000 枚級 move + 数千枚 exam の再採番」を包含する DoS ガード(超過は per-mutation failed。payload ≈ 550KB で bulk route の実用域内。bulk の mutation 件数上限 1000(`bulk/route.ts:73-77`)に対し move は常に 1 mutation)。
- **entity_id を代表 card id にしない理由**: ① entity_mutations の文書化された意味論「entity_id は対象 entity の PK」(`lib/db/schema.ts:657-673`)に対し、対象が card 群である op で単一 card を名乗るのは偽装になる ② client の coalesce key は `${entity_type}:${entity_id}:${op}`(`lib/sync/entity-mutations.ts:55-63`)— 代表 id だと連続する別内容の移動が coalesce で潰し合う。op instance uuid なら**移動は決して coalesce されず**、enqueue 順に全件送られる(意図どおり)。schema comment の「entity_id は対象 entity の PK」は「card_move の entity = 移動操作そのもの、entity_id はその instance id」と追記更新する(同 commit)。

### 2.2 絶対値化の裁定(D-2 — Order-1「絶対値を送って冪等」原則との整合)

client が挿入位置(末尾 / 先頭 / anchor 直後)を mirror の現在順に対して解決し、**base_order 値列を計算して送る**。anchor(afterCardId)送信 + server 解決は不採用。

- **採用理由**: ① undo は kickoff 決定 6 により「元の絶対値で発行」が確定しており、絶対値 wire は forward / undo / 再採番 / 将来 DnD を**単一の形**で表せる(anchor 形は undo と再採番を表現できず第 2 の形が要る)② 値が patch に固定されるため再送・二重適用が semantic にも冪等(同じ UPDATE の再実行)③ server apply が薄い(順序解決ロジックを server に持ち込まない)④ ユーザーの「563 番の下」という意図の基準は**ユーザーが見ていた mirror の順**であり、client 解決はそれに忠実。
- **失うもの**: apply 時点の server 状態に対する位置の正確性(mirror が stale なら並走 insert と同値・交錯しうる)。これは Order-1 が採番並走で既に受容した class(Order-1 §5.3)で、順序の決定性は §2.1 の重複容認 + id tiebreak が保つ。→ 収束保証の明文化は §2.5。

### 2.3 挿入計算と step=0 再採番の畳み込み(D-2 / D-7)

計算は Order-1 §2.3 の凍結式に従い、pure 関数として `lib/cards/domain/card-order.ts` に追加する(§5.1)。

1. 移動対象は **mirror の基準順(`compareByBaseOrder`)でソート**してから値を割り当てる(kickoff 決定 7 後段: 表示順ではなく基準順)。
2. 常駐列 = 移動先 exam の card 群 ∖ 移動対象(同一 exam 内移動では自分自身を除いた列に対して挿入位置を解決する)。anchor は常駐列に存在しなければならない(移動対象自身を anchor に取れない — UI 側で選択肢から除外し、plan 関数でも検証 error)。
3. 末尾 = Order-1 §2.3-1(`M + i·S`)/ 先頭・直後 = §2.3-2(`step = floor((B−A)/(k+1))`、先頭は A=0)。
4. `step = 0` の場合、§2.3-2 は「exam 内再採番(§2.3-3)を先行して再計算」と定めるが、**再採番後の隣接 gap は S=1024 のため k ≥ S(=1024 枚以上を単一 gap へ挿入)では再計算後も step=0 となり、凍結式の再帰は停止しない**(k ≤ S−1 では 1 回の再採番で必ず step ≥ 1)。そこで:
   - **k < S**: 凍結式どおり 2 段(§2.3-3 の値 → §2.3-2 の再計算)。ただし wire 上は**再採番割当と挿入割当を同一 mutation の `cards` に畳む**。別 mutation に分けると「再採番 failed + 挿入 applied」の順序逆転で、古い状態基準の絶対値が後から適用されて意図順が壊れる余地が生まれる(部分状態の決定性は保たれるが意図が失われる)。1 mutation なら中間状態が存在しない。
   - **k ≥ S(終端規則・D-7)**: 意図する最終順(anchor まで + 移動対象 + 残り)の**合成列に対して §2.3-3 の式(`i·S`, i=1..N)を一括適用**する。凍結式が定義しない域への終端規則であり、Order-1 spec の書き換えではない(§12-1 で OT 裁定)。
5. 再採番なし(step ≥ 1)の通常時、`cards` は移動対象のみの割当(常駐カードは patch に含めない)。

### 2.4 書込チャネルの最終決定(D-3 — kickoff 決定 5)

`base_order` の書き手は **create 経路(Order-1 実装済)+ `card_move` op** の 2 つで確定。update_field handler は追加しない(併用も不採用)。

- 理由: ① 1 枚の並べ替えも「1 枚の move」として card_move で表せる(チャネル 1 本で全 use case をカバー)② per-card update_field N 件での再採番は部分適用時に順序が壊れる(§2.3-4 で示した逆転と同じ class — 再採番は原子でなければ chunk 間で新旧値が交錯して並びが崩れる)③ Order-1 §2.4 の契約は「field を追加する**際の**」条件付き契約であり、追加しない選択と矛盾しない。
- **行 DnD(次 sprint)**: exam 内 reorder = `card_move`(exam_id = 現 exam)そのもの。DnD が必要とする「任意の絶対値割当」は本 wire が既に表現できるため、**DnD 用の新チャネルは不要**(kickoff scope 外条項の先取り要求を満たす)。
- update_field で `base_order` が届いた場合は dispatch miss → per-mutation failed(既存機構。`bulk/route.test.ts` に既に create wire の拒否 matrix があるのと同様に pin する — §10-6)。

### 2.5 収束保証の明文化(handoff ① への応答)

**保証する**:

1. どの部分状態・どの並走交錯でも全順序は決定的(Order-1 §2.1 — 重複容認 + id tiebreak)。
2. **移動対象の内部相対順は保存される**: 割当値は狭義単調増加(step ≥ 1 または i·S)なので、並走 insert が同値で交錯しても移動対象同士の前後は入れ替わらない。
3. 単一 client の逐次操作は enqueue 順(outbox local_id 昇順・`lib/sync/entity-mutations.ts:158-166`)どおりに server 適用され、その client の意図順に収束する(card_move は serial fallback — §2.6 — のため batch 内でも順序保存)。

**保証しない**(Order-1 handoff ① を継承): 複数端末が同一 exam の move / 再採番を並走させたとき「どちらかの意図した順」への収束。card 単位の last-writer-wins(apply 順)であり、結果は決定的だが意図とはずれうる。ゼロ〜単数ユーザーの現フェーズで多端末並走編集は稀であり、破綻(非決定・データ喪失)ではなく「位置ずれ」に留まるため受容する。

### 2.6 冪等性・成否モデル・cascadeLike(D-5)

- **冪等性 2 層**: ① `skipLog` なし(= dedup log あり)— apply と同 tx で `entity_mutations` 行を INSERT(mutation_id UNIQUE)。再送は既適用検査(`bulk/route.ts:120-139`)で `'skipped'`。② patch が絶対値のため、万一二重適用されても同じ UPDATE の再実行で無害(semantic 冪等)。
- **per-mutation 成否モデルとの関係**: card_move は 1 mutation = 1 tx(bulk route の per-mutation `withTenantTx`・`bulk/route.ts:98-101`)なので、「1 tx の all-or-nothing」は既存モデルにそのまま乗る。patch 内の全 UPDATE は同一 tx で commit / rollback(部分 commit なし)。失敗は failed[] に mutation_id が載る(200 契約不変)。
- **cascadeLike: true(D-5)**: 並列 path の group key は `${entity_type}:${entity_id}` で「1 mutation が N card 行に触る」ことを表現できず、同 batch 内の per-card update_field と順序保証なく並走してしまう。cascadeLike の定義(「cross-entity / 複数行巻込 op を並列化対象から外す」・`entity-mutation-registry.ts:88-102`)に合致するため flag を立て、**move を含む flush batch は全体 serial fallback**(`group-mutations-by-entity-key.ts:40-65`)。移動は低頻度のユーザー操作であり性能影響は無視できる。隣接する follow-up 台帳の「card.create の cascadeLike 撤去(並列化)判断」とは独立 — card.create の flag が将来外れても card_move の根拠(複数行書込)は自立して残る。registry の「9 件 enumerate assert」は 10 件に更新(§10-8)。

## 3. DB(migration 0038 — CHECK 拡張のみ)

```sql
ALTER TABLE "entity_mutations" DROP CONSTRAINT "entity_mutations_entity_type_enum";
ALTER TABLE "entity_mutations" ADD CONSTRAINT "entity_mutations_entity_type_enum"
  CHECK ("entity_mutations"."entity_type" IN ('card', 'tag_category', 'tag_option', 'card_move'));
ALTER TABLE "entity_mutations" DROP CONSTRAINT "entity_mutations_op_enum";
ALTER TABLE "entity_mutations" ADD CONSTRAINT "entity_mutations_op_enum"
  CHECK ("entity_mutations"."op" IN ('create', 'update_field', 'delete', 'move'));
```

(実ファイルは drizzle-kit 生成。上記は意図の宣言。)

- 語彙拡張は既存規約(`lib/db/schema.ts:657-673`: registry = SSoT / CHECK = backstop / **registry + CHECK + migration 同時更新・CHECK 拡張 migration 先行 → 新値を書く code**)に従う。deploy 順は §9。
- cards / exams のテーブル変更なし。`cards_order_idx (user_id, exam_id, base_order, id)` は移動後も有効(handoff ⑤ への応答): move apply の UPDATE は PK + user_id 条件、移動先 max 参照は (user_id, exam_id) 等価で同 index を使う。exam を跨ぐ ORDER BY は §4.4 の `getCardsForSourceDocument` だけで、これは `cards_source_document_idx` で行集合を引いた後の小規模 sort であり index 追加は不要。
- iso `check-constraints.test.ts` は registry から語彙を導出して DB CHECK と突き合わせる(`:195-200, 289-297, 471-488`)ため、registry 追加に自動追随する。`'exam'` を illegal と pin する既存 assert は**維持**(exam は今回も outbox に乗らない — D-8)。

## 4. server 層

### 4.1 apply(新設 `lib/cards/apply-card-move.ts` + registry entry)

registry(`lib/sync/server/entity-mutation-registry.ts`)に `card_move.move` を追加: `{ patch: cardMovePatchSchema, apply: applyCardMove, cascadeLike: true }`(skipLog なし = dedup log を書く)。apply は per-mutation tx 内で:

1. **移動先 exam の存在 + owner 検証**(kickoff 決定 9): `SELECT id FROM exams WHERE id = ? AND user_id = ?`。0 行 → `'failed'`(card.create の examNotFound(`apply-card-mutation.ts:75-82` / registry `:177-182`)と同一の扱い・同一の帰結 = failed[] → client は pending 残置 → 再送 → 30 日で stale 隔離)。
2. **対象 card の owner-scoped 突合**: `SELECT id FROM cards WHERE user_id = ? AND id IN (...)`。**不在 id(削除済 / 他 tenant)は skip し、存在する card にのみ適用**(D-4 — 理由は §4.2)。全件不在なら空適用で `'applied'`(削除済カードへの割当は vacuous に充足 — outbox が掃ける)。
3. **UPDATE**: 存在する各割当に `SET exam_id = ?, base_order = ?, updated_at = now() WHERE id = ? AND user_id = ?`(実装は VALUES join での一括 UPDATE 可)。**SET 句はこの 3 列のみ**(kickoff 決定 8 の不変条件。§10-3 で pin)。
   - `updated_at` bump は必須: pull の cards cursor は updated_at 基点(`lib/db/cards-pull.ts:28-30`)であり、bump が無いと移動が他端末に**一切伝播しない**。
   - `content_version` は触らない(D-6): 全既存書込経路で increment ゼロ・比較ゼロの dead 列(現物調査 + `docs/audit/2026-07-14` §B-2)。kickoff 決定 8 の括弧書きは「触れてよい」と読み、既存パターン(update_field も bump しない)に合わせて触れない。
   - exams(source / target)の updated_at も触らない(決定 8「以外に一切触れない」。試験一覧の「最終更新」表示が移動を反映しない副作用は受容 — card 件数表示は mirror の cards count なので追随する)。
4. **tombstone / entity_mutations log**: tombstone は書かない(削除ではない)。log INSERT は既存共通処理(`bulk/route.ts:152-167`)がそのまま担う。

### 4.2 削除済カード skip の裁定(D-4)

「1 枚でも不在なら全体 fail」を採らない理由: fail は client の pending 残置 → 再送ループ → 30 日 stale 隔離(`entity-mutation-flush-trigger.tsx:42,65-82`)という**回復経路のない silent lost write** に至る(Order-1 §2.1 が UNIQUE を退けたのと同じ構図)。削除は正当な並走(他端末 / 同端末の先行削除)であり、削除済カードは既にどの exam にも表示されないため、skip しても「部分成功で視覚的に破綻」(kickoff 決定 4 の不採用理由)は起きない。よって all-or-nothing の対象を「存在する card への割当全体」と定義する。移動先 exam 不在(§4.1-1)だけは skip で表現できない(全割当が無意味化する)ため failed とし、card.create の既存前例に揃える。この場合 client mirror は移動済み表示のまま server と乖離する(残余リスク — §11 参照)。

### 4.3 wire / schema 追加

- `lib/sync/shared/mutation-schemas.ts`: `cardMovePatchSchema`(§2.1)+ `cardMoveMutationEnvelope`(`entity_type: z.literal('card_move')` / `op: z.literal('move')`)を discriminated union(`:185-189`)に追加。
- `lib/sync/server/entity-mutation-registry.ts`: entry 追加(§4.1)。enumerate assert の期待値更新。
- client 型: `ClientEntityMutation` は `EntityMutationEnvelope` union の拡張が透過する(`lib/client-db.ts:166-173`)。**Dexie の version bump なし**(entity_mutations store の index 不変・cards store も不変)。

### 4.4 getCardsForSourceDocument の再裁定(D-10 — handoff ②)

移動導入で「1 source_document の cards は 1 exam に閉じる」前提(`lib/exams/list.ts:181-184` のコメント)が崩れる。順序を **`ORDER BY exam_id, base_order, id`** に再定義する。

- 根拠: Order-1 §2.5(カスタム演習 sequential)と同じ「exam でグループ化 → 各 exam 内は基準順」パターン。決定的・追加データ不要で、移動が起きるまでは現行と完全同値(単一 exam なら exam_id は定数)。OCR 読み取り順の完全再現は移動後は原理的に不可能(base_order は移動先で再割当される)ため追わない。created_at 案は publish 単位で全カード同値になり tie を解決できない(Order-1 §0 の実測)ので不採用。
- 変更は ORDER BY への `exam_id` 前置のみ(SELECT / 型 `CardListEntry` は不変)。当該コメントを再裁定後の内容に書き換える。

## 5. client 層

### 5.1 順序 domain の追加(pure — `lib/cards/domain/card-order.ts`)

既存 module(`BASE_ORDER_STRIDE` / `nextBaseOrders` / comparator 3 種)に追加する(1 定義を client / server 両側・test から使う。Order-1 §2.2 と同じ配置原則):

- `planMoveAssignments(input): MovePlan` — 入力 = `{ movedCards: OrderedCard[], targetCards: OrderedCard[], placement }`(placement = `{kind:'end'} | {kind:'start'} | {kind:'after', anchorId}`)。出力 = `{ assignments: Array<{ id, base_order }>, renumbered: boolean }`。§2.3 の全規則(基準順ソート・常駐列 = target ∖ moved・凍結式・k≥S 終端規則・anchor 検証)をこの 1 関数に閉じる。I/O なし・入力非破壊(既存 module の PURE 制約に従う)。
- 内部 helper(export は実装判断): §2.3-2 の `step` 計算と §2.3-3 の `i·S` 再割当。

### 5.2 MoveCards の実行(新設 hook `use-move-cards.ts`)

`app/(app)/app/exams/[id]/_hooks/` の既存 bulk hook 群(`use-bulk-card-tags.ts` / `use-bulk-card-delete.ts`)と同じ形で新設:

1. mirror から移動対象 + 移動先 exam の card 群を読む(`db.cards.where('exam_id')` — mirror は user 全量を持つ(pull が user 単位)ため他 exam の常駐列も読める)。
2. `planMoveAssignments` で割当を計算。undo 用に**割当対象の全 card**(移動対象 + step=0 時の再採番常駐)の元 `(exam_id, base_order)` をこの時点で控える(移動対象だけでは足りない — §5.4)。
3. `runOptimisticMutation`(`lib/sync/optimistic-mutation.ts:102-136`)で mirror 書込 + enqueue を 1 Dexie tx で実行: `mutate` = 割当ごとの `db.cards.update(id, { exam_id, base_order })`(mirror の `updated_at` は触らない — `inline-text-field.tsx` の update_field と同じ既存流儀。pull-back で収束)、`mutations` = card_move envelope 1 件(`entity_id: newId()`)。`throwOnError: true` で失敗は入口 UI の inline error に出す(既存 bulk と同じ)。
4. 返り値 = undo 素材 `{ movedCount, originals: Array<{id, exam_id, base_order}> }`。

mirror が移動先 exam を未 hydrate の窓(理論上の初期化直後)では常駐列が空に見え、採番が先頭 stride からになり既存カードと同値化しうる — Order-1 §2.1 の重複容認で順序は決定的に保たれ、位置ずれのみ(受容。Order-1 §5.3 と同 class)。

### 5.3 楽観更新の見え方

- 移動元 view: 対象カードが liveQuery(`where('exam_id')`)から即座に消える。移動先 view: 次回表示時に反映(同時に開いていれば即時)。
- flush 失敗(failed[])時: 既存どおり pending 残置 + 再送。mirror は移動済み表示のまま(§4.2 の残余リスク)。

### 5.4 undo(kickoff 決定 6)

- **置き場 = 発火元 component の React state のみ**(メモリ。reload / unmount で消える — 仕様どおり)。永続化・複数段は scope 外。
- **発行**: toast の [元に戻す] 押下 → 検証(下記)→ `MoveCards` の逆方向を**絶対値で** 1 mutation 発行: `exam_id` = 元(source)exam、`cards` = **forward の割当対象のうち元 exam_id が source であるもの全部**の `(id, 元 base_order)`。
  - この集合は cross-exam 移動では移動対象のみ(移動先常駐の再採番は、移動対象が去った後の相対順を変えないため戻す必要がない — Order-1 §2.3-3 の性質)。**同一 exam 内移動では再採番された常駐も含む**(必須: 移動対象だけを旧値に戻すと、1024 刻みに再採番済みの常駐列の中に旧来の小さい値が置かれ、元の順序が復元されない)。どちらの場合も対象の元 exam_id は source に一致するため、**undo は常に単一 exam への逆移動 = 単一 card_move で表せる**(D-9((c) の picker は 1 source exam / 操作)がこの単一性のもう 1 つの前提)。
  - 新しい mutation_id / entity_id を持つ通常の move であり、補償機構ではない。
- **検証(発行時・mirror に対して)**: ① 対象 card 全 id が mirror に存在(欠け = 削除された → 失敗「移動したカードの一部が削除されています」)② 元 exam が mirror に存在(消滅 → 失敗「元の試験が削除されています」)。検証失敗は toast を error 表示に差し替え、undo は発行しない。
- **二度押し防止**: 押下と同時に button を disabled + 発行後は toast を「元に戻しました」に置換(undo の undo は提供しない)。

## 6. exam 系の書込(D-8 — 切り出しの新規作成・試験名 inline 編集)

**mutation registry に exam を追加しない。** 「outbox は exam を運ばない(exam 削除は専用経路)」は DB CHECK + iso pin(`check-constraints.test.ts:295-296`)で強制された確立済み不変条件であり、exam create / delete は server action + `runGuardedPull` の専用レーンが既にある(`create-exam.ts` / `delete-exam.ts`)。これを覆す利得がない(exam 書込は低頻度・オンライン時操作で十分)。

### 6.1 切り出し(b)の原子性

kickoff の「exam create + MoveCards の 2 mutation の順序保証で足りるか、1 op に畳むか」への答え: **どちらでもなく「server action → 集約 mutation」の逐次 2 段**(exam create はそもそも mutation ではない)。

1. `createExam('無題の試験')`(既存 action・`_actions/create-exam.ts`。name zod min 1 を満たす)を await → examId 取得。
2. `runGuardedPull({ reason: 'exam-create' })`(既存 `create-exam-form.tsx:46` と同じ)で mirror に exam を反映。
3. §5.2 の MoveCards(移動先 = 新 examId、末尾)。
- 失敗モード: step 1 失敗 → 何も起きない(inline error)。step 3 前に中断 → 「無題の試験」の空 exam が残る(無害 — 空 exam の削除は既存の試験削除に任せる。kickoff 決定 2d と同じ扱い)。1 op に畳む(move apply 内で exam INSERT)案は、op の意味論を汚し registry に exam 書込を持ち込む(上記不変条件に抵触)ため不採用。
- 帰結: **切り出しはオンライン必須**(exam 作成が server action のため)。既存 exam への移動は offline でも動く(outbox)。この非対称は exam 作成一般が既にオンライン必須である現状と一貫。
- 切り出し後の自動遷移はしない(現 view に留まり toast を出す — 遷移すると component unmount で undo が消えるため)。

### 6.2 試験名 inline 編集

- **書込経路 = 新 server action `renameExam(examId, name)`**(`_actions/rename-exam.ts` 新設)。owner-scoped `UPDATE exams SET name = ? WHERE id = ? AND user_id = ?`(`updated_at` は `$onUpdate` が bump → pull cursor で他端末へ伝播)。name の zod は `create-exam.ts:21-25` の `nameSchema`(trim / min 1 / max 200)を共有 export にして再利用。
- **UI**: 試験詳細の h1(`exam-detail-view.tsx:219, 262` の 2 箇所)を新設 `ExamTitleInlineEdit` に置換。click → input 化、Enter/blur で commit、Escape で cancel。commit 中 disabled、成功で local state 更新 + `router.refresh()` + `runGuardedPull({ reason: 'exam-rename' })`、失敗は inline error(`option-row.tsx:281-312` の rename パターンに倣う。card 結合の `InlineTextField` は card 専用のため流用しない)。楽観 mirror 書込はしない(exams mirror は「原則 read-only(pull 上書きのみ)」・`client-db.ts:38-39` — 既存レーンを維持)。
- 試験一覧側の改名 UI は作らない(詳細画面で足りる。最小実装)。

## 7. UI(4 入口 + toast + gating)

### 7.1 一括バー「移動」(a — 主操作)

- `ExamCardTableActionBar`(`exam-card-table-action-bar.tsx`)に 4 つ目の操作「移動」を追加。既存のタグ付与 popover(`CardTagAddPopover` 方式・Radix Popover)と同じ形で `ExamCardMovePopover` を新設:
  - **移動先**: 既存 exam の native `<select>`(mirror `db.exams` から。現 exam を含む — 同一 exam 内移動のため。並びは `updated_at` desc・upload-form `:1239-1254` の前例に倣う)+ 「新規試験へ切り出し」ボタン(= b)。
  - **配置**: 末尾(既定)/ 先頭 / 指定カードの直後。「直後」選択時は anchor の native `<select>`(移動先 exam の常駐列を基準順で列挙、表示 = question_label / title の先頭部。移動対象自身は除外 — §2.3-2)。ソート・フィルタ適用中は「直後」を disabled + 理由表示(§7.4)。
  - 実行 → §5.2 → toast(§7.5)。エラーは既存 action bar の inline error 枠(`action-bar.tsx:130-138`)。
- 選択 model・selectedIds は既存のまま(`exam-card-table.tsx:280, 513`)。card ビューは選択機構が無いため対象外(table view 専用 — 既存の一括操作と同じ制約)。

### 7.2 行メニュー「ここに取り込む」(c — pull 型・少数枚用)

- table 行の select セル(side-peek trigger `exam-card-table-columns.tsx:114-128` の隣)に行メニュー trigger(⋯)を新設。menu は `ColumnHeaderMenu`(`exam-card-table-header-menu.tsx`)と同じ Radix Popover パターンの `ExamCardRowMenu`(項目は当面「ここに取り込む」のみ)。
- 押下 → 簡素 picker dialog(`ConfirmDialog` の portal modal パターン転用): ① source exam の native select(mirror の exams から現 exam を除外・**1 操作 1 exam** — D-9)② その exam のカードを基準順の checkbox リストで選択(検索・仮想化なし — 少数枚用。1000 枚級は (a) に任せる、と説明文を出す)③ 確定 → MoveCards(選択群を基準順ソート, 現 exam, `{kind:'after', anchorId: 行 card}`)。
- ソート・フィルタ適用中は menu 項目を disabled + 理由(§7.4)。

### 7.3 試験一覧「結合」(d)

- `exam-list-live.tsx:114-125` の行 action(詳細を見る / 削除)に「結合」を追加。押下 → inline 展開(`DeleteExamButton` の 4-phase パターンに倣う): 合流先 exam の native select(自身を除外)+ 配置(末尾 既定 / 先頭)+ 確認文言(「N 枚を◯◯へ移動します。元の試験は空のまま残ります」)。
- 実行 = mirror から source exam の全 card を読み MoveCards(全件, 合流先, 配置)。元 exam は空で残す(tombstone 化・自動削除なし — 削除は既存の試験削除)。cardCount = 0 の行では disabled。完了 toast は一覧ページ側で表示。

### 7.4 ソート・フィルタ gating(kickoff 決定 7)

- 判定は table の state(`sorting.length > 0 || columnFilters.length > 0`・`exam-card-table.tsx:283, 285`)。適用中: (a) の配置「指定カードの直後」と (c) の menu 項目を disabled にし、理由「ソート/フィルタ適用中は位置指定できません(解除するか、末尾/先頭を使ってください)」を表示。末尾 / 先頭への移動・切り出し・結合は許可。
- ソート中に選択して移動した場合の並びは §2.3-1(基準順ソートしてから割当)が構造的に保証する。

### 7.5 toast 基盤(最小)

- 新設 `components/ui/action-toast.tsx`: `billing-banner.tsx` の bespoke 実装(fixed 配置 / `role="status" aria-live="polite"` / auto-dismiss)を下敷きに、action button 1 個を載せられる最小 component。`{ message, actionLabel?, onAction?, onClose }` のみ。外部ライブラリ(sonner 等)は導入しない(新ライブラリ相談規律 + 最小実装)。
- 表示は発火元 component の local state(グローバル store・context は作らない — 表示面は exam 詳細と試験一覧の 2 箇所だけ)。auto-dismiss は **15 秒**(billing の 4.5 秒では undo に短すぎる)+ 手動 close。dismiss で undo 素材も破棄。
- 文言: 「N 枚を移動しました [元に戻す]」/ undo 完了「元に戻しました」/ undo 失敗は §5.4 の理由文言。

## 8. 触る箇所の全列挙

- **DB**: migration 0038(§3)/ `lib/db/schema.ts`(entity_mutations CHECK 2 本 + comment 更新)
- **shared**: `lib/sync/shared/mutation-schemas.ts`(patch + envelope union)
- **server**: `lib/cards/apply-card-move.ts`(新設)/ `lib/sync/server/entity-mutation-registry.ts`(entry)/ `lib/exams/list.ts`(§4.4 ORDER BY + comment)/ `app/(app)/app/exams/_actions/rename-exam.ts`(新設)/ `create-exam.ts`(nameSchema export 化)
- **domain**: `lib/cards/domain/card-order.ts`(`planMoveAssignments` 追加)
- **client**: `app/(app)/app/exams/[id]/_hooks/use-move-cards.ts`(新設)
- **UI**: `exam-card-table-action-bar.tsx`(移動 button)/ `exam-card-move-popover.tsx`(新設)/ `exam-card-row-menu.tsx` + 取り込み picker dialog(新設)/ `exam-card-table-columns.tsx`(行メニュー trigger)/ `exam-card-table.tsx`(配線 + gating 判定の受け渡し)/ `exam-list-live.tsx` + 結合 UI(新設 component)/ `exam-detail-view.tsx` + `exam-title-inline-edit.tsx`(新設)/ `components/ui/action-toast.tsx`(新設)
- **test**: §10(既存の enumerate / parity assert 更新を含む)

## 9. deploy 順と切替窓

**migrate 0038 先行 → deploy** の一方向(schema.ts の規約どおり: 旧 CHECK が新値を弾くため逆順は本番で INSERT 失敗)。窓中の挙動:

- 旧 code → 新 schema: 影響なし(CHECK は緩和方向)。
- 新 client bundle → 旧 server: `card_move` は registry lookup 失敗 → per-mutation failed → pending 残置 → 新 server deploy 後の再送で適用(データ喪失なし。ただし窓が長引けば mirror 乖離が見える)。deploy は通常 migrate 直後に続くため受容。

## 10. テスト戦略

1. **plan unit**(`card-order.test.ts` 拡張): 末尾 / 先頭 / 直後の割当値(凍結式との一致)/ step=0 → 2 段再採番の畳み込み(常駐 + 移動の割当集合)/ k ≥ S の終端規則 / 移動対象の基準順ソート / anchor が移動対象・不在の場合の error / 同一 exam 内移動(常駐列から自身を除く)/ 入力非破壊。
2. **move iso(原子性 + 不変条件)**: 実 PG で card_move 適用 → ① 全割当が 1 tx で反映(`ORDER BY base_order, id` readback が意図順)② **移動前後で FSRS 列・answered/streak・card_tags・answer_events・images・本文・source_document_id・content_version が bit 単位で不変**(kickoff 決定 8 の readback pin)③ 他 tenant の card id を混ぜても其行は不変(owner-scope)。
3. **SET 句 pin(unit)**: `applyCardMove` の SET が `{examId, baseOrder, updatedAt}` のみ(`card-field-handlers.test.ts:241-248` の決定 6 pin と対称に、**move が question_label に触らない**ことを含む — handoff ③)。
4. **冪等 iso**: 同一 mutation_id 再送 → `'skipped'`・行不変・log 1 行。異なる mutation_id で同一 patch 再適用 → 結果不変(semantic 冪等)。
5. **skip-missing iso**: patch 内 1 枚を先に削除 → 残りが適用され、削除済 id は影響なし・`'applied'`。全滅 → 空適用 `'applied'`。移動先 exam 不在 → `'failed'`(examNotFound 相当)。
6. **wire 拒否 matrix(route unit)**: exam_id 欠落 / cards 空 / card id 重複 / base_order 0・負・小数 / 10,000 件超 → per-mutation failed。update_field `field: 'base_order'` → dispatch miss で failed(D-3 の pin)。
7. **CHECK iso**: `check-constraints.test.ts` の registry 導出 assert が新語彙で green(`'exam'` illegal pin 維持)。
8. **registry unit**: enumerate 9 → 10 件 + `card_move.move` の `cascadeLike: true` assert。group helper が card_move 混在 batch を serial fallback に倒す。
9. **undo unit**: forward plan → originals 控え → inverse plan の適用結果が元の順序と一致(round-trip)。**同一 exam 内 + step=0 再採番を含む forward の round-trip を必須ケースに含める**(常駐復元を欠くと順序が壊れる — §5.4 の反例)。検証失敗 path(card 欠け / 元 exam 消滅)。
10. **getCardsForSourceDocument iso**: 2 exam に跨った cards が `(exam_id, base_order, id)` 順で返る。
11. **rename action test**: owner-scope / zod 境界(空・201 字)。
12. **UI**: gating(ソート適用中に「直後」disabled)/ toast 表示と undo 二度押し防止は component test で最小限。

**gate**(kickoff 指定): `pnpm lint`(whole-repo, --max-warnings=0)→ `typecheck` → `build` → `test` → `test:iso` 全 exit 0。sprint 完了時は CLAUDE.md 共通 gate(`pnpm run audit` 含む)。依存・Next 設定 file は不触の想定(`--frozen-lockfile` 系 gate は対象外)。

## 11. scope 外(明記)+ 残余リスク

**scope 外**:

- 行 DnD(直後の小 sprint — ただし書込チャネルは §2.4 で先取り確定済: DnD は card_move を消費し新チャネル不要)。
- 移動履歴の永続化・undo の複数段・undo の undo。
- exam の削除・アーカイブ仕様の変更(結合後の空 exam 自動削除もしない)。
- カードビュー(非 table)への選択・移動 UI(一括操作は従来どおり table 専用)。
- 移動先 exam 消滅時の mirror 自動巻き戻し(下記残余リスクの恒久対処)。

**残余リスク(受容・記録)**:

- 移動先 exam が並走削除された場合、move は failed → 再送ループ → 30 日 stale 隔離となり、client mirror では対象カードが「存在しない exam 所属」のまま不可視化する(server 側は source exam に残存し、他端末は正しく見える)。これは「update_field failed 後の mirror 乖離」という**既存 class** の一形態で、mirror 側の reconcile 機構は本 sprint では作らない(popover の移動先 list が mirror 由来のため、窓は実質的に純並走のみ)。恒久対処(failed mutation の mirror 巻き戻し等)は follow-up として claude.ai todo へ。
- patch.cards が 10,000 件を超える move(移動対象自体が 10,000 件超、または step=0 再採番で移動対象 + 再採番常駐が 10,000 件超)は wire validation により per-mutation failed となり、optimistic mirror が server と乖離し得る。現規模外として受容し、実 exam の枚数または一括移動件数がこの域に近づいた時点を、上限見直し / client-side 事前拒否の再訪トリガーとする。(2026-08-14 OT 承認時追記)

## 12. OT 確認点(spec が新たに確定した判断 — 承認時に併せて裁定)

1. **D-7**: Order-1 §2.3-2 の凍結式は k ≥ S(1024 枚以上を単一 gap へ挿入)で再帰が停止しない。本 spec が終端規則(合成列への i·S 一括再採番)を**凍結契約の未定義域への追加**として定義した — §2.3-4。Order-1 spec 本文は書き換えない。
2. **D-4**: 「1 tx の all-or-nothing」の精密化 — 削除済カードは skip して残りを適用(全体 fail は再送ループ → silent lost write のため)。移動先 exam 不在のみ failed — §4.2。
3. **D-6**: content_version は触らない(kickoff 決定 8 の括弧書きを「許容」と読んだ。全既存経路で dead)— §4.1。
4. **D-8**: 切り出しの exam 作成・試験名改名は server action 経路(mutation 化しない)。帰結として**切り出し・改名はオンライン必須** — §6。
5. **D-3**: base_order の update_field handler は追加しない(card_move 単独チャネル・DnD も同 op)— §2.4。
6. **D-9**: (c) 取り込み picker は 1 操作 = 1 source exam(undo を単一 mutation にする wire 前提)— §7.2 / §5.4。
7. **D-1**: 新 entity_type `'card_move'`(op `'move'`・entity_id = op instance uuid)。schema comment の entity_id 意味論を追記更新 — §2.1。
8. **D-10**: getCardsForSourceDocument = `(exam_id, base_order, id)` — §4.4。
9. UI 文言・挙動の仮置き: toast 15 秒 / 「無題の試験」/ gating 理由文言 / 結合の確認文言(実装時に最終確認)— §7。
10. 残余リスク受容(移動先 exam 並走削除時の mirror 乖離 / patch 上限超過)と follow-up 起票 — §11。
