# Edit-3 テーブル密度修正 Implementation Plan(ドラフト)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development(task 単位 fresh subagent + task 間 review)で実装する。Steps は checkbox 追跡。
> **状態:** plan ドラフト(未確定)。codex-plan-review cross-check 済 → OT 承認で確定。実装は承認後・別プロンプト。

**Goal:** 試験詳細テーブルの padding を Notion 基準へ極小化し縦密度を上げる。併せて sticky 2列・title 幅・sort_key 既定 hidden・問題文フォント統一を入れる。新 dep なし。

**Architecture:** 縦間延びは各入れ子層の padding/min-h 重積。table 専用層(td/th・CompactOptionsCell)は直接削る(card-view 無影響)。共有部品(`InlineTextField`/`InlineOptionCell`)は全レンダーパスを `cn(clsx+twMerge)` に統一して外部 className 上書きを対称化し、table 側 className で min-h/padding/font を詰める(density prop は足さない)。sticky は select 列に `meta.sticky` を足し `left-0` ハードコードを列ごと動的 left offset へ。title size を ~80px、sort_key を columnVisibility 既定 hidden(フラグ判定なし)。

**Tech Stack:** Next.js App Router / TS strict / TanStack Table v8(headless)/ Tailwind v4 / `cn`=clsx+twMerge(`lib/utils.ts`)/ Vitest + RTL / DevTools MCP smoke。

**Spec(唯一の起点):** `docs/superpowers/specs/2026-06-30-edit-3-table-density-design.md`

## Global Constraints

- 起点は spec のみ。spec 凍結。仕様変更が要るなら停止して OT 相談。
- 各 task 完了条件 = ① 該当 unit/component test green ② canonical + Codex 両 Critical/Important 0 ③ `[reviewed]`。
- **新 dep を入れない**。**density/variant prop を足さない**(cn 統一で済ます。preset は将来「直してから必要なら」)。
- **table 専用層は直接削る / 共有層のみ cn 経由で table 側 className から詰める**。
- **sort_key 既定 hidden にフラグ判定(新規/既存/v1 区別)を作らない**(ユーザー 0・最初から hidden で素直に)。
- **カードビュー(`InlineCardList`)の見た目不変**。共有部品変更時は consumer test 網羅 + card-view スクショ smoke。`exam-detail-view` の分岐不変。
- タスク範囲外(tag バッジ内部・write/query 経路・他機能)を触らない。tag 列 td 行高が全列一律 padding で詰まるのは許容(§Q1)。
- 行番号は plan 時点のもの。実装時に現物再確認。Test: Vitest + RTL。`git commit --no-verify` / `-n` 全面禁止。

## Sprint 完了 gate

- whole-repo `pnpm lint --max-warnings=0` exit 0(報告に1行明記)。CC と reviewer 両経路で確認。
- `pnpm typecheck` exit 0。
- **smoke gate の位置**: per-task 完了条件 = unit/RTL green + typecheck + review(worker が回せるもの)。**実機 smoke は per-task ブロッカーにしない**(worker は push しない = CLAUDE.md 標準フロー)。視覚・行高・sticky・font ジャンプ・card-view 差分は **sprint 末 stg smoke**(push 後 OT 指示で CC が DevTools MCP 実走)に集約。
- **T1 後の中間 stop**(spec §7): T1 完了で停止 → OT が密度を実機確認 → T2(共有 cn 統一)の要否判断。T1 で十分なら T2 を回避。
- **sequencing 明確化(Codex 抜け#10 反映)**: **T1 → stop → 密度実機判断 → (要なら)T2 → T3/T4** を基本順とする。T3(sticky)/T4(title 幅・sort_key)は padding と独立だが、**T1 の密度判定を視覚的に混濁させないため T1 単独で測ってから着手**(T3/T4 を T1 前に混ぜて密度評価しない)。T2 不要判断後は T3/T4 を並行可。
- **sprint 末 stg smoke**: sticky 2列が横スクロールで残る・title resize で offset ずれ・select hover 色消失 / padding 削減後の実行高・tap target・layout shift / フォント統一後の文字ジャンプ無し・非focus 下端余白消失・mobile 1 行時の両モード一致 / title 80px で input 破綻なし / **card-view スクショ差分(T2)**。

---

### Task 1: table 専用 padding 削減 + 問題文 displayClassName

**目的:** card-view に波及しない table 専用層の padding/min-h 重複を削り、問題文セルの font を `displayClassName` で揃える。

**Files:** Modify `exam-card-table.tsx`(td/th padding)/ `exam-card-table-options-edit-cell.tsx`(CompactOptionsCell 層)/ `exam-card-table-columns.tsx`(InlineTextField に `displayClassName` 追加)+ 各 `.test.tsx` 追記。

**Interfaces:** Consumes 既存(`InlineTextField` の `displayClassName?: string` prop は既存)。Produces なし(class 調整のみ)。

**制約(spec §3.2-1/3.2-4):**
- **table 専用層のみ**(card-view 不使用を fact-finding で確認: `CompactOptionsCell` は table 専用、td/th は table、`InlineOptionRow` の padding は card-view 側で table 無関係)。
- 削る対象(現物再確認の上): td/th `px-3 py-2`(`exam-card-table.tsx` td ~:451 / th ~:386)の縦成分を **`py-2`→`py-1`(全列一律=tag 含む、Q1 確定)**/ `CompactOptionsCell` の `space-y-1`(~:32)・box `p-1.5`(~:36-40 の縦)・`mt-0.5`(~:80)。**checkbox/削除の `min-h-8 min-w-8` は tap target ゆえ維持**。
- 問題文/解説/メモの table 列(`exam-card-table-columns.tsx` question :118 / explanation :171 / memo :186)の `InlineTextField` に **`displayClassName="text-sm …"` を付与**(focus textarea の `text-base` を edit パスの cn で上書き=文字ジャンプ解消)。**display パスの非対称は T2 の cn 統一で根治するが、`text-sm` 付与は edit パス(既に cn 経由)で即効く**。border-b はセルに残す(`border-separate` ゆえ tr 罫線不可)。

**font 統一の効く範囲(Codex cross-check 反映 — 限界を明示)**: T1 の `displayClassName="text-sm"` は **edit パス(textarea/input、既に primitive cn 経由)で即効き** `text-base`→`text-sm` で文字ジャンプを縮小。**display パスの className merge 非対称(:286-288)の根治は T2**。よって T1 完了時点で「フォント統一」は edit 側のみ・display 側は T2 まで残る、と分けて報告する。`text-sm` は font-size + line-height(20px)を束ねる Tailwind utility ゆえ leading も同時に揃う(別 `leading-*` の残存がないことを実装時に確認)。

**完了条件:**
- `exam-card-table.test.tsx` / `exam-card-table-options-edit-cell.test.tsx` / `exam-card-table-columns.test.tsx` 追記 green: ① td/th の縦 padding が削減値 ② CompactOptionsCell 層の space-y/box padding 削減 ③ checkbox/削除の min-h 維持 ④ 問題文/解説/メモ cell に `displayClassName="text-sm …"` が渡る。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。
- **中間 stop + 密度測定基準(Codex 抜け#1 反映)**: 本 task 完了で停止し OT 密度実機確認 → T2 要否判断(spec §7)。**判定を主観化させないため、stop 時に DevTools で「選択肢 1 件の高さ」「1 行の row 高」を T1 前後で実測し数値で比較**(target は §Q4。T3/T4 未 merge の状態で測り padding 単独効果を見る=後述 sequencing)。smoke は sprint 末。

---

### Task 2: 共有部品 cn 統一 + table 側 className で min-h/padding 詰め

**目的:** `InlineTextField`/`InlineOptionCell` の全レンダーパスを `cn` 統一し外部 className 上書きを対称化、table 側 className で共有層の min-h/padding を詰める。

**Files:** Modify `inline-text-field.tsx`(display div :286-288 / edit textarea :260 / input :268 を `cn` 化)/ `inline-option-row.tsx`(`InlineOptionCell` sharedBoxChrome :311 周辺の全パスを `cn` 化)/ table 側 caller(`exam-card-table-columns.tsx` の InlineTextField、`exam-card-table-options-edit-cell.tsx` の InlineOptionCell)で詰める className 付与 + 各 `.test.tsx` + card-view 回帰 test。

**Interfaces:** `InlineTextField` / `InlineOptionCell` の `className`(or `displayClassName`)合成を `cn(base, variant, className)` に統一(prop signature は不変=density prop 足さない)。

**制約(spec §3.1/3.3):**
- 全パス `cn(clsx+twMerge)` 化: display `<div>`(現状テンプレート結合 :286-288)を `cn(sharedBoxChrome, isEmpty && 'text-slate-400 italic', displayClassName)` に。edit も `cn(sharedBoxChrome, 'resize-none overflow-hidden', displayClassName)` に揃える。**display↔edit 両モードを同時変更**し box 寸法一致(layout shift 防止)維持。
- table 側だけ詰める: table の InlineTextField/InlineOptionCell caller に `min-h`/`py` を縮める className を渡す(twMerge で sharedBoxChrome の `min-h-8`/`py-1` を上書き)。**density prop は足さない**(className 直接)。**下限 = `md:min-h-6`(24px、WCAG 2.5.8 最低)を下回らない**(Q2 改定: desktop md: のみ 24px へ詰める。mobile は `min-h-11`(44px)/`min-h-8`(32px)を touch target ゆえ維持)。
- **どの prop が内側に効くか明示(Codex 抜け#4 反映)**: 詰める className は **box 本体(textarea/input/display div = sharedBoxChrome を持つ要素)に届く prop**(InlineTextField なら `displayClassName`、InlineOptionCell なら本文/解説の box に届く同等 prop)を使う。**wrapper(`space-y-1` 等の外側 div)だけ詰めて内側 box の `min-h-8` が残る誤りを防ぐ** — test で「内側 textarea/input/display 要素に上書き class が乗る」ことを assert。
- **card-view は className を渡さない or 現状維持** → 見た目不変。
- **回帰 hard gate(spec §3.3)**: consumer test 全 green。**card-view 不変の検証は class 文字列完全一致にしない(Codex 抜け#5: twMerge 導入で class 文字列順/重複が変わり完全一致は脆い)** → behavioral assertion(編集/表示/commit 挙動)+ token 単位の有無確認 + **sprint 末 card-view スクショ smoke**(見た目不変が本体保証)。card-view が未定義挙動(`p-2` と外部 `py-*` 両残り)に偶然依存していた場合に見た目が変わらないことをスクショで確認。

**完了条件:**
- `inline-text-field.test.tsx` / `inline-option-row.test.tsx` 追記 green: ① display/edit **両パス**で外部 className が **内側 box の** padding/min-h/font を確実に上書き(twMerge 後勝ち)② display↔edit の box 寸法一致(layout shift なし)。
- **card-view 回帰 green**: `inline-card-list.test.tsx` / `inline-option-row.test.tsx`(+ debounce)全 green(挙動不変。class 文字列完全一致 assert は使わない)。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。smoke(行高・layout shift・**card-view スクショ差分**)は sprint 末。

---

### Task 3: sticky 2列(select + title)

**目的:** select 列を pin に加え、select+title が横スクロールで一緒に左固定されるよう left offset を積み上げる。

**Files:** Modify `exam-card-table-columns.tsx`(select 列に `meta.sticky` + offset 情報)/ `exam-card-table.tsx`(th `left-0` ~:387 / td ~:452 を列ごと動的 left に)+ 各 `.test.tsx` 追記。

**Interfaces:** sticky meta を `{ sticky: true, stickyLeft: number }`(or render 側で `column.id` 分岐)に拡張。

**制約(spec §3.2-2):**
- select 列(`size:44` :59)に `meta:{sticky:true, stickyLeft:0}`、title(:87)を `{sticky:true, stickyLeft:44}`。`left-0` ハードコードを **`style={{ left }}`(既存 `style={{width}}` とマージ)or 任意値 class** に置換。**select 幅固定 44 ゆえ title の left は固定値 44 で足る**(title resize は 2 列目=最後の pin なので offset 不変)。
- z-index/背景は現行 `z-10 bg-background` 踏襲(2 列とも)。select に `bg-background` が付き **行 hover 色が select に出なくなる**のは既存 title 挙動の踏襲(許容)。
- 横スクロールで 2 列残る・title resize で offset ずれは **smoke**(RTL では取れない)。

- **既存 width style を壊さない(Codex 抜け#7 反映)**: `left` を付与する際、現状の `style={{ width: cell.column.getSize() }}` を**消さずマージ**(`style={{ width, left }}`)。列幅破壊を防ぐ。
- **z-index/layering(Codex 抜け#6 反映)**: select/title の左右重なりだけでなく、sticky セル × resize handle(title 右端 `absolute right-0`)× checkbox × dropdown の重なりを smoke で確認(現状 `z-10` 踏襲で破綻しないか)。

**完了条件:**
- `exam-card-table.test.tsx` / `exam-card-table-columns.test.tsx` 追記 green: ① select 列に sticky class + `left:0` ② title に sticky class + `left:44` ③ 非 sticky 列に left 付与なし ④ sticky セルの `style` に既存 `width` が維持されている。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。smoke(横スクロール 2 列残り・resize offset ずれ・select hover 色消失・z-index/layering)は sprint 末。

---

### Task 4: title 幅 ~80px + sort_key default hidden

**目的:** title 初期幅を 4文字相当に縮め(resize 維持)、sort_key を columnVisibility 既定で hidden にする(toggle で再表示可)。

**Files:** Modify `exam-card-table-columns.tsx`(title `size`)/ `exam-card-table.tsx`(columnVisibility 初期 hidden)+ 各 `.test.tsx` 追記。

**Interfaces:** columnVisibility 初期値に sort_key を hidden で含める。

**制約(spec §3.2-3):**
- title `size: 240`(:83)→ **~80px 起点**(14px×4 + padding 24px。Q3 確定: 固定でなく起点、sprint 末 smoke で header label/input 破綻を見て微調整可)。resize は table 設定(`enableColumnResizing` :224-225)で自動維持、minSize は他列に倣い無し。
- sort_key default hidden は **フラグ判定を作らず最初から hidden**(spec §3.2-3): columnVisibility 初期 state(`exam-card-table.tsx:77` `useState<VisibilityState>({})`)を `{ sort_key: false }` に。**ユーザー 0・DB 全消し可ゆえ既存 record 整合は考慮しない**(新規/v1/全表示 v2 区別ロジックを作らない)。
- **toggle UI 再表示維持**: sort_key は `getCanHide()` true のまま(`enableHiding` を false にしない)→ `exam-card-table-column-toggle.tsx` に列挙され再表示可。
- 注: 既存 mount load effect(~:244-261)が saved hiddenColumns を載せる経路は不変(初期 hidden は state 既定で表現。persist は既存 read-modify-write のまま)。
- **saved 設定との相互作用 caveat(Codex 抜け#8 反映)**: load effect は `hiddenColumns.length>0` のときだけ saved map で setState する。**saved に他列の hidden があり sort_key を含まない既存 record**(= 過去に sort_key を表示にした dev/stg state)があると、load が初期 `{sort_key:false}` を saved map で置換し sort_key が表示に戻る。**ユーザー 0・DB 全消し可ゆえフラグ判定は作らず許容**(spec §3.2-3)。ただし **smoke 前提として examViewPrefs(Dexie sync_meta)を事前クリアして「新規状態」で検証**する(dev/stg 残存 state で挙動がぶれるため)。

**完了条件:**
- `exam-card-table.test.tsx` / `exam-card-table-columns.test.tsx` 追記 green: ① title size ~80 ② 初期 columnVisibility で sort_key 非表示 ③ toggle UI に sort_key 列挙・トグルで再表示。
- typecheck 0。canonical + Codex 両 Critical/Important 0 + `[reviewed]`。smoke(examViewPrefs クリア後: title 80px で input/header label「タイトル」破綻なし・sort_key 既定非表示・toggle 再表示)は sprint 末。

---

## Self-Review

- **Spec coverage:** §3.1 cn 統一→T2 / §3.2-1 padding(table 専用)→T1・(共有)→T2 / §3.2-2 sticky 2列→T3 / §3.2-3 title 幅+sort_key→T4 / §3.2-4 font→T1(displayClassName)+T2(cn 根治)/ §3.3 回帰 gate→T2 / §7 中間 stop→T1 完了条件+Sprint gate。§4.2 OUT(新 dep・density prop・フラグ判定・tag バッジ)→Global Constraints。✓
- **Placeholder scan:** なし。padding 削減の具体値(py-1 等)・min-h 下限(§Q2)・title px(§Q3)は Open Question/裁量として明示(TBD でなく判断項目)。✓
- **Type consistency:** `InlineTextField` の `displayClassName` prop は既存(T1 で利用、T2 で cn 化)。sticky meta `{sticky, stickyLeft}` T3 で columns↔render 一致。columnVisibility `{sort_key:false}` T4。density prop は追加しない(全 task 共通)。✓

## Open Questions → OT 確定事項(2026-06-30 承認・実装に反映)

- **Q1 確定**: td `py-2`→`py-1` **全列一律**(tag 列 td も詰まる・バッジ内部不変)。→ T1。
- **Q2 確定(2026-06-30 kickoff で改定)**: 共有 `min-h` を table で詰める下限 = **T2 裁量。tap target 床 = `md:min-h-6`(24px、WCAG 2.5.8 最低)を下回らない**(desktop md: のみ 24px。mobile は `min-h-11`(44px)/`min-h-8`(32px)維持)。当初案「32px(min-h-8)床」から 24px へ改定(密度を最大化、tap が厳しければ sprint 末 smoke で戻す)。→ T2。
- **Q3 確定**: title **~80px 起点**(固定確定でなく、sprint 末 smoke で header label「タイトル」と input が破綻しないか見て微調整可)。→ T4。
- **Q4 確定**: 密度判定は**数値事前固定しない**。T1 前後で「選択肢 1 件の高さ」「1 row 高」を DevTools 実測し before/after をスクショで並べ、それを材料に **OT が T2 要否を判断**。→ T1 stop + Sprint gate。

### plan に取り込み済み(Codex 由来・OT 判断不要)
- T1 font 統一の限界(edit 即効/display 根治は T2)明示(抜け#2)→ T1 / leading は text-sm が束ねる確認(抜け#3)→ T1 / 内側 box に効く prop 明示(抜け#4)→ T2 / card-view gate を文字列完全一致にしない(抜け#5)→ T2 / sticky の既存 width style 維持(抜け#7)→ T3 / z-index・layering smoke(抜け#6)→ T3 / sort_key × saved 設定 caveat + smoke 前提クリア(抜け#8)→ T4 / title header label smoke(抜け#9)→ T4 / sequencing(抜け#10)→ Sprint gate / sticky bg の hover 色欠落を仕様明記(独立)→ T3 制約。
