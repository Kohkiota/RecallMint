# F3: Card + Tag aggregate(薄い DDD)— design spec

- 日付: 2026-07-09 / branch `develop` / 前提 HEAD: fact-finding 時 `aafcae7`(着手時に再スキャン)
- 入力: `docs/audit/2026-07-09-f3-factfinding.md`(42b1ef4)+ OT/claude.ai 確定 6 判断 + design 承認 9 点 + 追記 1 点(下記・**再議論しない**)
- 位置づけ: 完全 DDD の F3(意図 doc §5 の F4 相当)。型 = F1/F2 を踏襲しつつ、**F1/F2 との構造差分 = ①薄い repository(新設しない・§3.1)②W(挙動変更)無し(§4)③client が dedup 対象に含まれる(§3.6)** — この 3 点が本 spec の重点。

---

## 1. 確定判断(spec の前提・固定)

1. **scope = Card + Tag のみ。Exam は defer**(own 不変条件ほぼ無し — status は SourceDocument 帰属・card_count は Card 帰属。境界再設計とセットで後回し)。1 sprint 内で **F3a(Card)→ F3b(Tag)** の内部 phase 分割。
2. **repository 深さ = 薄い**(共有 pure module + VO + 最小 interface)。フル aggregate 儀式を避ける(v37 保留への回答)。具体形は §3.1。
3. **single 制約の帰属 = Card(card_tags 集合)所有 + SelectType VO**(A-1 の server 検証配置と整合)。
4. **card_count = (a) 維持 + ±N helper 集約**。projection 化不採用。**behavioral golden 先張り → helper 集約の順序**(唯一の挙動保存リスク面)。Grid-3 の下敷き。
5. **OCR path = correct_answer_ids 共有 module の対象外**(AI 信任境界。Gemini 出力を再導出しない現挙動維持)。※ card_count ±N helper の **consumer には OCR path も含む**(判断 4 — 混同注意: 除外されるのは correct_answer_ids の再導出のみ)。
6. **golden 先張り = Tag UNIQUE(category,name)+ cascade を筆頭**。Exam card_count inverse integrity は helper 集約が触る最小限のみ pin。

**design 承認(2026-07-09・veto なし)**: 薄い interface = repository 非新設(§3.1)/ file 配置(§3)/ VO = SelectType のみ(§3.3)/ dedup 対象 = byte-equivalent 確認済 3 種(§3.2/§3.4)/ card_count helper(§3.5)/ Tag golden 具体(§5)/ **W 無し・G→R 完結**(§4)/ phase 構成(§4)/ Codex plan-review 通過後に spec 確定。

**追記(OT・design 変更なし)**: **client diff 範囲の明示**。F1/F2 は client 完全不触だったが、F3 は client(session-runner:206 の inline 導出)が dedup 対象に含まれる。spec で client の card-rules 参照の発生箇所と diff の質(import rewire のみか実ロジック変更か)を明示し(§3.6)、完了条件で git diff 実証(§8)。「ゼロ」でなく「import rewire のみ」と正直に記録する。

環境前提: **zero users(prod 含む)・migration 一切不要・schema 変更ゼロ**。

## 2. スコープ / やらないこと

**やる**: Card domain 層新設(card-rules / card-tag-constraint)/ Tag domain 層新設(tag-values = SelectType VO)/ Card server dedup(correct_answer_ids 導出・null 正規化・field bounds の単一定義化)/ card_count ±N helper 集約(3 site)/ golden 先張り(card_count OCR +N・updatedAt 据え置き・Tag UNIQUE ×2・cascade tombstone)/ domain 純度 lint 拡張 / client の import rewire(§3.6 列挙分のみ)。

**やらない**: 新 repository file の作成(§3.1)/ **Exam の domain/aggregate 化(defer。ただし Card 所有の派生 cache として exams.card_count の更新は helper 経由で対象 — Codex 指摘採用・表現衝突の解消)**/ OCR path への correct_answer_ids 再導出導入(判断 5)/ category 同名の server 検証追加(§7 発見 — 挙動変更 = W 化は別途 OT 判断)/ buildNextTagSet の domain 移設(既に pure 共有 module・移設は所在整理であって dedup でない・client rewire を増やすだけ = YAGNI)/ tag-crud.ts:445-455 の inline 展開の共有化(rule of three 未達 2 site・意図的 inline)/ wire 契約変更(P0 §A #3/#4/#5/#6/#10 凍結)/ schema 変更 / is_correct 再計算(F2 spec 確定判断 2 の F3 帰属分は **deriveRating = Session 側の話**であり本 spec の Card/Tag scope 外 — 別途 OT 判断)。

## 3. 目標構造と file 配置

```
lib/cards/
  domain/                        ← 新設(純粋層・zod-free)
    card-rules.ts                ← deriveCorrectAnswerIds / NULLABLE_TEXT_FIELDS /
                                    normalizeNullableTextField(card-write.ts から verbatim 移動)
    card-tag-constraint.ts       ← hasSingleCategoryOverflow(A-1 判定の pure 抽出・Card 所有)
  card-count.ts                  ← 新設(infra・drizzle): bumpExamCardCount(±N 集約)
  card-write.ts                  ← 縮退: buildNewCardMutationPatch のみ残置(re-export shim は残さない)
  apply-card-mutation.ts         ← consumer 化(inline 導出 → card-rules import。SQL は残置)
  card-field-handlers.ts         ← consumer 化(inline 導出/正規化/A-1 判定 → domain import、
                                    bounds zod → validation/card import。SQL・dispatch は残置)
lib/tags/
  domain/                        ← 新設(純粋層)
    tag-values.ts                ← SelectType VO('single'|'multi' + 帰属 doc)
lib/validation/card.ts           ← 既存拡張: card field bounds zod を集約
                                    (mutation-schemas / card-field-handlers の単一 source)
app/(app)/app/upload/_actions/upload-persistence.ts ← card_count +N を helper 経由に(SQL 移譲)
```

### 3.1 「薄い interface」の具体形(判断 2 の実体・F1/F2 との明示差分)

**新 repository を作らない**。F1/F2 は散在 SQL を repository の意図別メソッドへ集約したが、Card/Tag の SQL は既に意図別 apply 関数(`applyCardCreateWithId` / `applyCardDelete` / `CARD_FIELD_HANDLERS` / `applyTag*` — 全て `DbExecutor` 型)に整理済 = **repository 前段が既に存在**。これを再梱包する file 追加は儀式(簡潔性規律: 間接層を足す前にそれ無しで書けないか試す)。

→ F3 の「薄い」= **既存 apply-\* を data-access seam として維持**し、その中の**ルール定義だけを domain へ吸い上げる**: domain(pure 定義)+ validation(zod bounds 単一 source)+ card-count(±N helper)+ 純度 lint。apply-\* は「domain を import して SQL を実行する consumer」に縮退する。

### 3.2 Card domain(`lib/cards/domain/`)

- **card-rules.ts**(card-write.ts から verbatim 移動): `deriveCorrectAnswerIds(options) → string[]` / `NULLABLE_TEXT_FIELDS` / `normalizeNullableTextField(field, value) → string | null`。既存 card-write.test.ts の該当 test も同時移動。
- **card-tag-constraint.ts**(card-field-handlers.ts:242-253 から verbatim 抽出): `hasSingleCategoryOverflow(assigned: {optionId, categoryId}[], categories: {id, selectType: SelectType}[]) → boolean` — カテゴリ別 option 数集計 + single ≥2 判定。**SelectType 型は `@/lib/tags/domain/tag-values` から import(pure→pure の cross-domain 参照 = 判断 3「Card が所有し Tag の SelectType を参照する」の型表現)**。orphan category の fail-closed(categories.length 不一致 → failed)は SQL 結果の存在検査ゆえ handler に残置(domain 抽出は判定 rule のみ)。**入力契約を doc 明文化**(Codex 指摘採用): domain 関数は「owner-scope + 存在検証済みの入力を受け取る」前提 — 未検証入力の防御分岐を domain に足さない(検証は handler 責務)。
- **import 純度**: F2 と同じ lint 型(runtime import 禁止 deny-list + allowTypeImports)。`lib/cards/domain/**` からの `@/lib/tags/domain/*` 参照は **type-only に限定**(SelectType は型ゆえ `import type` で足りる。lint で deny + allowTypeImports=true として runtime import 混入を機械検出 — Codex 指摘採用)。zod / drizzle / next / logger / lib/db / server-only 不可。

### 3.3 Tag domain(`lib/tags/domain/tag-values.ts`)— VO は SelectType のみ

`export type SelectType = 'single' | 'multi'`(schema `$type` と同値)+ 帰属 doc(「single の集合制約は Card 所有の `hasSingleCategoryOverflow` が判定し、Tag は select_type の定義を持つ」)。**F1/F2 型の関数付き VO にしない**(single 判定は Card 帰属 = 判断 3、Tag 側に置く rule が無い。儀式 VO を作らない — 判断 2)。buildNextTagSet(client toggle 意味論)は既存位置のまま(§2 やらない)。

**client/server の意図的別責務**(Codex 指摘採用・「まだ重複が残っている」と誤読されない為の明示): client `buildNextTagSet` = toggle 操作の**次集合計算**(UX 楽観・入れ替え semantics)/ server `hasSingleCategoryOverflow` = whole-set 受領時の**違反判定**(権威)。両者は同一 rule の重複定義でなく**異なる関数形**(集合の構成 vs 集合の検査)ゆえ単一化対象外 — F2 の「定義 1 つ・実行 2 回」原則の対象は同形定義の重複のみ。

### 3.4 bounds 集約(`lib/validation/card.ts` 拡張)— domain でなく zod 層

card field bounds(title 200 / sort_key 100 / question_text 10000 / explanation_text 10000 / memo 10000 / options 1-50 + id 重複 refine)を validation/card.ts に集約し、`mutation-schemas.ts`(create patch)と `card-field-handlers.ts`(update per-field)の両方が import する。**集約先が domain でないのは domain zod-free 原則(F2 lint 前例)の帰結**。

**挙動不変の根拠(spec 起草時に確認済)**: 両者の bounds は**現状 byte-equivalent**(限界値・エラーメッセージ・refine 完全一致。mutation-schemas.ts:49-73 ⇄ card-field-handlers.ts:60-92、optionSchema は既に validation/card.ts 共有)。よって集約は純粋 R であり W を生まない。tagOptionIdsSchema(uuid[]/max100)は tag_option_ids handler 固有ゆえ card-field-handlers 残置。

**equivalence の確認対象は値・message に限らない**(Codex 指摘採用): zod issue path / 複数エラー時の issue 順序 / parse 対象 shape も R3 の同値確認に含める(schema 合成の仕方で issue path が変わると unit assert が割れる — 現 test が message/path を assert していれば golden がそのまま検出器になる。plan で R3 の同値照合表に記載)。

### 3.5 card_count ±N helper(`lib/cards/card-count.ts`・infra)

```
bumpExamCardCount(tx: DbExecutor, args: {examId, userId, delta: number}) → Promise<void>
```

- **SQL 意味論 verbatim**: delta > 0 → 素の加算(create +1 / OCR +N の現挙動)/ delta < 0 → `GREATEST(card_count + delta, 0)`(delete の負値 guard 現挙動)。`updatedAt: sql\`${exams.updatedAt}\``(据え置き = 一覧順を乱さない)と owner-scoped WHERE(`eq(exams.id)` + `eq(exams.userId)`)を 3 site 共通で verbatim 維持。
- **delta の契約**(Codex 指摘採用): callers は非ゼロのみ(現 consumer = +1 / -1 / +N)。delta=0 は想定外 — 防御分岐・test を足さない(簡潔性規律)。一般 N の property test もしない(現 3 consumer の値で固定)。
- **配線 3 site**: apply-card-mutation.ts:109-117(+1)/ :171-179(-1)/ upload-persistence.ts:36-45(+N)。
- SQL text は param-bound 化で現行 render と異なりうる(`- 1` → `+ $1`)が、golden は**値 pin(behavioral)**ゆえ吸収。SQL 述語の同値照合表(F2 型)は plan で作成。
- DbExecutor 型は apply-card-mutation.ts から import(apply-tag-mutation.ts:19 と同 pattern)。

### 3.6 client diff 範囲(OT 追記の明示)★F1/F2 との差分

client の card-rules 参照は**発生する**。全列挙(これ以外の client 変更は無い):

| file | 変更の質 |
|---|---|
| `app/(app)/app/study/smart/_components/session-runner.tsx:206` | inline 導出(filter/map)→ `deriveCorrectAnswerIds` 呼び出しに置換。**ロジック同値**(単一化先が byte-equivalent) |
| `app/(app)/app/exams/[id]/_hooks/use-card-options.ts` | import 先 rewire 1 行(card-write → card-rules) |
| `app/(app)/app/exams/[id]/_components/inline-text-field.tsx` | import 先 rewire 1 行(同上) |
| `lib/cards/card-write.ts` | 縮退(移動 2 関数 + 定数の削除。buildNewCardMutationPatch 残置)。**re-export shim を残さない**(恒久間接層の回避 — CC 判断点 1) |

**挙動は全経路で不変**。完了条件(§8)で `git diff` により client 変更が上記列挙のみであることを実証し、session doc に「client diff = **import rewire + byte-equivalent な呼び出し置換(session-runner のみ)**」と記録(Codex 指摘採用・「import rewire のみ」は session-runner の call-site 置換を含む点で不正確 — F1/F2 の「client diff ゼロ」確認と同型・F3 は表現を正直化)。

## 4. Phase 構成 = commit 境界(G→R のみ・W 無し)

**挙動変更の有無 = 無し(spec で確定)**。根拠: dedup 3 種は byte-equivalent 確認済(§3.4)+ verbatim 移動(§3.2)+ helper は SQL 意味論保存(§3.5)+ A-1/single 制約は既実装の抽出のみ。**万一 R 中に divergence(定義間の差異)を発見したら即停止し、F1/F2 規律どおり W 隔離 commit に切り出して OT 判断**(想定なし・cover up 禁止)。**divergence の観測対象 checklist**(Codex 指摘採用・「見つけたら止める」の具体化): zod issue path / エラー message / WHERE 述語 / updatedAt semantics / wire shape(patch/response)/ tombstone entity_type / skipLog — R の各 commit でこの面の差分が出たら divergence と見なす。

| phase | commit(粒度は plan で確定) | 内容 | 挙動 |
|---|---|---|---|
| **G** | `test(cards|tags): F3 golden 先張り`(1 commit) | §5(card_count OCR +N / updatedAt 据え置き / Tag UNIQUE ×2 / cascade tombstone) | 不変(test 追加のみ) |
| **R**(F3a Card) | R1 `refactor(cards)`: card-rules 新設(additive・配線なし)/ R2: card-rules 配線 + card-write 縮退(server 5 inline + client 4 file・§3.6)/ R3: bounds 集約(validation/card + 2 consumer 配線)/ R4: card_count helper 新設 + 3 site 配線 | §3.2/3.4/3.5。**golden/snapshot 更新ゼロ = 挙動不変の客観証明** | 不変 |
| **R**(F3b Tag) | R5 `refactor(tags)`: tag-values + card-tag-constraint 新設(additive)/ R6: card-field-handlers A-1 block 配線 | §3.2/3.3 | 不変 |
| **R**(lint) | R7 `chore(lint)`: 両 domain の純度 lint 一括(独立 commit) | §3.2 lint 型 | 不変 |

- 新設(additive)→ 配線を別 commit にする(F1 R2→R3 / F2 R1→R2 の「移動と書換えを別 commit」踏襲)。
- R で golden が赤 → 即停止。golden を直して通す行為は禁止(P0〜P4 規律)。
- card-field-handlers.ts は R2(導出/正規化)→ R3(bounds)→ R6(A-1)の 3 回接触 — plan で同 file の hunk 衝突がない直列順を固定。
- lint を両 domain 一括 1 commit にするのは CC 判断点 2(F1/F2 は per-phase 1 commit だった — F3 は同 sprint 内 2 domain ゆえ集約)。

## 5. Phase G: golden 先張り

fact-finding Step 5 の gap のみ足す(Card は既 pin が厚く G は薄い — 既存の正: card-write.test 8 / card-field-handlers.test 57(A-1 の 4 test :1059-1137 = single 制約の pin)/ apply-card-mutation.test 18(±1 / GREATEST / integrity / WHERE spy)):

| # | 置き場 | 内容 | 塞ぐ gap |
|---|---|---|---|
| G1 | `app/(app)/app/upload/_actions/upload-persistence.test.ts`(新設) | **OCR bulk +N の behavioral pin**: saveExtractedCards で cardCount += cardRows.length / 同 tx / owner-scoped WHERE / **tx 内の exams UPDATE を全捕捉して updatedAt 据え置きを assert**(applyOcrTags 等の同 tx 副作用が観測を汚さない fake 設計)。fake db は apply-card-mutation.test の executor fake 型を踏襲。**G1 は R4 の前提 golden ゆえ、applyOcrTags の扱い(fake 通し or mock)は plan の最初の確定事項**(Codex 指摘採用 — 曖昧なまま G に入ると最初の commit で詰まる) | card_count 3 site 中 OCR +N のみ完全未 pin(fact-finding §5) |
| G2 | `lib/cards/apply-card-mutation.test.ts` 追記 | **updatedAt 据え置き pin**(create +1 / delete -1 の SET 句が `exams.updatedAt` self-reference = 一覧順不変の挙動)。shape 捕捉で可(fake が $onUpdate を模さないため) | 据え置きが unit 未 assert(helper 化で落とすと一覧順 regression) |
| G3 | `lib/tags/apply-tag-mutation.test.ts` 追記 | **UNIQUE create-dup**: applyTagOptionCreate 同 category 同名(別 id)→ failed + INSERT 不発 | UNIQUE は rename-dup(:386)のみ pin 済。create 面が未 |
| G4 | 同上 | **UNIQUE move-dup**: applyTagOptionUpdate category_id 移動で移動先同名 → failed + UPDATE 不発 | move 面が未 |
| G5 | 同上 | **cascade tombstone 列挙 pin**: applyTagCategoryDelete → category 自身 + 配下 option **全件**の tombstone INSERT(onConflictDoNothing)/ applyTagOptionDelete → 自身 tombstone | cascade の unit 可観測面が未 pin(mirror 削除反映の不変条件) |

**cascade の正直な限界**: 実 FK CASCADE(tag_options / card_tags の連動消滅)は fake db で観測不能 → **schema 保証 + stg smoke 領域**と記録(F2 の「SQL 述語は stg smoke」と同型)。unit で pin するのは tombstone 発行(= client mirror 反映の要)まで。

**UNIQUE golden の性質**(Codex 指摘採用): G3/G4 が pin するのは**事前 SELECT precheck の挙動**(failed + INSERT/UPDATE 不発)であり、並行 write 競合時の最終防衛は **DB UNIQUE 制約の領域**(unit fake で再現不能・zero users + refactor scope ゆえ対応不要 — 誤解防止の明記のみ)。

**更新禁止対象** = 既存 golden/snapshot 全部(contract 3 file 含む)+ G1-G5。R では凍結。

## 6. (W 該当なし)

本 spec に W phase は存在しない(§4 で確定)。§7 の発見(category 同名 server 素通し)を fix する場合は**別 spec/fix**(Group-A 型)であり F3 に同梱しない。

## 7. 制約(全 phase 共通)+ 発見事項

- **P0 凍結契約**: §A #3/#4(card_tags cursor = maxCreatedAt / whole-set 縮小補完)#5(tombstone entity_type union)#6(option isCorrect→is_correct 変換 = registry:156-162 不触)#10(card/tag delete の skipLog)。**contract snapshot 更新ゼロ** — R3 の wire 不変の直接の正 = `tests/contract/entity-mutations-bulk.contract.test.ts` + `tests/contract/pull.contract.test.ts`(R3 完了時にこの 2 file の snapshot 更新ゼロを個別確認 — Codex 指摘採用)。
- **レビュー観点(dispatch prompt に含める)**(Codex 指摘採用): ① OCR path へ domain rule(correct_answer_ids 再導出)を誤配線していないこと(判断 5 の境界維持)② tag_category 同名の server 検証を偶然追加していないこと(§7 発見の「触らない」担保)。
- **owner-scope 絶対則**(CLAUDE.md Clerk 3): apply-\* / helper の全 WHERE を verbatim 維持(G2/G1 が pin)。
- **エラーメッセージ byte 一致**: bounds 集約(R3)は zod message 含め一字不変(§3.4 の byte-equivalent を保つ)。
- 簡潔性規律: VO 1 つのみ / re-export shim なし / 起きえない分岐を足さない / apply-\* の SQL・dispatch 構造は不触。
- test 方針: 既存 fake db 境界維持・実 DB 禁止。
- **発見事項(scope 外・記録のみ)**: tag_category の**同名 check は client-only**(tag-crud.ts:51 throw。server applyTagCategoryCreate は素通し・schema に UNIQUE なし)。server 検証追加は挙動変更 = F3 でやらない・G で現挙動を pin もしない(将来 fix の余地を固めない)。Group-A 型の独立 fix 候補として OT 判断へ。

## 8. 完了条件

1. G/R の全 commit が §4 の境界で分離され、R は **golden・snapshot 更新ゼロ**で full test green。
2. whole-repo gate: `pnpm lint --max-warnings=0` / `typecheck` / `test` / `build` 全 exit 0(domain 純度 lint R7 含む)。
3. 各 feat 級 risk commit(R2/R3/R4/R6 = 配線置換)は canonical + Codex review で未解決 Critical 0 / Important 0(G/R1/R5 追加系も canonical 通過 — F1/F2 と同粒度)。
4. **client diff 実証**: `git diff <base>..HEAD -- app/ lib/sync/ lib/client-db.ts` の client 面変更が §3.6 の 4 file 列挙のみであることを確認し、session doc に「client diff = import rewire + byte-equivalent 呼び出し置換(session-runner)」と記録。**加えて旧シンボルの残存 import ゼロを rg で確認**(`deriveCorrectAnswerIds` / `normalizeNullableTextField` / `NULLABLE_TEXT_FIELDS` の card-write 参照が全消滅 — typecheck が第一防衛・rg は文字列参照の補完。Codex 指摘採用)。
5. stg smoke(push 後 OT 指示・非退行のみ): (a) card create/edit(options 正解変更・空文字クリア)/delete と一覧 card_count 表示整合 (b) OCR upload → card_count 加算 (c) tag CRUD + single toggle 入れ替え + category 削除の mirror 反映(tombstone 経路 = G5 の実 DB 側)+ **category delete 後に card 側の tag 割当が残らないこと**(実 FK CASCADE = card_tags 連動消滅の実 DB 確認 — Codex 指摘採用)。W 無しゆえ OT 実機必須項目なし。
6. Sprint 完了時に session doc + 停止(OT 判断待ち)。

## 9. CC 判断点(確定判断の範囲内での具体化・OT veto 対象)

1. **card-write.ts に re-export shim を残さない**(importers を直接 rewire。恒久間接層回避 — 代償は §3.6 の import rewire 2 行が client diff に乗ること。OT 追記の「正直に記録」で処理)— §3.6。
2. **lint = 両 domain 一括 1 commit**(F1/F2 の per-phase 粒度から集約)— §4。
3. **bounds 集約先 = lib/validation/card.ts**(domain でなく zod 層。domain zod-free 原則の帰結)— §3.4。
4. **helper の SQL 意味論 = delta 符号で分岐**(正 = 素の加算 / 負 = GREATEST。3 site の現 render に最接近)— §3.5。
5. **category 同名 server 素通しは pin せず記録のみ**(pin すると将来 fix の障害。fix は別途 OT 判断)— §7。

## 10. Codex cross-check 統合記録(帰属)

`docs/codex/2026-07-09-plan-f3-card-tag-aggregate.md`(1 パス・独立論点・detector PASS)。CC spec との突き合わせ結果:

- **採用(spec に反映)**: ① client diff 表現の正確化 —「import rewire のみ」→「import rewire + byte-equivalent 呼び出し置換(session-runner)」(§3.6/§8)② zod equivalence の確認対象拡張(issue path / 複数エラー順序 / parse shape・§3.4)③ card-write 縮退後の旧 import 残存ゼロ rg 確認を完了条件化(§8)④ cards→tags domain 参照を type-only 限定 + lint 機械検出(§3.2)⑤ hasSingleCategoryOverflow の入力契約明文化(存在検証済み入力前提・防御分岐を足さない・§3.2)⑥ stg smoke に「category delete 後 card 側割当が残らない」を明示(§8)⑦ UNIQUE golden = precheck 挙動 pin / 競合は DB UNIQUE 領域の明記(§5)⑧ delta 契約(非ゼロのみ・一般化しない・§3.5)⑨ Exam defer と exams.card_count 更新の表現衝突解消(§2)⑩ divergence checklist の具体化(§4)⑪ R3 の wire 不変の直接の正 = contract 2 file 明示(§7)⑫ buildNextTagSet ⇄ hasSingleCategoryOverflow の意図的別責務明示(§3.3)⑬ レビュー観点 2 点(OCR 誤配線 / category 同名不触)を dispatch 観点に追加(§7)。
- **部分採用(plan へ委譲)**: (i) G1 の fake 設計(applyOcrTags fake 通し or mock)= plan の最初の確定事項に格上げ + tx 内 exams UPDATE 全捕捉要件を spec 明記(§5)(ii) R3 同値照合表(zod issue path 含む)の作成(§3.4)(iii) R2→R3→R6 の card-field-handlers 直列順の hunk 設計(§4 既記載の具体化)。
- **不採用(理由記録)**: G/R1/R5 の canonical review を任意化(review gate 軽量化)— F1/F2 の実績(G/R 全 commit canonical + [reviewed])と CLAUDE.md 必須経路の一貫を優先。粒度差による事故(golden 不備のまま R 進行)の方が運用負荷より高くつく。
- **確認のみ(spec 変更不要)**: 薄い DDD の理由記録(§3.1 既記載)/ Card 所有 vs domain service(確定判断 3・§3.2 で型表現済)/ card_count cache 残余リスク(判断 4 で projection 不採用確定)/ OCR 信任の将来 data quality 論点(判断 5・記録済)/ golden 厚み vs brittle test(§5 の fake 限界記載で対応済)/ hunk 干渉リスク(§4 直列順で対応済)。

## 参照

- fact-finding: `docs/audit/2026-07-09-f3-factfinding.md`(不変条件密度 / twin 実測 / cross-aggregate / test gap)
- F1/F2 型: `docs/superpowers/specs/2026-07-08-f1-subscription-aggregate-design.md` / `2026-07-09-f2-session-aggregate-design.md`(G/R/W・additive→配線・lint 型・§10 の型)
- 契約: `docs/audit/2026-07-06-p0-contract-baseline.md` §A #3/#4/#5/#6/#10
- A-1: `docs/superpowers/specs/2026-07-08-group-a-invariant-fixes-design.md`(single 制約 server enforce = 9c530e9)
- 中核コード: `lib/cards/card-write.ts` / `lib/cards/apply-card-mutation.ts` / `lib/cards/card-field-handlers.ts` / `lib/tags/apply-tag-mutation.ts` / `lib/sync/shared/mutation-schemas.ts` / `lib/validation/card.ts` / `app/(app)/app/upload/_actions/upload-persistence.ts`
