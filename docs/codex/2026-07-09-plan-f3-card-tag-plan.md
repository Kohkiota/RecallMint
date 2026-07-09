# Codex plan cross-check — f3-card-tag-plan (2026-07-09)

- **作成日**: 2026-07-09
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **G/R 分離の検出器設計**
  - W 無しを成立させるには、R 前に現行挙動を pin する golden が実際に「変更対象の意味論」を観測できる必要がある。
  - 特に `card_count` は create/delete/OCR の 3 経路があり、OCR +N は未 pin なので G1 の fake が弱いと R4 の regress を検出できない。

- **G1 OCR fake の責務境界**
  - G1 の目的は `saveExtractedCards` の cards insert、同一 transaction、`exams.cardCount += N`、owner-scoped WHERE、`updatedAt` 据え置きの pin。
  - `applyOcrTags` 本体は find-or-create 多段で、G1 の対象ではない。通し fake にすると fake が複雑化し、test が tag 実装詳細に引きずられるリスクが高い。
  - 一方で mock する場合は「同じ tx object で呼ばれた」ことを必ず assert しないと、transaction 境界の golden にならない。

- **`updatedAt` 据え置きの観測**
  - helper 化で `updatedAt: exams.updatedAt` を落とすと一覧順などに影響する。
  - 既存 fake が `set` を捨てるなら、G2/G1 の fake 拡張で SET 句を捕捉する必要がある。
  - 値 pin と SQL render pin は分けるべき。param 化で SQL 文字列が変わっても挙動は同じ可能性がある。

- **`card_count` helper の符号 semantics**
  - `delta > 0` は素加算、`delta < 0` は `GREATEST(..., 0)` という非対称性が重要。
  - `delta=0` を一般化して防御分岐を足すと、spec の「起きえない分岐を足さない」に反する。
  - owner scope `examId + userId` と `updatedAt` self-reference は helper 側で固定すべき。

- **OCR path と card rules の境界**
  - `deriveCorrectAnswerIds` は client/server の通常 card mutation dedup 対象。
  - OCR path へ再導出を入れると AI 出力信任境界を変えるため、挙動変更になる。
  - R2/R4 で upload 周辺に触るため、誤配線検出の review 観点が必要。

- **zod bounds 集約の同値性**
  - 同値確認は limit と message だけでは不足。
  - issue path、複数 issue の順序、parse 対象 shape、schema composition の形が変わると contract や将来 test が割れる。
  - 現 test が message/path を assert していないなら、机上照合と snapshot 更新ゼロだけでは検出力に限界がある。少なくとも「文字通り移動」の制約が重要。

- **`card-field-handlers.ts` の多段接触リスク**
  - R2/R3/R6 が同一 file を 3 回触るため、import block と近接 hunk の順序管理が必要。
  - 対象 hunk は互いに素でも、import 整理や formatter による巻き込みが衝突・差分拡大要因になる。

- **domain 純度と cross-domain 参照**
  - Card domain が Tag の `SelectType` を参照する設計は妥当だが、runtime import にすると薄い domain の純度境界が曖昧になる。
  - `import type` 強制と lint が必要。
  - `card-tag-constraint` は存在検証済み・owner scoped 入力前提を明記し、防御ロジックを増やさない必要がある。

- **Tag UNIQUE golden の限界**
  - G3/G4 は precheck の挙動 pin であり、並行競合時の DB UNIQUE 制約までは fake unit で検証できない。
  - unit で INSERT/UPDATE 不発を pin する一方、DB 制約の保証範囲と混同しない記録が必要。

- **cascade tombstone と実 FK cascade の分離**
  - G5 で unit pin できるのは tombstone 発行。
  - `tag_options` / `card_tags` の実 FK cascade は fake では観測不能なので、stg smoke 領域として明確に残す必要がある。

- **client diff の厳密な封じ込め**
  - F3 は F1/F2 と異なり client が対象に入る。
  - `session-runner` は import rewire だけでなく inline logic から関数呼び出しへの置換なので、diff 実証で過小表現しないことが重要。
  - `inline-card-list` の `buildNewCardMutationPatch` は残置対象で、巻き込み変更を避ける必要がある。

- **旧 symbol 参照の消滅**
  - `card-write.ts` に re-export shim を残さない方針なので、旧 import 残存は typecheck と `rg` で確認する必要がある。
  - `buildNewCardMutationPatch` は残るため、単純な `card-write` 全排除ではなく旧シンボル単位で確認すべき。

- **scope 外の category 同名 server validation**
  - server で tag category 同名を偶然塞ぐと W になる。
  - F3 では pin もしない、fix もしないという判断を review 観点に入れる必要がある。

- **review/gate の運用リスク**
  - G/R 全 commit で snapshot 更新ゼロと canonical review を要求するなら、plan は各 task の停止条件を明確にしないと「赤を直すために golden 更新」の事故が起きる。
  - risk task は特に contract snapshot 更新ゼロを個別確認すべき。

## plan ドラフトへの抜け・未考慮指摘

- **G1 は概ね必要点を押さえている**
  - `applyOcrTags` を mock に固定し、同一 tx object を assert する方針は妥当。
  - ただし `set.cardCount` の「fragment に param N」が具体的にどの表現を許容するかが曖昧。SQL render 文字列依存に寄ると brittle になるため、値・式種別・`updatedAt` self-reference の観測粒度を plan 内でより明確にした方がよい。

- **G1 の transaction fake の失敗経路が未記載**
  - `applyOcrTags` が mock なので、失敗時 rollback は対象外でよいが、その非対象性は明記した方がよい。
  - 今の plan だと「同 tx」は見るが「transaction callback 内で exams update が発生した」ことの観測方法がやや暗黙。

- **R3 zod 同値照合は机上チェック中心で、検出器としては弱い**
  - plan は現 test が message/path を見ていない事実を認めているが、追加 golden を足さない判断の理由が薄い。
  - W 無しを強く主張するなら、少なくとも R3 前後で代表 field の `safeParse` issue path/message/order を直接比較する一時確認、または小さな unit 追加を検討対象として明記した方がよい。
  - ただし spec が golden 追加範囲を固定しているなら、plan は「追加しない代わりに文字通り移動 + snapshot 更新ゼロで担保」と限界を明示すべき。

- **R3 の `mutation-schemas.ts` 側の path 変化リスクがやや過小**
  - 同じ schema object を field に差すだけなら path は通常維持されるが、object shape や nullable/refine の位置を変えると変化する。
  - plan の「合成し直し禁止」は良いが、`optionSchema` 既存 export との import/export 名衝突や循環 import の確認が未記載。

- **card-field-handlers 3 回接触は順序の記載はあるが、import 整理の巻き込み禁止が弱い**
  - 共通接触が import block のみなら、各 commit で必要最小 import だけ触る、formatter による広域 import reorder を許す/許さないを決めた方がよい。
  - R2/R3/R6 の各完了条件に `git diff -- lib/cards/card-field-handlers.ts` の hunk 確認を入れると、設計意図に合う。

- **R2 の server 5 inline の列挙がやや不足**
  - apply-card-mutation の `deriveCorrectAnswerIds` 置換は書かれているが、「server 5 inline」の内訳が task 本文だけでは読み取りづらい。
  - `card-field-handlers` の 4 箇所 + `apply-card-mutation` 1 箇所として明示すると実装者の漏れが減る。

- **R4 helper test と G1/G2 の責務重複**
  - helper 直 unitで fragment shape を見るなら、G1/G2 との重複が増える。
  - 重複自体は悪くないが、G1/G2 は consumer の golden、helper unit は helper contract と位置づけを分けておくべき。

- **client diff 実証の base が曖昧**
  - plan は `git diff <G 直前>..HEAD` としているが、spec は `<base>..HEAD` 文脈。
  - G commit で test 追加が入るため client diff には影響しないはずだが、実証対象は実装全体なのか R のみなのかを固定した方がよい。

- **`rg 'card-write'` の書き方が雑**
  - `buildNewCardMutationPatch` は残置なので、`card-write` 参照自体は client に残る可能性がある。
  - 旧シンボル import の残存ゼロを確認する grep 条件に限定すべき。

- **R7 の lint 赤実証を commit message/session doc に記録する運用が重い**
  - read-only review観点では問題ではないが、実装 plan としては一時違反を入れて revert する操作が余計な事故面になる。
  - 既存 F1/F2 前例に合わせるならよいが、必須にするなら「作業ツリーに残さない」だけでなく、どの rule が赤になったかの記録粒度を定めるべき。

- **docs commit `[no-review]` が全体方針と少し緊張**
  - Global Constraints では各 task commit が `[reviewed]` 前提に見える一方、最終 docs は `[no-review]`。
  - spec と矛盾しないならよいが、review gate の対象外である理由を一言書いた方がよい。

## リスク / 対立しうる設計判断

- **mock vs fake**
  - `applyOcrTags` mock は G1 を単純化できるが、実際の同一 tx 内副作用の総量は見ない。
  - 通し fake は統合度が上がるが、fake が本体より複雑になり golden の信頼性を落とす。今回の範囲では mock 優位。

- **zod test を追加するか、文字通り移動で済ませるか**
  - 追加 test は R3 の検出力を上げる。
  - ただし spec の G 範囲外に test を増やすと plan 粒度が増え、R の「golden 更新ゼロ」運用がやや複雑になる。

- **helper の SQL render をどこまで pin するか**
  - render 文字列 pin は regression 検出が強い一方、Drizzle の表現差や param 化に弱い。
  - 挙動保存が目的なら、owner WHERE、delta semantics、`updatedAt` self-reference を構造的に見る方が安定する。

- **re-export shim なし vs 移行の安全性**
  - shim なしは恒久間接層を避けられる。
  - 代わりに旧 import 残存の検出が必須になり、client diff が増える。

- **thin DDD の境界**
  - repository 非新設は現行 apply 関数の形に合っている。
  - ただし domain/rules/validation/helper が分散するため、責務説明と lint がないと「どこに置くべきか」が再び曖昧になる。

- **scope 外不具合を pin しない判断**
  - category 同名 server 素通しを pin しないのは将来 fix を邪魔しない。
  - 一方で F3 実装中に偶然塞いだ場合は W 混入になるため、review 観点で明示的に監視する必要がある。