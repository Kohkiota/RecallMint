# Codex plan cross-check — sprint-t-md-table (2026-07-17)

- **作成日**: 2026-07-17
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

- **表示だけの変更境界**  
  保存形式、編集 raw MD textarea、OCR prompt/schema、書込経路を触らないことが最重要。不具合が出ても「保存前処理」や「OCR 出力補正」に逃げる設計はスコープ逸脱。

- **Markdown 全体描画を避ける必要**  
  表以外の CommonMark 解釈は OCR 本文を静かに変質させるため、table ノードの位置情報だけを使う設計は妥当。ただし parser の仕様変更がそのまま表示仕様変更になるため、exact pin と snapshot pin は必須。

- **offset の単位の明確化**  
  spec は「byte 同一」と書いているが、JS の `slice` と mdast `position.offset` は実装上 UTF-16 string index として扱うはず。日本語を含むため、テスト名・不変条件は「文字列連結が入力と完全一致」として検証し、必要なら UTF-8 byte 比較も別途行うべき。

- **root 直下 table 限定の帰結**  
  blockquote/list 内 table は現状維持でよいが、shared_context 起因で将来 `> ` 内 table が増えると「表が描画されない」問い合わせになりうる。仕様上の制限として UI/QA/運用側にも見える形で残す必要がある。

- **壊れた表の見え方の受容**  
  表直後の本文吸収を受け入れる判断は成立するが、これは parser 挙動依存が強い。fixture snapshot だけでなく「なぜこの壊れ方を正とするか」のコメントまたは test 名が重要。

- **HTML content model / hydration**  
  `<p>` 内 table の回避は必須。加えて `<span>` 内 table、`<button>` 内 table も invalid であり、hydration は壊れなくても React warning、アクセシビリティ、クリック領域、ブラウザ差分のリスクが残る。特に `button > table` は慎重に実機確認したい。

- **table CSS は外側レイアウトへの影響が本体**  
  「横スクロールなし」だけでなく、TanStack table の auto layout で列幅を押し広げないことが本質。`td/th { overflow-wrap:anywhere }` は必要だが、`table`, `thead`, `tbody`, `th`, `td` の display/width/border/spacing が外側 CSS と衝突しないかも見るべき。

- **ReactMarkdown のリンク・画像無効化**  
  画像リクエスト 0 は必須。リンクは `<a>` を出さないだけでなく、クリック編集との競合を避ける目的なので、セル内 autolink がクリック可能にならないことも検証対象。

- **パフォーマンス**  
  5 site で表示中に parser が走る。`useMemo` は必要だが、テーブルビューの可視セル数、仮想化再レンダー、`hasMdTable` との二重パースが累積コストになりうる。

- **第 2 スコープは独立変更源**  
  サムネ配線は MD 表描画と別の変更源。テスト・レビュー・不具合切り分けのため、コミットや task を分ける判断は妥当。

## plan ドラフトへの抜け・未考慮指摘

- **offset の byte/code-unit 問題が plan にない**  
  T2 は「byte 同一」と書いているが、実装はおそらく string slice。日本語 fixture で `Buffer.from(reconstructed).equals(Buffer.from(input))` まで見るか、表現を「string 完全一致」に直すかを決める必要がある。

- **C/E の二重パース回避が曖昧**  
  spec では「二重パースの回避方法は plan で」とあるが、plan T5 は `hasMdTable(text)` と `<MdTableText value>` を別々に呼ぶ形に見える。表あり学習面で同じ文字列を 2 回 parse する可能性がある。`segmentMdTables` 結果を共有する API、または wrapper component 化が必要。

- **site-level DOM 同一の検証が A/B/C/E 中心で、D が弱い**  
  T5 の D は表入り option text の test はあるが、表 0 個の option text/explanation が従来 DOM と同一かの検証が明示されていない。不変条件は 5 site 全部なので D も対象にすべき。

- **option explanation 側の表 test が薄い**  
  学習面 D は option text と explanation の両方が対象だが、plan の test は option text 中心に見える。`opt.explanation` に表がある場合も明示した方がよい。

- **`<button>` 内 table の実機/hydration 確認が不足**  
  spec は受容としているが、plan には React warning / hydration warning / keyboard 操作 / click-to-answer の確認がない。少なくとも test か smoke 観点に入れるべき。

- **CSS の具体検証が不足**  
  T3 に CSS 要件はあるが、テーブルビュー auto layout の列押し広げ防止を再現する test または visual smoke が弱い。`overflow-wrap:anywhere` が `td/th` に実際に当たっていること、外側 column width を押さないことを確認したい。

- **ReactMarkdown が生成する wrapper 差分の snapshot 範囲**  
  table segment に react-markdown を使うと、空白や `<thead>/<tbody>` 構造、改行由来 text node が snapshot に出る可能性がある。plan は snapshot ありだが、期待 DOM の安定化方針が薄い。

- **raw HTML の期待挙動が曖昧**  
  「セル内 raw HTML fixture」とあるが、`<script>`, `<img src>`, `<span>` などが文字として見えるのか、エスケープ表示か、消えるのかを固定する観点を明確にした方がよい。

- **サムネ配線の権限/削除挙動確認が薄い**  
  thumbnails でも削除可能なら、テーブルビューから削除した際の既存 mutation、キャッシュ更新、row virtualizer 下の再描画が問題ないか確認が必要。add 非表示だけでは不足。

- **T1 の `pnpm install --frozen-lockfile` 順序が不自然**  
  依存追加で lockfile を更新する task なら、最初は frozen では失敗する可能性がある。完了条件として「更新後に frozen install が通る」はよいが、作業手順としては通常 install と frozen 検証を分けて書く方がよい。

## リスク / 対立しうる設計判断

- **invalid nesting を受容するか、DOM 不変性を一部緩めるか**  
  `<span>/<button>` 構造維持は既存 DOM 不変に強い。一方で HTML 妥当性・a11y・React warning の負債を残す。ここは最も対立しやすい判断。

- **root 直下限定か、mdast node 直接描画へ進むか**  
  root 限定はスコープを抑えられるが、blockquote 内 table を将来拾えない。node 直接描画は拡張性があるが、実装と検証範囲が増える。

- **parser 委譲か、OCR 実データ向け境界補正か**  
  GFM 委譲は仕様が明快。表直後本文吸収のような実害には弱い。補正器を入れると救えるケースは増えるが、独自 Markdown 判定器化するリスクがある。

- **表 0 個 DOM 完全同一 vs HTML 妥当性改善**  
  DOM 完全同一を守るほど既存 wrapper を温存する必要がある。逆に HTML 妥当性を優先すると、表 0 個でも wrapper 差分が出る可能性がある。

- **exact pin の安定性 vs 保守コスト**  
  表示仕様固定には exact pin が合うが、セキュリティ更新や ReactMarkdown 周辺の更新時に明示的な再レビューが必要になる。

- **テーブルビュー thumbnails の密度**  
  thumbnails のみでも行高は増える。情報量は上がるが、テーブルビューの一覧性・仮想化 jitter・削除操作の誤タップリスクと衝突しうる。