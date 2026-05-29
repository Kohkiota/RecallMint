# 東京リージョン移行 after 計測 (function hnd1 + DB ap-northeast-1)

- 日時: 2026-05-29 (05:06〜05:09 GMT)
- 種別: session log / stg perf 計測 (実装変更なし、 計測 doc のみ)
- 対象 stg: `https://stg.recallmint.nekotest.net`
- account: `komail9server+001@gmail.com` (clean state、 OT が 2FA code hand-off)
- 実行手段: Playwright MCP + DevTools Network / PerformanceResourceTiming (問題 2/3 と同手順)
- 移行内容: Vercel function を hnd1 固定 (`f87cf6e`、 origin/develop 反映済 = stg auto-deploy) + Supabase DB stg を ap-northeast-1 へ移行 (OT 実施)
- before baseline: 問題 3 after (`docs/superpowers/sessions/2026-05-28-problem3-after-measurement.md` §0-final、 function **iad1**、 bulk 4,769ms)
- 結論: **function region が iad1→hnd1 に切替確認 (全経路 x-vercel-id `hnd1::hnd1`)。 bulk flush 4,769ms → 769ms (~6.2x)。 問題 3 で残った ~1.6s 以上の上振れは function↔DB cross-region RTT であり、 東京 co-location で解消。**

---

## 1. region 切替確認 (x-vercel-id 実値)

全経路で **`hnd1::hnd1`** (edge hnd1 / **function hnd1**)。 問題 2/3 計測時は `hnd1::iad1` (function iad1 = US)。

| 経路 | x-vercel-id (実値) | function region |
| --- | --- | --- |
| `/api/cards/pull` | `hnd1::hnd1::zl9g2-1780031204024-a4418fd61b2d` | **hnd1** (旧 iad1) |
| `/api/review-events/bulk` | `hnd1::hnd1::szxqr-1780031261624-47b98fe62409` | **hnd1** (旧 iad1) |

→ `f87cf6e` の `vercel.json regions:["hnd1"]` が stg に反映済。 全 Node.js serverless function が東京実行。

---

## 2. 性能 (before/after、 同一操作・同一条件)

計測条件 = 問題 3 と同一: clean state (IDB before:[recallmint]→clear、 answer_events=0 確認)、 sessionLimit=5 / FSRS ON、 smart 5 問を Good(rating=3) 完答 → 経路 2 flush。

### review-events bulk POST (本命)

| 段階 | function region | DB region | Function Duration (PRT≒TTFB) | failed |
| --- | --- | --- | --- | --- |
| before (per-event tx × N) | iad1 | (移行前) | 16,773〜17,426ms | (計測時 body のみ) |
| 問題 3 after (単一 tx、 iad1) | iad1 | (移行前) | **4,769ms** | [] |
| **東京移行後 (単一 tx、 hnd1 + ap-northeast-1)** | **hnd1** | **ap-northeast-1** | **769ms** | **[]** |

- **4,769ms → 769ms = 約 6.2x 短縮 (~4,000ms 減)**。 per-event 比では 16.7-17.4s → 0.77s = **~22x**。
- correctness 維持: response `{"ok":true,"failed":[]}`、 全 5 event `sync_status='synced'`、 RETURNING 件数照合 throw なし。

### DB pull 系 (function hnd1)

`/app` 着地 (PullTrigger) で並走する pull。 2 サンプル (初回 /app + dashboard 復帰時):

| 経路 | 初回 /app | dashboard 復帰時 |
| --- | --- | --- |
| `/api/cards/pull` | 106ms | 168ms |
| `/api/exams/pull` | 361ms | 108ms |
| `/api/study-days/pull` | 295ms | 126ms |

- いずれも **sub-400ms**。 問題 1 計測の page-load baseline (`/app` ~2,100ms 等) とは指標が違う (あちらは SSR page-load) が、 DB pull 自体は東京 co-location で軽い。

### 演習完了 → dashboard 遷移

- 「ダッシュボードへ」 click → `/app` navigation duration **656ms** (PerformanceNavigationTiming)、 pull 3 本 108〜168ms 並走。 体感即時。

---

## 3. correctness (実 DB 反映)

| 指標 | 本 session 後 |
| --- | --- |
| bulk response | `{"ok":true,"failed":[]}` (全件成功) |
| Dexie | 全 5 event `synced` / session `synced` |
| dashboard 今日の学習問題数 | **5** (適用 5 distinct card 反映) |
| スマート復習 due | 50 → **48 件** (FSRS due 前進 = cards 反映) |

→ cards / reviews / study_days すべて実 DB (ap-northeast-1) に commit。

---

## 4. 東京移行 全体進捗

| 作業 | 状態 | 根拠 |
| --- | --- | --- |
| Vercel function hnd1 固定 | ✅ 完了 | `f87cf6e` (vercel.json regions)、 stg で x-vercel-id `hnd1::hnd1` 確認 |
| Supabase DB stg → ap-northeast-1 | ✅ 反映確認 (OT 実施) | 直接 region 表示は不可だが、 function iad1→hnd1 で bulk が 4.8s→0.77s に**改善**した事実が co-location を裏付け (DB が US のままなら function 東京化は逆効果のはず) |
| stg 計測 | ✅ 完了 (本 doc) | 上記 §1-3 |
| Supabase DB prod → ap-northeast-1 | (OT 管理、 本 doc 対象外) | — |
| main マージ / prod deploy | OT 判断待ち | — |

---

## 5. 所見 (事実ベース)

- **問題 3 で残った ~1.6s 以上の上振れの正体は function↔DB の cross-region RTT** だった。 問題 3 時点では function=iad1 (US) ↔ DB が遠く、 単一 tx に畳んでも数 RTT 分の往復が ~4.8s に効いていた。 function を hnd1、 DB を ap-northeast-1 に**両方東京へ co-locate** したことで RTT が大幅短縮し、 同じ単一 tx + bulk SQL コードのまま 769ms に収束。
- = **SQL の往復回数削減 (問題 3) と物理距離削減 (東京移行) は直交する改善**で、 両方効いた。 16.7s (per-event/US) → 4.8s (単一 tx/US) → 0.77s (単一 tx/東京)。
- bulk は cold 単発 (x-vercel-cache MISS) でこの値。 warm / 連続 invoke のばらつきは別 task。

---

## 6. OT hand-off (本計測の対象外)

- **OCR upload の計測**: 課金/AI (Gemini) 実走系のため Claude Code は実行せず OT 依頼。 手順: `/app/upload` で小サイズ PDF/画像 1 件 upload → process server action / OCR 完了までの時間 + x-vercel-id (function region 確認) を DevTools で取得。 東京移行で Gemini API 呼出自体の RTT は変わらない (Gemini は Google 側 region) が、 OCR 前後の DB 書込 (cards bulk INSERT / upload_records) は東京 co-location の恩恵を受けるはず。
- **prod 反映 + prod での VERCEL_REGION / DB region 確認**: OT。

---

## 7. 計測識別子 (OT の Vercel log 照合用)

| 軸 | 値 |
| --- | --- |
| bulk session_id | `b46bd45b-8932-41fb-843c-c05d63962e8a` |
| bulk event_id (5) | `bbe44b54` / `6c69ea52` / `748b9952` / `fba02e89` / `03feb1aa` |
| bulk x-vercel-id | `hnd1::hnd1::szxqr-1780031261624-47b98fe62409` (date Fri, 29 May 2026 05:07:42 GMT) |
| cards/pull x-vercel-id | `hnd1::hnd1::zl9g2-1780031204024-a4418fd61b2d` (date 05:06:44 GMT) |

OT が `review_events.bulk.timing` を引けば 769ms の per-phase 内訳 (select-cards / insert-events / insert-reviews / update-cards / study-days) が分かる。
