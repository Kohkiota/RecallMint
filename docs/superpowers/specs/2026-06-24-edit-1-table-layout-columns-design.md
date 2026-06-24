# Edit-1: 試験詳細テーブルのレイアウト解放 + 全列追加

- 作成: 2026-06-24
- シリーズ: 編集ビュー再構築 (Edit-1)
- 種別: spec (design record)。plan は本 spec review 後に別途。
- 前提調査: 編集ビュー再構築 fact-finding 報告 (構造系は再調査不要、本 spec の起点)

---

## 1. 目的とゴール

試験詳細 (`/app/exams/[id]`) のテーブルビューを Notion DB 風に進化させる第一歩。

1. **左右の巨大余白を撤廃**し、テーブルビューを画面幅まで解放する。
2. 解放によって**横スクロールを実発火**させる (現状 `overflow-x-auto` は存在するが死んでいる)。
3. 横スクロールの実機検証ができるよう、**カードビューの全項目をテーブル列として追加**する。
4. 各列は**固定幅 + ユーザーのドラッグ resize** モデル (伸縮 fill ではなく、固定幅多数 + 横スクロール)。

カードビューは温存 (無改変)。app-header は無改変。

---

## 2. 全体ルール (各 task 共通、冒頭一度)

- 型: TypeScript strict。命名既定 (file kebab / Component PascalCase / 関数 camelCase / 定数 UPPER_SNAKE)。
- owner-scope 不変: 全 read は `WHERE user_id = ?` 相当 (既存の useLiveQuery filter を踏襲)。
- **カードビュー (InlineCardList) は無改変**: card view の挙動・見た目を一切変えない。回帰させない。
- **書込経路は新設しない**: 編集系 cell は既存 `InlineTextField` をそのまま使い、書込は内部 `runOptimisticUpdate` (mirror 直書き + outbox enqueue) に委ねる。親からの mutation wiring は持たせない。
- **追加 join 禁止**: 全列データは `row.original.card` (ClientCard) から取得する。新規 join store は足さない。
- Tailwind v4 / 一貫した世界観 (テンプレ AI デザイン回避)。
- mobile 実機 view (DevTools) 検証必須。

---

## 3. 確定した設計判断 (Step 0 実コード確認に基づく)

### 3.1 OT open Q の確定 (推奨どおり)

1. **問題文列 = 中身無改変 + sticky pin を title へ移設** (open Q1 微修正で確定)。
   - **問題文の中身は無改変**: read-only / `line-clamp-2` / `sortLikeServer` ヘッダソート (連番順、# 列削除の代替) をそのまま保持する。問題文の editable 化は選択肢編集 sprint と同時に行う (本 sprint では editable 化しない)。
   - **sticky-left pin だけを問題文 → title へ移設**: `meta.sticky` 相当の pin 指定を問題文列から外し、新規 title 列に付与する。問題文は非 pin の通常列 (位置は §4.2 で sort_key の後) になる。
   - 根拠 (なぜ問題文を editable にせず title を pin にするか): `InlineTextField` で問題文を editable 化すると multiline textarea の auto-resize (`useLayoutEffect` scrollHeight 追従) + `line-clamp-2` が固定幅 + sticky セル内で衝突するリスクが高い。一方 **title は単一行 (`multiline` 無)** で auto-resize 概念がなく、clamp も元々持たないため、pin + editable の共存リスクが低い (Step 0 §3.2 で確認)。
   - `sortLikeServer` ヘッダソートは問題文列ヘッダに残す (中身無改変)。新規 sort_key 列への sort 付与は本 sprint では行わない (OUT、必要なら後続)。

2. **column resize 幅 = 非永続** (リロードで初期固定幅にリセット)。
   根拠: `examViewPrefs` の現 schema は `{ version: 1, view }` の `.strict()`。列関連 schema 拡張は Edit-3 (columnVisibility) と束ねる。初期固定幅の後調整は code 定数側で行う前提のため、永続化は本 sprint で必須ではない。`columnFilters` が既に非永続の前例。

3. **幅分岐の所有 = ExamDetailView + page.tsx** (詳細 §3.3)。

### 3.2 Step 0 で判明した新規事実 (brief からの差分)

- **`#` 列は存在しない**。Grid-2 T2 で削除済 (`exam-card-table-columns.tsx` コメント明記、現 column id は `select/question/tags/lastCorrect/currentStreak/lastReview` の 6 本のみ)。連番順ソートは問題文ヘッダクリックが代替で担う。→ brief の「既存維持: # 列」は誤認。**`#` 列は追加しない**。
- **loading.tsx / error.tsx も波及スコープ IN**。`<main>` から max-w を外すと各 route の `loading.tsx` (skeleton) / `error.tsx` も full-width 化し、ロード中に全幅 skeleton のチラつきが出る。→ これらにも per-page と同じラッパを当てる (§5 影響範囲)。
- **title の pin + editable 共存 = 可 (open Q1 微修正の Step 0 根拠)**。title の `InlineTextField` は card view で `multiline` 無 = 単一行 `Input` を render する (auto-resize textarea ではない)。`Input` は `bg-transparent` のため、sticky-left の `<td>` (`bg-background`) 内に置くとセルが scrolled 下層に対し不透明を保つ (underlay 成立)。display mode は `whitespace-pre-wrap break-words` (clamp 不在) で、固定幅セルでは長い title が複数行に折り返し行高が可変になる (Notion 風テーブルとして許容)。→ title を pin + editable にしても問題文のような multiline/clamp の衝突は起きない。

### 3.3 試験詳細 page の幅分岐 (open Q3 確定)

`exams/[id]/page.tsx` 外側は full-width とし、capped を**要素単位**で付与する:

| 要素 | 幅 | 所有 file |
| --- | --- | --- |
| 戻りリンク + header (h1 + 作成/更新メタ) | `max-w-4xl mx-auto px-4` (capped) | `page.tsx` |
| ViewToggle (カード / テーブル切替) | capped | `ExamDetailView` |
| カードビュー (InlineCardList) | capped (= 従来どおり) | `ExamDetailView` |
| **テーブルビュー (ExamCardTable)** | **full-width / 最小左右 padding** | `ExamDetailView` |

→ 幅分岐の owner は `ExamDetailView` (`view` state を持つため card/table の幅を出し分けられる) と `page.tsx` (自身の header を cap)。`ExamCardTablePullGate` 等の非表示要素は幅に無関係。

> テーブル内の sticky-left pin は **title 列** に付与する (§3.1-1 で問題文から移設)。pin はセル単位の CSS であり、本 §3.3 の page/view レベル幅分岐とは独立。

---

## 4. スコープ

### 4.1 IN

**T-A 幅移設 (max-w-4xl 移設方式)**
- 共有 layout `app/(app)/app/layout.tsx:73` の `<main>` から `max-w-4xl mx-auto px-4 py-8` を撤去し `flex-1 w-full` 相当に。
- (app) 配下の各 page (+ loading/error) が自前で `max-w-4xl mx-auto px-4 py-8` 相当のラッパを持ち、従来の見た目を維持する。
- 試験詳細だけは §3.3 の view 分岐 (header/toggle/card view = capped、table view = full-width)。
- app-header (`:23` の max-w-4xl) は無改変。

**T-B テーブル列幅モデル + resize**
- `exam-card-table.tsx:273` の `<table className="w-full ...">` から `w-full` を撤廃し、列幅合計モデルへ。
- 各列に TanStack `column.size` で固定初期幅を与える (問題文広め / sort_key・指標系狭め / text 系中程度の常識配分。具体値は code 定数、resize で後調整前提)。列幅合計 > viewport で既存 `:272 overflow-x-auto` が発火。
- `enableColumnResizing: true` + render 側で `header.getSize()` / `cell.column.getSize()` を `style={{ width }}` に反映 (現 render は width 未反映 = 追加配線)。
- resize handle を th に追加 (`header.getResizeHandler()`、`columnResizeMode` は 'onChange' 想定、plan で確定)。
- resize は sticky-left pin 列と共存させる (handle は th 内絶対配置、別軸)。

**T-C 列追加 (カードビュー全項目を列化)**
- 新規・編集可 (InlineTextField を cell に drop): `title` / `sort_key` / 解説 `explanation_text` / メモ `memo`。
- 新規・read-only 表示のみ: 選択肢 `options` (正解ハイライト)。**新規の軽量 read-only 表示部品**を新設 (commit/working-set ロジックは持ち込まない)。
- 既存維持: `select` / 問題文 (中身無改変・本 sprint で pin を喪失し非 pin 通常列へ、§3.1-1) / タグ (TagCell) / 直近正誤 / 連続正解数 / 最終回答日時。
- sticky-left pin は title 列へ移設 (§3.1-1 / §4.2)。
- データは全て `row.original.card` から (追加 join なし)。

**T-D sticky header (推奨採用)**
- thead の th に `sticky top-0 z-10 bg-background`。
- 左 pin (`left-0`、本 sprint で title 列へ移設) と上 pin (`top-0` 新規) は別軸、角セル (select th / title th) は両軸付与。
- `border-collapse` + sticky の border 落ち癖に注意 (bg-background + border 処理を plan で詰める)。

### 4.2 列構成 (最終確定)

```
select / title(sticky pin・編集) / sort_key(編集) / 問題文(read-only・無改変) /
選択肢(read-only新規) / タグ(TagCell既存) / 解説(編集) / メモ(編集) /
直近正誤 / 連続正解数 / 最終回答日時
```

- 編集系 4 列 (title / sort_key / 解説 / メモ) = `InlineTextField`、書込は内部 runOptimisticUpdate (単票編集と同一経路、親 wiring 不要)。
- **sticky-left pin = title 列** (select の直後・最左の固定列)。問題文から移設 (§3.1-1)。
- 問題文 = 非 pin の read-only 通常列。中身 (clamp / sortLikeServer ヘッダソート) は無改変。
- 角セル (select th / title th) は left+top 両軸 sticky (§4.1 T-D)。
- `#` 列は追加しない (§3.2)。

### 4.3 OUT (今回入れない)

- **選択肢の inline 編集** (新規 editable compact cell + InlineOptionList の commit/working-set 切り出し) → 次 sprint。今回 選択肢は read-only 表示のみ。
- **columnVisibility / 列の表示非表示** → Edit-3。
- **side peek** → Edit-4。
- **app-header の改変**。
- **column resize 幅の永続化** (§3.1-2)。
- **問題文列の editable 化** (§3.1-1)。

---

## 5. 影響範囲

max-w-4xl 移設は全 (app) page に波及する。

**page.tsx (10件)**: `app/(app)/app/page.tsx` / `exams/page.tsx` / `exams/[id]/page.tsx` (特殊・view 分岐) / `settings/page.tsx` / `study/custom/page.tsx` / `study/smart/page.tsx` / `tags/page.tsx` / `upgrade/page.tsx` / `upload/page.tsx` / `upload/result/[sourceDocumentId]/page.tsx`

**loading.tsx (7件)**: `exams/[id]/loading.tsx` / `exams/loading.tsx` / `app/loading.tsx` / `settings/loading.tsx` / `study/custom/loading.tsx` / `study/smart/loading.tsx` / `tags/loading.tsx`

**error.tsx (1件)**: `app/(app)/app/error.tsx`

**テーブル系**: `layout.tsx` / `exam-detail-view.tsx` / `exam-card-table.tsx` / `exam-card-table-columns.tsx` / 新規 read-only 選択肢表示部品。

> 注: loading.tsx を持たない route (upload / upgrade / study root 等) は skeleton 非表示のままで問題なし。error.tsx は segment 共通の root 1 枚で全 (app) を覆う。

---

## 6. 完了条件

- テーブルビューが画面幅まで解放され、左右巨大余白が消えている (mobile / desktop)。
- 列幅合計 > viewport で横スクロールが**実発火**する。
- ユーザーが列境界をドラッグして幅変更できる (resize handle 動作)。
- 新規 5 列 (title / sort_key / 解説 / メモ / 選択肢) が表示される。編集系 4 列は cell クリックで InlineTextField 編集 → mirror + outbox に反映 (単票編集と同挙動)。選択肢列は read-only で正解ハイライト表示。
- カードビューは見た目・挙動とも無改変 (回帰なし)。
- 全 (app) page (+ loading/error) が従来の見た目を維持 (max-w-4xl 中央寄せ、レイアウト崩れなし)。
- sticky header / sticky-left pin が固定幅 + 横スクロール下で共存動作。
- canonical code review で Critical 0、commit に [reviewed]。
- whole-repo `pnpm lint` (--max-warnings=0) exit 0。

---

## 7. 検証スコープ

- **canonical code review**: `superpowers:requesting-code-review` skill 経路 (skill template + general-purpose subagent + 厳格 prompt、改変なし)。観点に whole-repo lint 実行確認を含める。
- **stg smoke (push 後、OT 指示で CC が DevTools MCP 実走)**:
  - 全 (app) page (10 page) のレイアウト崩れ確認 (max-w-4xl 移設の回帰チェック)。
  - 試験詳細の 2 view (テーブル = full-width / カード = capped) + loading/error の幅。
  - テーブル横スクロールの実発火、列 resize ドラッグ、sticky header / 左 pin。
  - 編集系列の inline 編集 → mirror 反映、選択肢 read-only 表示。
- whole-repo lint exit 0 を完了報告に 1 行明記。

> Next 設定 file (matcher / proxy.ts / next.config.*) は触らないため、per-task の `pnpm build` gate は本 sprint では不要 (依存/Next/Node/lockfile 不変)。ただし layout/page の TSX 大量改修のため、完了 gate で `pnpm typecheck` を回す (plan で確定)。
