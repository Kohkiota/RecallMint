# Codex plan cross-check — notion-table-s1 (2026-07-03)

- **作成日**: 2026-07-03
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **状態の単一性**
  TanStack の `sorting` / `columnFilters` を primary にする方針は妥当だが、UI 用 `Condition[]` が実質 state 化しないようにする必要がある。chip の順序、編集対象、hidden column 表示、全クリアが常に TanStack state から再導出されることが重要。

- **初期ソートの意味**
  `sorting=[]` にして data pre-sort を既定順とするなら、「既定順」は UI 上の条件ではない。これによりバーのゼロ時シュリンクと整合する。一方で、ユーザーが全ソート削除した後に「問題文昇順に戻った」と見えるため、その挙動をテストで固定すべき。

- **既存 predicate/value 形の完全維持**
  段階1 は predicate 新規開発禁止なので、フィルタ editor は既存 UI ロジックの移設に留める必要がある。特に `currentStreak` の空入力、NaN、op/input local state 復元、`tags` の空 map 解除がリスク。

- **`undefined` 解除の徹底**
  active indicator は `getIsFiltered()` に依存するため、空値を state に残すと dot/chip が誤点灯する。個別削除、全クリア、editor 内解除、タグ全解除の全経路で同じ規約が必要。

- **hidden column 条件の可視性**
  hidden column に active filter/sort が残ると header indicator では解除不能に近い。動的バーが唯一の全体可視化面になるため、hidden 状態でも chip 表示・編集・削除できることは必須要件。

- **同一列複数条件への将来余地**
  `ColumnFiltersState` は列 id ごと実質 1 value なので、段階3-4 の同一列複数条件では value-as-array 等に移行する可能性がある。段階1 では実装不要だが、バーや registry が 1 列 1 chip 前提に固定されすぎると後段の負債になる。

- **ヘッダーメニューと resize/select のイベント分離**
  header click が即ソートから menu open に変わるため、trigger 領域、resize handle、select checkbox の DOM/イベント境界を明確にする必要がある。特に resize drag と Popover trigger の干渉は手動 smoke 対象。

- **Popover の入れ子問題**
  filter editor が select/input/tag popover を含むため、DropdownMenu は不利。`tags` は `CardTagAddPopover` 直 trigger にするなど、nested popover を避ける構造判断が重要。

- **動的バー高さと仮想化 offset**
  条件追加・削除・シュリンクで toolbar 高さが変わる。`filterBarWrapperRef` を撤去せず、動的バー + 列トグル wrapper として再定義し、ResizeObserver/listOffset を維持する必要がある。

- **テストの非空性**
  既存 sorting test が UI 非依存 harness なら、それだけでは header menu 経由の動的 sorting は保証できない。新 UI test で add/update/remove/multi/初期空を別途固定する必要がある。

- **固定バーとの共存期間**
  S1-2/S1-3 で旧 fixed filter bar と新 dynamic bar が一時共存するなら、同じ `columnFilters` を二重に操作する。テスト中に UI が二重表示されることによる曖昧さ、重複 aria label、ユーザー操作経路の混線に注意が必要。

- **タグ filter の `selectOnly` 変更**
  これは純粋な UI 移設ではなく、filter 文脈で作成/編集導線を消す仕様変更。要件上は OT 凍結済だが、既存利用者の操作差分として明確に扱うべき。

- **列表示名・capability registry の一貫性**
  menu、bar、indicator、editor が別々に列 id/display name/filter capability を持つと不整合が起きる。plain object map 1 箇所方針は良いが、表示名 map と editor registry が分裂しすぎないよう注意。

- **アクセシビリティ / キーボード操作**
  header が sort button から menu trigger へ変わるため、aria-label、focus、Escape、Tab、screen reader 上の active 状態表現が変わる。テスト範囲に最低限の role/name 検証が必要。

- **mobile viewport**
  条件 chip が横に増えた場合の折返し、横スクロール、Popover 位置、ボタンの押しやすさが設計論点。段階1 でも UI 器なので smoke 対象に入れるべき。

## plan ドラフトへの抜け・未考慮指摘

- **`toggleSorting(desc, true)` の挙動を過信している可能性**
  plan は「未追加なら末尾追加、追加済なら方向更新、重複なし」としているが、TanStack の sort removal cycle や既存 sort state との相互作用を reducer で明示する案が薄い。仕様を厳密固定したいなら `setSorting(prev => add/update)` のほうがテスト可能で、remove は chip × に限定できる。

- **同一列複数条件への将来余地が `TableCondition` 型で弱い**
  `TableCondition` が `kind + columnId + value` だけなので、後段で同一列複数条件を chip 化する際に condition id が不足する可能性がある。段階1 で実装不要でも、型名や導出関数が「columnId が一意キー」前提になりすぎる点はリスク。

- **filter chip の testid が columnId 固定**
  `condition-chip-filter-<columnId>` は段階1 では足りるが、同一列複数条件では破綻する。将来を考えるなら、内部 key だけでも index/condition key を許容する設計にしておく余地がある。

- **label 定数の置き場がやや不自然**
  `ANSWER_STATE_LABELS` / `STREAK_OP_LABELS` を condition-bar に移して editors が import する設計は、依存方向として UI bar が domain label の所有者になる。後段で editor/bar の責務が膨らむため、軽量な shared constants に置くほうが自然な可能性がある。

- **固定バー共存時の aria/name 衝突への言及がない**
  S1-2/S1-3 で旧 filter bar と新 editor が共存するなら、同じ aria-label の select/input が複数存在し、RTL test が不安定になる可能性がある。`within` の対象限定や旧バーをテストから区別する方針が必要。

- **`tags` だけ header menu ではなく直 Popover になる差分の受け入れ条件が弱い**
  spec では nested popover 回避として妥当だが、受け入れ基準の「ヘッダークリックでメニュー」とは微妙に違う。tags は「メニュー」ではなく「filter popover」が開く例外として明記したほうがよい。

- **hidden column の sort 条件も表示対象かが曖昧**
  主入力では hidden column の active 条件全般が問題。plan は S1-2 で hidden chip 表示を扱うが、テスト記述は filter 寄りに読める。hidden column の sort chip も表示・削除できることを明示したほうがよい。

- **column visibility toggle と condition bar の相互作用テストが薄い**
  hidden 条件表示はあるが、「列を隠す → header indicator 消える → bar chip は残る → chip 解除 → rows 復元」までの一連の UX が重要。単なる `columnVisibility` 初期値テストでは足りない可能性がある。

- **ResizeObserver の実効検証が構造確認寄り**
  S1-5 の「wrapper 内に ConditionBar がある構造を test」は弱い。jsdom の制約はあるが、ResizeObserver callback が条件数変化で呼ばれる、または listOffset 更新関数が動くことを検証する観点がほしい。

- **`FilterEditorContext` から `tagEditCallbacks` を落とす影響確認が不足**
  `selectOnly=true` なら不要という判断は妥当だが、`CardTagAddPopover` が callbacks 不在で完全に問題ないか、既存 props の必須/optional 挙動確認が必要。

- **allAssignedOptionIds / tag map 空解除の具体確認が不足**
  plan には adapter 移設とあるが、タグを全解除したときに `{}` を残さず `undefined` にすることを完了条件に明記したほうがよい。dot 誤点灯の主要リスク。

- **indicator dot の対象列定義**
  「registry 登録列 header に dot」とあるが、active filter が registry 外に存在した場合の扱いが未定義。段階1 では registry 外 filter はない前提だが、将来 config 追加時に dot と bar がズレないよう同じ capability source を使うべき。

- **sort-only / both / filter-only の列分類が plan に固定されすぎ**
  `question, lastReview` sort-only、`lastCorrect/currentStreak` both、`tags` filter-only と明記しているが、列定義の `getCanSort()` と registry を source にする原則と二重管理になりうる。分類は説明に留め、実装は capability から導出するほうがよい。

- **stg smoke が OT push 後のみ**
  local で可能な Playwright/DevTools 相当の軽い確認があるなら、push 後に初めて mobile/menu/resize を見るのは遅い。少なくとも実装者のローカル smoke 観点として前倒し可能。

## リスク / 対立しうる設計判断

- **`toggleSorting` 使用 vs 明示 reducer**
  TanStack API に乗るなら `toggleSorting(desc, true)` は簡潔。一方、Notion 式の「追加/方向更新/削除は chip」の厳密 UX を固定するなら `setSorting` reducer のほうが予測しやすい。

- **段階1 最小実装 vs 後段複数条件耐性**
  columnId 単位 chip/testid/registry は段階1では最小だが、段階3-4 で同一列複数条件が来ると再設計が必要。今から condition identity だけ薄く入れるか、後段で割り切って変えるか判断が必要。

- **旧バー共存による安全な分割 vs テスト/UX 混線**
  共存は段階分割しやすいが、同じ state を二つの UI が操作するため、テスト曖昧化や aria 衝突が起きる。短期間に抑えるか、S1-2+S1-3 をまとめる選択もありうる。

- **tags の直 Popover例外 vs 一貫した header menu UX**
  nested popover 回避を優先すると tags だけ挙動が違う。一貫性を優先すると外側 menu + 内側 tag popover の複雑性が増す。

- **label/registry の分散 vs 過度な抽象化回避**
  plain object map 1 箇所は簡潔だが、display name、editor、summary、indicator 対象が散ると不整合リスクがある。小さな shared config に寄せるか、過抽象化を避けて明示的に分けるかの判断が必要。

- **UI test 重視 vs smoke 依存**
  Radix Popover、resize、virtualizer、mobile は jsdom だけでは限界がある。unit/component test で状態遷移を固め、実ブラウザ smoke でレイアウト/イベント干渉を拾う分担が必要。