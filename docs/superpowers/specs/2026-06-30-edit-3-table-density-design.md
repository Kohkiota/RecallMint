# Edit-3: テーブル密度修正(padding 極小化 + sticky 2列 + 列既定)

- 作成: 2026-06-30
- シリーズ: 編集ビュー再構築 Edit-3(試験詳細テーブルの密度を Notion 基準へ。Edit-1/2 の上に乗る純 UI 調整 sprint)
- 種別: spec(design record)。plan は本 spec を起点。
- 前提: Edit-1/2 反映済(11 列・editable cell 7・columnVisibility + examViewPrefs v2 hiddenColumns)。Edit-3 fact-finding 報告を起点(方針確定でスコープ不変ゆえ追加調査不要・行番号は plan/実装時に現物再確認)。本 spec は実装せず。
- スコープは OT 承認 + claude.ai/GPT cross-check 済(§3)。spec はこれを動かさない。仕様変更が要るなら停止して OT 相談。

---

## 1. 目的 / ゴール

試験詳細テーブルビューの padding が広すぎて縦に間延びしている(OT が DevTools で実測)。**Notion 基準(外側 1 層のみ上下左右 8px・内部の入れ子は padding を持たない)へ密度を上げる**。併せて横スクロール時の可読性(sticky 2列)と初期列構成(title 幅 / sort_key 既定)を整える。

- 縦間延びの主因 = 各入れ子層が同じように padding/min-h を持ち**重積**(OT 核心指摘)。
- inline 編集ライブラリは claude.ai + GPT 独立 cross-check 済で**不採用**(専用ライブラリ / ProseMirror・Tiptap / 複製いずれも)。TanStack v8 headless ゆえ**自前部品を直すのが筋**。**新 dep を入れない**。

---

## 2. 全体ルール / 制約

- 起点は spec のみ。spec 凍結。
- 各 task 完了条件 = ① 該当 unit/component test green ② canonical(`superpowers:requesting-code-review`・template 改変なし)+ Codex 独立レビュー両者 Critical/Important 0 ③ `[reviewed]`。
- **簡潔性規律(横断)厳守**:
  - **新 dep を入れない**。**density / variant prop を足さない**(className 合成の `cn` 統一で済ます。同指定が table 内多数に散ったら**将来 cva preset 化** = 「直してから必要なら preset」。代替にしない = YAGNI)。
  - **table 専用層は直接削る**(card-view 無影響)。**共有層のみ `cn` 経由で table 側 className から詰める**。
  - **sort_key 既定 hidden にフラグ判定(新規/既存/v1 区別)を作らない**(ユーザー 0 = DB 全消し可ゆえ最初から hidden で素直に)。
  - タスク範囲外(tag セルのバッジ内部・他機能)を触らない。
- **カードビュー(`InlineCardList` consumer)は見た目不変**(共有部品 `InlineTextField`/`InlineOptionCell` 変更時は回帰 gate)。`exam-detail-view` の card/table 分岐は不変。
- 全 read は `user_id` scope 維持(本 sprint は純 UI ゆえ write/query 経路に触れない)。
- Test: Vitest + RTL。AI/課金は非該当。`git commit --no-verify` / `-n` 全面禁止。

---

## 3. 確定した設計判断(OT 承認 + cross-check 済)

### 3.1 核実装 = className 合成の `cn` 統一
**現状(現物確認)**: `InlineTextField`(`inline-text-field.tsx`)の `sharedBoxChrome`(:236 `block w-full min-h-11 rounded-md p-2 md:min-h-8 md:py-1`)を、**display パスは素の `<div>` にテンプレート結合**(:286-288 `${sharedBoxChrome} … ${displayClassName ?? ''}`、`cn`/twMerge なし)、**edit パスは Textarea/Input primitive 内部の `cn` 経由**(:260/:268)で当てている。→ 外部 className の上書きが**非対称**(focus は twMerge で効く・非focus は `p-2` と外部 `py-*` が両残りで CSS ソース順依存=不確実)。
**Edit-3**: `InlineTextField` / `InlineOptionCell` の**全レンダーパス(span/textarea/input/wrapper)を `cn(clsx+twMerge)` に統一**し、外部 className を最後に合成(`cn(base, variant, className)`)。これで table 側が className で **padding / font / min-h を確実に上書き**できる。**density prop は足さない**。これが 1・4 共通の根本修正。

### 3.2 4 点スコープ
1. **全セル padding 極小化**: **table 専用層は直接削る**(td/th `px-3 py-2`、`CompactOptionsCell` の `space-y-1` / box `p-1.5` / `mt-0.5` 等)。**共有層**(`InlineTextField`/`InlineOptionCell` の `sharedBoxChrome` = `min-h-8`/`min-h-11`/`py-1`)は §3.1 の `cn` 統一後に **table 側 className で詰める**。重積の核 = 1 選択肢が box `p-1.5` + 本文 cell `min-h-8` + 解説 cell `min-h-8` で縦肥大。
2. **sticky を select + title の 2 列に**: 現 pin は title のみ(`meta.sticky`)で th/td に `left-0` ハードコード。**select 列に `meta.sticky` 追加 + left offset 積み上げ**(select=`left-0` / title=`left-44px`、select 幅固定 44 ゆえ固定値で足る)。`left-0` ハードコードを**列ごと動的 left** へ。
3. **title 初期幅 ~80px(4文字相当、resize 維持)+ sort_key を columnVisibility 既定 hidden**: フラグ判定を作らず**最初から hidden** で素直に実装。**列 toggle UI から再表示できることは維持**。
4. **問題文 focus/非focus フォント統一**: 非focus span は table root `text-sm` 継承・focus textarea は primitive `text-base` ベタ書きで切替時に文字ジャンプ + 非focus 下端余白。**table 列に `displayClassName="text-sm …"` 付与**(card-view は既に一致済ゆえ無影響)。`cn` 統一の結果 textarea の `text-base` が正しく上書きされ 1 と同じ根本修正に乗る。

### 3.3 共有部品回帰 gate(T2)
`InlineTextField`/`InlineOptionCell` は card-view と共有 → **consumer test 網羅**(`inline-card-list` / `inline-option-row`)+ **card-view の見た目が意図外に変わらないことを実機 smoke でスクショ確認**。display↔edit の box 寸法一致(layout shift 防止)を**両モード同時変更で維持**。GPT 指摘 = card-view が「内部 `p-2` と外部 `py-*` の両残り(未定義挙動)」に偶然依存していた場合に見た目が変わりうる(未定義挙動ゆえ直すべきだが、**変化が出ないことを smoke で確認**)。

---

## 4. スコープ

### 4.1 IN(task 目安。境界は plan で確定)
- **T1** table 専用 padding 削減(td/th・CompactOptionsCell 層)+ 問題文 `displayClassName` 付与(table 専用・card-view 無影響)。
- **T2** 共有部品 `cn` 統一(全パス cn 化 + table 側 className で min-h/padding 詰め)。card-view 回帰 gate 必須・最重量。
- **T3** sticky 2列(select `meta.sticky` + 動的 left offset)。
- **T4** title 幅 ~80px + sort_key default hidden。

### 4.2 OUT(やらないこと)
- **新 dep / inline 編集ライブラリ / ProseMirror・Tiptap / 部品複製**(cross-check で不採用)。
- **density / variant prop**(`cn` 統一で済ます。cva preset は将来「直してから必要なら」)。
- **sort_key hidden のフラグ判定**(新規/既存/v1/全表示 v2 区別を作らない)。
- **tag セルのバッジ内部の見た目変更**(td 行高は全列一律 padding で詰まるが許容)。
- **write / query 経路・他機能**への変更。card-view の見た目変更(回帰させない)。

---

## 5. テスト方針(概要・詳細は plan)
- **T1**: RTL で td/th・CompactOptionsCell 層の削減 class assertion + 問題文 cell に `displayClassName` が渡ること。
- **T2**: `cn` 統一後に外部 className が display/edit 両方で上書きできる unit + **card-view 回帰**(`inline-card-list`/`inline-option-row` consumer test 全 green)。
- **T3**: select/title 両 sticky class + 動的 left offset の付与 assertion。
- **T4**: title size ~80 + sort_key 初期 hidden + toggle UI に sort_key 列挙(再表示可)。
- **実機 smoke が唯一の表面化手段**(build/typecheck/RTL 不可、sprint 末 stg): sticky 2列が横スクロールで残るか・title resize で offset ずれ・select hover 色消失 / padding 削減後の実行高・tap target・layout shift / フォント統一後の文字ジャンプ無し・非focus 下端余白消失・mobile 1 行時の両モード一致 / title 80px で input 破綻なし / **card-view スクショ差分(T2)**。
- Sprint gate: whole-repo `pnpm lint --max-warnings=0` exit 0(報告1行)+ `pnpm typecheck` exit 0 + sprint 末 stg smoke。

---

## 6. 受け入れ基準(Done)
- table の縦密度が Notion 基準(外 1 層 8px・入れ子の重複 padding/min-h 解消)に寄り、行高が実測で縮む。
- 横スクロールで select+title が 2 列まとめて左固定。title 幅 ~80px(resize 可)、sort_key 既定非表示(toggle で再表示可)。
- 問題文セルの focus/非focus で文字ジャンプ・下端余白なし。
- **card-view の見た目不変**(スクショ差分なし)。全 feat task が canonical + Codex 両 Critical/Important 0 → `[reviewed]`。

---

## 7. 中間 stop checkpoint(T1 後)
**T1 完了で一旦 stop**。OT が密度を実機で見て **T2(共有部品 cn 統一)の要否を判断**する(T1 の table 専用削減だけで十分詰まれば、最リスキーな共有変更=T2 を回避できる = 中間 smoke の正しい使い所)。T3/T4 は padding と独立ゆえ並行可。

---

## 8. Open Questions(OT 判断待ち)
1. **td `py-2`→`py-1` の全列一律適用**: tag 列(対象外)の td 行高も一律で詰まる。これを許容で確定か(バッジ内部は不変)。
2. **共有 `min-h-8`/`min-h-11`(tap target)を table で詰める下限**: WCAG 44px 推奨に対し table 密度をどこまで下げるか(min-h を外すか縮めるか)。T2 着手前に目標行高を OT が指定するか実装裁量か。
3. **title「4文字相当」の px**: spec 既定 ~80px(14px×4 + padding)で固定可か、実機調整前提で T4 裁量か。
