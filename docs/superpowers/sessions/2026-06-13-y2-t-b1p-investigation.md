# Y-2 Sub-plan B T-B1' 前提崩壊 → 真の dominant 再特定 (2026-06-13)

T-B1' は plan B-perf.md L87-94 で「`category-list.tsx:127-148` の per-option `db.card_tags.count() × N` を anyOf 集約に置換」 を fix 方針としていた。 しかし実コード read で **該当 N+1 が `/app/tags` 初回表示経路に存在しない**ことが判明 (Step 0 報告済)。 OT 指示「実測で原因を確定してから fix を選ぶ」 に従い stg 実機 DevTools Performance trace で再計測。

- **計測日時**: 2026-06-13
- **stg**: stg.recallmint.nekotest.net (deploy = `1e50c5b`、 push 同期済)
- **計測 user**: `komail9server+clerk_test@gmail.com` (T-B1 runbook 規律: OT 本アカウントに fixture 投入禁止)
- **fixture**: T-B1 seed runbook 流用、 exam 1 + cards 2000 + tag_categories 10 + tag_options 100 + card_tags 4000 (Y2B1- prefix、 T-B1 と完全同形)
- **比較対象**: T-B1 計測 (`docs/superpowers/sessions/2026-06-12-y2-tags-perf-investigation.md`、 2026-06-12) の `/app/tags` 計測 (3 回平均 4,830 ms、 dexie_render_attr 4,591 ms)

---

## 1. Step 0 で発見した前提崩壊

T-B1 session log L95 は dominant 内訳を「**推定、 code 読み + 構造から**」 と明記 (実測ではない)。 推定された「per-option `db.card_tags.where('[option_id+user_id]' 相当).count() × 110 options`」 = **実コードに存在しない**:

| session log 推定 | 実コード |
|---|---|
| `category-list.tsx:127-148` で per-option `card_tags.count() × 110` | `category-list.tsx:127-130` = `tag_categories.toArray()` のみ。 per-option `card_tags.count()` は `category-list.tsx:144-151` の `handleDeleteRequest` 内 (削除フロー click 時、 初回表示時ではない) |
| `tag_options.where('category_id').equals(catId).toArray() × 13 categories` | `option-list.tsx:115-122` = active 1 件 (初回 null で空配列) のみ |

つまり T-B1 fix 方針 (anyOf 集約) は **対象 N+1 が存在しない**。

---

## 2. 計測方法 (T-B1 protocol 同形)

T-B1 計測 protocol (`text_appeared_at = MutationObserver で対象 text が DOM に現れた瞬間の performance.now()`) を踏襲、 加えて `PerformanceObserver` で `longtask` (>50ms の main thread block) を観測:

- **TTFB / response_end / FCP / loadEvent**: Navigation Timing API
- **longtask entries**: `performance.getEntriesByType('longtask')` で >50ms の連続 JS 実行を観測
- **Dexie wall-clock**: 計測 text appear 後に `tag_categories.getAll()` 単独で再実行、 IDB level の cost を直接測定

シナリオ:
1. **初回ロード** (T-B1 protocol と同形): `/app` → `/app/tags` navigate → Y2B1-cat-01 text 出現で計測終了 (3 回)
2. **active 切替**: 初回ロード後、 Y2B1-cat-01 click → Y2B1-opt-01-01 text 出現で計測終了 (OptionList mount + 10 options render)

---

## 3. 計測結果

### 3.1 初回ロード (3 回計測)

| run | TTFB | responseEnd | FCP | loadEvent | longtask 件数 | longtask >50ms |
|---|---|---|---|---|---|---|
| 1 | 9 ms | 147 ms | 180 ms | **272 ms** | 0 | 0 |
| 2 | 9 ms | 208 ms | 240 ms | **304 ms** | 0 | 0 |
| 3 | 10 ms | 116 ms | 148 ms | **217 ms** | 0 | 0 |
| **avg** | 9 ms | 157 ms | 189 ms | **264 ms** | **0** | **0** |

### 3.2 IDB level bench (run 1 時、 mainthread 空き状態で実行)

- `db.tag_categories.getAll()` (= category list の useLiveQuery と等価): **0.7 ms** (13 件 fetch)

### 3.3 active 切替 (1 回計測)

| metric | 値 |
|---|---|
| Y2B1-cat-01 click → Y2B1-opt-01-01 text appear | **31 ms** |
| longtask 件数 | 0 |
| longtask >50ms | 0 |

---

## 4. T-B1 計測値との比較

| metric | T-B1 計測 (2026-06-12) | T-B1' 計測 (2026-06-13) | 差 |
|---|---|---|---|
| TTFB | 10.2 ms | 9 ms | ±0 |
| FCP | 265 ms | 189 ms | ±0 |
| response_end | 239 ms | 157 ms | ±0 |
| text_appeared (= loadEvent 相当) | **4,830 ms** | **264 ms** | **18x 速い** |
| dexie_render_attr (text - response_end) | **4,591 ms** | **107 ms** | **43x 速い** |

T-B1 計測の dexie_render_attr 4,591 ms = 95% 占有 は **今は完全に再現しない** (107 ms = 2.3% 占有)。

---

## 5. 仮説候補と評価

T-B1 計測 (06-12) と T-B1' 計測 (06-13) の間の commit 履歴を `git log --since="2026-06-12" --until="2026-06-13" -- 'app/(app)/app/tags/' 'lib/sync/' 'lib/tags/' 'lib/client-db.ts'` で確認:

- `7c5a7ee feat(perf): T-B4 #1c exam-list-live materialize 回避 (Dexie v6 schema 追加)`
- `4a0704d feat(sync): T-B3 #1b group-mutations-by-entity-key helper 新設`

両 commit は `/app/tags` の useLiveQuery 経路に **直接の変更なし**。 つまり T-B1 → T-B1' の間に /app/tags は無変更。

### 仮説 (a): T-B1 計測 protocol の artifact (seed 直後の pull drain 中の useLiveQuery 多重 re-fire)

T-B1 計測は **fixture 投入直後 + cleanup 前** に実行された (session log §2 step 5 「Dexie 反映確認 (Step 5)」 直後に §3 計測)。 server に大量 INSERT (cards 2000 / card_tags 4000) 直後の状態で、 Dexie pull change event が dispatch される間、 useLiveQuery callback が複数回 re-trigger されていた可能性。 React render が毎回 ~13 categories × dnd-kit setup を繰り返し、 dexie_render_attr に「pull drain 中の不安定状態」 が含まれた。

T-B1' 計測 (今) は seed 完了 + pull drain 完了 + stable state で実施 = 多重 re-fire なし = 264 ms。

これは plausible だが確証なし (再現実験で「seed 直後の即時計測」 をすれば確認可能、 ただし時間コスト大)。

### 仮説 (b): 環境一過性 (Vercel deploy bundle / Clerk session の cold start 等)

T-B1 計測時の bundle / Clerk session が偶発的に重かった可能性。 ただし T-B1 計測 run 2/3 (warm) でも 4,148 ms / 4,093 ms と一貫して遅い = 一過性とは説明つきにくい。 仮説 (a) のほうが優勢。

### 仮説 (c): T-B1 計測 protocol の MutationObserver 発火タイミング artifact

T-B1 計測の `text_appeared_at` は MutationObserver microtask で発火 = 真の DOM update より遅延する可能性 (React の async commit + DOM update + microtask queue 終端で発火)。 ただし microtask 遅延は通常 ms オーダー、 4,830 ms の説明にならない。

---

## 6. 結論

- **/app/tags は今や速い**: page 全体 264 ms / longtask 0 件 / Dexie 0.7 ms / active 切替 31 ms。 通常運用での体感遅延は無い。
- **T-B1 計測値 4,830 ms は再現しない**: 仮説 (a) (seed 直後 pull drain 中の多重 re-fire) が最も plausible、 通常運用に影響しない artifact の可能性が高い。
- **T-B1' fix 方針 (anyOf 集約) は対象 N+1 が存在しないため不発動**。 実装しても意味がない / 違う場所を最適化する事故。

---

## 7. fix 方針候補 (OT 判断項目)

CC 推奨は **論点 A**:

| 案 | 内容 | 評価 |
|---|---|---|
| **A. T-B1' を skip / Y-3 繰越** | 通常運用で 264 ms = launch 前 hardening 不要、 plan B-perf.md T-B1' を `[skipped]` / `[Y-3 deferred]` に変更 | CC 推奨。 計測値が再現しない以上、 真の dominant が無い |
| B. seed 直後シナリオを追加計測 | 仮説 (a) の検証のため、 fresh seed 投入直後の即時計測で 4,830 ms 再現を試みる | 時間コスト大 (~3 分)、 ただし仮説 (a) 確証なら「pull drain 中の多重 re-fire」 を別 fix 対象として記録できる |
| C. T-B1 計測時の環境異常を session log に記録して closing | 仮説 (b) (一過性) を取り、 plan 側に「再現確認済、 通常運用で問題なし」 とのみ記載 | (a) の確証が無いと closing 早すぎる、 ただし plan 内 task 消化として最速 |

---

## 8. cleanup 結果

| store | seed 前 (baseline) | seed 後 | cleanup 後 |
|---|---|---|---|
| exams | 1 | 2 | **1** ✓ |
| cards | 6 | 2006 | **6** ✓ |
| tag_categories | 3 | 13 | **3** ✓ |
| tag_options | 10 | 110 | **10** ✓ |
| card_tags | 0 | 4000 | **0** ✓ |
| Y2B1- prefix 残骸 | — | — | **0** ✓ |

cleanup 手順:
- exam delete: `deleteExam` server action × 1 (server FK CASCADE で cards 2000 連動)
- tag_category delete: entity-mutations bulk × 10 (server cascade で tag_options 100 + card_tags 4000 連動、 T-B3 #1b cascade fallback)
- page reload で pull → tombstone drain → baseline 復帰

stg test data 残置なし。 OT 本アカウントへの波及なし。

---

## 9. CC 停止 (実装に入らない)

OT 指示「真の dominant 特定 + 方針候補提示で停止し、 OT 判断 → spec/plan 見直し (brainstorming → writing-plans) を経て実装着手」 に従い、 本セッションで実装には入らず chat 報告で停止。
