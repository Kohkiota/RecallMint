# Sprint T(MD 表 read-only 描画 + テーブルビュー サムネ)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OCR が吐く MD パイプ表を 4 面(カードビュー / テーブルビュー / side peek / 学習面)で read-only `<table>` 描画し、テーブルビューに画像サムネを配線する。

**Architecture:** spec `docs/superpowers/specs/2026-07-17-sprint-t-md-table-readonly-render-design.md`(確定・凍結)。核 = 全機能パース + root 直下 table ノードの offset 切り出し(§3.1-3.2)、共有 renderer 1 個が text セグメントを素の text node で出し call site wrapper を温存(§3.3 = 不変条件①の成立機構)。第 2 スコープ(サムネ)は変更源が別ゆえ独立 task。

**Tech Stack:** react-markdown 10.1.0 / remark-gfm 4.0.1 / remark-parse 11.0.0 / unified 11.0.5(全て exact pin・caret なし)。test = Vitest 4(per-file `// @vitest-environment jsdom`)+ tests/contract snapshot。

## 全体ルール(各 task に適用・task からは参照)

1. feat task = **TDD(test first)** → canonical + Codex review → **Crit0/Imp0 収束** → `[reviewed]` commit。per-task full test green(RED を commit しない)。
2. **display 枝のみ変更**。edit 枝(raw MD textarea)・保存形式・書込経路・OCR 系 file(Gemini prompt / `lib/ai/prompts/ocr-extract.ts` / response schema)に 1 バイトも触らない(spec §4-4)。
3. 不変条件(spec §4): ① 表 0 個入力で現状と DOM 同一(5 site 全部)② セグメント連結復元 = 入力と **string 完全一致(`===`)** — mdast `position.offset` は UTF-16 code unit(JS string index)であり「byte」ではない(Codex 論点採用: 同一 string なら byte も同一ゆえ `===` が最も厳密かつ十分)③ MD 画像記法から外部リクエスト 0 件。
4. renderer 設定は spec §3.4 で固定: `components.img` 無効(alt 表示)/ `components.a` 無効(children 表示)/ `singleTilde: false` / rehype 系・remark-breaks・allowedElements 不使用。
5. `.snap` の無条件 `-u` 禁止(diff を読んで意図した変更のみ受理)。
6. 実カード fixture 2 件(spec §6 A/B)は **OT が `length(question_text)` を確認して確定させる**(OT レビューで切断痕跡なしと判定済 = A は閉じパイプで完結・B は選択肢 d まで揃う)。**OT の length 確認結果を受けてから T2 の fixture 化に進む**(未受領なら T2 fixture 化の直前で停止)。
7. review dispatch の観点 list に whole-repo lint 実行確認を含める(CLAUDE.md)。自走継続・停止条件・spec 凍結は CLAUDE.md 準拠。

---

### Task T1: dep 導入 + de-risk(chore)

**目的**: 4 packages を exact pin で導入し、二重パーサ不在と build 健全性を確認、bundle size の baseline を記録する(spec §5)。

**Files**: Modify `package.json` / `pnpm-lock.yaml`。

**制約**: `react-markdown@10.1.0` / `remark-gfm@4.0.1` / `remark-parse@11.0.0` / `unified@11.0.5` を dependencies に **exact 記法**(caret なし)で追加。他の依存・設定は触らない。

**手順**: 通常 `pnpm install` で lockfile 更新 → commit 対象確定後に `pnpm install --frozen-lockfile` で再検証(Codex 指摘採用: 依存追加 task で最初から frozen は失敗する)。

**完了条件**: ① `pnpm why remark-parse unified react-markdown remark-gfm` で各 package が単一バージョン(react-markdown 内部 range `^11` に dedupe)② frozen 再検証 / `pnpm typecheck` / `pnpm build` 全 exit 0 ③ **build 出力の route サイズを baseline として記録**(消費 site 未配線ゆえ差分は T7 で確定 — 推測数字を置かない、spec §5)。commit = `chore(deps)` + `[no-review]`(ロジック変更なし)。

---

### Task T2: セグメンテーション純関数(TDD 厚く)

**目的**: MD 文字列を `[text][table][text]…` セグメント列に分割する pure 関数(spec §3.2)。表示ユーティリティゆえ `lib/markdown/` 新設(I/O なし)。

**Files**: Create `lib/markdown/segment-md-tables.ts` / Test `lib/markdown/segment-md-tables.test.ts`(environment node のまま・jsdom 不要)。

**Interfaces(Produces)**:
- `type MdSegment = { type: 'text' | 'table'; value: string }`
- `segmentMdTables(text: string): MdSegment[]` — root 直下(depth 1)の table ノードのみ table セグメント化。空 text セグメントは配列に入れない。表 0 個 → `[{ type: 'text', value: text }]`(string 完全一致)。
- **`hasMdTable` は produce しない**(修正 3: T5 は Codex 採用で `segments.some(s => s.type === 'table')` に変わり consumer 不在 = 初日から dead code のため落とす)。

**制約**: パーサ構築 = `unified().use(remarkParse).use(remarkGfm, { singleTilde: false })`(spec §3.1 処理フロー)。判定器自作禁止(GFM 委譲)。offset は `position.start.offset` / `end.offset` のみ使用(= 我々は返り値で `String.slice` するだけ・UTF-16 code unit 前提)。

**test(spec §6 全列挙 + 実測エッジ)**: 表 0 個で原文と string 完全一致 / **連結復元 property(全 fixture: segments の value 連結 `===` 入力)** / **サロゲートペア fixture(修正 1・最重要)** = 絵文字 or `𠮟` 等の BMP 外文字を **①表より前 ②表内セル ③表より後** に含む 3 版(+ 3 箇所全部入り版)で連結復元 property が通る。この test だけが「offset は UTF-16 code unit で我々は slice するだけ」という**設計の load-bearing な前提**を検証する(現 fixture list は全て BMP 内 = 唯一の危険経路を一度も通らず green になるため必須。offset が code unit なら自明に通り、code point ならペア以降の全テキストがズレて RED)/ 区切り行なし・列数不一致は表にならない / 空行なし直後の表は認識 / 表直後の本文吸収(実カード B 形 — test 名に「GFM 仕様の吸収挙動を正として pin」と明記)/ blockquote・リスト内の表は text のまま / 表が先頭・末尾(実カード A 形)・複数・連続 / 空文字列。実カード A/B 全文を fixture file に置く(全体ルール 6)。

**完了条件**: 上記 test green(この test 実行が ESM/vitest 動作確認を兼ねる、spec §5)・Crit0/Imp0・`[reviewed]`。

---

### Task T3: 共有 renderer component + contract snapshot

**目的**: セグメント列を描画する共有 renderer(spec §3.3)。text = 素の text node(span 等を足さない)、table = react-markdown。

**Files**: Create `components/markdown/md-table-text.tsx` / Test `components/markdown/md-table-text.test.tsx`(jsdom)/ Create `tests/contract/md-table-render.contract.test.tsx`(jsdom・snapshot)。

**Interfaces**:
- Consumes: `segmentMdTables` / `MdSegment`(T2)。
- Produces: `<MdTableText value={string} />` — Fragment を返す。text セグメント → `{value}`(React text node)、table セグメント → `<ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} components={{ img, a }}>`(設定 = 全体ルール 4)。`useMemo(() => segmentMdTables(value), [value])` でパースを value 変化時のみに。
- Produces(低レベル): `<MdTableSegments segments={MdSegment[]} />` — `MdTableText` の内部実体を export(Codex 論点採用: T5 の C/E が `segmentMdTables` を 1 回だけ呼び、tag 判定と描画で segments を共有 = 二重パース回避)。

**制約(CSS・spec §3.5)**: 表 = 縦に伸びる・行数で切らない・省略記号なし・横スクロールなし・`w-fit` 相当(コンテナ幅に引き伸ばさない)・**セルに `overflow-wrap: anywhere`**(外側 TanStack 列を押さない)。表スタイルは renderer 内で完結(4 面同一適用・面ごと出し分けなし)。

**test**: 表 0 個 → **`container.textContent === value` かつ element 子ノードがゼロ(`container.querySelector('*') === null`)**(修正 4: React text node は `innerHTML` で `<`→`&lt;` / `&`→`&amp;` に serialize されるため `innerHTML === value` は raw HTML fixture で必ず落ちる — 「text node のみで DOM 要素を足していない」の正しい表現は textContent 一致 + 子要素ゼロ)/ `![x](url)` → `<img>` 不在 + 「x」(alt)表示 / `![](url)`(空 alt)→ `<img>` 不在・表示なし / `[厚労省](url)` → `<a>` 不在・「厚労省」表示(URL は表示から落ちる = spec §3.4 既知挙動)/ `~x~` → `<del>` 不在(singleTilde:false)/ セル内 `<script>` 要素が DOM に**存在しない**(rehype-raw 不使用)/ td・th に `overflow-wrap: anywhere` 相当 class が当たっている(構造 assert — layout 実測は smoke)/ 末尾改行値でも renderer は `<br>` を足さない(補償は call site 責務)。**contract snapshot**: 実カード A(正常 2 列表)+ 実カード B(**吸収挙動の pin** — ライブラリ更新で挙動が変われば `.snap` diff が捕まえる、spec §6)+ セル内 raw HTML / autolink fixture。snapshot は raw innerHTML を prettify せず固定(react-markdown 生成の thead/tbody・空白 text node 込みで pin — それ自体が「表示仕様の固定」の目的、Codex 論点採用)。

**完了条件**: test + snapshot green・Crit0/Imp0・`[reviewed]`。

---

### Task T4: 編集面配線(挿入点 A/B)

**目的**: `InlineTextField` / `InlineOptionCell` の display 枝の `{value}` 補間点だけを `<MdTableText>` に差し替える(spec §2 挿入点 A/B・§3.3)。

**Files**: Modify `app/(app)/app/exams/[id]/_components/inline-text-field.tsx`(display 枝 :314 の `{displayText}` のみ)/ `app/(app)/app/exams/[id]/_components/inline-option-row.tsx`(InlineOptionCell display 枝 :453 の `{value}` のみ)/ Test 既存 test file に追加。

**Interfaces**: Consumes `<MdTableText value={...} />`(T3)。

**制約**: wrapper span(`whitespace-pre-wrap break-words`)・`<br>` 補償・placeholder 分岐・edit 枝は **1 文字も変えない**。isEmpty 分岐は従来どおり(renderer は非空時のみ)。

**不変条件① = golden-first で機械証明する(修正 2)**。手書きリテラル固定は「読み違えて誤 DOM を pin」/「同一 commit で新コードから .snap 生成 = 必ず green = 無証明」の 2 通りに壊れるため使わない。既存 G→R→W 規律に沿い、次の順で組む(commit の切り方は CC 判断):

- [ ] **Step 1(golden 取得・差し替え前)**: `inline-text-field.tsx` / `inline-option-row.tsx` を**現行コードのまま**、表 0 個 value の display 枝 DOM を `toMatchSnapshot()` で採取し green を確認(= .snap が**旧 DOM から**生成される)。表あり value の snapshot も同時採取(この時点では生記号 = 現状描画が pin される)。
- [ ] **Step 2(RED 確認）**: 表入り value で「span 内に `<table>` が存在する」assert を追加 → 現行コードで FAIL することを確認(RED は commit しない)。
- [ ] **Step 3(差し替え)**: `{displayText}` / `{value}` 補間点を `<MdTableText>` に差し替え。
- [ ] **Step 4(不変条件① 証明 + 新挙動）**: 表 0 個 snapshot が **`.snap` diff なしで green のまま**であることを確認(= 差し替えが表 0 個 DOM を変えていない機械的証明)。表あり snapshot は意図した差分(生記号→`<table>`)を**目視で確認して**更新受理(`.snap` 無条件 `-u` 禁止・全体ルール 5)。Step 2 の `<table>` assert が PASS に転じる。
- [ ] **Step 5**: click で edit 開始・textarea に raw MD(既存挙動の回帰）+ 既存 test 回帰なしを確認 → commit。

カードビュー / テーブルビュー / side peek は全て A/B 共有ゆえ、この 2 file で 3 面カバー(spec §2)。

**完了条件**: 表 0 個 snapshot が diff なし green(不変条件①証明)+ 表あり snapshot が意図差分で受理 + 既存 inline-text-field / inline-option-row / exam-card-table 系 test 回帰なし・Crit0/Imp0・`[reviewed]`。

---

### Task T5: 学習面配線(挿入点 C/D/E)

**目的**: session-runner の 3 独立 site に renderer を配線。C/E は表を含む時のみ `<p>`→`<div>`(spec §3.3 — p>table は hydration 破壊、表 0 個は `p` 維持で DOM 同一)。

**Files**: Modify `app/(app)/app/study/smart/_components/session-runner.tsx`(C :435-437 / D :473-484 / E :525-529)/ Test `app/(app)/app/study/smart/_components/session-runner.test.tsx`(既存)に追加。

**Interfaces**: Consumes `<MdTableText>` + `<MdTableSegments>` + `segmentMdTables`(T2/T3)。

**制約**: `<button>` / marker span / 選択肢の highlight class・回答トグルは **1 文字も変えない**(span/button 内 table nesting は spec §3.3 で受容済)。stripPrefix の適用順は現状維持(strip 後の文字列を renderer に渡す)。className は全 site 維持(C/E は tag だけ条件切替)。実装詳細は下記 Step 3。

**不変条件① = golden-first(修正 2・T4 と同型)**。C/D/E の 3 site すべてを対象に、次の順で組む:

- [ ] **Step 1(golden 取得・差し替え前)**: `session-runner.tsx` を**現行コードのまま**、表 0 個の question(C)/ option text・explanation(D)/ explanation(E)の DOM を `toMatchSnapshot()` で採取し green 確認(= 旧 DOM から .snap 生成。C/E は現行 `<p>` が pin される)。
- [ ] **Step 2(RED 確認)**: 表入りで「C/E が `<div>` + `<table>`」「D の option text・explanation が button 内 `<table>`」assert を追加 → 現行コードで FAIL 確認(RED は commit しない)。
- [ ] **Step 3(差し替え)**: C/E = `useMemo(() => segmentMdTables(text))` を **1 回**呼び `segments.some(s => s.type === 'table')` で tag を `'p'`/`'div'` 切替 + `<MdTableSegments segments>` 描画(二重パースしない、Codex 採用)。D = `{stripPrefix 後 displayText}` と `{opt.explanation}` の補間点のみ `<MdTableText>` に差し替え。
- [ ] **Step 4(不変条件① 証明 + 新挙動)**: 表 0 個 snapshot(C の `<p>` 含む)が **`.snap` diff なしで green のまま**であることを確認 + Step 2 assert が PASS に転じる + 表あり snapshot を意図差分で受理。
- [ ] **Step 5**: 表入り描画で **console.error/warn(React validateDOMNesting 等)が出ない**ことを spy で assert + 回答フロー(選択→判定)の既存 test 回帰なし → commit。

**完了条件**: 表 0 個 snapshot が C/D/E とも diff なし green(不変条件①証明・5 site 全部）+ 表あり意図差分受理 + console warn なし + 回答フロー回帰なし・Crit0/Imp0・`[reviewed]`。

---

### Task T6: テーブルビュー 画像サムネ配線(第 2 スコープ)

**目的**: Sprint I の列挙漏れ(spec §2)を埋める。question / explanation_text / memo 列 + 選択肢列に thumbnails を出す(spec §3.6)。

**Files**: Modify `app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx`(3 列の cell に `CardImageGallery slot='thumbnails'` を `InlineTextField` 直下へ・`meta.userId` + `row.original.card.images`)/ `app/(app)/app/exams/[id]/_components/exam-card-table-options-edit-cell.tsx`(`CompactOptionsCell` props に `images: ClientCardImage[]` / `userId: string` を追加し、各選択肢の下に `opt.uid` gate 付き thumbnails — `inline-option-row.tsx:116-124` と同パターン)/ Test `exam-card-table-columns.test.tsx` / `exam-card-table-options-edit-cell.test.tsx` に追加。

**Interfaces**: Consumes 既存 `CardImageGallery`(props: `images/target/cardId/userId/slot`)。`CompactOptionsCell` の新 props は columns cell(:201-206)から `row.original.card.images` + `meta.userId` を渡す。

**制約**: **add affordance は配線しない**(slot='thumbnails' のみ・削除はカードビュー同等に可、spec §3.6)。target 語彙 = `'question_text'` / `'explanation_text'` / `'memo'` / `'option:<uid>'`(Sprint I 確定)。attach/remove の独自経路を新設しない。

**test**: ① 画像ありカードの 3 列 + 選択肢に thumbnail が render ② uid なし・画像なし選択肢は増分 DOM ゼロ ③ add affordance(`画像を追加` ボタン/アイコン)が table 列に**出ない** ④ thumbnail 削除 → 既存 `removeImageFromCard` 経路(mock)が呼ばれる(独自経路が無いことの確認、Codex 論点採用)。

**完了条件**: test + 既存 table 系 test 回帰なし・Crit0/Imp0・`[reviewed]`。

---

### Task T7: sprint 完了 gate + session doc

**目的**: dep / lockfile を触った sprint の完了 gate(CLAUDE.md)+ bundle size 差分確定 + 記録。

**Files**: Create `docs/superpowers/sessions/2026-07-XX-sprint-t-completion.md`(実施日で命名)。

**完了条件**: ① `pnpm install --frozen-lockfile` / `pnpm typecheck` / `pnpm build` / `pnpm test` 全 exit 0 ② whole-repo `pnpm lint`(--max-warnings=0)exit 0 — 報告 chat に「whole-repo lint exit 0 確認済」1 行明記 ③ **bundle size: T1 baseline との route サイズ差分を実測し session doc に記録**(spec §5)④ session doc commit(`docs(session)` + `[no-review]`)。完了後 **Sprint 境界で停止**(OT push → stg smoke は OT 指示後に CC が DevTools で実施: 実カード 2 件 × 4 面 + 表 0 個カード不変 + Network 外部リクエスト 0 + テーブルビュー サムネ + 行高観察 + **学習面 button 内 table の実機確認**(console に hydration/nesting warning なし・表領域クリックで回答トグルが機能)+ **テーブルビューで長い連続語入り表の列幅実測**(td width が指定値を超えて押し広げられない)・spec §7 + Codex 論点採用)。

---

## 実行順序と依存

T1 → T2 → T3 → T4 → T5 → T6 → T7。T6 は T3-T5 と独立(T1 後ならいつでも可)だが、単線実行では上記順。T4/T5 は T3 の `MdTableText` に依存。

## Plan 段階 Codex cross-check(CLAUDE.md)

**実施済(2026-07-17)**: raw = `docs/codex/2026-07-17-plan-sprint-t-md-table.md`。採用 9 点(offset 用語の正確化 = string `===` / C/E 単一パース API / D の 0 個 DOM 同一 + explanation 表 test / React warning spy / anywhere 構造 assert + smoke 列幅実測 / snapshot 安定化方針 / raw HTML `<script>` 不在 assert / サムネ削除経路 test / T1 install 手順分離)は本 plan に反映済(各所「Codex 論点採用」)。不採用は OT 承認済の決定と重複する対立論点(root 限定 / nesting 受容 / 委譲 vs 補正器 / exact pin / サムネ密度)= spec §9 で決定済。**OT 承認で plan 確定** → 確定後は plan 完了まで自走(Critical は CC 解決を試み、未解決のみ即上げ)。
