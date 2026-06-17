# Grid-2 設計: 試験詳細テーブルビューのフィルタ + ソート + 一括操作 (タグ付与/除去/削除) + 指標列

- 日付: 2026-06-17
- 対象 sprint: Grid-2 (Grid-1 の後続。Grid-2.5 / Grid-3 とは別 sprint)
- 種別: feat (UI 機能追加 + bulk mutation wiring + seed オプション追加)
- 前提 fact-finding: 2026-06-17 調査 (A. bulk 土台 / B. 削除経路 / C. フィルタ・ソートデータ経路 / D. seed 回答記録)。本 spec はその結論を前提として扱う。

## 1. 目的

Grid-1 で導入した試験詳細のテーブルビュー (`/app/exams/[id]` の table view) に、**フィルタ + ソート + 一括操作 (タグ付与 / タグ除去 / 削除) + 指標列表示** を追加する。

実現する体験は「**絞り込み → 全選択 → 一括タグ操作 / 一括削除**」。これにより S2.3 カスタム演習の「タグ絞り込み前提」を提供する。

Grid-1 の table 基盤 (`ExamCardTable` / `ExamCardRow` / `getRowId=card.id` / selection state / module スコープ columns) を**土台にして拡張**する。置き換えではない。既存カードビュー (`InlineCardList`) は温存する。

## 2. スコープ (in)

### 2.1 指標列 (表示のみ)

- 直近正誤 (`last_correct`: true / false / null)、連続正解数 (`current_streak`)、最終回答日時 (`last_review`) を列として表示する。
- **read-only 表示**。inline 編集はしない (編集は Grid-2.5)。
- 未回答カードは `last_correct=null` / `current_streak=0` / `last_review=null` / `answered=false` (回答フローが書き込み済み = scheduler stub ではない。fact-finding D 確認)。表示は「未回答」を識別できる形にする (例: 直近正誤 null = 「—」/ 最終回答 null = 「未回答」)。

### 2.2 ソート (ヘッダーから)

- ソート対象: **sortKey (連番) / 直近正誤 / 連続正解数 / 最終回答日時**。
- **タグはソート対象外** (1 card に複数 tag が付き、スカラー projection が無いため。fact-finding C-10 確認。tag はフィルタのみ)。
- TanStack Table の **sorting model を配線** (現状 `getCoreRowModel` のみ、全列 `enableSorting:false`)。`getSortedRowModel` を追加し、対象列の `enableSorting:true`。

### 2.3 フィルタ

- **tag フィルタ**: カテゴリ → option の段階選択 (既存タグ操作 UI と体験を揃える)。デフォルト結合は **「カテゴリ内 OR / カテゴリ間 AND」** (例: 重要度=高 OR 低、かつ 分野=数学)。評価は `row.tags.some(t => t.category.id===X && t.option.id===Y)` ベース (fact-finding C-10 で実装可確認)。
- **回答状態フィルタ**: 回答済み (`answered=true`) / 未回答 (`answered=false`) / 正誤 (`last_correct` true / false / null)。
- **数値比較フィルタ**: 連続正解数の比較 (≤ 等)。TanStack の `filterFn` をカスタムで実装。
- フィルタ / ソート状態は **セッション限定 (永続化しない)**。`examViewPrefs` には保存しない。リロードで初期化。理由 = フィルタは一時的な絞り込みであり、保存すると前回の絞り込みが残って「全件見えない」事故になりやすい。

### 2.4 一括操作 + アクションバー

- **multi-select**: チェックボックスで複数選択。チェックボックスは**常時表示** (Grid-1 と同じ。hover 出現は Grid-2 でも採用しない)。
- **全選択**: 「絞り込み → 全選択 → 一括操作」が中核フローのため、全選択は **現在フィルタ適用後の可視行を対象** とする (TanStack の filtered row model 基準。フィルタで隠れた行は選択しない)。§7.3 で確定。
- 選択時のみ下部に **floating アクションバー** (「N件選択中」 + [タグ付与] [タグ除去] [削除])。
- **一括タグ付与 / 除去**: 選択 N card に対し per-card で tag-set を計算 → `runOptimisticMutation` を **1 回呼ぶ** (`mutate` で全 card_tags 書込、`mutations` に N 件の `update_field`) → **1 tx + 1 flush**。単票 `useCardTagToggle` の N ループは使わない (N tx / N flush になるため。fact-finding A-2 確認)。**bulk タグ helper を新設**。
- **一括削除**: `runOptimisticMutation` に `cards.bulkDelete(ids)` + N 件 tombstone を wiring → **1 tx で N 物理削除 + N tombstone enqueue**。card ごとに **distinct mutation_id 必須** (payload 内 mutation_id 重複は server 400)。**bulk 削除 helper を新設**。
- 一括削除には**確認ダイアログ**(「N件を削除しますか?」)を挟む (事故防止)。
- **selection の維持 / 解除**: タグ付与 / 除去 (属性変更系) の後は selection を**維持**。削除の後は削除行が消えるため selection から**外す** (= 残存行のみ selection 維持、削除された id は drop)。
- **bulk 失敗時 UI**: flush 後に `failed[]` が返ったら「N件中 M件成功、K件失敗 (再試行されます)」を表示。失敗分は pending 据置で次 flush 再送 (fact-finding A-4 / B-7 どおり冪等で安全)。

### 2.5 検証用 seed

- `seed-perf-exam.ts` に「一部カードに回答記録を投入する」オプションを足す (指標列・回答状態フィルタを stg で目視検証するため。現状の seed 300 件は全件「未回答」で検証不能)。
- **方式 = (b) cards 指標列を直接 synthetic UPDATE** (`answered` / `last_correct` / `current_streak` / `last_review` を適当な分布で書く)。Grid-2 が読むのは cards 列のみ (grid は `answer_events` を参照しない。fact-finding D 確認) ため (b) で十分。リアル FSRS replay (a) は不要。
- 既存 `--cleanup` の cascade で完結する範囲に閉じる (`study_days` は書かない = skip。`study_days` は cards/exams への FK が無く cascade されないため。fact-finding D 確認)。

## 3. スコープ外 (Grid-2 では扱わない)

以下は本 spec が**意図的に除外**する。DoD にも判定基準を入れない。

- 選択肢列 / 選択肢編集 / 正解切替 (Grid-2.5)。
- 解説・メモの inline 編集 (Grid-2.5)。
- 指標列の inline 編集 (Grid-2.5。Grid-2 は read-only 表示のみ)。
- **タグのソート** (データ構造上スカラー projection が無いため。フィルタのみ)。
- フィルタ / ソート状態の**永続化** (セッション限定)。
- 試験間移動 (Grid-3)。
- FSRS の due / stability 等の表示 (S2.1)。
- 検索ボックス式の tag フィルタ (将来 option が増えたら検討。Grid-2 は段階選択)。
- 列幅 (`columnSizing`) / 表示列 (`columnVisibility`) の永続化。
- 仮想化 (数百件、Grid-1 と同じ理由で不要)。
- 日付範囲フィルタ (`last_review` の範囲指定)。Grid-2 の数値比較は **連続正解数のみ**。

## 4. アーキテクチャ

### 4.1 ファイル境界 (新規 / 改修)

`/app/(app)/app/exams/[id]/_components/` 配下:

- `exam-card-table.tsx` — **改修**。フィルタ / ソート state の保持、`getFilteredRowModel` / `getSortedRowModel` の配線、アクションバーの出し分け。useLiveQuery の join で row に指標 field を載せる (§4.4)。
- `exam-card-table-columns.tsx` — **改修**。指標列 (直近正誤 / 連続正解数 / 最終回答日時) の column def 追加、対象列の `enableSorting:true` + `sortingFn`、tag 列に filter 用 `filterFn` を付与。module スコープ維持。
- `exam-card-table-action-bar.tsx` — **新規**。floating アクションバー UI (N件選択中 + 3 ボタン)。配置は §13 OQ-3。
- `exam-card-table-filter-bar.tsx` — **新規**。フィルタ UI (tag 段階選択 / 回答状態 / 数値比較)。tag フィルタ UI の実現方式は §13 OQ-1。
- `exam-card-bulk-delete-dialog.tsx` — **新規**。一括削除確認ダイアログ (「N件を削除しますか?」)。

`/app/(app)/app/exams/[id]/_hooks/` 配下:

- `use-bulk-card-tags.ts` — **新規**。選択 N card に対する一括タグ付与 / 除去 helper。per-card tag-set 計算 → `runOptimisticMutation` 1 回呼び。tag-set 計算ロジックの配置は §13 OQ-8。
- `use-bulk-card-delete.ts` — **新規**。選択 N card の一括削除 helper。`runOptimisticMutation` に `cards.bulkDelete` + N tombstone を wiring。distinct mutation_id を各 card で生成。

`lib/sync/` 配下:

- **改修なし想定**。`runOptimisticMutation` (`optimistic-mutation.ts:72`) / `enqueueEntityMutation` (`entity-mutations.ts:69`) / flush (`entity-mutations.ts:254` + `entity-mutation-flush.ts:41`) はそのまま流用。新 tx primitive を作らない (fact-finding A-1 確認)。新規ロジックが lib/sync 側に必要と判明したら plan で停止して OT 相談。

`scripts/seed-perf-exam.ts`:

- **改修**。`--with-answers[=ratio]` 相当のオプションを追加し、一部 card の指標列を synthetic UPDATE (§2.5 / §11)。

### 4.2 既存を壊さない境界 (regression gate)

- bulk helper は **`runOptimisticMutation` (既存・Y-1 prod 済) を流用**する wiring 中心。canonical 経路を 2 本に増やさない。
- 単票タグ操作 (`useCardTagToggle` / `CardTagsSection` / `CardTagOptionList` / `CardTagAddPopover`) の挙動を**侵食しない**。bulk helper は単票 hook を呼ばず、`runOptimisticMutation` を直接呼ぶ独立経路だが、enqueue する mutation の **shape (`card` / `update_field` / `patch.field='tag_option_ids'`) は単票と同一** にする (server registry / coalesce / pull 適用を共有するため)。
- 単票削除 (`DeleteCardButton` → `runOptimisticMutation` → `card` / `delete`。`delete-card-button.tsx:25-61`) の挙動を**不変**に保つ。bulk 削除は同じ mutation shape を N 件束ねた形にする。
- 既存カードビュー (`InlineCardList`) のタグ / 削除 / inline 編集挙動を**不変**に保つ。
- Grid-1 で確立した table の参照安定性 (§4.3) / `getRowId=card.id` / flat array join を**維持**する。

### 4.3 React Compiler OFF 前提での参照安定性 (Grid-1 から継続)

React Compiler は OFF 維持。filter / sort state を追加しても TanStack の `columns` / `data` / `state` の参照安定性を崩さない:

- `columns`: module スコープ維持 (指標列 / sortingFn / filterFn も module スコープの column def 内に閉じる)。
- `data`: useLiveQuery 戻り値の派生を `useMemo` で安定化 (§4.4 の row data-shape 変更後も deps が同じなら同じ ref)。
- `state`: `rowSelection` に加え `sorting` / `columnFilters` (または独自 filter state) を `useReactTable` の `state` に渡し、setter を `useCallback` 安定化。

### 4.4 row data-shape の変更 (指標 field を載せる)

現状の `ExamCardRow.card` は `toExamDetailCard` (`inline-card-list.tsx:47-57`) で間引かれ、`current_streak` / `last_correct` / `last_review` / `answered` が**載っていない** (fact-finding C-8/C-9 確認)。これらは元の `ClientCard` (`filteredCards`) には materialize 済みだが row まで届いていない。

- Grid-2 では join (`exam-card-table.tsx:76-93` 相当) を改修し、**raw ClientCard (または指標 field) を row に載せる**。これにより数値比較 filterFn / 回答状態 filterFn / 指標列 cell renderer が field を参照できる。
- **Dexie schema / pull 経路は変更不要** (field は既に client 側に存在)。新規 fetch 経路を増やさない。
- 形は §13 OQ-7 (ExamCardRow.card を full ClientCard 化 / 指標 field を並列に持たせる)。

## 5. 指標列の表示ルール

- **直近正誤**: `last_correct===true` → 正 (○ 等) / `false` → 誤 (× 等) / `null` → 「—」(未回答)。
- **連続正解数**: `current_streak` (整数)。未回答は 0。
- **最終回答日時**: `last_review` (ISO string) を JST で表示。`null` → 「未回答」。表示粒度 (日付のみ / 相対表現) は実装時に視覚調整。
- 列の並び順・幅は Grid-1 の既存列 (checkbox / # / 問題文 / タグ) の後ろに追加する想定。具体配置は実装時 (columnVisibility 永続化はしないので固定列順)。

## 6. ソートのデータ経路

- TanStack `getSortedRowModel` を配線。対象列 (sortKey / 直近正誤 / 連続正解数 / 最終回答日時) に `enableSorting:true`。
- **null の扱いを明示**: 連続正解数は数値。直近正誤 / 最終回答日時は null を含むため、`sortingFn` で **null を末尾に固定** (Grid-1 の `sortLikeServer` NULLS-LAST 慣習と整合)。直近正誤の順序定義 (false < true か、null をどちらに寄せるか) は実装時に確定するが、null は常に末尾。
- ソートはクライアント側評価 (useLiveQuery で読んだ flat 配列に対する TanStack sorting)。新規 fetch を増やさない。
- 初期ソート: Grid-1 の `sortLikeServer` 相当 (sortKey 昇順) を初期 state とする。ヘッダークリックで上書き、リロードで初期化 (非永続)。

## 7. フィルタ + selection の相互作用

### 7.1 フィルタのデータ経路

- TanStack `getFilteredRowModel` を配線。3 種のフィルタを `columnFilters` (または独自 filter state) で保持。
- **tag フィルタ**: カテゴリ内 OR / カテゴリ間 AND。filter 値の形は `{ [categoryId]: optionId[] }` のような map。評価 = 各カテゴリについて `row.tags.some(option ∈ 選択)` を AND 結合。
- **回答状態フィルタ**: `answered` / `last_correct` を見る単一 axis。未回答 (`answered=false`) は `last_correct=null` と等価 (fact-finding D)。UI 上の axis 分割は §13 OQ-9。
- **数値比較フィルタ**: `current_streak` に対する比較 (≤ N 等)。カスタム `filterFn`。
- すべてクライアント側評価 (新規 fetch なし)。

### 7.2 フィルタ × ソートの順序

- TanStack の標準パイプライン (core → filtered → sorted) に乗せる。フィルタ適用後の行集合に対してソートが効く。

### 7.3 全選択のスコープ (確定)

- 全選択 = **フィルタ適用後の可視行のみ**を対象とする (TanStack の filtered row model 基準)。フィルタで隠れた行は全選択に含めない。
- 理由: 中核フローが「絞り込み → 全選択 → 一括操作」であり、隠れ行まで一括操作されると事故になる。
- 実装: TanStack の `getIsAllRowsSelected` / `toggleAllRowsSelected` は `getFilteredRowModel` 配線時に filtered 行基準で動く。これを用いる (page-row ではなく filtered all-row)。

### 7.4 selection の維持 / 解除 (確定)

- **タグ付与 / 除去後**: selection を**維持**。`getRowId=card.id` のため、optimistic 反映で row data が変わっても selection key は安定。
- **削除後**: 削除された card.id を selection から**除外** (残存行のみ維持)。物理削除で row が消えるため、消えた id を残すと幽霊選択になる。
- **フィルタ変更時**: 既存 selection はそのまま保持するが、フィルタで隠れた行の selection を「見えないまま一括操作」に含めない設計上の懸念がある → §13 OQ-6 で扱う (隠れ選択行の扱い)。

## 8. 一括書き込みの atomic 設計

### 8.1 一括タグ付与 / 除去 (`use-bulk-card-tags.ts`)

- 入力: 選択 card id 群 + 対象 (categoryId, optionId) + 操作種別 (付与 / 除去)。
- per-card で **次 tag-set を計算** (現 `card_tags` から該当 option を add / remove した結果)。既存 `buildNextTagSet` (`use-card-tag-toggle.ts:86` 相当) のロジックを再利用 (配置は §13 OQ-8)。
- `runOptimisticMutation` を **1 回**呼ぶ:
  - `stores`: `[db.card_tags, db.entity_mutations]`
  - `mutate`: 全 card 分の `card_tags` put / delete を 1 tx 内で実行
  - `mutations`: N 件の `{ entity_type:'card', entity_id:<cardId>, op:'update_field', patch:{ field:'tag_option_ids', value:<next> } }`
- 結果 = 1 rw tx + 1 flush。server 側は非 cascadeLike の `card.update_field` のため group 並列処理対象 (fact-finding A-4 / T-B3)。
- **混在選択時のセマンティクス** (一部 card が既に該当タグ保持 / 一部未保持) は §13 OQ-5 で確定。

### 8.2 一括削除 (`use-bulk-card-delete.ts`)

- 入力: 選択 card id 群。
- `runOptimisticMutation` を 1 回呼ぶ:
  - `stores`: `[db.cards, db.entity_mutations]` (+任意で `db.card_tags` を client mirror 即時 purge する場合は追加)
  - `mutate`: `db.cards.bulkDelete(ids)` (+任意で `db.card_tags.where('card_id').anyOf(ids).delete()`)
  - `mutations`: N 件の `{ entity_type:'card', entity_id:<cardId>, op:'delete', patch:{} }`、各 **distinct mutation_id**
- 結果 = 1 rw tx で N 物理削除 + N tombstone enqueue。
- client card_tags の cascade は単票同様 **pull 駆動 purge** に委ねるのが既定 (`pull.ts:259-261` が card tombstone から card_tags を purge。fact-finding B-5)。即時 purge するかは §13 OQ-11 寄りの実装判断 (単票と挙動を揃えるなら委ねる)。
- server: `card.delete` は cascadeLike のため bulk route は serial fallback 処理だが冪等 (card 不在で silent return / tombstone onConflictDoNothing)。部分失敗は failed[] → 再送収束 (fact-finding B-7)。
- 確認ダイアログ (`exam-card-bulk-delete-dialog.tsx`) を経由してから実行。

### 8.3 bulk 失敗時の UI

- flush 戻り (または `runOptimisticMutation` の logEvent / throwOnError 経路) から failed 件数を取得し、「N件中 M件成功、K件失敗 (再試行されます)」を表示。
- 失敗分は pending 据置で次 flush 再送 (冪等で安全。fact-finding A-4)。表示手段は §13 OQ-4。

## 9. データ供給 (useLiveQuery 流用)

- Grid-1 同様、table view 配下の **既存 useLiveQuery を流用** (`exam-card-table.tsx:54-93`)。cards + tag_categories + tag_options + card_tags を読み、flat な `ExamCardRow[]` に join。
- §4.4 の data-shape 変更で row に指標 field を載せる以外、**新規 fetch 経路を増やさない**。
- フィルタ / ソートはこの flat 配列に対する TanStack model 評価 (client 側)。
- bulk optimistic 書込は useLiveQuery 経由で同 tick 反映 (card_tags / cards mirror 更新が live data に伝播)。

## 10. perf gate (Grid-1 と同じ枠組み + bulk 観測)

「table が card より速い」は要求しない。以下を満たすこと:

1. **client perf**: 数百件 (目安 300 件) でフィルタ適用 / ソート / 全選択 / 一括操作時に明確な固まり (操作不能・長時間メインスレッドブロック) が無いこと。
2. **resource**: フィルタ / ソート / bulk で RSC / API fetch 数が増えないこと (client 側評価 + 既存 flush 経路)。
3. **bulk**: 300 件全選択 → 一括タグ付与が **1 tx + 1 flush** で完結し、操作不能にならないこと。一括削除も同様。
4. **stg 実測が正本** (jsdom / fake-indexeddb で wall-clock を assert しない)。`stg.recallmint.nekotest.net` で seed 回答記録付き試験を使って実走。

## 11. 検証用 seed (回答記録オプション)

- `seed-perf-exam.ts` に回答記録投入オプションを追加。方式 (b) = cards 指標列を直接 synthetic UPDATE。
- 書く列: `answered=true` / `last_correct` (true/false の分布) / `current_streak` (0..N の分布) / `last_review` (過去日時の分布) / `updated_at=now()` (増分 pull が拾うため)。
- 未回答カードも一定割合残す (フィルタ「未回答」検証のため)。割合は `--with-answers=<ratio>` 等で指定 (デフォルト値は実装時)。
- `answer_events` / `reviews` / `study_days` は**書かない** (grid は cards 列のみ参照。study_days は cascade されず再 seed で蓄積するため特に避ける。fact-finding D)。
- 冪等性: 既存 `--cleanup` が `[PERF-SEED]%` exam を削除 → cards CASCADE で指標列ごと消える。study_days を書かないため leak しない。
- L2 ガード (DATABASE_URL token check) は既存どおり stg/test/dev のみ許可 (本 spec で変更しない)。

## 12. per-task gate

table 系 component は hook を多用するため、各 task の gate に **lint (hook-rules) + typecheck + build** を含める:

- `pnpm lint` (--max-warnings=0) exit 0
- `pnpm typecheck` exit 0
- `pnpm build` exit 0

Sprint 完了 gate (whole-repo lint 等) は CLAUDE.md 既出ルールに従い本 spec で重複定義しない。

## 13. Open Questions と CC 推奨

各 OQ は「案を併記 + CC 推奨を明示」。OT 判断が必要 (◆) / CC 推奨で進める (○) を分ける。

### 13.1 ◆ OQ-1: tag フィルタ UI の実現方式

- 案 A-1 (CC 推奨): **Grid-1 の `CardTagAddPopover` (initialCategoryId / initialStage 資産) を流用**し、選択結果を「付与」ではなく「フィルタ条件」として受け取る adapter を被せる。既存のカテゴリ→option 段階選択 UX をそのまま再現でき、体験を揃えられる。
- 案 A-2: フィルタ専用 UI を新設 (カテゴリごとに option chip を並べ、トグルで選択)。filter 用途に最適化できるが、既存 popover と二重実装になり UX の一貫性が崩れるリスク。
- 案 A-3: カテゴリ単位の dropdown (multi-select) を横並び。実装は軽いが、カテゴリ数が増えると横幅を圧迫。
- **CC 推奨: 案 A-1** — 「既存タグ操作 UI と体験を揃える」brief 制約に最も整合。ただし popover は「付与アクション」前提の責務なので、フィルタ用に「選択 = 即付与しない / 確定で filter state に反映」へ振る舞いを分岐する adapter が要る。流用の境界 (どこまで共有しどこを分岐するか) は plan で確定。

### 13.2 ◆ OQ-2: 数値比較フィルタ (連続正解数) の UI

- 案 N-1 (CC 推奨): **プリセット + 比較演算子付き数値入力** (例: 演算子 select [≤ / = / ≥] + 数値入力)。柔軟かつ実装単純。
- 案 N-2: スライダー (range)。直感的だが上限が動的 (max streak 不定) で UX 設計が難しい。
- 案 N-3: プリセットのみ (「未習得 (streak≤2)」「習得中」「定着 (streak≥5)」等のラベル)。学習文脈で意味が明確だが閾値をプロダクト側で固定する必要。
- **CC 推奨: 案 N-1** — Grid-2 では最小限の汎用フィルタで足り、閾値プリセット (N-3) は学習指標の意味づけが固まってから (将来) でよい。演算子は当面 ≤ のみでも可 (brief「≤ 等」)。

### 13.3 ◆ OQ-3: アクションバーの floating 配置とモバイル

- 案 AB-1 (CC 推奨): **画面下部固定の floating バー** (viewport bottom、選択時のみ slide-in)。table のスクロール位置に依らず常に届く。mobile でも親指圏内。
- 案 AB-2: table 下端に sticky 表示。スクロール文脈に紐づくが、長い table で下端まで行かないと見えない。
- 案 AB-3: table 上部 (フィルタバー隣) に inline 表示。視線移動は少ないが、選択行から遠い。
- **CC 推奨: 案 AB-1** — 「選択 → 即操作」の動線が最短。mobile は下部固定 + 3 ボタンを icon+短ラベルで収める。Grid-1 のチェックボックス常時表示と整合し、選択中だけ出る floating で画面占有を抑える。

### 13.4 ◆ OQ-4: bulk 失敗 UI の具体

- 案 BF-1 (CC 推奨): **トースト通知** (「N件中 K件失敗、再試行されます」)。一時的・非ブロッキングで、再送が背後で走る性質に合う。
- 案 BF-2: アクションバー内インライン表示 (失敗件数バッジ)。selection 文脈に紐づくが、selection を解除すると消える。
- 案 BF-3: 行レベルのエラー表示 (失敗 card にマーカー)。粒度は最高だが実装コスト高。
- **CC 推奨: 案 BF-1** — 失敗は「pending 据置 → 次 flush 再送」で自動収束するため、ユーザー操作を要求しない非ブロッキング通知が適切。トースト基盤が既存にあるか plan で確認 (無ければ最小実装 or BF-2 にフォールバック)。

### 13.5 ◆ OQ-5: 一括タグ付与 / 除去の混在選択時セマンティクス

選択 N card の一部が既に該当タグを保持、一部が未保持の場合の「付与」「除去」の意味。

- 案 TS-1 (CC 推奨): **付与 = 未保持の card にのみ追加 (保持済みは no-op) / 除去 = 保持済みからのみ削除 (未保持は no-op)**。冪等で直感的。アクションバーに [タグ付与] [タグ除去] を別ボタンで持つ brief とも整合 (トグルではなく明示的 add/remove)。
- 案 TS-2: トグル (保持↔未保持を card ごとに反転)。単票 `useCardTagToggle` と同じ挙動だが、混在選択で「半分付いて半分外れる」直感に反する結果になりやすい。
- **CC 推奨: 案 TS-1** — brief のアクションバーが付与 / 除去を分けている時点で「明示的 add / remove」が前提。混在でも結果が予測可能 (付与 = 全 card が保持状態に収束 / 除去 = 全 card が未保持に収束)。tag-set 計算はこの規則で per-card 算出。

### 13.6 ◆ OQ-6: フィルタで隠れた行の selection 扱い

フィルタ変更で、既に選択済みの行がフィルタ外に隠れた場合。

- 案 HS-1 (CC 推奨): **隠れた行の selection は保持するが、一括操作の対象はフィルタ可視行に限定しない (= 選択されている全行を操作対象とする)**。ただし「N件選択中」の N は隠れ行を含むため、アクションバーに「(うち M 件は現在のフィルタ外)」を補足表示。
- 案 HS-2: フィルタ変更時に隠れる行の selection を自動解除。常に「見えている選択 = 操作対象」で安全だが、フィルタを跨いだ選択ができない。
- 案 HS-3: 隠れ行も操作対象、補足表示なし。最小実装だが「見えない行が消える / タグが付く」事故リスク。
- **CC 推奨: 案 HS-1** — 中核フローは「絞り込んでから全選択」なので隠れ選択は稀だが、起きたときに silent に操作するのは危険。保持 + 件数の透明化 (隠れ M 件の明示) で安全と柔軟性を両立。実装が重ければ HS-2 にフォールバック (この場合 spec 改訂注記)。

### 13.7 ○ OQ-7: row data-shape 変更の形

§4.4 で指標 field を row に載せる形。

- 案 DS-1 (CC 推奨): `ExamCardRow.card` を間引き型 (`ExamDetailCard`) から **full `ClientCard`** に変更し、指標 field を含める。filterFn / cell renderer が `row.card.current_streak` で参照可能。
- 案 DS-2: `ExamCardRow` に指標 field を**並列に追加** (`{ card: ExamDetailCard; tags; metrics: { current_streak; last_correct; ... } }`)。既存 `ExamDetailCard` 型を触らず最小差分。
- **CC 推奨: 案 DS-1** — 間引きは Grid-1 の歴史的経緯であり、table view では full ClientCard を持つ方が自然 (Grid-2.5 の inline 編集でも全 field が要る)。ただし `ExamDetailCard` を使う既存箇所への影響を plan で確認 (影響が広ければ DS-2)。

### 13.8 ○ OQ-8: bulk タグ helper の tag-set 計算ロジック配置

- 案 TG-1 (CC 推奨): `use-card-tag-toggle.ts` の `buildNextTagSet` (`:86`) を **module スコープの純関数に切り出し**、単票 hook と bulk helper の両方が import。ロジック 1 箇所。
- 案 TG-2: bulk helper 内に独自実装 (重複)。
- **CC 推奨: 案 TG-1** — DRY かつ単票 / bulk の tag-set 計算が乖離する静かなバグを防ぐ。純関数化は副作用が無く regression リスクが低い。

### 13.9 ◆ OQ-9: 回答状態フィルタと正誤フィルタの UI 統合

未回答 (`answered=false`) は `last_correct=null` と等価。回答済みは正 (`true`) / 誤 (`false`)。

- 案 AS-1 (CC 推奨): **単一の状態 select** (「すべて / 未回答 / 直近正解 / 直近不正解」の 4 値)。answered と last_correct を 1 axis に統合し、ユーザーには 1 つの選択肢として提示。
- 案 AS-2: 2 つの独立フィルタ (回答済み/未回答 の toggle + 正誤 の toggle)。柔軟だが「未回答 かつ 直近正解」のような無意味な組合せが選べてしまう。
- **CC 推奨: 案 AS-1** — 4 値は相互排他で意味が明確、無意味な組合せを構造的に排除できる。複数同時 (例: 「未回答 OR 直近不正解」) が要るなら multi-select 化 (将来)。

### 13.10 ○ OQ-10: filter / sort model の state 管理方式

- 案 SM-1 (CC 推奨): **TanStack 標準の `columnFilters` / `sorting` state** を `useReactTable` の controlled state に乗せる。tag フィルタの複雑な値は単一 column の filterValue (map) として持たせる。
- 案 SM-2: フィルタ state を独自 React state で持ち、filtered 行を `useMemo` で自前計算してから TanStack に渡す。柔軟だが TanStack の row model と二重管理。
- **CC 推奨: 案 SM-1** — TanStack の流儀に乗る方が selection / sorting との統合 (filtered all-row 全選択 §7.3) が素直。tag フィルタの map 値は custom `filterFn` で評価。複雑すぎれば SM-2 を局所採用。

### 13.11 ○ OQ-11: 一括削除確認ダイアログの実装

- 案 CD-1 (CC 推奨): **専用 modal ダイアログ** (`exam-card-bulk-delete-dialog.tsx`、「N件を削除しますか?」+ 確定 / キャンセル)。bulk は影響範囲が大きく、明示的な modal が安全。
- 案 CD-2: 単票 `DeleteCardButton` の 2-phase inline 確認 (idle→confirm) をアクションバーに踏襲。一貫性はあるが、N 件削除の重さに対して inline は軽すぎる。
- **CC 推奨: 案 CD-1** — 一括削除は不可逆かつ広範囲。modal で件数を明示し誤操作を防ぐ。既存の dialog primitive (shadcn 等) があれば流用。

## 14. Definition of Done

完了とみなすには以下を**全て満たす**:

### 14.1 指標列
- [ ] 直近正誤 / 連続正解数 / 最終回答日時の 3 列が read-only 表示される。
- [ ] 未回答カード (`last_correct=null` 等) が識別可能に表示される (「—」/「未回答」)。

### 14.2 ソート
- [ ] sortKey / 直近正誤 / 連続正解数 / 最終回答日時 でヘッダーソートが正しく並ぶ。
- [ ] null を含む列で null が末尾に固定される。
- [ ] タグ列はソート不可 (enableSorting:false 維持)。
- [ ] ソート状態がリロードで初期化される (非永続)。

### 14.3 フィルタ
- [ ] tag フィルタ (カテゴリ内 OR / カテゴリ間 AND) が正しく絞る。
- [ ] 回答状態フィルタ (回答済み / 未回答 / 正誤) が正しく絞る。
- [ ] 数値比較フィルタ (連続正解数 ≤ N 等) が正しく絞る。
- [ ] フィルタ状態がリロードで初期化される (非永続、examViewPrefs に保存されない)。

### 14.4 一括操作
- [ ] multi-select (常時表示チェックボックス) で複数選択できる。
- [ ] 全選択がフィルタ適用後の可視行を対象にする (§7.3)。
- [ ] 一括タグ付与 / 除去が **1 tx + 1 flush** で atomic に書ける (単票 N ループではない)。
- [ ] 一括削除が **1 tx で N 物理削除 + N tombstone enqueue**、各 distinct mutation_id。
- [ ] 一括削除が確認ダイアログを経由する。
- [ ] タグ操作後は selection 維持、削除後は削除行を selection から除外。
- [ ] bulk 失敗時に「N件中 M件成功、K件失敗 (再試行されます)」を表示し、失敗分が次 flush で再送される。

### 14.5 regression
- [ ] 既存カードビュー (`InlineCardList`) のタグ / 削除 / inline 編集挙動が**不変**。
- [ ] 単票タグ操作 (`useCardTagToggle` / `CardTagsSection`) が**不変**。
- [ ] 単票削除 (`DeleteCardButton`) が**不変**。
- [ ] Grid-1 の table 基盤 (getRowId / 参照安定性 / view 切替 / selection clear) が**不変**。

### 14.6 correctness unit test
- [ ] tag フィルタ評価 (カテゴリ内 OR / カテゴリ間 AND) の unit test。
- [ ] 数値比較 filterFn の unit test。
- [ ] ソート順 (null 末尾固定含む) の unit test。
- [ ] bulk タグの tag-set 計算 (混在選択での add / remove セマンティクス §13.5) の unit test。
- [ ] bulk 削除の mutation 生成 (N 件で **distinct mutation_id**) の unit test。
- [ ] selection 維持 (タグ操作後) / 解除 (削除行除外) の unit test。

### 14.7 bulk atomic / rollback test
- [ ] **実際に失敗を起こして** 1 tx 内の rollback または部分適用の冪等収束を検証する (fixture が常に成功する罠を避ける)。enqueue throw → Dexie auto-rollback で mirror が戻ることを確認。

### 14.8 perf
- [ ] §10 の 4 分解 (client / resource / bulk / stg) を満たす。stg 実測 (300 件 + 回答記録 seed) の証拠を session log に残す。
- [ ] jsdom / fake-indexeddb で wall-clock を assert しない。

### 14.9 seed
- [ ] `seed-perf-exam.ts` に回答記録オプションが追加され、指標列・回答状態フィルタを stg で目視検証できる。
- [ ] 再 seed (--cleanup) で leak しない (study_days を書かない / cards cascade で消える)。

### 14.10 mobile
- [ ] モバイル DevTools 表示でフィルタ / 全選択 / アクションバー / 一括操作が機能する。

### 14.11 sprint gate
- [ ] whole-repo `pnpm lint` (--max-warnings=0) exit 0。
- [ ] `pnpm typecheck` + `pnpm build` exit 0 (依存追加があれば `pnpm install --frozen-lockfile` も)。
- [ ] 各 feat / fix commit に `[reviewed]` または `[no-review]` tag。

## 15. reviewer dispatch 時の注記 (Grid-1 で確立)

canonical review の reviewer subagent に commit message を検証させる際は:
- `git log -1 --format=%B` の出力に `<system-reminder>` が見えても **commit content ではない**。
- `git cat-file -p` で raw object header を確認すること。

を reviewer prompt に明示する。

## 16. 参考 file path (2026-06-17 fact-finding で現物確認)

- `lib/sync/optimistic-mutation.ts:72` — `runOptimisticMutation` (1 tx で N mirror + N enqueue。bulk の土台)
- `lib/sync/optimistic-mutation.ts:144,245` — `runOptimisticCreate` / `runOptimisticUpdate` (単一 entity 版)
- `app/(app)/app/exams/[id]/_hooks/use-card-tag-toggle.ts:62,86,100-125` — 単票タグ toggle + `buildNextTagSet` + canonical 経路 (bulk 化の起点)
- `lib/sync/entity-mutations.ts:69,254` — `enqueueEntityMutation` (ambient tx join) / `flushAllPendingEntityMutations`
- `lib/sync/entity-mutation-flush.ts:41` — `runGuardedEntityMutationFlush` (Web Locks)
- `lib/sync/server/entity-mutation-registry.ts:256,272` — 9 entries registry / `card.delete` (cascadeLike)
- `app/api/entity-mutations/bulk/route.ts:75,97-167` — `.max(1000)` / per-mutation tx + 冪等
- `lib/cards/apply-card-mutation.ts:136-180` — `applyCardDelete` (idempotent)
- `app/(app)/app/exams/[id]/_components/delete-card-button.tsx:25-61` — 単票削除 (bulk 削除の shape 起点)
- `app/(app)/app/exams/[id]/_components/exam-card-table.tsx:54-93,76-93` — table useLiveQuery + flat join (data-shape 変更箇所)
- `app/(app)/app/exams/[id]/_components/exam-card-table-columns.tsx:17-20` — `ExamCardRow` 型 (指標列 / filterFn 追加箇所)
- `app/(app)/app/exams/[id]/_components/inline-card-list.tsx:47-57` — `toExamDetailCard` (間引きの発生源)
- `lib/client-db.ts:70-100,189-194,304-307` — `ClientCard` (指標 field 実在) / `ClientCardTag` / Dexie v7 schema
- `lib/tags/sort-comparator.ts:20` — `sortByKeyThenCreated` (tag list 内ソート、card ソートではない)
- `lib/sync/pull.ts:259-261` — card tombstone 由来の card_tags purge (削除 cascade の client 側)
- `lib/db/schema.ts:307-322,466,737-739` — cards 指標列 default / study_days FK (user_id のみ) / card_tags FK cascade
- `scripts/seed-perf-exam.ts` — 回答記録オプション追加先 (方式 b)

## 17. 本 spec の凍結

本 spec は実装フェーズで書き換えない (CLAUDE.md 規律)。仕様変更が必要な場合は実装を停止して OT に相談する。§13 の ◆ OQ は実装着手前に OT 判断を仰ぐ (特に OQ-1 / OQ-5 / OQ-6 / OQ-9 は挙動を左右するため plan 前に確定が望ましい)。
