# Codex plan cross-check — s4-text-filter (2026-07-05)

- **作成日**: 2026-07-05
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **値形 `{op, value:string}` の識別方法**
  - streak も `{op, value}` なので、値だけの duck-typing は破綻する。
  - 判別は `columnId` ベースに寄せる必要がある。
  - 既存 streak 値形を変える案も許可されているが、非永続とはいえ既存 UI/test への影響が出るため、変えない方が低リスク。

- **テキスト正規化の責務**
  - セル値は `null / undefined / 空文字 / 空白のみ` を空文字扱いにする。
  - 比較時は大文字小文字を無視する。
  - ただし「空白のみを空扱い」にすることと、「通常文字列の前後空白を trim して比較すること」は別問題。
  - 要件上は空白のみを空に正規化するだけで、通常値の前後空白まで削るかは設計判断が必要。

- **値必須演算子の空値時挙動**
  - editor 側で空文字でも filter value を残す設計にするか、`undefined` に落とす設計にするかで chip 表示・dot 表示・再編集体験が変わる。
  - 要件は「値必須演算子で値が空の間はフィルタ無効」であり、必ずしも filter state を消すことは要求していない。
  - filter state を残すなら、実質無効なのに chip/dot が出る可能性がある。

- **否定演算子と空セル**
  - `と一致しない` / `を含まない` / `で始まらない` は今回ないが、少なくとも否定演算子では空セルが通る。
  - 特別分岐ではなく、空文字正規化後の通常演算として自然に成立するか確認が必要。

- **「未入力」「未入力ではない」の value 扱い**
  - 値なし演算子でも値形は `{op, value:string}`。
  - 保存する value を `''` にするのか既存値を保持するのかで、演算子を戻した時の UX が変わる。
  - 要件は入力欄を隠すことだけで、隠した時に入力値を破棄するかは明示されていない。

- **対象列 ID と表示名の対応**
  - 対象列は 5 つだが、実データのフィールド名と column id が一致しない列がある。
  - `question` column は `question_text` を読む必要がある。
  - タイトル / ソートキーは S3 sortable 化済みなので、sort accessor と filter raw source の整合確認が必要。

- **header menu の gate 変更**
  - 現状 `canSort` で menu 表示が閉じているため、非 sortable 列にも filter menu を出す必要がある。
  - `canSort || hasFilterEditor` にすると、select/options など本来 menu 不要な列へ波及しないか確認が必要。
  - sort 不能列では sort UI なし・filter UI ありのメニュー構成になる。

- **editor registry の型設計**
  - 現在 registry key union が 3 列固定。
  - 5 列追加時に `Record<...>` を広げるだけでよいか、列 ID 定数から derive するか判断が必要。
  - “frozen interface” コメントがあるため、ctx/props 形を変えない方がよい。

- **chip 表示の責務**
  - generic chip 経路は registry に editor がある列を前提にしている。
  - テキスト列追加後は再編集 popover と chip body が自然に動く必要がある。
  - 値なし演算子では chip が `列名: 未入力` のように余計な空白や空値を出さないこと。

- **空値フィルタの UI 表示矛盾**
  - 値必須演算子で `value=''` の場合、predicate は全行通過する。
  - その状態で chip/dot が表示されるなら、「フィルタがあるように見えるが結果は変わらない」状態になる。
  - 要件上許容されるか、editor が `undefined` に落とすべきかは確認ポイント。

- **テスト観点**
  - 純関数 predicate は node test で網羅できる。
  - column filterFn は row.original 直読みのため、accessor/sort とは独立して確認が必要。
  - header menu は非 sortable 列に filter-only menu が出ること、既存 sortable/filterable 列が壊れないことが重要。
  - condition bar は既存 3 filter の文言回帰を固定すべき。

## plan ドラフトへの抜け・未考慮指摘

- **空値 filter state を残す設計の UX リスクが未整理**
  - S4-3 では「値を全消ししても `{op, value:''}` で残る」としている。
  - 一方、要件は「値必須演算子で値が空の間はフィルタ無効」。
  - この設計だと chip と dot は出るが全行通過する状態になり得る。
  - 仕様として許容するなら、chip 表示や dot 表示も含めて明記すべき。

- **値なし演算子で既存入力値を破棄する判断が暗黙**
  - plan は値なし op 選択時に `{op, value:''}` を書く。
  - これにより、たとえば `contains "abc"` から `未入力` に切り替え、再び `contains` に戻すと `"abc"` が失われる。
  - 要件には破棄/保持の指定がないため、UX 判断として明示が必要。

- **「空白のみセルは空扱い」以外の trim 方針はよいが、検索値側の扱いが要注意**
  - plan は `filter.value.trim()===''` なら無効、比較は両辺 `toLowerCase()`。
  - つまり検索値 `" abc "` は前後空白込みで比較される。
  - これが意図通りならよいが、ユーザー入力の前後空白を検索語として扱うかは明示した方がよい。

- **Unicode 大文字小文字比較の限界が未言及**
  - `toLowerCase()` は要件の「タグ popover 踏襲」と整合する。
  - ただし locale 非依存で、全角/半角、濁点合成、かな/カナ、アクセント差は吸収しない。
  - 日本語アプリなので「大文字小文字以外の正規化はしない」と明記しておくと後続の誤解を避けられる。

- **`column.columnDef.header` から列名導出する前提がやや弱い**
  - plan は 5 列すべて string としているが、将来 header が ReactNode 化されると editor label が壊れる。
  - 既に `getDisplayName(columnId)` があるなら、editor も同じ表示名取得経路を使う案を比較してよい。

- **registry key と TEXT_FILTER_COLUMN_IDS の二重管理リスク**
  - plan では `TEXT_FILTER_COLUMN_IDS` と registry union の両方に 5 列 ID を列挙している。
  - 片方だけ更新されると chip summary / editor / dot / menu のズレが起きる。
  - derive できる箇所は derive するか、テストで全 ID 登録を固定した方がよい。

- **generic chip 経路の説明に矛盾気味の箇所がある**
  - S4-2 は「registry 追加前でも editor なし列 generic 経路で chip 表示」と書いている。
  - しかし調査結果では generic 経路は「registry に editor がある列」が前提。
  - S4-2 単独で text chip を表示するなら、registry なしでも表示する経路変更が必要になる。ここは実装順序と完了条件を再確認すべき。

- **filter-only menu のアクセシビリティ/操作確認が薄い**
  - `ColumnHeaderMenu` が構造上成立することは確認済みだが、trigger の aria、focus、popover close、keyboard 操作が非 sortable 列でも自然かは plan に薄い。
  - header menu gate を変えるため、UI 回帰対象として入れておく価値がある。

- **既存 `lastCorrect` が filter editor registry にある点との関係がやや曖昧**
  - plan の registry union には `lastCorrect` が含まれるが、調査結果の predicate 名は `matchesAnswerState`。
  - 文言回帰も含め、回答状態 filter の値形と text/streak 判別の衝突がないことを明示すべき。

- **パフォーマンス観点は smoke 寄りで、unit/integration では固定されていない**
  - 300-card 体感 smoke はある。
  - ただし keystroke ごとに columnFilters 更新されるなら、5 列 text filter の lower-case/Array.from 省略などが頻繁に走る。
  - 現状規模なら問題なさそうだが、設計判断として「クライアント評価のまま許容」を明記してよい。

## リスク / 対立しうる設計判断

- **filter state を空値で残す vs `undefined` に落とす**
  - 残す: 再編集状態は保ちやすいが、chip/dot が出るのに絞り込み無効という UI 矛盾が出る。
  - 消す: UI は素直だが、editor 入力途中の状態保持が弱くなる。

- **値なし op で入力値を破棄する vs 保持する**
  - 破棄: state が単純。
  - 保持: op を戻した時の UX がよいが、値なし op の chip/predicate では value を無視する規律が必要。

- **summary 判別を columnId dispatch にする vs 値形を識別可能に変える**
  - columnId dispatch: 既存値形を壊さず低リスク。
  - discriminated union: 型安全だが、既存 streak 値形変更の影響が増える。

- **通常文字列の前後空白を保持する vs trim して比較する**
  - 保持: 要件の「空白のみを空扱い」に忠実。
  - trim: ユーザー検索としては親切な場合があるが、Notion 準拠から外れる可能性がある。

- **表示名取得を header から取る vs display-name map から取る**
  - header 由来: 実装が局所的。
  - map 由来: ReactNode header 化に強く、condition bar と一貫する。

- **TEXT_FILTER_COLUMN_IDS を単一定義に寄せる vs 各層で明示列挙**
  - 単一定義: 漏れに強い。
  - 明示列挙: 各層の依存が見えやすいが、ズレのテストが必須。