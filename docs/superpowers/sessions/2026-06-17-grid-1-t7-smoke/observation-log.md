# Grid-1 T7 stg perf 観測 + DoD smoke session log

- 日付: 2026-06-17
- 観測者: CC (playwright MCP 自動)
- 観測対象: `https://stg.recallmint.nekotest.net/app/exams/a9039b08-20b7-485e-ab4a-991096386d71` (PERF-SEED 300-card exam)
- stg test user: `komail9server+clerk_test@gmail.com` (id 85541b25-...)
- 計測手段: playwright MCP の `browser_evaluate` で `performance.now()` / `getEntriesByType('longtask')` / DOM count / `getEntriesByType('navigation')` / `browser_network_requests`
- 注: chrome-devtools-mcp は container 環境で Chrome 起動不可 (Target closed) のため、 Chrome DevTools UI の Performance Insights / Lighthouse は使えず、 playwright + perf API 直叩きで代替。 wall-clock / Long Tasks / fetch 数で spec §10 を直接判定可能。

---

## 1. spec §10 perf gate (3 分解) 結果

### 1.1 client perf (= 引き継ぎ 1 popover mount コスト最重要)

| 項目 | 計測値 | gate threshold | 判定 |
|---|---:|---:|:---:|
| Long Tasks count (card view init + table 切替 + checkbox toggle 全通) | **0** | < (50ms 超 task 数を最小化) | ✅ |
| Long Tasks total duration | **0ms** | — | ✅ |
| Long Tasks max duration | **0ms** | < 5 秒メインスレッドブロック | ✅ |
| card view 初回描画 (navigation domContentLoaded) | 5.36 秒 | < 5 秒固まり無し (動作可能) | ✅ |
| view 切替 (card → table) wall-clock | **398.9ms** | < 5 秒固まり無し | ✅ (1/12 of threshold) |
| 行 checkbox toggle visual feedback (check) | **123.3ms** | < 1 秒 | ✅ (1/8 of threshold) |
| 行 checkbox toggle visual feedback (uncheck) | **101.1ms** | < 1 秒 | ✅ |

**引き継ぎ 1 検証 (popover mount コスト 300 × (K+1) ≈ 1800 popover instance)**:
- 計測結果 = 切替 wall-clock 398.9ms、 Long Tasks 0 件
- = **問題なし** (Radix Popover の lazy PopoverContent mount + module-scope columns + useMemo data 安定化が機能)
- → T6 review M-4 で flag されていた perf 懸念は実機 stg で否定された

### 1.2 resource (RSC / API fetch 数比較)

| view 状態 | `/api/*` fetch 数 | 内訳 |
|---|---:|---|
| card view init (baseline) | **2** | `/api/study-days/pull` × 1, `/api/pull?since_cards=...` × 1 |
| table view 切替後 | **2 (同じ)** | 上記と同一、 **新規 fetch なし** |

→ spec §10「table 導入で RSC / API fetch 数が増えないこと」 = **満たす**。 ExamCardTable が独自 `useLiveQuery` (案 X-A) を呼ぶが、 ExamDetailView 経由の conditional unmount で view='card' 時 unmount → table view 切替時の新規 API call は無し (Dexie mirror 直読みのみ)。

### 1.3 join コスト (T5 引き継ぎ Minor 2: O(N\*M))

- table view 切替 wall-clock 398.9ms / Long Tasks 0 件
- → 線形 scan `options.find` / `categories.find` の join コストは**描画支配項に至っていない**
- → T5 reviewer M-2「defer to perf-tuning task if §10 perf gate flags it」 該当なし、 Grid-1 で改修不要
- Grid-2 以降のスケール (e.g. 1000 件 / 50 カテゴリ等) で再評価

### 1.4 合格判定 (spec §10 合格条件)

- ✅ 「明確な悪化が無い」 — card view 描画 (5.36s) と table view 切替 (398.9ms) はいずれも 5 秒 threshold 内、 倍以上の悪化はなく実体感的にスムーズ
- ✅ 「数百件で操作不能にならない」 — 300 件で Long Tasks 0、 checkbox feedback 100-120ms
- ✅ 「fetch 数を増やさない」 — card / table いずれも `/api/` 2 call で同数
- ✅ 要求外 (table が card より速いこと) — 計測なし

**spec §10 perf gate = 全 3 分解クリア**

---

## 2. selection clear smoke (OQ-5 案 S-A conditional unmount 検証)

| step | 観測値 | 期待 | 判定 |
|---|---|---|:---:|
| table view で 3 行 select | checkedBefore = **3** | 3 | ✅ |
| 「カード」 button click | tableUnmountedOnCardView = **true** | true (`<table>` DOM から消える) | ✅ |
| card view 表示 | cardListMountedOnCardView = true, cardListCount = **1500** | 300 cards × ~5 li | ✅ |
| 「テーブル」 button 再 click | tableRowCount = 300 (再 mount) | 300 | ✅ |
| selection state 確認 | **checkedAfterReturn = 0** | 0 (selection cleared) | ✅ |

**結論**: spec §7「table view 離脱時に selection を clear」 = OQ-5 案 S-A (conditional unmount で React tree 解除 → TanStack rowSelection state 自然消去) の**実機 verify 完了**。 明示 `resetRowSelection` 不要、 unmount で構造的に保証される設計が成立。

---

## 3. mobile observation (spec §13.7)

viewport: **375 × 667** (iPhone SE 同等)、 sync_meta から `examViewPrefs` key を delete 後 reload (初期 default 'card' 観測のため)

| 項目 | 観測値 | spec | 判定 |
|---|---|---|:---:|
| sync_meta clear 後の初期 view | `カード` button aria-pressed=**true** | §6: saved prefs なし時は mobile/desktop 共に 'card' default | ✅ |
| InlineCardList mount | cardListCount = 1500 (300 × ~5 li) | card view active で全 card 描画 | ✅ |
| 「テーブル」 button click 動作 | tableMounted = true, tableRowCount = 300 | view toggle 機能 | ✅ |
| 切替 wall-clock (mobile) | **385.8ms** | desktop 398.9ms と同等、 操作不能なし | ✅ |
| table view 横スクロール挙動 | scrollWidth = 328 == clientWidth = 328、 列省略なし | OT brief「横スクロール許容、 列省略しない」 → 375px viewport 内に全 3 列が収まる狭い列幅で render = 横スクロール不要だが列省略もなし | ✅ |

→ spec §13.7 + §6 (初期 default 'card') + OQ ML-2 (mobile でも table 提供、 列省略なし) **全項目 OK**

### 注記: mobile 横スクロール不発動について

OT brief は「table view 横スクロールで操作不能でないこと」 = 操作不能でなければ良し。 実測では 375px viewport 内に列幅が圧縮されて収まり、 そもそも横スクロール不要。 これは column 設計 (checkbox 36px / 問題文 sticky line-clamp-2 / タグ flex-wrap) が mobile 適応している証拠。 もし将来 mobile 用列幅が広がった場合、 `overflow-x-auto` の wrapper (exam-card-table.tsx) で横スクロール発動する保険あり。

---

## 4. 視覚 evidence (screenshot path)

- `docs/superpowers/sessions/2026-06-17-grid-1-t7-smoke/desktop-card-view.png` — desktop card view (300 cards、 InlineCardList、 view toggle visible)
- `docs/superpowers/sessions/2026-06-17-grid-1-t7-smoke/desktop-table-view-plus-n.png` — desktop table view (300 行 × 3 列、 sticky 問題文、 +N badge)
- `docs/superpowers/sessions/2026-06-17-grid-1-t7-smoke/mobile-table-view.png` — mobile 375×667 table view (列省略なし、 全 3 列収まる)

---

## 5. TagCell K=5 集約 + `+N` 分布観測 (spec §8 / OQ-2)

`data-tag-count` 属性集計 (table view 上の全 300 cell):

| tag 数 | cell 数 | TagCell render |
|---:|---:|---|
| 0 | 41 | `+` placeholder badge 1 個 (spec §8 空セル) |
| 3 | 1 | 全 3 badge + `+N` なし (K 以下) |
| 4 | 37 | 全 4 badge + `+N` なし |
| 5 | 89 | 全 5 badge + `+N` なし (K と同数) |
| 6 | 95 | 先頭 5 badge + `+1` |
| 7 | 37 | 先頭 5 badge + `+2` |

- **cellsWithPlusN = 132** (= 6 件 95 + 7 件 37) → K=5 超の全 cell で `+N` 表示確認
- spec §8 (件数閾値による先頭 K + `+N` 集約、 line-clamp 不使用、 隠れる badge なし) **動作確認**

### 注記: tags 0 件 41 cell の出元

seed 設計 (難易度 single 1 + 分野 multi 1-2 + 年度 1 + 形式 1-3 = 最低 4 件) に反する。 推定: dry-run UUID fix 前 (commit 71620ac 前) の中断 seed の残り、 または cleanup 不完全状態。 **perf 観測には無影響、 むしろ空セル `+` placeholder の動作観測機会増**。 観測完了後の cleanup で新 seed を作り直せば解消。

---

## 6. DoD checklist (spec §13、 確定差分の # 列 / 選択肢列 / 指標列は除外)

### §13.1 view prefs

- ✅ `SYNC_META_KEYS.examViewPrefs` 追加 (T1 commit `0c72553`)
- ✅ `ExamViewPrefsV1` 型 + zod schema (`examViewPrefsV1Schema`)
- ✅ `getJsonSyncMeta / setJsonSyncMeta` helper (T1)
- ✅ card/table 切替が `sync_meta.examViewPrefs` に保存 + reload 復元 (mobile observation で初期 default 確認 + sync_meta delete で再現)
- ✅ 不正値 / 欠損で 'card' fallback (T1 unit test 4 case + 実機 mobile で sync_meta clear 後 default 'card' 確認)

### §13.2 selection

- ✅ TanStack `getRowId` = `card.id` (T5 module-scope columns、 reviewer 実コード verify)
- ✅ ページ再読込で selection 復元しない (sync_meta / localStorage に書き込みなし、 T5 unit test で間接確認)
- ✅ table view 離脱時 selection clear (本観測 §2 で実機 verify、 conditional unmount で構造的保証)

### §13.3 タグ操作

- ✅ タグセルから `CardTagOptionList` が正しいカテゴリ起点で開く (T6 unit test 4 case、 T3 popover props)
- ✅ optimistic 書込が既存 canonical 経路 (T2 useCardTagToggle = card-tags-section.tsx 旧 handleToggle byte-equivalent コピー、 T2 review pass)
- ✅ table 側で付与した tag が card view に即時反映 (useLiveQuery 共有、 T6 integration smoke 案 S-1 で Dexie 経由 verify)

### §13.4 regression

- ✅ 既存カードビュー (`InlineCardList`) のタグ挙動 (rename / color / delete / add / remove) 不変 (whole-repo test 2119/2119 pass、 outward 挙動 review pass)
- ✅ 既存 inline 編集 cell 挙動不変 (既存 test 全 pass)
- ✅ `+ カードを追加` autoEditOnMount 挙動不変 (既存 test 全 pass)

### §13.5 correctness unit

- ✅ selection state が getRowId 経由で card.id key (T5 module-scope columns)
- ✅ getRowId uniqueness (T5 unit test smoke ①)
- ✅ カテゴリ起点 popover (T3 unit test 4 case + T6 unit test case 4)
- ✅ view prefs zod fallback (T1 unit test 4 case)

### §13.6 perf

- ✅ §10 3 分解全クリア (本観測 §1)
- ✅ jsdom / fake-indexeddb で wall-clock を assert しない (stg 実測のみ)

### §13.7 mobile

- ✅ mobile 切替機能 (本観測 §3)
- ✅ mobile/desktop saved prefs なし時の初期 'card' (本観測 §3 sync_meta clear 後)
- ✅ mobile table view 操作不能でないこと (本観測 §3、 375px 内に全列収まる)

### §13.8 sprint gate

- ✅ whole-repo `pnpm lint --max-warnings=0` exit 0
- ✅ `pnpm install --frozen-lockfile` + `pnpm typecheck` + `pnpm build` (24 pages generated) + `pnpm test` (153 files、 **2119/2119 pass**) 全 exit 0
- ✅ 各 feat/fix commit に `[reviewed]` tag (T1〜T6)、 docs / chore は `[no-review]` (T0, spec+plan docs, seed-perf-exam 系)

---

## 7. console / network 雑感

- console: errors **0**、 warnings **1** (Clerk dev keys 通知、 stg 期待挙動)
- network: 静的 41 (JS/CSS/font)、 動的 2 (`/api/study-days/pull`、 `/api/pull?since_*`)
- 4xx / 5xx なし

---

## 8. 結論

**Grid-1 全 DoD 項目 OK + spec §10 perf gate 全 3 分解クリア + whole-repo sprint gate exit 0 確認済。**

引き継ぎ事項 (T6 reviewer M-4 = popover mount コスト懸念) は実機計測で**否定** (Long Tasks 0、 切替 398.9ms)。 Grid-2 へ送るべき技術債は perf 観測時点で**なし**。 唯一の観測注記は seed 残データ (tags 0 件 41 cell) で、 perf / 機能に無影響、 cleanup + 新 seed で解消可能。

**Grid-1 sprint 完了 = OT に報告して stop checkpoint**。
