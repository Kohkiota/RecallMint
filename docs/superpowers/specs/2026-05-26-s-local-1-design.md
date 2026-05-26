# S-local-1 cards local mirror / offline 演習 設計 (design spec)

- 起票日: 2026-05-26
- 種別: design spec (investigation `2026-05-26-s-local-1-investigation.md` の調査結果整理)
- 状態: design 確定前 OT review 待ち
- 関連 spec: `docs/02-tech-spec.md` §13.14 / §14 (local-first 設計、 §14.11 で MVP 採用決定済)
- 前 sprint: S-cache 系 close (`docs/superpowers/sessions/2026-05-26-s-cache-series-close.md`)

## 1. 結論サマリ

- cards local mirror は **MVP 採用済** (§14.11 で v1.x 送り撤回)。 offline 演習 / dueCount local projection / inline 編集 optimistic 等の前提となる
- 既存 Dexie schema (lib/client-db.ts) は **cards / exams / sync_meta テーブルが既に定義済**。 不足は **pull 経路 (server → client) と pull-on-startup の wire-up**
- FSRS は ts-fsrs (5.3.2、 +~25 KB gzip) で client 計算可能、 既存 `lib/fsrs.ts` の default scheduler を共有する形で server / client 同値計算が成立
- reconcile は **server authoritative + client mirror (read 中心)** 方針で開始。 mutations (answer_events / card_mutations) は既存 bulk API 経由で既に冪等
- 最初の 1 sprint 候補は **Phase α (cards pull MVP)** を推奨

## 2. cards local mirror は本当に必要か

**結論: 必要 (offline 演習要件と一致)**

| use case | 必要性 | 備考 |
|----------|-------|------|
| offline 演習 (電車内 / 飛行機) | **必須** | server 不到達でも session が回ること |
| dueCount local projection (S-cache-3.2) | 必須 | cards.due の client 計算が前提 |
| inline 編集 optimistic | 強く望ましい | 既に card_mutations table 用意済 |
| session 開始の体感速度向上 | 望ましい | server fetch ラウンドトリップ削減 |
| online 利用での server query 削減 | 副次効果 | 主目的ではない |

§14.11 (tech-spec) で「§13.14 の v1.x 送り方針を撤回し、 MVP スコープに含める」 と
既に OT 決定済。 本 design はその方針を実装可能な単位に分解するもの。

## 3. どの単位で card を local に持つか

候補:

| 案 | 単位 | 容量目安 (5K cards) | 適用シナリオ | 推奨度 |
|----|------|--------------------|--------------|--------|
| 全件 | user 全 cards | ~10 MB | 全 use case | **★ 推奨** |
| Per-exam | user 選択 exam のみ | ~1-2 MB | 特定試験集中時 | △ MVP 後検討 |
| Due-soon | due 期間 N 日以内 | ~1-3 MB | storage 制約強い時 | × MVP 早期は不要 |
| On-demand | session 開始時に pull | 0 (毎回 fetch) | server 接続前提 | × offline 不能 |

**推奨**: **全件 mirror**。 理由:
- IndexedDB quota は browser 共通で 数百 MB〜数 GB (Chromium 系)、 10 MB はゼロコスト
- MVP user の card 総数は ~数千件想定 (推定: 1 試験 100-500 問 × 数試験)
- 「offline で全試験対応」 が最も user 価値高い
- pull / sync 戦略が一律にできる (per-exam / due-soon は filter logic が複雑)

将来 5万件超で問題になれば per-exam に切替検討 (= 早期最適化禁止、 YAGNI)。

## 4. exam / card / property / answer_events の local schema

**既存 Dexie schema** (`lib/client-db.ts`) で **ほぼ充足**。 追加が必要なものは少ない:

### 4.1 既存テーブル概要

| table | PK | 用途 | 状態 |
|-------|----|------|------|
| exams | id | server pull cache (read-only) | schema 定義済、 pull 未配線 |
| cards | id | server pull cache (read-only) + sync_status | schema 定義済 (FSRS 全 column 含む)、 pull 未配線 |
| user_settings | user_id | 設定 (session_limit, fsrs_mode) | pull 未配線 |
| study_sessions | session_id (client uuid) | 演習メタ | write path 配線済 |
| answer_events | local_id (auto) + event_id index | 回答ログ | write path 配線済、 bulk push 済 |
| card_mutations | local_id (auto) + mutation_id index | inline 編集 patch | schema 定義済、 write path 未配線 |
| sync_meta | key | key-value (last_pull_at 等) | 定義済、 write path 未配線 |

### 4.2 想定追加項目 (本 sprint で確定、 実装は別 sprint)

- `sync_meta` key 群:
  - `last_card_pull_at` (ISO8601、 増分 pull cursor)
  - `last_exam_pull_at` (同上)
  - `last_user_settings_pull_at` (同上)
- index 追加候補:
  - `cards.due` (既に存在、 due 順 sort 用)
  - `cards.exam_id` + `cards.due` 複合 (= per-exam 演習開始時に高速)
    → 既存単独 index でも十分機能、 追加は計測後検討

### 4.3 schema migration 要否

- 上記の sync_meta 追加 / index 追加は **既存 schema version 1 内で済む** (sync_meta はそもそも自由 key-value、 cards.due は既存)
- 大規模 migration 不要。 schema version up は schema 構造変更時のみ

### 4.4 properties (customProps)

server 側 `cards.customProps` は jsonb (Notion 互換 prop 機構)。 client side では
`cards.custom_props` (snake_case) として既に Dexie type 定義済 (推定、 要確認)。
本 sprint で追加検討事項なし。

## 5. FSRS due 判定を client に持つ場合の影響

### 5.1 ライブラリ評価

- `ts-fsrs@5.3.2`: pure TS、 Node API 依存なし、 gzip 後 ~25 KB
- 既存 `lib/fsrs.ts` は `scheduler = fsrs()` (default params) + `rate(card, rating, now)` の 2 export
- これを `'use client'` ファイルからも import 可能 (server / client 両用設計)

### 5.2 server / client 同値性

| 項目 | 状態 | 備考 |
|------|------|------|
| default params | 共通 | `fsrs()` 引数なし = ライブラリ default |
| Rating mapping | 共通 | `RATING_MAP` (lib/fsrs.ts) を共用 |
| now: Date | UTC で同一 | 通信遅延分のずれは許容範囲 |
| user 別 retention 等 | **未実装** | user_settings に desiredRetention column なし |

**結論**: 現状の default 設定なら server / client 同値。 将来 user-level retention 等を
入れる場合は user_settings に column 追加 + client/server 同時参照が必要。

### 5.3 client 計算の用途範囲

- **dueCount projection**: cards.due フィールド (local) を見て count するだけなら ts-fsrs 不要 (純粋な date 比較)
- **next-due preview UI**: 回答前に「rate=Good なら次は ~3 日後」 表示 → ts-fsrs 必要
- **offline session 中の cards.due 更新**: rate 後 client で next state 計算 → cards local 更新 → online で server に bulk push → server で再計算 (authoritative)

→ **Phase α (cards pull) では ts-fsrs client import 不要**。 Phase β (offline 演習) で
追加。

## 6. server authoritative との reconcile 方針

### 6.1 大原則

- **server が authoritative**。 cards の FSRS state は server `submit-review-tx.ts` が
  ts-fsrs を呼び DB に upsert したものが正
- **client mirror は read 中心**。 client は cards.* を直接 mutate しない (= 直接
  update query を送らない)
- **mutate は既存 event/mutation 経由**:
  - 回答 → answer_events (Dexie) → bulk POST → server submitReviewTx → cards 更新
  - 編集 → card_mutations (Dexie) → bulk POST → server card update → cards 更新
- **次の pull で client mirror が新値を取得** → ループ closure

### 6.2 pull 戦略

- **full snapshot** (起動時 1 回): user 全 cards を `GET /api/cards/pull` で取得 → Dexie cards table を **replace** (delete-all + insert-all)
- **Δ pull** (起動後 / 一定間隔): `GET /api/cards/pull?since=${last_card_pull_at}` で
  更新分のみ取得 → 各 card を upsert
- **Δ cursor**: `last_card_pull_at` (ISO8601) を sync_meta に保存

### 6.3 conflict 処理

- cards: **server wins** (client mirror は read 専用なので conflict 概念がない)
- mutations (answer_events / card_mutations): 既存の `event_id` / `mutation_id` 冪等で
  二重送信 OK、 client が pending リトライ
- マルチデバイス同編集の OCC: `contentVersion` (server cards 既存 column) で検出可能だが
  実装は別 sprint (S-local-N、 N >> 1)。 last-write-wins から開始

### 6.4 stale 取扱い

- client mirror が古い (server で更新が走ったが client は未 pull) → ユーザ操作前に Δ
  pull を起動時 + 一定間隔で実行
- 既存の dashboard SSR は今後も server fresh を読む (本 sprint で変更しない)、 mirror
  は session 開始時の cards 取得など特定 use case で利用

## 7. bulk sync / retry / conflict handling

### 7.1 client → server (mutation push)

既に `lib/sync/review-events.ts` で確立。 同 pattern を card_mutations に複製:

```
// 仮イメージ (本 sprint では実装しない)
async function flushPendingMutations(): Promise<FlushResult> {
  const mutations = await getPendingMutations()
  const response = await client.post('/api/card-mutations/bulk', { mutations })
  await markMutationsSynced(syncedIds)
}
```

- mutation_id UNIQUE で server 側冪等
- failed[] で部分失敗対応
- sync_status 4 状態 (pending / syncing / synced / failed)
- retry: 次トリガ (online 復活 / app 起動 / visibilitychange) で再 flush

### 7.2 server → client (pull)

新規 helper を `lib/sync/cards.ts` (仮) に用意:

```
// 仮イメージ
async function pullCards(): Promise<PullResult> {
  const since = await getSyncMeta('last_card_pull_at')
  const response = await client.get(`/api/cards/pull?since=${since}`)
  await replaceOrUpsertCards(response.body.cards)
  await setSyncMeta('last_card_pull_at', response.body.now)
}
```

- 初回は `since` なし → full snapshot
- 2 回目以降は Δ
- response shape: `{ cards: [...], now: ISO8601 }` (now は次回 cursor)

### 7.3 retry / backoff

既存 review-events は exponential backoff 未実装 (= 「次トリガ任せ」)。 cards pull も
同方針で MVP 開始、 必要なら別 sprint で追加。

### 7.4 トリガ (§14.7.1 既述)

- 起動時 (app mount)
- 復帰時 (visibilitychange visible)
- online 復活時 (navigator.onLine + online event)
- pull は dashboard / session 開始の入口で 1 回試行 (= "lazy first pull" 戦略)

## 8. offline 演習 MVP の最小範囲

### 8.1 MVP 成立条件

- session 開始時に必要 cards (= due 該当) が **既に local にある**
- 回答 → 判定 → Dexie 記録は **既に offline 動作** (S-cache-1 で実装済)
- session 完了 → 「ダッシュボードへ」 → online 復帰待ち or 即遷移 (S-cache-3.1 で
  warning UI 既に対応)
- 結果反映: online 復帰時に bulk flush → server で再計算 → 次 pull で mirror 更新

### 8.2 段階分け (推奨)

| Phase | スコープ | 工数感 | 価値 |
|-------|---------|-------|------|
| **α** (S-local-2) | cards pull (read-only) + sync_meta | S | mirror 基盤、 即時利用無し |
| **β** (S-local-3) | session-runner が cards を local 由来に切替 + due 判定 client 化 | M | online 体感向上、 offline 基盤 |
| **γ** (S-local-4) | server `getSessionCards()` failure fallback + empty UI 集約 (offline 演習 MVP の前段) | S-M | server reach OK での DB 起源障害耐性 |
| **δ** (S-local-5+) | dueCount local projection (S-cache-3.2 相当) | S | dashboard race-free 強化 |
| **ε** (将来) | Service Worker / app shell precache / mounted-page client session 等 — **真の offline 演習成立に必要** | L | 完全 PWA / 真の offline 演習 MVP 達成 |

### 8.3 「演習成立」 の定義 (重要、 2026-05-26 amend で正確化)

**真の offline 演習成立** = browser が完全 offline (Vercel reach 不能) でも
`/app/study/smart` への新規 navigation + session 起動 + 回答 + 完了 / 次 session
起動が成立する状態。 達成には Phase ε (Service Worker / app shell precache /
mounted-page client session 等) **完了が前提**。 当初の段階分けで γ に置いて
いたが、 γ (S-local-4) は server reach 後の `getSessionCards()` 失敗 fallback
のみ達成 (真の offline navigation は RSC fetch 必須のため不可) のため格下げ。

γ 時点で達成:
- server reach OK + DB 起源 throw 時の Dexie cards fallback
- Dexie + server 両方 0 件のときの empty UI 一元判断

γ 時点で **未達** (= ε で達成):
- airplane mode (browser → Vercel reach 不能) での `/app/study/smart` 新規
  navigation。 RSC / document fetch が必須のため Service Worker / route
  precache なしには不可能
- offline 中の dashboard 遷移 (S-cache-3.1 の `router.push('/app')` も RSC
  fetch を要するため server reach 前提)

## 9. 既存 Dexie schema との差分

### 9.1 ほぼ差分なし (本 sprint 範囲)

- table 構造変更: なし
- index 追加: なし (Phase β で `cards.due` 単独 index を due 順 sort に活用、 既存)
- schema version up: 不要 (schema=1 のまま)

### 9.2 wire-up が必要な部分 (実装作業の中身)

- `lib/sync/cards.ts` (新規): pullCards / replaceOrUpsertCards
- `lib/sync/exams.ts` (新規): pullExams (cards のための exam meta)
- `lib/sync/user-settings.ts` (新規): pullUserSettings (将来 retention 等のため雛形)
- sync_meta の key 定数定義 (`last_card_pull_at` 等)
- 既存 `client-db.ts` に変更なし

### 9.3 新規 server endpoint

- `GET /api/cards/pull?since=...` (新規)
- `GET /api/exams/pull?since=...` (新規)
- `GET /api/user-settings/pull` (新規 or 既存 user route)
- `POST /api/card-mutations/bulk` (新規、 既存 review-events/bulk と同 pattern)
- 認証は既存 Clerk + user_id 絞り込み

## 10. 最初の 1 sprint 候補 (S-local-2)

### 10.1 候補比較

| 候補 | スコープ | 工数 | 価値 | risk |
|------|---------|------|------|------|
| **X (推奨)** | Phase α: cards pull MVP (full snapshot) + sync_meta wire-up | S-M | mirror 基盤確立、 後続全てが乗る | 低 |
| Y | FSRS client PoC (vitest で server/client 同値) | XS | 後続 Phase β の安全保証 | 低 |
| Z | X + Y 同時 (cards pull + FSRS PoC) | M | 一気に β に進める基盤 | 中 |
| W | schema 確定だけ (sync_meta key 定義 + types) | XS | 設計確定の証跡のみ、 動作変更なし | 低 |

### 10.2 推奨: 候補 X (Phase α = cards pull MVP)

理由:
- 一番太い基盤 (pull infrastructure) を最初に立てる
- Y (FSRS client PoC) は β Phase に組み込む方が文脈に沿う
- Z は review 範囲が広がる、 1 sprint としては大きすぎる
- W は他に動かない → 単独価値が薄い

### 10.3 S-local-2 (Phase α) の最小スコープ (仮、 本 sprint では plan 化しない)

スコープ:
- `GET /api/cards/pull` 新規 endpoint (full snapshot first、 user 全 cards 返却)
- `GET /api/exams/pull` 新規 endpoint (cards の exam_id を解決するため)
- `lib/sync/cards.ts` (新規): `pullAllCards()` で Dexie cards table に full replace
- `lib/sync/exams.ts` (新規): 同上
- 起動時の dashboard / app entry point で 1 回 pull を kick off (fire-and-forget)
- sync_meta key (`last_card_pull_at` / `last_exam_pull_at`) は将来 Δ pull に備えて記録
- **session-runner は変更しない** (session は引き続き server fetch ベース)
- **dueCount は変更しない** (S-cache-3.2 と同じ理由、 mirror 立ち上げのみ)

完了条件:
- vitest で `pullAllCards` mock client / Dexie write の test (3-5 case)
- pnpm build / test 全通過
- code-reviewer Critical 0 件
- OT 実機 smoke: 「dashboard を開く → DevTools → Application → IndexedDB → recall-mint → cards table に行が入っている」

非ゴール (Phase α 中):
- Δ pull (Phase β 以降)
- session-runner の local 由来切替 (Phase β)
- FSRS client 計算 (Phase β)
- offline 動作 (Phase γ)
- conflict resolution UI (将来)

## 11. やらないこと (本 sprint = S-local-1 内、 および S-local-2 候補から除外)

### S-local-1 (本 sprint = investigation 段階)

- アプリコード変更
- migration 書き
- Dexie schema 変更 (= client-db.ts 変更)
- Service Worker 対応
- offline 演習実装
- ts-fsrs の client bundle 化
- 新 API endpoint 実装
- push

### S-local-2 候補 (= Phase α 提案範囲外)

- cards 以外の mirror (exams は cards の付随で含めるが、 properties は対象外)
- Δ pull / cursor base sync (full snapshot のみ)
- session-runner の local cards 読切替
- dueCount local projection
- FSRS client 計算
- offline session 成立
- マルチデバイス conflict UX
- last-write-wins 以外の resolution
- per-exam / due-soon の選択 pull
- 起動以外のトリガ (visibilitychange 等は別 sprint)

### 永続的に out-of-scope (本シリーズで扱わない)

- 完全 offline app shell (Service Worker / Workbox)
- 画像 cache offline (cards.images の URL 取得は別議論)
- AI OCR offline (server 機能、 client 化不可)
- Stripe / Clerk offline (外部依存、 不可能)

## 12. 関連ファイル / 参照

- design 入口: `docs/superpowers/specs/2026-05-26-s-local-1-investigation.md`
- tech-spec local-first 設計: `docs/02-tech-spec.md` §13.14 / §14 (§14.11 で MVP 採用決定)
- 既存 Dexie schema: `lib/client-db.ts`
- 既存 sync helper: `lib/sync/review-events.ts`
- 既存 FSRS: `lib/fsrs.ts`
- 既存 server FSRS 計算: `lib/cards/submit-review-tx.ts`
- 既存 server schema: `lib/db/schema.ts` (cards / exams / reviews / answer_events / etc.)
- 既存 bulk endpoint pattern: `app/api/review-events/bulk/route.ts`
- 前 sprint close 記録: `docs/superpowers/sessions/2026-05-26-s-cache-series-close.md`

## 13. 次のステップ (OT 判断必要)

S-local-1 (= 本 design spec) の OT review 後:

- OK → S-local-2 (Phase α = cards pull MVP) を writing-plans skill で plan 化
- 設計修正必要 → 本 spec を update + 再 review
- 別案採用 (例: Y = FSRS PoC 先行) → スコープ再交渉
