# Sprint T(MD 表の read-only 描画)設計 spec

- **日付**: 2026-07-17 / **status**: 確定(2026-07-17 OT レビュー承認・修正 6 件反映済)
- **起点**: `docs/audit/2026-07-15-b1-scope-reduction-and-cardview-freeze-factfinding.md` §3 + OT kickoff(確定スコープ・決定事項は kickoff が正、本 spec はそれを HEAD 裏取りと共に記録する)
- **前提**: B1 縮小スコープ(本文 inline 画像なし・欄単位画像 = Sprint I 完了)の続き。保存形式 plain text・編集 raw MD textarea は 1 バイト/1 ミリも変えない。**display 枝のみ**変える。

## 1. スコープ

OCR が Markdown パイプ表記法で吐いた表(`| 項目 | 値 |`)が生記号のまま表示されている。これを read-only で `<table>` 描画する。

**In**:
① MD 表の read-only 描画 — 対象欄 = 問題文 / 各選択肢(text・explanation)/ 解説 / メモ、対象面 = カードビュー / テーブルビュー / side peek / 学習面の 4 面(**面ごとの出し分けをしない**)
② 第 2 スコープ(同 branch・変更源が別): テーブルビューへの画像サムネ配線(Sprint I `CardImageGallery` 流用)

**Out(非スコープ)**: 表の編集 UI / 表以外の MD 記法の描画 / 保存形式の変更 / `format: 'plain' | 'markdown'` 等のフィールド形式フラグ(判定器 = ヒューリスティックになるため却下済)/ Gemini prompt・`ocr-extract.ts`・response schema(不可触)/ `custom-session-preview.tsx`(line-clamp-2 truncate ゆえ表描画は無意味)

## 2. Step 0 HEAD 再検証結果(2026-07-17・HEAD = dc8b06a)

fact-finding §3 は Sprint F / I より前の記述のため全点を HEAD で裏取りした。**スコープと食い違う事実なし**(行番号ズレと追加の設計論点のみ)。

| 論点 | HEAD 事実(file:line) | 含意 |
|---|---|---|
| 挿入点 5 点の実在 | **(A)** `InlineTextField` display 枝 `inline-text-field.tsx:293-326` / **(B)** `InlineOptionCell` display 枝 `inline-option-row.tsx:434-463` / **(C)** question `session-runner.tsx:435-437` / **(D)** option text+expl `session-runner.tsx:473-484`(text は `stripPrefix` 後 :463)/ **(E)** explanation `session-runner.tsx:525-529` | 全点健在。Sprint F の InlineCardRow 抽出は「InlineCardRow → CardEditorFields → A/B」の集約構造を変えていない(編集 3 面 = カードビュー `card-editor-fields.tsx:87-95,124-157` + `InlineOptionList`・テーブルビュー `exam-card-table-columns.tsx:181-190,248-257,266-275` + `CompactOptionsCell`→B・side peek = CardEditorFields 共有) |
| display 枝の現描画 | A/B = `<span class="whitespace-pre-wrap break-words">` + 末尾改行時の装飾 `<br>` 補償(`inline-text-field.tsx:314-322` / `inline-option-row.tsx:452-460`)。C/E = `<p class="whitespace-pre-wrap ...">`、D = `<button>` 内 `<span class="whitespace-pre-wrap">` | **line-clamp / truncate は対象 4 欄の display 経路に一切ない**(実機スクショと一致。line-clamp は除外済の custom-session-preview.tsx:107 のみ) |
| テーブルビューのセル overflow | `<table>` は `table-fixed` なし = **table-layout: auto**(`exam-card-table.tsx:657-659`)。列幅は th/td の `width` style(CSS 変数、`:218-221,710-713`)= auto layout では**提案値**。container は `overflow-auto`(`:646-649`) | min-content が列幅を超える子は **clip されず列を押し広げ**、表総幅が `getTotalSize()` を超えて水平スクロールが伸びる。→ kickoff の条件付き要件(崩れ防止)が**発動**(§3.5) |
| MD 描画系 dep | package.json / pnpm-lock.yaml とも markdown 系(react-markdown / remark / marked / markdown-it / micromark / mdast)**0 件**。`dangerouslySetInnerHTML` 0 件 | 新規導入 4 packages(§5)。既存との競合なし |
| テーブルビューの画像サムネ | Sprint I spec(`2026-07-15-sprint-i-image-four-fields-design.md`)は全文で table/テーブルビューに**言及ゼロ**。「編集面」の実装点 = CardEditorFields(カードビュー + side peek 共有)と InlineOptionList のみ | **意図的却下ではなく列挙漏れ**(覆す理由は不要)。配線材料は揃っている: `row.original.card.images`(`lib/client-db.ts:112`)+ `meta.userId`(`exam-card-table-columns.tsx:40`) |
| OCR の表の実データ形 | 表指示 = `lib/ai/prompts/ocr-extract.ts:37-42`(4 欄 + shared_context 適用 :23-28)。**shared_context は各行 `> ` 前置の引用ブロックとして question_text 先頭へ複製**(`:55-56,85-91`)され、その定義に「表」を明記(`:61`) | **blockquote 内の表は実データとして起こる** → §3.2 の「root 直下のみ」判断の根拠 |

### パーサ実挙動の実測(unified@11.0.5 + remark-parse@11.0.0 + remark-gfm@4.0.1、pin 予定版そのもので確認)

1. **空行なしで段落直後に始まる表も表として認識される**(paragraph interrupt 可)— OCR 出力に多い形が救える
2. **blockquote 内の表**: table ノードの offset slice は初行のみ prefix なし・継続行に `> ` が混入(`"| 薬剤 | 用量 |\n> |---|---|\n> ..."`)= **単独再パース不成立**
3. **表直後に空行なしで続く本文は表の行として吸収される**(end.offset が本文行を含む。GFM 仕様どおり・GitHub と同挙動)。**実データで発生する**(card `2e97b7b7` = 表の後に問題文後半と選択肢 4 つが続く形 → カード全体が 1 枚の壊れた表として描画される)。**受容する**。理由 = 破綻が**視認可能**であり(明らかに壊れた表として見える)、ユーザーが編集で空行 1 個を入れれば直る。これは「正しく見えて間違っている」静かな変質(フル MD 却下の理由、§3.1)とは質が異なる。parser に境界規則(「`|` を含まない行で表を打ち切る」等)を持たせる案は、委譲原則に例外を開ける対価に見合わないため却下。受容 = 放置ではなく、この挙動を実カード fixture + snapshot で pin する(§6)
4. 区切り行なし / ヘッダーと区切り行の列数不一致 → **表と認識されない**(fail-safe = 生記号のまま現状維持)
5. データ行の列数ズレは表として吸収(不足 = 空セル・超過 = 無視)
6. リスト内の表も slice にインデント prefix が混入(blockquote と同型の不成立)

## 3. 設計

### 3.1 コア: 全機能パース + table offset 切り出し(決定事項の理由記録)

- **「MD 全体をプレビューする」案は却下済み**。理由 = OCR が本文を書く製品で「MD 記法はユーザー責任」が成立しない。CommonMark のブロック級記法(行頭 `1.` のリスト化と採番し直し / 4 スペース字下げのコードブロック化 / 次行 `---` の setext heading 化 / 行頭 `>` の引用化)が OCR 出力を静かに変質させる。しかも Gemini prompt / `ocr-extract.ts` / response schema は不可触ゆえ、出力を MD-safe にする手段が無い。
- **「表だけ有効化」というパーサオプションは存在しない**(remark-gfm は 5 機能一括、土台の CommonMark は消せない)。ゆえに「**パーサは全機能で走らせ、結果のうち table ノードの位置だけ使い、残りの解釈は捨てる**」が本設計の核。
- **危険面は表のセル内 inline に構造的に閉じる**。GFM spec §4.10 が「A table is a leaf block」「Block-level elements cannot be inserted in a table」「cells containing arbitrary text, in which inlines are parsed」と規定するため、ブロック級の事故はセル内では原理的に起こりえない。
- **表判定は GFM 仕様に委譲し、判定器を自作しない**。非認識(§2 実測 4)は生記号のまま = fail-safe。列ズレは GFM が吸収(実測 5)。

処理フロー:
1. `unified().use(remarkParse).use(remarkGfm, { singleTilde: false })` で対象欄の文字列をパース
2. mdast の table ノードの `position.start.offset` / `end.offset` で原文を `[text][table][text]…` に分割
3. text セグメント = 現状の renderer に**原文をそのまま**渡す(今と同一の DOM)
4. table セグメント = react-markdown に切り出した文字列を渡す(切り出しが表だけなので、フル MD で描かせても表しか出てこない)
5. 表 0 個なら segments = text 1 個 = 現状と完全に同一

### 3.2 セグメンテーション規則

- **対象 = root 直下(depth 1)の table ノードのみ**。blockquote / list 内の入れ子は対象外 = 生記号のまま現状維持。理由の正確な記録: 本設計の「切り出し文字列を react-markdown に渡す」手順では offset slice に行頭 prefix(`> ` / インデント)が混入し単独再パースが成立しない(§2 実測 2,6)が、これは**手順が招いた制約であって原理的な不能ではない**(table ノードから直接描画すれば prefix は存在しない — パーサが blockquote container を剥がした後の中身がノードのため)。root 直下限定の実際の根拠 = **ノード起点描画にすれば blockquote 内も可能だが、実データに `> ` 付きの表が存在しないため本 sprint では不要**。実データ確認(2026-07-17・OT の SQL): OCR 実出力 2 件はいずれも root 直下の表(`> ` なし)、shared_context の `> ` 引用に表が入る形は観測されなかった。
- 不変条件: **text セグメント + table スライスの連結 === 入力文字列(string 完全一致)**。mdast の `position.offset` は UTF-16 code unit(JS string index)であり「byte」ではない — 我々は返された offset で `String.slice` するだけゆえ、`===` による string 完全一致が最も厳密かつ十分(同一 string なら byte も同一)。offset ずれによる重複・消失をこの再構成テストで検出する(§6)。**サロゲートペア(BMP 外文字)が唯一の危険経路** = code unit と code point がズレるのはそこだけ → fixture で必ず通す(§6)。
- 空 text セグメント(表が先頭/末尾/連続)は DOM に出さない。
- 実装形: 純関数 `lib/markdown/`(I/O なし・test 厚く。DDD 方針の pure 層準拠 — ただしビジネス規則ではなく表示ユーティリティなので `lib/<context>/domain/` ではなく独立 dir)。

### 3.3 共有 renderer component(1 個・5 site から import)

fact-finding 総括(3)の CC lean どおり**共有 renderer 1 個**(`components/markdown/`)を新設し、A/B/C/D/E の 5 site が import する(rule of three 充足)。

- **renderer はセグメント列だけを描く**: text セグメント = **素の text node(原文 verbatim・span 等を足さない)**、table セグメント = react-markdown の `<table>`。各 site の既存 wrapper・class・末尾改行 `<br>` 補償は **call site に温存し 1 文字も変えない** — 差し替えるのは `{value}` 補間点のみ。→ 表 0 個入力では renderer 出力 = text node 1 個となり、**5 site すべてで DOM が同一**(§4 不変条件を全 site で厳密充足)。
- **edit 枝は 1 ミリも触らない**(raw MD textarea 維持。編集 = display 全体クリックの既存方式も不変)。
- **wrapper の HTML content model 対応**(Step 0 で判明した追加論点):
  - **(C)(E) の `<p>` wrapper**: `<p>` 内の `<table>` は HTML パーサが `<p>` を auto-close して再親化するため SSR/hydration が壊れる。→ **表を含む値の時のみ `<div>`(class 維持)、表 0 個は `<p>` 維持**(不変条件①を破らない)。判定はセグメンテーション結果を流用(二重パースの回避方法は plan で)。
  - **(A)(B)(D) の `<span>` 内・(D) の `<button>` 内**: 表が既存 span(pre-wrap)の中に入るため `span > table` / `button > table` となり content model 上 invalid だが、HTML パーサの再親化規則は `<p>` のみ(span/button は authored どおり parse)= hydration 安全・全ブラウザで anonymous box 補正により正常描画。button の構造替え(`div role="button"` 化)は disabled / focus / aria の再実装を伴い blast radius 過大、span 剥がしは不変条件①違反のため、**現構造を維持し nesting を受容**(CC 判断・OT レビュー対象)。A/B の span が持つ `break-words`(overflow-wrap: break-word)はセルに継承されるが、§3.5 の `anywhere` がセル側で上書きする。
    - **status = 論証による受容 → 2026-07-17 stg 実機で確認済に格上げ**(区別: 論証は「HTML パーサ再親化規則 + React `findInvalidAncestorForTag` が `<p>` 祖先のみ判定」の演繹、実機確認は現物の目視)。**実機根拠**: 選択肢 text と選択肢 explanation の両方に表を入れた card で `<button>` 内の `<table>` が正常描画・console warning なし・表を含む/含まない選択肢いずれもクリックで選択可能(table がクリックイベントを食わない)。session doc 2026-07-17 参照。

### 3.4 react-markdown 設定(理由ごと記録)

- **`components.img` = 無効化(alt テキストを出す。黙って消さない)**。理由 = `![](url)` を描画すると Sprint I の assetId 間接参照(URL を保存しない / private R2 / 参照カウント GC / オフライン Cache)を迂回する第 2 の画像経路ができ、B1 破棄の判断(本文 inline 画像はやらない)が穴あきになる。外部 URL 読込は CSP img-src 違反にもなる。
- **`components.a` = 無効化(children をプレーン表示)**。理由 = display 全体クリックで編集モードに入る方式ゆえ、リンク遷移と blur commit が競合する。GFM autolink(セル内の裸 URL)も同経路で無害化される。**既知挙動**: `[厚労省](https://…)` は「厚労省」として表示され **URL は表示から落ちる**(原文には残る)— img が alt を出して URL を落とすのと同じ形で一貫している。
- **`singleTilde: false`**。理由 = セル内の `~注意~` が打消し線になるのを防ぐ。GFM 仕様上も単一チルダは禁止(GitHub が独自に通しているだけ)。
- **remark-breaks / allowedElements / rehype-raw / rehype-sanitize / MDX = 不要**。理由 = text セグメントを MD として描かないので、打ち消すべき副作用が発生しない。rehype-raw 不使用によりセル内 raw HTML は描画されない(挙動は fixture で固定する)。

### 3.5 表の CSS 要件(実装は CC の判断)

- 縦に伸びる。行数で切らない。省略記号を出さない。
- 横スクロールを作らない。
- 表の幅は内容に合わせる(width 固定せず、狭い表をコンテナ幅いっぱいに引き伸ばさない = `w-full` 禁止、shrink-to-fit)。
- **追加要件(Step 0 条件発動)**: テーブルビューは table-layout auto + width 提案値ゆえ、溢れる子が**列を押し広げる**(§2)。→ 描画する表のセルに **`overflow-wrap: anywhere`** を適用し、min-content 寄与を潰して外側の列レイアウトを押さない。`break-word` でなく `anywhere` の理由 = min-content 計算での扱いが仕様上異なり、CSSWG は「テーブルセルは intrinsic size で決まるため break-word では折返しが効かない」を動機に anywhere を新設した経緯(要件を満たすのは anywhere 側)。面ごとの出し分けをしない原則により 4 面同一適用。
- コンテナ幅超過そのものは要件にしない(日本語は文字単位で折返せるため min-content 幅は実質極小。溢れうるのは折返し点を持たない長い英語連続語のみで、少しのはみ出しは許容 — ただし上記 anywhere により列崩れはしない)。

### 3.6 第 2 スコープ: テーブルビューの画像サムネ配線

- Sprint I の**列挙漏れ**(§2)を埋める。変更源は MD 表描画と別(gallery の配線 vs テキストの解釈)。
- 配線: 問題文 / 解説 / メモ 列 = セル内 `InlineTextField` 直下に `CardImageGallery`(カードビューと同形・削除可)。選択肢列 = `CompactOptionsCell` に `images` + `userId` を透過し、各選択肢の下に `option:<uid>` gate 付き gallery(`InlineOptionList` `inline-option-row.tsx:116-124` と同パターン)。
- **add affordance の扱い(2026-07-17 OT 決定で訂正)**: T6 は当初「add 非配線(セル密度・§9 行高肥大回避)」としたが**覆す**。理由 = ① 本 sprint の背骨「面ごとの出し分けをしない」。delete を table 列で許した以上、add だけ切ると同じ原則を自分で破る(「同じ画像なのに見る場所で足せたり足せなかったり」は覚えられない規則)② density 懸念が実測に耐えず — Sprint I で add affordance は小 inline icon に圧縮済、stg 実機では問題文セルが表描画で数百 px 高になり icon の寄与は無視できる。→ **table 列も card view / side peek と同じ add affordance・同じ attach 経路**(target 語彙 Sprint I 確定のまま)。slot 指定は CC 判断。
- 行仮想化(MemoizedTableBody + row virtualizer)により gallery instance 数は可視行に有界。

## 4. 不変条件(spec 明記・kickoff 指定)

1. **表が 0 個の入力に対し、現状と DOM が同一**であること(5 site すべて。renderer が text を素の text node で出し、wrapper・class・`<br>` 補償・(C)(E) の `<p>` tag を call site が温存することで成立、§3.3)。
2. **offset ずれによるテキストの重複・消失が起きない**こと(連結復元 = 入力と string 完全一致、§3.2。サロゲートペア fixture で code unit 前提を検証)。
3. **Markdown の画像記法から外部リクエストが 1 件も発生しない**こと(components.img 無効化、§3.4)。
4. 保存形式・編集枝・書込経路は変更ゼロ(display 枝のみ)。

## 5. dep(exact pin・caret なし)

| package | pin | 根拠 |
|---|---|---|
| react-markdown | **10.1.0** | registry 最新と一致(2026-07-17 確認) |
| remark-gfm | **4.0.1** | 同上 |
| remark-parse | **11.0.0** | 切り出しに直接使用。react-markdown@10.1.0 内部 range `^11.0.0` を満たし単一インスタンスに dedupe |
| unified | **11.0.5** | 同上(内部 range `^11.0.0`) |

- **exact pin の理由** = MD ライブラリの更新は「内部実装の更新」ではなく「表示仕様の更新」。パッチでパースが変われば画面が変わる。
- 二重パーサ検査: 実装時に `pnpm why remark-parse unified` で単一バージョンを確認(完了条件に含める)。
- **ESM only / vitest**: vitest 4(Vite ベース・native ESM)ゆえ追加 transform 設定不要の見込み。component test は既存慣行どおり per-file `// @vitest-environment jsdom` 注釈(`card-image-gallery.test.tsx:1` と同形)。実装 task の最初の test 実行で確認し、問題があれば plan で扱う。
- **bundle size 実測(de-risk gate)**: dep 導入 task の完了条件に client bundle size の実測・記録を含める(`pnpm build` の route サイズ差分)。**推測で数字を置かない**。

## 6. test 方針

- **contract**: 表描画の DOM snapshot を `tests/contract/` に置く(既存 `__snapshots__` 慣行。**`.snap` の無条件 `-u` 禁止**)。セル内 raw HTML / autolink / 打消し線の挙動も snapshot で固定。
- **実カード fixture(OT SQL 抽出・2026-07-17)**: OCR 実出力 2 件がちょうど 2 パターンを網羅するため、合成 fixture でなく実形をそのまま使う。**(A)** card `06f4e35f-b2d3-44af-a69d-86693ea10658` = 表が末尾で終わる(後続なし・基礎疾患×医薬品成分の 2 列表)→ 正常描画の pin。**(B)** card `2e97b7b7-0d3c-4f5a-933e-afcc7ce27841` = 表直後に空行なしで本文が続く(成分×分量の 2 列表 + 吸収)→ **受容した吸収挙動を snapshot で pin し、ライブラリ更新でこの挙動が変わったら `.snap` diff が捕まえる**状態にする(§2 実測 3。受容 = 放置ではない)。※ 手元の抜粋は `left(question_text, 500)` の結果 — **fixture 化の前に全文であることを OT に確認**(500 字超の切断があれば全文を再取得)。
- **セグメンテーション純関数(厚く)**: 表 0 個で原文と string 完全一致 / 連結復元(offset ずれ検出)/ **サロゲートペア(BMP 外文字)を表の前・表内セル・表の後に置いた fixture で連結復元 property が通る**(UTF-16 code unit 前提の唯一の危険経路・§3.2)/ 区切り行なし・列数不一致は表にならない / 空行なし直後の表は認識される / 表直後の本文吸収(実カード B)/ blockquote・リスト内の表は対象外(現状維持)/ 表が先頭・末尾(実カード A)・複数・連続。
- **renderer component**: 表 0 個 → renderer 出力は text node のみ・site 単位で現状 DOM と同一 / img 記法 → `<img>` 不在 + alt テキスト表示 / a 記法 → `<a>` 不在 / (C)(E) の tag 切替(表 0 個 = `p` / 表あり = `div`)/ 末尾改行 `<br>` 補償の維持。
- **第 2 スコープ**: テーブルビュー列に thumbnails が出る / uid なし選択肢は増分 DOM ゼロ(既存 gallery test の拡張)。
- AI mock 必須・実 API 禁止(既存規律、本 sprint は AI 経路に触れないが明記)。

## 7. smoke(stg・push 後)

- **vacuous 罠は解決済**: OCR 実出力の 2 実カード(§6 の A / B)がちょうど 2 パターン(表が末尾で終わる / 表直後の本文吸収)を網羅する。**PERF-SEED 用の合成カードは不要**。smoke はこの 2 カードで行う。
- 実カードは実用途の内容(医薬品成分・分量の 2 列表)。長い連続語がコンテナ幅を超えた際に**列レイアウトが崩れないか**(§3.5 anywhere)もこの smoke で併せて観察。
- 確認面: 4 面すべて(カードビュー / テーブルビュー / side peek / 学習面)で同一の表が `<table>` 描画される / 表 0 個カードの見た目不変 / 編集クリックで raw MD textarea(不変)/ DevTools Network で画像記法カードから外部リクエスト 0 件 / テーブルビューにサムネ表示。
- **行高変化の観察(blocker ではない)**: 表描画でカード行高が変わる。カードビュー仮想化の `ESTIMATED_CARD_HEIGHT = 738`(`inline-card-list.tsx:78`)は実測中央値ゆえずれる可能性 — `measureElement` が動的高さを処理するため観察のみとし、todo Phase 4 の監視項目「可変行高 measureElement: 1000 件超で jitter」に接続する。

## 8. 非スコープ・制限の記録

- 表の編集 UI / 表以外の MD 描画 / 保存形式変更 / 形式フラグ / OCR 系 file(§1 Out 再掲)。
- **shared_context(`> ` 引用)内の表は描画されない**(root 直下限定の帰結、§3.2)。生記号のまま = 現状維持であり劣化ではない。ノード起点描画に切り替えれば blockquote 内も描画可能(原理的不能ではない)だが、**実データに `> ` 付きの表が存在しない**(2026-07-17 OT SQL 確認)ため本 sprint では不要。観測されたら拡張候補。
- **follow-up 記録(OCR prompt 側課題・単独タスクにしない)**: 「MD 表の直後に空行を吐かせる」を prompt に足せば §2 実測 3 の吸収形(card `2e97b7b7`)は源流で消える。画像切り出しのための OCR チューニングを行う際に同時に整理・対処する(同一 file・同一変更源・検証 1 回で済む)。
- `custom-session-preview.tsx:107`(line-clamp-2)は対象外(fact-finding (F) と同判断)。

## 9. 設計判断の確定状況

- kickoff で OT 確定済: §1 スコープ / §3.1 コア / §3.4 設定 / §3.5 基本 CSS 要件 / §5 pin 方針 / §6-7 test・smoke 方針。
- **CC 判断 5 点 = OT 承認済(2026-07-17 spec レビュー)**: ① root 直下の table のみ(§3.2。理由の正確な記録は同節 — 実データ不在ゆえ不要、原理的不能ではない)② renderer = 素の text node + call site wrapper 温存、(C)(E) は表を含む時のみ `p`→`div`、span/button 内 table nesting 受容(§3.3)③ テーブルビュー列崩れ防止 = セル `overflow-wrap: anywhere`(§3.5、kickoff の条件付き要件の発動)④ テーブルビュー サムネは thumbnails のみ・add 非配線(§3.6)⑤ remark-parse / unified も exact pin(§5)。
- 同レビューの修正 6 件(実測 3 の受容理由書き直し / 実カード fixture pin / blockquote 理由訂正 / 実カード 2 件で smoke / OCR prompt follow-up 記録 / 行高観察・a 既知挙動・bundle size 実測)は反映済。
