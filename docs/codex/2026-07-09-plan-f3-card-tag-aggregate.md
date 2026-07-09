# Codex plan cross-check — f3-card-tag-aggregate (2026-07-09)

- **作成日**: 2026-07-09
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

1. **「薄い DDD」の成功条件は、domain 抽出よりも挙動不変の証明**
   - Card/Tag は state machine ではなく CRUD/導出/整合ルール中心。
   - したがって価値は aggregate 形状そのものではなく、既存 inline rule の重複を単一定義化しても挙動が一切変わらないことを証明できるかにある。
   - G→R で golden 更新ゼロを守れる粒度設計が最重要。

2. **Card と Tag は完全には独立していない**
   - single 制約は TagCategory.select_type を参照するが、発火点は Card の card_tags 集合更新。
   - F3a(Card)→F3b(Tag)の順序でも、`card-field-handlers.ts` は複数回触る。
   - 同一 handler に correct_answer_ids/null/bounds/single が集まっているため、hunk 干渉・レビュー困難化・テスト失敗時の原因切り分けがリスク。

3. **OCR path は二重の扱いが必要**
   - correct_answer_ids は AI 信任境界として共有 rule 対象外。
   - 一方で card_count +N は helper consumer に含む。
   - この区別をコード・テスト・レビュー観点で明確にしないと、「OCR も Card write だから domain rule 適用すべき」という誤配線が起きうる。

4. **card_count helper は小さいが、実質 cross-aggregate 書込 API**
   - owner-scope WHERE、updatedAt 据え置き、delta の正負 semantics、GREATEST guard が契約。
   - 特に positive delta では GREATEST を使わない現挙動、negative delta だけ guard する現挙動を固定する必要がある。
   - helper 化により SQL render が変わる可能性があるため、SQL 文字列ではなく behavioral pin に寄せる判断は妥当だが、WHERE と updatedAt は別途観測が必要。

5. **bounds 集約は「共通化」ではなく validation contract の移設**
   - zod error message、refine order、issue path、parse 対象の shape が変わると behavioral 変更になりうる。
   - 「byte-equivalent」とされているが、実装時には値・message だけでなく zod issue path や複数エラー時の順序も確認対象にすべき。

6. **Tag UNIQUE は DB 制約と事前 SELECT の二重構造**
   - create/rename/move の各経路で事前検証がある。
   - DB UNIQUE が最終防衛線だが、unit fake では DB constraint は再現されない可能性がある。
   - golden は「事前 SELECT による failed + INSERT/UPDATE 不発」を pin するのか、「DB constraint を期待する」のかを明確に分ける必要がある。

7. **cascade は unit test で完全には証明できない**
   - tombstone 発行は fake で pin できる。
   - 実 FK CASCADE、card_tags 消滅、mirror 反映の end-to-end は fake では不足。
   - schema 保証 + stg smoke として扱う判断は必要だが、完了条件でどこまでを F3 の責任にするか明示が要る。

8. **domain 純度 lint の範囲設計が重要**
   - `lib/cards/domain` が `lib/tags/domain` を type/pure import するのは設計上妥当。
   - ただし path alias 経由で runtime import が混入しやすい。
   - deny-list だけでなく、許可 import の粒度を明示しないと lint が形骸化する。

9. **client diff は「import rewire のみ」と言い切りすぎない方がよい**
   - `session-runner.tsx` は inline filter/map から関数呼び出しへ変わる。
   - byte-equivalent なら挙動不変だが、これは単なる import rewire ではなく call-site logic replacement。
   - 完了条件では「import rewire + byte-equivalent call replacement」と表現した方が正確。

10. **re-export shim を残さない判断は健全だが、移行漏れリスクがある**
   - 既存 importers の全数把握が前提。
   - client/server/test の import path を `rg` で網羅し、残存 import がないことを完了条件に含めるべき。

11. **「W なし」前提は妥当だが、停止条件を強くする必要がある**
   - divergence 発見時に W 隔離とあるが、どの差分を divergence とみなすかが曖昧。
   - zod issue path、SQL WHERE 条件、updatedAt、error message、mutation wire shape、tombstone entity_type、skipLog などを具体的停止条件にするべき。

12. **zero users でも local-first mirror/outbox の契約は軽視できない**
   - zero users は migration 不要の根拠にはなる。
   - しかし sync contract、cursor、tombstone、outbox op shape は将来互換性の根幹なので、schema 変更なしでも wire snapshot 更新ゼロが重要。

13. **Tag category 同名 server 素通しを pin しない判断には記録以上の注意が必要**
   - pin しないのは将来 fix の自由度を残すため妥当。
   - ただし F3 の refactor 中に偶然 server validation が追加される、または既存 client-only behavior を domain 化してしまうリスクがある。
   - 「触らない」対象として明示するだけでなく、レビュー観点に入れるべき。

14. **Exam defer は妥当だが、card_count helper が Exam table を触る**
   - Exam aggregate は defer でも、`exams.card_count` write は F3 の対象。
   - 「Exam の一切やらない」と「exams table の card_count を触る」は矛盾して見えるため、表現上は「Exam aggregate/domain は defer。ただし Card 所有の派生 cache 更新として exams.card_count helper は対象」と明確に分けるべき。

15. **test fake の忠実度が設計リスク**
   - helper 化や tombstone pin は fake executor の観測能力に依存する。
   - fake が SQL self-reference、transaction boundary、onConflictDoNothing、owner WHERE を正しく捕捉できない場合、golden の証明力が弱くなる。

## plan ドラフトへの抜け・未考慮指摘

1. **client diff の表現がやや不正確**
   - §3.6 と §8 で「client diff = import rewire のみ」としているが、`session-runner.tsx` は inline logic から shared function call への置換。
   - 「import rewire のみ」ではなく「import rewire + byte-equivalent function call replacement」と明記すべき。

2. **zod 集約の equivalence 観点が不足**
   - §3.4 は限界値・message・refine 完全一致に触れているが、zod issue path、複数エラー時の順序、parse 対象 shape の一致が明示されていない。
   - bounds 集約で subtle regression が出るならここ。

3. **`card-write.ts` 縮退後の import 全数確認が完了条件にない**
   - re-export shim を残さないなら、`deriveCorrectAnswerIds` / `normalizeNullableTextField` / `NULLABLE_TEXT_FIELDS` の旧 import が全消滅したことを `rg` で確認する条件が必要。

4. **domain 純度 lint の許可 import がまだ曖昧**
   - deny-list はあるが、`lib/cards/domain` → `lib/tags/domain` の runtime import を許すのか type-only に限定するのかが曖昧。
   - `SelectType` は type なので `import type` 強制が望ましい。純度 lint で検出するかも明記した方がよい。

5. **`hasSingleCategoryOverflow` の入力契約が薄い**
   - assigned/categories の重複、unknown category、category length mismatch の扱いが「handler に残置」とあるが、domain 関数単体の前提が明文化されていない。
   - domain 関数は「存在検証済みの category set を受け取る」と契約化した方がよい。

6. **Tag cascade golden の「card_tags」観点が弱い**
   - G5 は tag_category / tag_option tombstone を pin するが、card_tags junction の消滅・mirror 反映については schema/stg smoke に逃がしている。
   - それ自体は妥当だが、stg smoke 項目には「category delete 後、カード側の tag assignment が残らない」確認を明示した方がよい。

7. **Tag UNIQUE の race/concurrency は対象外と明記されていない**
   - 事前 SELECT による duplicate check は競合に弱く、最終的には DB UNIQUE が担保する構造。
   - zero users かつ refactor scope では対応不要だが、「unit golden は precheck behavior の pin、concurrency は DB constraint 領域」と明記すると誤解が減る。

8. **card_count helper の delta=0 扱いが未定義**
   - API は `delta: number` だが、0 を許すのか no-op にするのか、呼ばない前提なのかがない。
   - 余計な分岐を足さない方針なら「callers pass non-zero; 0 は想定しない/テストしない」などを決めるべき。

9. **card_count helper の negative delta 一般化リスク**
   - 現状 delete は -1 のみ。helper は `{delta: number}` で -N も表現できる。
   - 将来用の一般化に見えるため、必要最小なら `delta` は number でも「current consumers are +1, -1, +N only」とテストで固定した方がよい。

10. **G1 の fake db 設計が未確定のまま重要度が高い**
   - upload-persistence は OCR tags など周辺副作用も絡む。
   - 「applyOcrTags の扱いは plan で確定」とあるが、G1 は R4 の前提 golden なので、ここが曖昧だと最初の commit で詰まる。

11. **Exam defer と `exams.card_count` 更新対象の表現衝突**
   - §2 の「Exam の一切(defer)」は、card_count helper が exams table を更新する事実と読者に矛盾して見える。
   - 「Exam domain/aggregate は defer。Card 所有の派生 cache として exams.card_count 更新のみ対象」と修正した方がよい。

12. **review gate がやや重すぎる可能性**
   - §8 で R2/R3/R4/R6 だけでなく G/R1/R5 も canonical 通過とある。
   - これは安全側だが、1 sprint 内の薄い refactorとしては運用負荷が高い。必須 gate と任意 review を分けてもよい。

13. **P0 wire contract の検証方法が不足**
   - 「contract snapshot 更新ゼロ」はあるが、F3 で触る `mutation-schemas.ts` の変更に対して、具体的にどの snapshot/test が wire shape を守るかが plan 内では薄い。
   - R3 後に entity mutation registry / bulk contract が不変である確認を明記した方がよい。

14. **`buildNextTagSet` を移設しない判断は妥当だが、single rule の client/server duality が残る**
   - server は `hasSingleCategoryOverflow`、client は既存 `buildNextTagSet`。
   - 挙動が同じか、意図的に別責務なのかを明示しないと、将来「まだ重複が残っている」と見なされやすい。

15. **updatedAt 据え置き pin の対象が card_count のみでよいか要確認**
   - helper 化で `exams.updatedAt` self-reference を守るのは重要。
   - ただし OCR path の transaction で他の exam update が混じるなら、G1/G2 がそれを観測できるか確認が必要。

## リスク / 対立しうる設計判断

1. **薄い DDD vs 一貫した DDD 形状**
   - 薄い approach は現実的で過剰抽象を避ける。
   - 一方で F1/F2 と構造が変わるため、将来の開発者が「どこまで domain に置くべきか」を迷う可能性がある。
   - 対策は、spec に「state machine なし・CRUD rule中心だから薄い」と理由を残すこと。

2. **Card 所有の single 制約 vs domain service**
   - Card 所有は現 write point と一致し最小。
   - ただし TagCategory.select_type に依存するため、純粋な Card aggregate としては外部参照を持つ。
   - domain service にすると概念上は明快だが、F3 では層が増えすぎる。

3. **card_count cache 維持 vs projection 化**
   - cache 維持は現挙動・perf を守る。
   - projection 化は整合性上 clean だが、perf 退行と scope 増大がある。
   - F3 では helper 集約が妥当。ただし「派生 cache はズレうる」残余リスクは残る。

4. **OCR correct_answer_ids を信任する vs 再導出する**
   - 信任維持は挙動不変。
   - 再導出は整合性を強めるが、AI 出力との意味差分が出る可能性があり W。
   - F3 では除外が妥当だが、将来の data quality issue として残る。

5. **golden を厚くする vs refactor の機動性**
   - G を厚くすると R の安全性が上がる。
   - ただし fake で観測しにくい cascade/SQL まで無理に pin すると brittle test になる。
   - plan の schema保証 + stg smoke 方針は妥当だが、fake の限界を明記し続ける必要がある。

6. **re-export shim なし vs diff 最小化**
   - shim なしは恒久間接層を避ける。
   - ただし client diff が増え、移行漏れリスクが上がる。
   - 完了条件に import 残存ゼロ確認を入れれば許容できる。

7. **W なし前提 vs 実装中 divergence**
   - 現時点の調査では W なしで妥当。
   - ただし bounds/zod/schema/fake SQL の細部で divergence が見つかる可能性は残る。
   - 「見つけたら止める」だけでなく、具体的 divergence checklist を持つべき。