# Y-2 Sub-plan B T-B1 — `/app/tags` H7 初期遅延 切り分け調査 (2026-06-12)

stg 環境 (develop top reflect 済) に 2000 card 級 fixture を投入し、 Playwright MCP 経由で `/app/tags` の初期表示遅延を計測。 (a) server roundtrip / (b) Dexie 初回 fetch / (c) SSR rendering の 3 要因を実数値で分離 (spec §3.1 H7、 plan B T-B1)。 比較対象 = `/app/exams` (= T-B4 同根)。

## 結論 (要旨)

**(b) Dexie 初回 fetch + per-option N+1 が圧倒的 dominant** (~95%)、 (a) (c) は誤差。 `/app/tags` の遅さは `category-list.tsx:127-148` の `db.tag_options.where(category_id) + 各 option ごと db.card_tags.count()` の客側 N+1 構造に直結。 同 fixture で `/app/exams` も client-side で遅いが、 こちらは T-B4 (exam-list-live 全 cards scan) と同根なので既存 plan B の T-B4 / T-B5 / T-B7 群でカバー予定。

**OT 提案**: plan B T-B1 完了条件の **(i) perf 同根併合** (= 既存 T-B4 系) ではなく **(ii) 軽ければ独立 Task T-B1' を本 plan 末尾追加** が妥当。 `category-list.tsx` の per-option N+1 は `db.card_tags.where('option_id').anyOf(allOptionIds)` の単一 query + JS reduce で `optionId → count` を一括算出する hash 集計型 fix (T-B5 と同形パターン、 helper 再利用余地あり)。 H7 単独で Y-3 繰越 (iii) を要する重さではない (10 categories × 10 options 規模で 4-5s = 100 options × 100 options 規模で 10-50s)、 本 sprint 内に T-B5 と隣接して着手するのが効率的。

---

## 1. 投入実績 (seed wall-clock = T-B3 #1b baseline)

`docs/superpowers/sessions/2026-06-12-y2-b1-seed-runbook.md` のとおり Playwright MCP × `POST /api/entity-mutations/bulk` (entity_mutations log 経由、 production-faithful) で投入。

| step | 内容 | mutations | wall_clock (ms) | applied | failed |
|---|---|---|---|---|---|
| step 2 | tag_categories 10 + tag_options 100 (create) | 110 | 6,447 | 110 | 0 |
| step 3a | cards 0-999 (create) | 1,000 | 54,924 | 1,000 | 0 |
| step 3b | cards 1000-1999 (create) | 1,000 | 53,423 | 1,000 | 0 |
| step 4a | tag_option_ids update cards 0-999 | 1,000 | 70,305 | 1,000 | 0 |
| step 4b | tag_option_ids update cards 1000-1999 | 1,000 | 69,788 | 1,000 | 0 |
| **合計** | — | **4,110** | **254,887** | 4,110 | 0 |

= **平均 62.0 ms / mutation** (serial per-mutation tx、 T-B3 改善前)。 内訳の傾向: card create (~54 ms) < card update_field tag_option_ids (~70 ms、 server side `handleTagOptionIds` の DELETE+INSERT 含む) と妥当 (= T-B3 で並列化したい order 通り)。 **本 wall-clock は T-B3 #1b の改善対象 baseline として再掲予定** (plan B T-B3 計測契約: 10 独立 key 入力で逐次 vs 並列の wall-clock 比較)。

Step 1 (exam manual UI 作成、 Server Action `createExam`) と Step 5 (Dexie verify 経由 navigate + pull) は seed wall-clock に含めず別計測。

### Dexie 反映確認 (Step 5)

navigate `/app` → 5s wait → IDB 直問:

| store | seed 前 | seed 後 | 期待値 |
|---|---|---|---|
| cards | 23 | 2,023 | 23 + 2000 = 2023 ✓ |
| exams | 2 | 3 | 2 + 1 = 3 ✓ |
| tag_categories | 3 | 13 | 3 + 10 = 13 ✓ |
| tag_options | 10 | 110 | 10 + 100 = 110 ✓ |
| card_tags | 13 | 4,013 | 13 + 4000 = 4013 ✓ |

`Y2B1-` prefix の identifier match = 10 cat / 100 opt / 2000 card / 1 exam = 完全一致。 server → pull → Dexie 経路の一貫性確認済。

---

## 2. 計測方法

Playwright MCP の `browser_navigate` で対象 page にナビゲート、 同時に Performance API + MutationObserver で以下を捕捉:

- **TTFB**: `performance.getEntriesByType('navigation')[0].responseStart` (= response の最初の byte 到達時刻、 nav 基準)
- **response_end**: 同 navigation entry `.responseEnd` (HTML 末尾到達 = SSR 完了の closest proxy)
- **FCP**: `performance.getEntriesByType('paint').find(p => p.name === 'first-contentful-paint').startTime`
- **text_appeared_at**: MutationObserver で対象 text (Y2B1-cat-01 / seed-y2-b1-tags-perf) が DOM に現れた瞬間の `performance.now()` (= useLiveQuery 初回 resolve + render 完了の proxy)
- **dexie_render_attr** (derived): `text_appeared_at − response_end` (= server response 受領後の client-side aggregation + render 帰属時間)

各 page 3 run 平均、 run 間に必ず `/app` (= dashboard、 軽量) へ navigate して RSC / Clerk session / JS bundle を warm に維持。 run 1 は cold cache 影響あり (FCP 大)、 run 2/3 で安定化を確認。

---

## 3. 計測結果

### `/app/tags` (categories 13 + options 110 + card_tags 4013)

| run | TTFB (ms) | FCP (ms) | response_end (ms) | text_appeared (ms) | dexie_render_attr (ms) |
|---|---|---|---|---|---|
| 1 | 10.2 | 492 | 462 | 6,250 | **5,788** |
| 2 | 10.2 | 128 | 106 | 4,148 | **4,042** |
| 3 | 10.1 | 176 | 149 | 4,093 | **3,943** |
| avg | 10.2 | 265 | 239 | 4,830 | **4,591** |

### `/app/exams` (exams 3 + cards 2023 + card_tags 4013、 同 fixture)

| run | TTFB (ms) | FCP (ms) | response_end (ms) | text_appeared (ms) | dexie_render_attr (ms) |
|---|---|---|---|---|---|
| 1 | 10.6 | 140 | 114 | 2,340 | **2,226** |
| 2 | 10.7 | 112 | 91 | 4,306 | **4,215** |
| 3 | 9.9 | 200 | 173 | 4,696 | **4,523** |
| avg | 10.4 | 151 | 126 | 3,781 | **3,655** |

---

## 4. 切り分け解釈 (要因 (a)/(b)/(c) 帰属)

`/app/tags` の text_appeared 平均 4,830 ms を構成要素別に帰属:

| 要因 | 値 (ms) | 比率 |
|---|---|---|
| (a) server roundtrip (TTFB) | 10.2 | 0.2% |
| (a)' server response 末尾までの転送 (response_end - TTFB) | 229 | 4.7% |
| (c) SSR rendering (FCP - TTFB) | 255 | 5.3% |
| **(b) Dexie 初回 fetch + render (text_appeared - response_end)** | **4,591** | **95.0%** |

= **(b) が圧倒的 dominant**。 (a) (c) は誤差。 `/app/exams` も同様に dexie_render_attr ~3,655 ms = 96.7% を占める。

dexie_render_attr の内訳 (推定、 code 読み + 構造から):

- **`/app/tags`** (`category-list.tsx:127-148`):
  - `db.tag_categories.toArray()` — single scan、 N=13、 軽い
  - `db.tag_options.where('category_id').equals(catId).toArray()` × 13 categories — 計 13 query、 各 options ~10 件
  - **`db.card_tags.where('[option_id+user_id]' 相当).count()` × 110 options** — N+1 構造、 card_tags 4013 行を 110 回 partial scan、 これが Dominant
- **`/app/exams`** (exam-list-live):
  - 全 cards scan で「exam ごと count + 最終更新」 集計、 cards 2023 件を 1 回 full scan + JS aggregation、 これが Dominant (T-B4 同根)

`/app/tags` が `/app/exams` より平均 ~1 s 重い (~25% 増) のは per-option N+1 のアクセスパターンが Dexie の `.count()` 実装上 store cursor 反復で起きており、 cards scan の単発 cursor 反復より cache 局所性が悪い (推定、 確証は DevTools Performance trace で取得すべき)。

---

## 5. Fix 位置の OT 提案

plan B T-B1 完了条件: (i) perf 同根なら T-B4 / T-B5 / T-B6 / T-B7 群に併合 / (ii) 軽ければ独立 Task T-B1' / (iii) 重ければ Y-3 繰越提案。

CC 推奨 = **(ii) 独立 Task T-B1' (本 plan 末尾追加)**。

理由:
- per-option N+1 のアクセスパターンは既存 T-B4〜T-B7 と異なる (T-B4 = 全 cards scan / T-B5 = card_tags page subset / T-B6 / T-B7 = `[user_id+due]` index 利用)。 H7 fix は **`db.card_tags.where('option_id').anyOf(allOptionIds).toArray()` の単一 query + JS reduce で hash 集計** という新パターン、 T-B5 と精神的に近いが用途が異なる
- 本 sprint 内 budget (Sub-plan B 残 7 task) に T-B5 と隣接して 1 task 追加は妥当な負担、 (iii) Y-3 繰越まで重くない
- 4-5s の dominant 体感遅延は launch 前 hardening の趣旨に直結 (Y-2 sprint goal)、 本 sprint で消化したい

T-B1' (本 plan 末尾追加候補):

- **File**: `app/(app)/app/tags/_components/category-list.tsx` (modify) + 既存 test
- **目的**: useLiveQuery 内 per-option `db.card_tags.count()` N+1 を単一 `db.card_tags.where('option_id').anyOf(allOptionIds).toArray()` + JS reduce へ集約 (= `optionId → count` hash)。 4-5 s → 数百 ms を目標
- **制約**: 表示挙動不変 (各 option pill に表示される件数 / cardCount 集計値)。 anyOf の order 不安定 → 集計後の表示 sort key は既存維持 (`created_at ASC` 等)。 Y-1 #3 / T-B5 の anyOf 経路 precedent 流用
- **完了条件**: 同 fixture (2000 card / 100 option / 4000 card_tags) で再計測、 text_appeared 平均 < 1,500 ms (= 3x 改善目標)、 既存 category-list test + tags page test 全 pass、 Critical 0、 [reviewed]

T-B1' を plan B 末尾に追加する commit は本 stop checkpoint で OT 承認後に CC 起草 (= plan 更新 + 同 sprint 内実装)。

---

## 6. cleanup 完了確認

計測完了後、 plan B T-B1 / runbook §6 のとおり cleanup を実走:

| step | 内容 | wall_clock (ms) | 結果 |
|---|---|---|---|
| C1 | UI で seed exam 削除 (server cascade cards 2000 + card_tags 4000) | 1,806 | UI から exam 行消失 + 確認 dialog 経由 |
| C2 | bulk POST `op='delete'` × tag_categories 10 (server cascade tag_options 100 + 残 card_tags) | 689 | applied 10 / failed 0 |
| 合計 | — | 2,495 | cleanup 完了 |

Dexie 検証 (navigate `/app` → 4s wait → 全 store count):

| store | cleanup 後 | seed 前 baseline | 差 |
|---|---|---|---|
| cards | 23 | 23 | ±0 ✓ |
| exams | 2 | 2 | ±0 ✓ |
| tag_categories | 3 | 3 | ±0 ✓ |
| tag_options | 10 | 10 | ±0 ✓ |
| card_tags | 13 | 13 | ±0 ✓ |

Y2B1- prefix の identifier match = 全 0 件 ✓ (categories / options / cards / exams 全 store)。

### tombstone cursor advance 検証 (runbook §6 step 5)

`sync_meta` 確認:

```
tombstone_cursor: 2026-06-12T11:57:45.608Z (cleanup 後 11:57:xx 以降に advance)
cards_cursor:    2026-06-12T11:52:19.457Z (seed pull 時)
card_tags_cursor:2026-06-12T11:52:19.457Z (seed pull 時)
exams_cursor:    2026-06-12T11:46:23.078Z (initial)
tag_categories_cursor: 2026-06-12T11:46:45.908Z (initial)
tag_options_cursor:    2026-06-12T11:46:51.300Z (initial)
```

cleanup 直後の pull で tombstone (= cards 2000 + tag_categories 10 + tag_options 100 + exam 1 = ~2111 件、 card_tags は cascade 派生で tombstone に乗らず client 側で `option_id` / `card_id` ベースの bulk purge) が 1 回 drain され cursor が advance、 baseline 汚染なし。

---

## 7. 残課題 (本 stop checkpoint で OT 判断)

1. **T-B1' 追加 plan B 末尾** の承認 — CC 推奨 (ii) 独立 task。 OT 否認なら (i) 既存 T-B4 群に併合 or (iii) Y-3 繰越。
2. **Sub-plan B 残 ordering の確定** — T-B1 完了後の T-B2 / T-B3 #1b (stop checkpoint = 着手承認) / T-B4 / T-B5 / T-B6 / T-B7 / T-B8 を順次 or T-B3 並走など、 OT 指定 (plan B 全体ルール 6 stop = T-B1 残置で OT 判断後 ordering)。
3. (independent) **T-C4 推奨 (c) Y-3 繰越** の OT 裁定 — 別 stop checkpoint。
