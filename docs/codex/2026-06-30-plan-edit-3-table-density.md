# Codex plan cross-check — edit-3-table-density (2026-06-30)

- **作成日**: 2026-06-30
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **「密度」の受け入れ基準が数値化されていない**
  - Notion 基準「外側1層 8px のみ・入れ子 padding なし」はあるが、最終的な行高、選択肢1件あたり高さ、textarea/input の最小高、モバイル時の許容高さが未定義。
  - T1 後に OT 実機判断する方針は妥当だが、判断軸が主観化しやすい。

- **padding 削減と tap target の衝突**
  - CompactOptionsCell の主因は `min-h-8` ×2 と td padding。
  - checkbox/delete の `min-h-8 min-w-8` 維持は妥当だが、本文・解説 input/textarea を詰めた場合、クリック/フォーカスしやすさ、IME 操作、空欄時の押しやすさが落ちる可能性がある。

- **表示モードと編集モードの寸法一致**
  - 問題は単に font size だけでなく、display div / textarea / input の line-height、padding、border、min-height が一致するか。
  - `text-sm` を渡しても、`leading-*` や textarea primitive 側の default が残ると切替ジャンプが残る可能性がある。

- **`cn` 統一は正しいが、既存の偶然依存を壊す可能性**
  - 現在は `p-2` と外部 `py-*` が両残りする未定義寄りの状態。
  - `twMerge` により「最後勝ち」へ変わるため、card-view や他 consumer が偶然その衝突後の CSS order に依存していた場合、見た目が変わる。

- **className API による密度制御は局所 sprint には妥当だが、将来の散逸リスクがある**
  - density prop を足さない判断は YAGNI として妥当。
  - ただし table 側 caller に `min-h` / `py` / `text` が散るため、同種セルが増えた時に密度ルールが複製される。

- **T1 と T2 の分離はリスク低減になる一方、T1 の font 修正は T2 に一部依存**
  - edit パスは primitive 内部 `cn` で効くため T1 でも効果がある。
  - display パスの class merge 非対称は T2 まで残るため、T1 時点の「フォント統一完了」と言い切れる範囲は限定的。

- **sticky 2列は固定 offset 前提の検証が必要**
  - select 幅 44 固定なら title left=44 は成立。
  - ただし border、resize handle、CSS width と TanStack size のズレ、DPI/subpixel、`box-sizing` によって視覚的な 1px ずれが出る可能性がある。

- **sticky 背景と hover/selection state**
  - `bg-background` 固定により hover 色・選択行色・状態色が sticky 列だけ欠落しうる。
  - 既存 title の踏襲として許容するなら、仕様として明記した方がよい。

- **z-index 階層**
  - th sticky と td sticky が同じ `z-10` だと、header / body / resize handle / dropdown / checkbox の重なりで問題が出る可能性がある。
  - 横スクロール時だけでなく、縦スクロール時の header 有無も確認対象。

- **sort_key default hidden と永続化設定の相互作用**
  - 初期 state `{ sort_key: false }` だけでよいかは、既存の hiddenColumns load effect が保存設定をどう merge / overwrite するかに依存する。
  - 「ユーザー0」前提なら migration は不要だが、保存済み localStorage/IndexedDB 設定が開発環境に残るケースはテストで混乱しやすい。

- **title 80px は編集時 UX と衝突しうる**
  - 非編集表示は4文字相当でよくても、編集 input、placeholder、resize handle、sort icon、header label が破綻する可能性がある。
  - minSize なしのままならユーザー resize でさらに潰せる点も考慮が必要。

- **テスト可能なものと実機確認必須のものの境界**
  - class assertion は padding/class merge/sticky left の存在確認には有効。
  - 実際の行高、layout shift、sticky 重なり、横スクロール挙動、card-view 差分は DOM class test だけでは保証できない。

## plan ドラフトへの抜け・未考慮指摘

- **密度の最終受け入れ基準が弱い**
  - plan は `py-1 等`、`下限は §Q2` としており、実装者裁量が残る。
  - T1 後 stop は良いが、「十分」の判定基準、比較対象スクショ、測定箇所が未定義。

- **T1 の完了条件に font 統一の限界が明記されていない**
  - T1 で `displayClassName="text-sm …"` を渡しても、display パスの `cn` 非対称は T2 まで残る。
  - T1 完了条件では「edit パスでは効く」「display パスの padding/font class merge 根治は T2」と分けて書いた方がよい。

- **`leading` / line-height の扱いが薄い**
  - 調査結果は `text-sm` vs `text-base` を主因としているが、実際のジャンプは line-height も絡む。
  - `displayClassName="text-sm"` だけでなく `leading-*` を揃える必要があるかを確認項目に入れるべき。

- **sharedBoxChrome の border / min-height / padding の相互作用が曖昧**
  - T2 は `min-h`/`py` を table 側 className で詰めるとしているが、display/edit 両方で border 有無が異なるなら高さ一致が崩れる。
  - test に「computed height」相当を入れられないなら、smoke の明示項目にすべき。

- **InlineOptionCell の具体的な caller API が曖昧**
  - plan は `className(or displayClassName)` としているが、どの prop が本文・解説・wrapper に効くのかが曖昧。
  - 誤って wrapper だけ詰め、input/textarea の `min-h-8` が残るリスクがある。

- **card-view 不変 gate がやや test 名依存**
  - consumer test + screenshot smoke は妥当。
  - ただし「className 不変」は `twMerge` 導入後に class 文字列順や重複が変わるため、文字列完全一致テストは脆い。見た目不変を狙うなら behavioral/class token/assertion の粒度を指定した方がよい。

- **sticky の z-index と header/body の重なりが plan にない**
  - `z-10 bg-background` 踏襲だけでは、header sticky がある場合や resize handle との重なりが未検討。
  - select/title の左右重なりだけでなく、縦方向・ヘッダー・メニューの layering を smoke 対象に追加すべき。

- **sticky left の style merge リスク**
  - plan は `style={{ left }}` or 任意値 class としているが、既存 `style={{ width }}` との merge を誤ると列幅が壊れる。
  - 完了条件に「既存 width style を維持」を入れた方がよい。

- **sort_key hidden と saved settings の優先順位が不足**
  - plan は mount load effect 不変としているが、保存済み visibility が `{}` の場合に sort_key が表示へ戻るのか、初期値が維持されるのかを確認すべき。
  - ユーザー0でも dev/stg の既存保存状態で挙動確認がぶれる。

- **title 80px の header 内容が未検討**
  - cell input 破綻は smoke にあるが、header label、sort icon、resize handle、column menu/toggle との関係が薄い。
  - `minSize` なしを維持する判断も、80px 化と合わせて再確認対象。

- **T1/T3/T4 並行可と中間 stop の運用が衝突しうる**
  - 要件では T1 後 stop して T2 要否判断、T3/T4 は独立で並行可。
  - plan は task 列挙上 T1 stop を強く書いているが、T3/T4 を T1 前後どちらで進めるのか、T1 実機判断前に混ぜて見た目評価してよいのかが曖昧。

## リスク / 対立しうる設計判断

- **最小変更 vs 根治**
  - T1 だけなら card-view リスクは低いが、共有 `min-h` が残って密度改善が不足する可能性が高い。
  - T2 まで行くと根治に近いが、共有部品の未定義依存を壊すリスクが上がる。

- **className 制御 vs 明示的 density API**
  - 今回は新 prop なしが妥当。
  - ただし今後 table 用 class が複数 caller に散るなら、cva preset や shared table-cell preset へ寄せる判断が再浮上する。

- **視覚密度 vs 操作性**
  - Notion 風に詰めるほど読み取り密度は上がる。
  - 一方で MCQ 編集、checkbox、削除、textarea focus、モバイル操作では押しにくさが出る。

- **sticky 背景の一貫性 vs hover/selection 表現**
  - `bg-background` 固定は重なり防止に効く。
  - ただし hover/selected row の連続性は失われる。既存 title と揃えるか、sticky 列にも状態背景を反映するかは設計判断。

- **固定 offset の単純さ vs 将来拡張**
  - select=44/title=44 固定は今回スコープでは簡潔。
  - 将来 select 幅変更、列順変更、追加 pinned column があるなら TanStack の pinning/offset 計算へ寄せる必要がある。

- **sort_key 初期 hidden の単純さ vs 保存状態との整合**
  - ユーザー0なら直書きで十分。
  - ただし既存 dev/stg の保存 visibility がある場合、初期 hidden と保存値の優先順位で確認結果が食い違う可能性がある。