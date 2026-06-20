# Grid-2 T7 stg perf 観測 + DoD smoke session log

- 日付: 2026-06-20
- 観測者: CC (playwright MCP 自動)
- 観測対象: `https://stg.recallmint.nekotest.net/app/exams/3e81f836-0ef3-4541-bc6f-60bb384b53f9` (PERF-SEED 300-card exam、 `--with-answers` で回答記録あり)
- stg test user: id 85541b25-... (session 永続済、 再ログイン不要)
- 計測手段: playwright MCP `browser_evaluate` で `performance.now()` / `getEntriesByType('longtask')` / `getEntriesByType('navigation')` / DOM count / Dexie 直 read (`indexedDB.open('recallmint')`)、 `browser_network_requests` で `/api/*` 数。
- 注: chrome-devtools-mcp は container で Chrome 起動不可のため Grid-1 同様 playwright + perf API 直叩きで代替。

> **重要**: 再 seed で exam id が変わった。 旧 `a9039b08-...` (@2026-06-17) は 404 (cleanup 済)、 新 `3e81f836-...` (@2026-06-20T16:16、 `--with-answers=0.5`) を観測対象とした。

---

## 0. 回答記録 seed (T0 `--with-answers`) の stg 実値確認

Dexie 直 read (exam `3e81f836`, 300 card):

| 項目 | 値 |
|---|---:|
| total | 300 |
| answered=true | 150 (50%) |
| answered=false | 150 (50%) |
| last_correct=true | 106 |
| last_correct=false | 44 |
| last_correct=null (未回答) | 150 |
| current_streak>0 | 106 |
| last_review!=null | 150 |

→ T0 `--with-answers=0.5` が stg で正しく投入されている (回答済 50% / 未回答 50% 混在、 last_correct true/false/null の 3 値が揃い、 指標列・回答状態フィルタの実データ検証が可能)。

---

## 1. spec §10 perf gate (4 分解) — 300 件実測

全操作で **Long Tasks 0 件** (50ms 超のメインスレッドブロックなし)。

### 1.1 client perf

| 操作 | wall-clock | Long Tasks | gate threshold | 判定 |
|---|---:|---:|---|:---:|
| card view 初回描画 (navigation domContentLoaded) | 775ms | 0 | < 5 秒固まりなし | ✅ |
| view 切替 (card → table、 300 行 render) | 499ms | 0 | < 5 秒固まりなし | ✅ |
| ソート (連続正解数 列ヘッダ click、 降順) | 293ms | 0 | 操作不能なし | ✅ |
| フィルタ (回答状態=直近正解) | 80ms | 0 | 操作不能なし | ✅ |
| 全選択 (フィルタ適用中、 106 行) | 31ms | 0 | 操作不能なし | ✅ |
| 一括タグ付与 (300 選択、 click→optimistic) | 117ms | 0 | 操作不能なし | ✅ |
| 一括削除 (3 選択、 confirm→消滅) | 437ms | 0 | 操作不能なし | ✅ |

- ソート降順確認: 連続正解数 列 click で先頭 5 行 streak = `[10,10,10,10,10]` (降順 = 最大値先頭)。
- 全操作で Long Tasks 0、 体感スムーズ。 300 件で操作不能・長時間ブロックなし。

### 1.2 resource (RSC / API fetch 数)

| view 状態 | `/api/*` fetch 数 | 内訳 |
|---|---:|---|
| card view (baseline) | 2 | `/api/study-days/pull`, `/api/pull?since_*` |
| table view 切替後 | 2 (同じ) | **新規 fetch なし** |

- フィルタ / ソートは **client 側評価のみ** (TanStack columnFilters / sorting、 新規 fetch なし)。
- → spec §10「フィルタ / ソート / bulk で RSC / API fetch 数が増えない」 = **満たす**。

### 1.3 bulk (本番規模、 1 tx + 1 flush)

`/api/entity-mutations/bulk` への POST を観測:

| 操作 | POST 数 | response | 反映確認 |
|---|---:|---|---|
| 一括タグ付与 (300 選択 → 形式:穴埋め add) | **1** (#49) | 200 | 穴埋めタグが **300 card 全件**に反映 (Dexie read。 TS-1: 未保持のみ add) |
| 一括削除 (3 選択) | **1** (#53) | 200 | mirror card 300 → **297** (削除 3 件)、 削除 id は selection から除外 |

- 各 bulk op = **1 Dexie rw tx + 1 flush POST** で完結 (T4/T5 設計どおり、 N 件を 1 POST)。 300 mutation は bulk endpoint の max 1000 内。
- → spec §10「300 件全選択 → 一括操作が 1 tx + 1 flush で完結し操作不能にならない」 = **満たす**。

### 1.4 stg 実測が正本

wall-clock / Long Tasks / fetch 数はすべて stg 実機計測。 jsdom / fake-indexeddb で wall-clock を assert する test は書いていない (unit は挙動正当性のみ)。

**spec §10 perf gate = 4 分解すべてクリア。**

---

## 2. selection / フィルタ 結合 smoke (§7.3 / §7.4 / HS-2)

| 検証 | 観測 | 期待 | 判定 |
|---|---|---|:---:|
| 全選択 = filtered (§7.3) | フィルタ「直近正解」(可視 106) で全選択 → 選択 **106** (隠れた 194 を含まない) | filtered 可視行のみ | ✅ |
| HS-2 自動解除 | 「直近正解」(106 選択) → フィルタ「直近不正解」(可視 44) に変更 → 選択 **0**、 action bar 消失 | 隠れた選択行が自動解除 (selection ⊆ 可視) | ✅ |
| 削除後 selection 除外 (§7.4) | 3 件選択 → 削除 → 選択 **0**、 削除 id は DOM/selection から消失、 action bar 非表示、 mirror 297 | 削除行を selection から除外 | ✅ |
| タグ操作後 selection 維持 | (300 選択 → 一括タグ付与後も popover open のまま選択維持。 OT 結合実機確認でも確認済) | 維持 | ✅ |

- HS-2 不変条件「N件 = 今見えている選択行」 = 実機で成立 (T6 の単一 prune effect が機能)。

---

## 3. 確認 modal (CD-1) / bulk delete UI

| 項目 | 観測 |
|---|---|
| 削除ボタン → modal | title「カードを削除しますか?」、 description「選択した 3 件…」、 buttons [キャンセル, 削除する] |
| 削除する → 確定 | 3 件削除、 437ms、 Long Tasks 0 |
| reload 復活 | OT 結合実機確認で「reload で復活しない」 確認済 (削除 POST 200 = server tombstone 永続) |

---

## 4. mobile (§14.10 + M3)

viewport **375 × 667** (iPhone SE 同等):

| 項目 | 観測 | 判定 |
|---|---|:---:|
| フィルタ / 全選択 / action bar / 一括操作 | mobile で機能 (上記 §1-§3 と同経路で動作) | ✅ |
| table 横スクロール | `.overflow-x-auto` scrollWidth=460 > clientWidth=328 → 横スクロール発動 (列省略なし) | ✅ |
| **M3: action bar の最終行 occlude** | 修正前: action bar (fixed, top=561, height=106) が最終行 (bottom=620) の下部 ~59px を occlude | ⚠️→修正 |

### M3 修正 (commit `196499d` `fix(grid): ... [reviewed]`)

- 原因: action bar が `position: fixed; bottom-0` のため、 最下部スクロール時に最終行を覆う。
- 修正: ExamCardTable root `<div>` に **選択時のみ** `pb-32` (128px) を付与 (`selectedIds.length > 0 ? 'pb-32' : undefined`)。 action bar mount 条件と同一 gate のため非選択時の余白増なし。 pb-32 は bar 高さ ~106px + 失敗メッセージ wrap 分の余裕を確保。
- canonical review pass (Critical 0 / Important 0 / Minor 2)。 Minor の「失敗メッセージ wrap で更に高くなる狭幅 edge case」 を踏まえ pb-28 → pb-32 に bump 済。
- **残課題 (handoff)**: 狭幅 + bulk 失敗 + ボタン wrap が同時成立する極端 case では pb-32 でも僅かに不足しうる (失敗 UI は transient「再試行されます」、 行は scroll 可能)。 将来 bar 高さ動的計測で hardening 余地。 現状は実用上問題なし。

### 視覚 evidence
- `desktop-table-actionbar.png` — desktop table view (指標 3 列 + action bar 2 件選択中)
- `grid2-mobile-actionbar-overlap-before.png` — mobile 375×667 修正前の action bar overlap

---

## 5. DoD checklist (spec §14)

### §14.1 指標列
- ✅ 直近正誤 / 連続正解数 / 最終回答日時 の 3 列 read-only 表示 (table header `[…, 直近正誤⇅, 連続正解数⇅, 最終回答日時⇅]` 実機確認、 T1)
- ✅ 未回答カード識別 (last_correct=null → 「—」、 last_review=null → 「未回答」、 T1 + 混在 seed で目視)

### §14.2 ソート
- ✅ sortKey(問題文列) / 直近正誤 / 連続正解数 / 最終回答日時 でヘッダソート (実機 293ms、 降順確認)
- ✅ null 末尾固定 (T2 `sortUndefined:'last'`、 unit test)
- ✅ タグ列ソート不可 (T2 `enableSorting:false`)
- ✅ リロードで初期化 (非永続、 T2 controlled state)

### §14.3 フィルタ
- ✅ tag (カテゴリ内 OR / 間 AND) — T3 + bulk popover 経由で動作
- ✅ 回答状態 (4値) — 実機「直近正解」で可視 106 = last_correct_true 106 一致
- ✅ 数値比較 (連続正解数) — T3 unit test
- ✅ 非永続 (リロード初期化、 examViewPrefs 不保存)

### §14.4 一括操作
- ✅ multi-select (常時 checkbox)
- ✅ 全選択 = filtered (§7.3 実機 106)
- ✅ 一括タグ付与/除去 1 tx + 1 flush (実機 1 POST、 300 件反映)
- ✅ 一括削除 distinct mutation_id (T5 unit) + 確認 modal (CD-1 実機)
- ✅ selection 維持(タグ)/ 除外(削除)/ 自動解除(フィルタ HS-2) — 実機確認
- ✅ bulk 失敗 UI inline (T6、 toast 非導入)

### §14.5 regression
- ✅ InlineCardList / 単票タグ操作 / 単票削除 / Grid-1 table 基盤 不変 (whole-repo 2217 tests pass、 popover 3 file + lib/sync 無改造を各 task の git diff で実証)

### §14.6 correctness unit
- ✅ tag filterFn / 数値 filterFn (T3 21 case)
- ✅ ソート順 null 末尾 (T2 10 case)
- ✅ bulk tag-set 計算 (T4 build-next-tag-set)
- ✅ bulk delete mutation distinct id (T5)
- ✅ selection 維持/解除 (T6 6 case)

### §14.7 bulk atomic / rollback
- ✅ 実際に失敗を起こす rollback test (T4: enqueue 2回目 throw → card_tags 全 revert / T5: enqueue throw → cards mirror 全 revert + 冪等収束)

### §14.8 perf
- ✅ §10 4 分解クリア (本観測 §1)
- ✅ jsdom / fake-indexeddb で wall-clock 非 assert

### §14.9 seed
- ✅ `--with-answers` で指標列・回答状態フィルタ検証可 (本観測 §0、 stg 実投入)
- ✅ study_days 不書込 / cards cascade で leak なし (T0 設計、 再 seed で旧 exam cleanup 確認 = a9039b08 が 404)

### §14.10 mobile
- ✅ mobile でフィルタ / 全選択 / action bar / 一括操作 機能 (本観測 §4)
- ✅ M3 action bar overlap 修正 (`196499d`)

### §14.11 sprint gate
- ✅ whole-repo `pnpm lint --max-warnings=0` exit 0
- ✅ `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` + `pnpm test` exit 0 (164 files / **2217 tests pass**、 M3 fix 後の最終 state でも table 系 48 tests pass + 全 suite 再確認)

---

## 6. console / network 雑感

- console: errors **0** (warnings は Clerk dev keys 通知等、 stg 期待挙動)
- network: 動的 `/api/` = card/table とも 2 (pull 系) + bulk POST 2 (今回の観測操作分)
- 4xx / 5xx なし (bulk POST 2 件とも 200)

---

## 7. 観測による seed への副作用 (handoff)

本観測で stg PERF-SEED exam (`3e81f836`) を以下のとおり変更した (PERF-SEED test data のため許容、 必要なら OT が再 seed):
- 形式:穴埋め タグを 300 card 全件に付与 (一括タグ付与の観測)
- 3 card 削除 (300 → 297、 一括削除の観測)

→ 次回 clean な perf 観測時は `--cleanup` + 再 seed 推奨。

---

## 8. 結論

**Grid-2 全 DoD 項目 OK + spec §10 perf gate 4 分解クリア + whole-repo sprint gate exit 0。**

- 300 件で全操作 Long Tasks 0、 フィルタ 80ms / ソート 293ms / 全選択 31ms / bulk add 117ms (1 POST) / bulk delete 437ms (1 POST)。
- §7.3 全選択=filtered / HS-2 自動解除 / 削除後 selection 除外 を実機で実証。
- T5 引き継ぎ懸念 (join O(N\*M)) は 300 件で描画支配項に至らず (table 切替 499ms、 Long Tasks 0)。
- M3 (mobile action bar overlap) のみ実機で検出 → `pb-32` 余白で修正 (`196499d` [reviewed])。

**Grid-2 sprint 完了。**
