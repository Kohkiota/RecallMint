# Codex plan cross-check — side-peek-trigger (2026-07-06)

- **作成日**: 2026-07-06
- **種別**: plan 段階の独立論点出し(diff レビューでない / fix ループなし / 1 パス cross-check)
- **入力**: 調査結果+要件(主) + plan ドラフト(参考添付)。anchor 防止のため plan 承認は求めていない
- **反映主体**: CC 本体(Codex 論点を CC 自身の plan と突き合わせ、統合して OT に提示)
- **保存意図**: OT 規律(Codex raw findings は docs/codex/ 配下に永続化)

---

## 独立論点(調査結果 + 要件から導出)

### 1. title セル内トリガーの click / keyboard 衝突

- 「button が InlineTextField display div の兄弟なら display div の `onClick=startEdit` は経由しない」は、DOM 構造としては成立する。
- ただし成立条件はかなり具体的:
  - button が `InlineTextField` の子孫にならないこと
  - wrapper / `td` / `tr` 側に将来 `onClick` が追加されないこと
  - `InlineTextField` 側が wrapper 全体を覆う絶対配置や pointer capture を持たないこと
  - button の z-index / hit area が display div より上にあり、クリックが button に届くこと
- `stopPropagation` 不要という判断自体は妥当だが、「不要」ではなく「親側に click handler を置かない前提で不要」と明文化した方がよい。
- keyboard 面では別リスクがある:
  - display div は `role=button tabIndex=0`
  - peek button も native button
  - 同一 title セル内に Tab stop が 2 つ並ぶ
  - desktop では opacity 0 の button が Tab 到達可能
- これは仕様上意図されているが、SR / keyboard ユーザーには「見えないがフォーカスできるボタン」になりうる。`focus-visible` で可視化されるなら許容可能だが、button 自身に `md:focus-visible:opacity-100` が確実に効く必要がある。

### 2. opacity 非表示のアクセシビリティ

- `display:none` を避けて Tab 到達可能にする設計は一貫している。
- 一方で `opacity:0` の button は SR には常時存在する。
- title セル内の click-to-edit button と peek open button が両方読み上げ対象になるため、ラベルの区別が重要。
  - `InlineTextField`: 「タイトル 編集」
  - peek button: 「カードを開く」
- 開状態で `aria-pressed` を使うなら、この button は toggle button として解釈される。再 click で close する仕様とは整合する。
- ただし label が常に「カードを開く」だと、`aria-pressed=true` 時に「開く、押されています」になり、閉じる操作としてはやや曖昧。許容するか、label を状態で変えるかは設計判断。

### 3. mobile 常時表示と 80px title 幅

- モバイル table 到達経路がある以上、hover 前提にしない判断は必要。
- ただし初期 80px の title セルに常時 button を置くため、実用上はかなり狭い。
- 不透過背景で視認性は担保できるが、文字の読めなさ・誤 tap・横スクロール時の操作性は残る。
- button の touch target が `size-6` 相当だと、一般的な 44px 推奨より小さい。テーブル密度とのトレードオフとして受容するか明示した方がよい。

### 4. editing 中の非表示判定

- `group-has-[input]/peek` は input 構造に依存するため、InlineTextField が textarea を使う場合も考慮が必要。
- 要件には Input/Textarea とあるので、`group-has-[input]` だけでは multiline 編集中に発火しない可能性がある。
- `group-has-[textarea]` も必要になる可能性が高い。
- また InlineTextField の内部 DOM が将来変わると CSS 判定が壊れる。JS props を足さない方針なら、これは受容リスクとして明記すべき。

### 5. Esc layering / Radix non-modal Dialog

- non-modal Dialog + Portal + popover/dropdown の Esc layering は、Radix の DismissableLayer stack に期待する設計。
- ただし成立には以下が必要:
  - peek 内 popover/dropdown も Radix layer 系であること
  - popover/dropdown が Dialog.Content の React subtree 内から開かれること
  - Esc event が app 側の document handler や Dialog 側独自 handler で先に close されないこと
- `onOpenChange` 一元化はよいが、Esc の個別 handler を足さない方針でも Dialog 自体は Esc で閉じる。
- popover が開いている時に Esc が popover だけを閉じるかは実装依存の重要点なので、RTL だけでなく実ブラウザ smoke の最優先確認にすべき。

### 6. non-modal + 外クリック preventDefault の副作用

- 外クリックで閉じない設計は要件と整合する。
- ただし `onInteractOutside.preventDefault()` が背面テーブル側の click / focus を阻害しないかは確認が必要。
- Radix の outside interaction は pointer/focus outside を検知するため、preventDefault の意味が「Dialog close を止める」だけに留まるか、背面操作にも影響しないかを実測すべき。
- 要件では peek を開いたままテーブル側セル編集できる必要があるため、ここは重要。

### 7. Esc と編集中 commit

- InlineTextField が Esc handler を持たず blur commit なら、peek 内 input 編集中 Esc は「保存して閉じる」になる。
- これは破壊的ではないが、一般的な Esc = cancel 期待とはズレる。
- Open Question 扱いでよいが、仕様としてユーザーに不意打ちになりうる。
- 特に長文 textarea 編集中に Esc で閉じて保存される点は、受容判断が必要。

### 8. active row / data / filter の意味

- prune を `data` から消えた時のみとする設計は、フィルタ離脱で閉じない要件と整合する。
- ただし `data` が本当に column filter 前の全件であることが前提。
- 将来 `data` の意味が変わると prune 条件が壊れるため、`data` の契約をコメントまたは型・命名で補強する余地がある。
- activeRow を `find` で毎 render 探す規模性能は、多数カード時に軽微な懸念。必要なら map 化だが、現時点では YAGNI でよい。

### 9. z-index / Portal の衝突

- panel z-45、popover/dialog z-50 は方針として妥当。
- ただし z-50 同士は DOM 順依存になる。
- tag popover と confirm dialog、billing banner 等が同時に出ると重なり順が設計保証されない。
- 本件では z 台帳を全面整理しない判断は妥当だが、「peek 内から開く z-50 は panel より上」以上の保証はしない、と明確にした方がよい。

### 10. title 非表示時の到達不能

- OT 確定なら問題ない。
- ただし side peek が重要導線になるなら、列非表示で消えることはユーザー体験上のリスク。
- 少なくとも column toggle UI 上で title が hideable なままなら、「peek への唯一の入口をユーザーが消せる」状態になる。
- これは許容済みでも、将来問い合わせ・混乱のリスクとして残る。

---

## plan ドラフトへの抜け・未考慮指摘

- Task 2 の CSS 例が `group-has-[input]/peek` のみで、要件にある Textarea 編集中をカバーしていない可能性がある。`group-has-[textarea]/peek` 相当の検討が抜けている。

- `md:focus-visible:opacity-100` が button 自身に効く前提になっているが、opacity 0 の button に keyboard focus した時に確実に可視化されるかの検証項目が弱い。テストに class 存在はあるが、実挙動確認が必要。

- button の `aria-label="カードを開く"` と `aria-pressed` の組み合わせは toggle としてはやや曖昧。開状態で再 click が close なら、label の状態変化をするか、現状を許容するかの判断が未記載。

- mobile 常時表示について、touch target サイズの受容判断がない。`size-6` 相当は狭い可能性があり、密度優先で許容するのか、実際は `h-8 w-8` 程度にするのか未整理。

- `onInteractOutside.preventDefault()` が背面テーブル操作を阻害しないことは Task 3 のテストに一部あるが、Radix の pointer outside / focus outside の副作用として明示的な論点になっていない。重点項目に上げた方がよい。

- Esc layering は sprint 末 smoke に入っているが、Task 1 の unit test 完了条件には popover 開状態の Esc が含まれていない。RTL で完全保証できないとしても、最低限「Dialog 内に Radix Popover を置いた時に Esc が popover のみ閉じる」系の component test を検討する余地がある。

- `Dialog.Close` の × click で `onClose` ちょうど 1 回という test はよいが、`onOpenChange(false)` 一元化により、parent state 更新後に `row=null` になる流れまで含めて二重発火しないかを見る必要がある。

- Task 1 の props に `row: ExamCardRow | null` とある一方、`cardTags` は別 props。`row=null` 時に `cardTags` が stale でも無害であること、row/cardTags の card_id 不一致時にどう扱うかは未記載。防御コード禁止なら、親側責務として明記した方がよい。

- `activeCardTags = liveData?.cardTags.filter(...)` の deps が plan では `liveData/activeCardId` と粗い。実装上 `liveData.cardTags` が安定参照でない場合は問題ないが、memo の依存粒度は注意点。

- `data.find` による activeRow 取得は設計として十分だが、カード数が多い場合の render cost は未評価。現時点で map 化不要でも、受容判断として書ける。

- `key={row.card.id}` の位置が曖昧。Dialog.Content 全体に付けるのか、本文 subtree に付けるのかで focus / animation / remount 範囲が変わる。plan は「content 子ツリー」と書くが、期待する reset 対象をもう少し明確にした方がよい。

- title cell wrapper 化により、既存 `InlineTextField` の `w-full` や min-height と table cell の高さ計算が変わらないかの観点が弱い。wrapper に `w-full` を付ける必要があるか確認対象。

- pinned title 列の場合、td 側が sticky z-[1] で、button も z-[1]。同じ stacking context 内で意図通り button が上に来るかは実測対象。特に pinned 背景合成と button 背景の見え方。

- plan は `top-1` 例だが、調査結果では `top-1/2 -translate-y-1/2` 案も出ている。折返し title・複数行時に top 固定がよいのか、中央固定がよいのかの判断が未整理。

- 「title 非表示時は到達不能」を許容しているが、plan のテストや smoke に「title column hidden 時に crash しない / meta 不要部分が壊れない」観点がない。到達不能は許容でも、非表示設定自体の回帰は避けたい。

---

## リスク / 対立しうる設計判断

- **stopPropagation なし vs 将来保守性**  
  現構造では不要。ただし親 wrapper / td / tr に click handler が追加されると崩れる。構造保証を重視するか、将来耐性として button 側で stopPropagation するかは設計思想の対立点。

- **opacity 0 でも Tab 到達可 vs 視覚的一貫性**  
  keyboard 到達性は上がるが、SR には常時存在し、Tab 順も増える。hover UI として隠すなら `sr-only` / `tabIndex` 制御も考えられるが、JS viewport 判定なし方針と衝突する。

- **CSS `has` 依存 vs 明示 state**  
  CSS のみは実装が小さい。一方、InlineTextField の内部 DOM に依存し、input/textarea 両対応漏れが起きやすい。明示 props/state を足すと堅牢だが、プリミティブ非改変方針に反する。

- **non-modal 併用性 vs Esc / focus の予測可能性**  
  テーブル併用には non-modal が合う。一方、focus trap なし・外クリック close なし・Esc 保存 close は、一般的な dialog 期待から外れる部分がある。

- **mobile overlay 案 b vs mobile native navigation**  
  実装は小さいが、ブラウザ戻るで閉じない・キーボード干渉・固定 overlay の癖が残る。route 案は重いが mobile 体験は自然。

- **z-index 最小追加 vs 全体整合**  
  z-45 は局所解として妥当。ただし z-50 帯の DOM 順依存は残る。今 sprint で触らない判断は現実的だが、将来の overlay 増加で負債化しうる。

- **title 非表示許容 vs 導線の安定性**  
  ユーザー責任で割り切ると実装は小さい。ただし peek が主要機能になるほど、唯一導線が列設定で消えるリスクは大きくなる。