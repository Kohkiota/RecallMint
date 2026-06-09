# Tag-4c-2a-fix-4: タグ popover の幅一貫性修正 (min-w-56 + break-words + 型選択 二重 px-2 解消)

## Goal

タグ popover (`CardTagAddPopover` / `CardTagEditPopover`) が stage 遷移のたびに横幅が一貫性なく収縮・膨張する問題を、 PopoverContent に最小幅 floor を入れ、 row テキストを折返し可能にし、 型選択 stage の二重 px-2 インデントを解消することで、 全 stage で幅と content インデントを一貫させる。

## 背景・問題

現状 (commit `0be3064` 後、 Tag-4c-2a-fix-3 まで反映済):

- 両 popover の `<PopoverContent className="w-auto max-w-sm p-0">` で **`w-auto`** が指定 → popover 幅が内側 content の最大幅で決まる (max-w-sm 384px が cap)
- stage 遷移時に内側 content の最大幅要素が変わるため popover 自身が**収縮 / 膨張**:
  - **stage A** (category combobox): 既存 category 行で決まる
  - **stage B** (CardTagAddPopover の option 一覧、 新規 category 作成直後 or 既存 category click 後): empty placeholder + 既存 option 行で決まる
  - **stage C** (createCategoryType 2 button): button content + 見出し (Fix-2 で削除済) で決まる
  - **stage D** (CardTagEditPopover の option 一覧、 バッジ click): header + 既存 option 行で決まる

OT 実機指摘:
- **指摘 1**: 「新規 category 作成 → option 追加画面 (stage B)」 が空入力 option list 0 件にもかかわらず **明らかに広い** (体感で stage D より 100px 以上幅広)
- **指摘 2**: 型選択 stage (C) が他 stage より **狭く見える** (Tag-4c-2a-fix-3 Fix-1 の wrapper `px-2 pb-1` で button content が popover 左から 16px に押し込まれている、 他 stage の row content は 8px → 8px ずれ)
- **指摘 3**: stage 遷移ごとに popover 横幅が変わる→ UX 一貫性が低い

### Step 0 で確定した真因 (指摘 1)

OT brief の容疑 (back button「カテゴリ選択へ戻る」 が幅を支配している) は**否定**。 Step 0 調査結果:

- 「カテゴリ選択へ戻る」 wrapper = ~140px (text-xs 8 文字 96px + ChevronLeft 12px + gap-1 4px + px-2 padding 16px ≈ 128-140px)
- stage D の header「{category.name} を編集」 = ~104px (text-sm font-medium 5 文字 80px + px-3 padding 24px)
- 差 ~36px、 これだけでは「明らかに広い」 体感は出ない

**真因は empty placeholder の text 長さ**:
- `card-tag-option-list.tsx:185-188` の `<p className="px-2 py-3 text-center text-sm text-slate-500">{emptyPlaceholderText}</p>`
- default text「上の入力欄に名前を入れて『新規作成』 で追加できます」 ≈ **30 文字** × text-sm 14px ≈ **420px** unwrapped
- `<p>` は `white-space: normal` で wrap するが、 popover が `w-auto` で「この `<p>` を wrap しないで済む最大幅」 を試そうとして max-w-sm cap (384px) 近くまで膨張
- stage B (新規 category 作成直後 option 0 件) で empty placeholder 表示 → popover ~380px
- stage D (既存 category option 数件) で empty placeholder 非表示、 短い option 名 (60-96px/row) のみ → popover ~150-200px

→ **stage 遷移時の幅変動の根本原因は empty placeholder の長 text と w-auto の組合せ**

## Scope

### In scope (Tag-4c-2a-fix-4)

**Fix-1. PopoverContent に最小幅 floor を入れる**
- `card-tag-add-popover.tsx:240` `<PopoverContent className="w-auto max-w-sm p-0">` → `<PopoverContent className="min-w-56 max-w-sm p-0">`
- `card-tag-edit-popover.tsx:120` 同様
- `w-auto` を削除 (Tailwind では `min-w` と `max-w` の両方指定で intrinsic sizing から min-max 間に挟まれる挙動を採る、 `w-auto` 不要)
- `min-w-56` = 14rem = 224px、 `max-w-sm` = 24rem = 384px
- 効果:
  - stage 遷移時に popover が**常に 224-384px 範囲**に収まる → 体感「stage 遷移時の幅変動」 を大幅に軽減
  - stage B の empty placeholder は 224px で 2-3 行 wrap、 stage D は短い option 行で 224px floor を取る → 両者 popover 幅がほぼ 224px で**揃う**
  - stage C の 2 button も 224px floor → 「狭くなる」 体感解消

**Fix-2. row text を `break-all` で折返し可能にする (Japanese 想定)**
- `card-tag-option-list.tsx:236-244` の color pill `<span>` (`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium`):
  - 現状 `whitespace-nowrap` も `break-*` も無いが、 `inline-flex` 内の Japanese 連続漢字 (no spaces) は通常 wrap しない (`overflow-wrap: normal` default)
  - 長 Japanese 名 (例「肺気腫合併心房細動」 ≈ 9 文字 ≈ 108px + padding) が overflow して popover を max-w-sm 超えで膨張させる可能性
  - 修正: `break-all` (`word-break: break-all`) を追加 → 任意位置で改行可能、 max-w-sm 内に収まる
  - 代替: `break-words` (`overflow-wrap: break-word`) — 英文 word boundary 優先、 Japanese で効きが弱い。 採用しない (Japanese 中心のため)
- `<span>新規作成: {trimmed}</span>` (`card-tag-option-list.tsx:296`):
  - 現状 default `white-space: normal` で wrap 可、 ただし `trimmed` が長 Japanese (no spaces) なら同様 wrap しない可能性
  - `break-all` 追加 → 長入力時に max-w-sm 内 wrap
- empty placeholder `<p>` (`card-tag-option-list.tsx:185-188`):
  - 現状 `text-center` のみ、 `<p>` block の default `white-space: normal` で wrap
  - default text には spaces (全角 / 半角) が含まれている → wrap 効く
  - **修正不要** (Fix-1 の min-w-56 + max-w-sm cap で自然に 2-3 行 wrap される)
- back button text `<span>カテゴリ選択へ戻る</span>` (`card-tag-add-popover.tsx:327`):
  - 現状 default `white-space: normal`、 flex button 内、 ~96px 程度なので min-w-56 内に収まる
  - **修正不要**

**Fix-3. 型選択 stage の二重 px-2 解消**
- `card-tag-add-popover.tsx:510` の `<div className="px-2 pb-1">` を `<div className="pb-1">` に変更
- 効果: 2 button outer から外側 `px-2` が消える → button class 自身の `px-2` (= 8px) のみ効く → button content 左端が popover 左から **16px → 8px** に移動
- これで stage A / B / D の row button content (popover 左から 8px) と縦揃え一致
- `createError <p>` (line 532) は 2-button wrapper の**外**にあり既に `className="px-2 text-xs text-red-600"` で 8px インデント → 修正不要
- back button block (line 485) `<div className="px-2 pt-2">` も既に 8px インデント → 修正不要 (back button content 左端は 8px、 他 stage と整合)
- `multiButtonRef` + default focus useEffect は ref 依存で DOM ancestor padding に無関係 → 修正不要

### 維持する不変条件 (Tag-4c-1 / 4c-2a / 4c-2a-fix / 4c-2a-fix-2 / 4c-2a-fix-3 継承)

- whole-set 不変条件 / single 最大 1 個・0 個許容 / 案 a 取り直し / parent 一括 subscribe + useMemo + 子 `React.memo` / popover stage + Esc 階層 (5 stage、 createCategoryType 含む) / npm dep 追加ゼロ / user_id 親 prop / atomic 戦略 / 既存 manager 据置 / option 作成挙動不変
- multi default focus + Enter 即決定 / 二重発火ガード / category 同名抑制 / 編集 stage 全選択 focus rAF / category 行 select_type icon
- **本 sprint は全 fix が見た目 (レイアウト/CSS) のみ**、 logic / state / handler / event flow / イベント順序 一切不変

### Out of scope (別 sprint / 別 chore)

- **empty placeholder text の短文化** → 別 chore (本 sprint は min-w-56 + max-w-sm で「2-3 行 wrap」 を許容、 text 自体は変えない)
- **CardTagEditFields stage (editCategory / editOption / kebab 経路) の padding `px-3`** → 本 sprint は触らない (stage A/B/D は `px-2` で揃うが、 CardTagEditFields は `px-3` で +4px インデント差あり、 視覚的「揃わない」 が出る可能性 — ただし機能上問題なく、 OT brief で言及なし、 別 sprint 要望待ち)
- **DB UNIQUE / 名前マージ** → Tag-3
- **`handleRenameCategory` trim / normalize** → 別 chore
- **D&D (C-2)** → Tag-4c-2b
- **タグ管理画面撤去** → 据置
- **manager 画面 (旧 void / 空文字 user_id pattern)** → Sync-fix-1

## Architecture

### file 構成

**改修:**
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.tsx` (~ ±0 行)
  - PopoverContent class: `w-auto max-w-sm p-0` → `min-w-56 max-w-sm p-0` (Fix-1)
  - 型選択 stage の 2-button wrapper class: `px-2 pb-1` → `pb-1` (Fix-3)
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.tsx` (~ ±0 行)
  - PopoverContent class: `w-auto max-w-sm p-0` → `min-w-56 max-w-sm p-0` (Fix-1)
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.tsx` (~ ±2 行)
  - color pill `<span>` class に `break-all` 追加 (Fix-2)
  - 新規作成行 `<span>新規作成: {trimmed}</span>` class に `break-all` 追加 (Fix-2)
- `app/(app)/app/exams/[id]/_components/card-tag-add-popover.test.tsx` (+~20 行)
  - PopoverContent class `min-w-56` を含む構造 assertion
  - 型選択 stage の 2-button wrapper class `pb-1` (`px-2 pb-1` 不在) assertion
- `app/(app)/app/exams/[id]/_components/card-tag-edit-popover.test.tsx` (+~5 行)
  - PopoverContent class `min-w-56` を含む構造 assertion
- `app/(app)/app/exams/[id]/_components/card-tag-option-list.test.tsx` (+~10 行)
  - color pill / 新規作成行 `<span>` に `break-all` class が含まれる assertion

**新規作成:** なし

**不変:**
- `app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx` / `.test.tsx`
- `app/(app)/app/exams/[id]/_components/card-tags-section.tsx` / `.test.tsx`
- `app/(app)/app/exams/[id]/_components/card-tag-badge.tsx`
- `lib/db/schema.ts` / `lib/client-db.ts` / `lib/tags/apply-tag-mutation.ts`

### 重要な設計判断

#### 1. `w-auto` 削除 + `min-w-56 max-w-sm` 併用 (Fix-1)

Tailwind / CSS で `min-width` と `max-width` を併用すると、 width 計算は:
- intrinsic content width (browser が「中身を wrap せずに置きたい最小幅」 を計算) を base に
- `min-width` で floor、 `max-width` で cap
- content がさらに広く要求すれば `max-width` で頭打ち + 内部 wrap (default `white-space: normal` 要素)

stage 別の挙動 (修正後):
- **stage A** (category combobox): category 行 ~150-200px → popover は min-w-56 floor = 224px (intrinsic より広い場合のみ floor)
- **stage B** (option combobox、 新規 category 作成直後): empty placeholder が wrap 計算で text-sm 30 文字 = ~420px > max-w-sm 384px → max-w-sm で cap、 placeholder は 2-3 行 wrap → popover **384px** (max-w-sm に張りつく)
- **stage C** (型選択 2 button): button content ~150-180px → popover **224px** (min-w-56 floor)
- **stage D** (既存 category 編集 option list): header ~104px + 短い option 行 ~80px → popover **224px** (min-w-56 floor)

→ stage B は依然 384px に張りつくが、 stage A / C / D が 224px floor で揃う。 stage B (option 0 件) と stage D (option 数件) で **依然差は出る** が、 体感的には「stage A → D の遷移 = 224px 維持」 「stage A → B (新 category 作成直後) = 224px → 384px の 1 度だけの拡張」 で**前回の連続収縮膨張よりは大幅マシ**。 empty placeholder text の短文化は別 sprint で扱う。

代替案 (採用せず):
- (a) PopoverContent に `w-[24rem]` (= 384px fixed) を指定 → 全 stage で固定 384px、 stage C の 2 button が「余白だらけ」 になる
- (b) PopoverContent に `w-56` (224px fixed) を指定 → stage B の empty placeholder が wrap 過多 (3-4 行)、 long option 名で overflow
- (c) `min-w-64` (256px) や `min-w-72` (288px) → 224px より広く、 stage C の 2 button が「やや余白」、 stage B との差を更に減らせる、 ただし stage A / D の category 行が 256-288px なら自然に floor で揃う

**採用判断**: `min-w-56` (224px) は Step 0 で全 stage で破綻なし確認済、 OT brief 確定。 必要なら plan 実装中に DevTools で実機確認、 256-288px に微調整可 (spec での確定値は 224px)。

#### 2. `break-all` を color pill + 新規作成行 span に限定 (Fix-2)

color pill (`inline-flex items-center ...`) は Japanese 連続漢字 (no spaces) で wrap しないため、 長 option 名で overflow リスク → `break-all` で任意位置 break させる。

新規作成行 `<span>新規作成: {trimmed}</span>` も `trimmed` が長 Japanese なら同様 → `break-all` 追加。

なぜ `break-all` で `break-words` ではないか:
- `break-words` (= `overflow-wrap: break-word`): 英文の word boundary を尊重しつつ overflow 時のみ word 内 break。 Japanese (no word boundary) では word-break 既定 (normal) のままで break しない
- `break-all` (= `word-break: break-all`): 任意位置 (Japanese 文字間含む) で break。 Japanese 中心の本 UI に適合

empty placeholder `<p>` には不要:
- `<p>` block で default `white-space: normal`、 default text には全角 spaces / 句読点で wrap 効く
- 長 Japanese 連続文字列でない限り正常 wrap、 default text は OK

back button `<span>` には不要:
- 短文 (8 文字)、 flex button 内、 min-w-56 224px に十分収まる

#### 3. 二重 px-2 解消は outer `px-2` 削除 (Fix-3)

OT brief 確定方針。 outer の `<div className="px-2 pb-1">` から `px-2` を削除する 1 文字置換 (`pb-1` 残し)。

なぜ button class の `px-2` を消さないか:
- button class `flex w-full items-center gap-2 px-2 py-1.5 text-sm hover:bg-slate-100 rounded` の `px-2` は **button 内 content の左右余白** (button hover 領域含む)
- 他 stage の row button も同じ `px-2 py-1.5` を持つ → button class は揃える方が一貫
- outer の `px-2` は「2-button block を内側に押し込む余分なインデント」 で、 他 stage には対応する outer 余分インデントがない (= 他 stage は row button 直下 `<li>` で outer padding なし)

修正後:
- 2-button content 左端 = popover 左から **8px** (button class `px-2` のみ)
- 他 stage の row content 左端 = popover 左から **8px** (同上)
- back button block の back button content 左端 = popover 左から **8px** (outer `px-2 pt-2` のみ、 button class padding なし)
- createError 左端 = popover 左から **8px** (`px-2` のみ)

→ 全 stage の content 左端が 8px に**統一**。

### Error handling

- popover が min-w-56 で「常に 224px 以上」 → 短 content stage (例 stage C) で popover 自身が「余白だらけ」 に見える可能性、 ただし 2 button は `w-full` で popover 内幅全体に張る → 視覚的に「button が popover 幅で並んでいる」 状態、 違和感少
- empty placeholder が 224px で wrap して 2-3 行になる → 読みやすさは保たれる、 別 sprint で短文化検討

### Tests strategy (test 観点のみ、 詳細 case は plan 側で task ごとに割る)

- **card-tag-add-popover.test.tsx**:
  - PopoverContent JSX に `min-w-56` class が含まれる (`w-auto` 不在)
  - 型選択 stage の 2-button outer が `<div className="pb-1">` (`px-2 pb-1` ではない) — structural assertion
  - 既存 stage 遷移 / Esc / handler / focus / guard regression なし
- **card-tag-edit-popover.test.tsx**:
  - PopoverContent JSX に `min-w-56` class が含まれる
  - 既存 stage 遷移 / kebab / editOption regression なし
- **card-tag-option-list.test.tsx**:
  - color pill `<span>` に `break-all` class が含まれる
  - 新規作成行 `<span>` に `break-all` class が含まれる
  - 既存 row click / kebab / filter / 新規作成行 click / select_type icon regression なし
- **smoke**: stg 実機で 8-10 観点 (plan 同梱 checklist)

## 規模見積もり

- 改修 3 source file (各 ~1-2 行修正) + 3 test file (~30 行新規 + regression): 純増 ~50-60 行
- plan は ~180 行 (300 cap 内、 Task 数 3 程度)、 Tag-4c-2a 系の amend に重ねる (`0be3064` を amend)

## 受入基準 (Acceptance criteria)

- 両 popover (`CardTagAddPopover` / `CardTagEditPopover`) の PopoverContent class が `min-w-56 max-w-sm p-0` (`w-auto` 不在)
- stage A (category combobox) と stage D (既存 category 編集 option list) で popover 横幅が**揃う** (両者 224px floor、 実機目視 ±4px 以内)
- stage C (型選択 2 button) の popover 横幅が他 stage と揃う (224px floor)、 button content 左端が 8px (popover 左から)、 他 stage の row content と縦揃え一致
- stage B (新規 category 作成直後の option 一覧、 option 0 件 + empty placeholder 表示) で popover が max-w-sm 384px で cap、 empty placeholder が 2-3 行 wrap (受容、 別 sprint で短文化検討)
- 長 Japanese option 名 / category 名 (例「肺気腫合併心房細動」) が color pill 内で `break-all` 折返し、 popover を max-w-sm 超で膨張させない
- 全 fix 後、 stage 遷移時の popover 横幅変動が「stage A → D で常に 224px」 「stage A → B で 1 度だけ 224px → 384px の拡張」 に収束
- Logic / state / handler / event flow 完全不変 (multi default focus / 二重発火 guard / Esc / popover close reset / 同名抑制 / 全選択 focus / category 行 icon 全 regression なし)
- Tag-4c-1 / Tag-4c-2a / Tag-4c-2a-fix / Tag-4c-2a-fix-2 / Tag-4c-2a-fix-3 の全 regression なし
- npm dep 追加なし、 schema 不変、 server logic 不変

## リスク / オープン論点

1. **min-w-56 224px の妥当性**: Step 0 で全 stage 破綻なし確認済、 ただし実機 mobile (DevTools mobile view) で「popover が card より大きく見える」 等の体感問題が出る可能性。 plan 実装中に DevTools で確認、 必要なら `min-w-64` (256px) / `min-w-72` (288px) に微調整 (OT 確認上で)。
2. **stage B (option 0 件 + empty placeholder) は依然 384px に張りつく**: 受入基準で許容、 別 sprint で empty placeholder text 短文化 (例「上で『新規作成』 を押して追加」 程度に圧縮) で更に改善可能。 OT 体感で許容 / 別 sprint 必要を判断。
3. **`break-all` の効きが効きすぎるリスク**: 短い英語 name (例 "AI") にも適用されるが、 短文字数なら wrap 発火条件 (content > container width) が成立しないので無害。
4. **PopoverContent の `w-auto` を `min-w-56` に変更したときの shadcn Popover の挙動**: `w-auto` は default、 `min-w-*` を指定すると Tailwind / CSS の通常挙動で intrinsic width + floor + cap。 shadcn の internal style は無関係。 安全。
5. **CardTagEditFields の `px-3` インデント (kebab 経路 stage E / F)**: 本 sprint で触らない、 他 stage の `px-2` (= 8px) と 4px 差。 OT 体感で「揃わない」 と感じる場合は別 sprint で対処。

## Commit / Push 方針 (OT 指示反映)

- 本 sprint の全変更を Tag-4c-2a 系の feat commit `0be3064` (= 現在の HEAD~3、 Tag-4c-2a-fix-3 amend 後 hash) に **`git commit --amend`** で畳む (別 commit を積まない)
- amend 手順は Tag-4c-2a-fix-3 Task 3 と同 pattern (`git reset --soft HEAD~3` で直近 3 docs commit を pop → docs を unstage → source/test/smoke を add → `git commit --amend --no-edit` → 3 docs commit + 本 sprint docs commit を再積み = 計 4 docs commit)
- amend 後の commit message は `--no-edit` (既存維持)
- `0be3064` は origin/develop に push 済 (Tag-4c-2a-fix-3 amend を OT が force-with-lease push 済の想定) → push は `git push --force-with-lease origin develop` で OT が実施 (Claude Code は push しない)
- docs (spec + plan) は別 `docs(tag): Tag-4c-2a-fix-4 spec + plan ... [no-review]` commit で積む

## 参照

- 実装対象: `app/(app)/app/exams/[id]/_components/card-tag-{add-popover,edit-popover,option-list}.tsx`
- Tag-4c-2a-fix-3 spec (前提): `docs/superpowers/specs/2026-06-08-tag-4c-2a-fix-3-design.md`
- Tag-4c-2a-fix-3 plan: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-3.md`
- Tag-4c-2a-fix-3 smoke: `docs/superpowers/plans/2026-06-08-tag-4c-2a-fix-3-smoke-checklist.md`
- 該当箇所の現コード:
  - PopoverContent (CardTagAddPopover): `card-tag-add-popover.tsx:239-240` `<PopoverContent className="w-auto max-w-sm p-0">`
  - PopoverContent (CardTagEditPopover): `card-tag-edit-popover.tsx:119-120` 同上
  - 型選択 stage 2-button wrapper: `card-tag-add-popover.tsx:510` `<div className="px-2 pb-1">`
  - color pill: `card-tag-option-list.tsx:236-244`
  - 新規作成行 span: `card-tag-option-list.tsx:296`
  - empty placeholder (Fix-1 で間接解決、 直接修正なし): `card-tag-option-list.tsx:185-188`
- Step 0 調査結果: 本 spec §背景・問題 §設計判断 §リスク に反映済 (別 file 化なし)
