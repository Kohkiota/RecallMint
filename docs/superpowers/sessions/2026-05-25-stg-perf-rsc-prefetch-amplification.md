# stg 環境の主要 page navigation が遅い原因調査

> **状態**: 計測 + コード調査完了、 改善は S-cache-2 / S-cache-3 と並行 or 単独 sprint で実施可。
> 普遍化した教訓は `lessons/2026-05-25-link-prefetch-amplifies-server-load.md` 参照。

## 1. きっかけ

S-cache-1 の stg smoke (`commit 20d4896`) 中、 「主要ページ間の遷移が体感で遅い」 OT 観察。 Playwright MCP + Chrome DevTools で計測 + コード調査を統合し、 根本原因を構造的に特定したい。

調査範囲:
- 主要 6 page (`/app` `/app/exams` `/app/study/smart` `/app/settings` `/app/exams/[id]` `/app/cards/[id]`) の navigation timing + Resource Timing + long task
- 直接 RSC fetch (cold cache MISS) の TTFB + body streaming
- `auth()` / `getCurrentUser()` 全呼出箇所の分類 + 重複 RSC render 検出
- `getCurrentUser` の React.cache 適用範囲
- revalidatePath / router.refresh の必要性 (Dexie 移行後を見据えて)
- `app/(app)/app/layout.tsx` の server fetch (dynamic 強制の根源)

## 2. 計測結果 (Playwright stg、 ログイン済 / cold MISS)

### 2.1 直接 RSC fetch (Vercel cache MISS、 server SSR の実時間)

| path | TTFB | body streaming | total | RSC size | x-vercel-cache |
|---|---|---|---|---|---|
| `/app` (dashboard) | 417 ms | 1629 ms | **2046 ms** | 5 KB | MISS |
| `/app/exams` | 489 ms | 1167 ms | **1656 ms** | 11.5 KB | MISS |
| `/app/study/smart` | 383 ms | 701 ms | **1084 ms** | 7.6 KB | MISS |
| `/app/settings` | 391 ms | 466 ms | **857 ms** | 9.9 KB | MISS |

`Server-Timing` header は無し (Next.js / Vercel が出していない)、 ブレークダウンは JS 計測 + コード分析からの推定。

### 2.2 Navigation timing (warm、 prefetch 済の遷移)

| 開いた page | DCL | load | 同時並列発火していた RSC prefetch (path / dur) | longTasks |
|---|---|---|---|---|
| `/app` | 2314 ms | 2393 ms | 5 個 (`/app/upgrade` 650, `/app/upload` 536, `/app/exams` 499, `/app/study/smart` 484, `/app/settings` 413) | 0 |
| `/app/exams` | 2558 ms | 2611 ms | **7 個** — header 4 + 試験一覧 3 (`/app/exams/<id>` × 3、 540 / 405 / 378) | 0 |
| `/app/study/smart` | 1880 ms | 1934 ms | 4 個 (header) | 0 |
| `/app/settings` | 1645 ms | 1710 ms | **9 個** — header 4 + 法的 4 (`/contact` `/terms` `/privacy` `/legal`) + `/app/upgrade` | 0 |
| `/app/exams/[id]` | 2265 ms | 2364 ms | 5 個 (header) | 0 |

longTask 0 件 = クライアント JS の重さは原因ではない、 server RTT + SSR が支配。

### 2.3 既知ノイズ

- console error: `Framing 'https://vercel.live/' violates ... frame-src ...` — Clerk auto CSP が Vercel preview の `vercel.live` フィードバック iframe を弾く。 production には注入されないので無視可。

## 3. コード調査結果

### 3.1 `getCurrentUser()` 全箇所

`auth()` 直接呼出は 2 箇所のみ (`lib/auth/ensure-user.ts:31` + `contact/actions.ts:44`)、 他は全部 `getCurrentUser` 経由で 24 callsite。

- layout: 1 (`app/(app)/app/layout.tsx:28`)
- page.tsx: 12 (dashboard / exams / exams/[id] / cards/[id] / study/smart / upload / upload/result/[id] / upgrade / settings / marketing top / pricing)
- server action: 8 (revalidate / delete-card / update-card / delete-exam / update-card-field / save-session-limit / save-fsrs-mode / settings/actions / submit-review (dead) / upgrade/actions / upload/process)
- API route: 2 (`review-events/bulk` `exams/status`)

### 3.2 `getCurrentUser` 実装

`lib/auth/ensure-user.ts:29-42`:

```ts
export const getCurrentUser = cache(
  async (): Promise<User | null> => {
    const { userId } = await auth()
    if (!userId) throw new UnauthenticatedError()
    const db = getDb()
    const rows = await db.select().from(users)
      .where(eq(users.clerkId, userId)).limit(1)
    return rows[0] ?? null
  },
)
```

- `React.cache()` wrap 済 (同 RSC tree 内で結果共有、 layout + page 重複は 1 SELECT に集約)
- `auth()` は JWT decode のみで net call 無し
- `users` SELECT は `clerk_id` UNIQUE index で 1 行 lookup
- 戻り値: `Promise<User | null>` (webhook race で null)

**射程の限界**: `React.cache` は同 request の RSC render tree 内のみ。 `<Link>` prefetch される別 page の RSC は別 render tree 扱いで cache 共有しない。

### 3.3 revalidatePath / revalidateTag / router.refresh

`revalidateTag` 0 件、 `revalidatePath` 11 箇所 (前回調査 (S-cache-0 review pass) と同件数)、 `router.refresh()` 4 箇所。

Dexie 完全移行 (S-cache-2 / S-cache-3) 後の判定:
- 編集系 (`update-card-field` / `update-card` / `delete-card` / `delete-exam`): **撤回可** (`card_mutations` bulk API 経路に置換後)
- 設定系 (`save-session-limit` / `save-fsrs-mode`): **撤回可** (userSettings Dexie 化で)
- OCR 完了 (`process.ts:118` `revalidatePath('/', 'layout')`): **必要** (mass mutation で全表)
- session 完了 「もう一度」 `router.refresh()`: 現状必要、 Dexie pre-sync で撤回可
- OCR processing → completed 遷移の `router.refresh()`: 必要

### 3.4 `app/(app)/app/layout.tsx` の server fetch

ファイル 52 行、 server fetch は **`getCurrentUser()` 1 箇所のみ** (28 行)。 内部で `auth()` + `users` SELECT、 結果で webhook race UI / zombie session redirect を判定。

dynamic 化を外せるか: **外せない**。 `auth()` が `cookies()` を読むため Next.js が自動 dynamic。 layout を static 化しても子 page 全 dynamic なので意味薄。

## 4. 根本原因 (impact 順)

### 4.1 `<Link prefetch>` default が全 dynamic page を並列で server に投げる (主因)

Next.js 15 の `<Link>` は `prefetch={true}` がデフォルト。 viewport に入った時点で `?_rsc=...` 付き GET を送り、 server が full RSC payload (= dynamic page を完全 SSR) を返す。 dashboard を開くと:

- header 5 link (`upload` `exams` `study/smart` `settings` `upgrade`) を prefetch
- dashboard CTA (`dashboard-actions.tsx:15`) で `study/smart` も prefetch
- → **5 並列**で他 page の SSR を server に要求

`/app/exams` だと header 4 + 試験一覧の `<Link href="/app/exams/[id]">詳細を見る</Link>` × 3 で **7 並列**。 `/app/settings` は header 4 + 法的 4 + upgrade で **9 並列**。

server 側では各 RSC が:
1. `auth()` (Clerk JWT decode、 net call 無し)
2. `users` SELECT (1 行、 ~1-10 ms)
3. page 固有の DB query 群 (dashboard なら streak + dueCount で 3 SELECT)

を実行。 server 1 page の cold SSR が 400-2000 ms。 prefetch 並列度が server を飽和させ、 体感的な navigation 遅延の主因になる。

### 4.2 dashboard `streak.ts` の SELECT 2 本が streaming body の 1629 ms を占有 (副因)

`lib/db/streak.ts:67-97` の `getReviewStatsForUser`:
1. `SELECT distinct_card_count FROM study_days WHERE user_id = ? AND day = ?` (今日件数)
2. `SELECT day::text FROM study_days WHERE user_id = ? AND day >= ? AND review_count > 0 ORDER BY day DESC` (直近 61 日 streak)

加えて `/app/page.tsx:15-18` で `SELECT count(*) FROM cards WHERE user_id=? AND due<=now()` (due count)。

合計 3 SELECT + getCurrentUser SELECT で 4 SELECT が逐次。 Neon serverless の per-query latency が乗算的に効く。

### 4.3 prefetch 別 RSC tree で `getCurrentUser()` が並列発火 (微少因)

`React.cache` は同一 RSC render tree 内のみ。 prefetch される別 page の RSC は別 render tree。 dashboard を開くと 5 並列 prefetch × (`auth` + `users` SELECT) が server に並列発火。 1 query は ~10 ms 程度なので「主因」 ではないが、 並列度が高い場面で connection pool / Neon serverless edge を圧迫する。

## 5. 改善案 (ROI 順)

1. **`<Link prefetch={false}>` を header (4-5) + 法的 (4) link に付与** — 一番効く。 5 行の変更で 1-2 秒の navigation 体感改善。 user の意図的 hover / focus 時のみ prefetch する `prefetch="hover"` (Next.js 15) 検討。
2. **dashboard 統計を Dexie 派生 / API 化** — `study_days` SELECT 2 本を client 側 `/api/dashboard/stats` 別 fetch + Suspense で段階表示。 streak は Dexie の `answer_events` 集計で近似可。
3. **`unstable_cache` で `getCurrentUser` の users SELECT を cache 化** — `revalidateTag('user:<clerk_id>')` 付き、 Clerk webhook で invalidate。 prefetch 9 並列下で 9× 効く。
4. **`/app/exams` の試験リスト link に `prefetch={false}`** — 試験数 N に比例。 7 並列 → 4 並列。
5. **`Server-Timing` header を主要 Route Handler で出す** — dev 体験向上 (DevTools で可視化)。

### Dexie 移行との接続

- S-cache-2 (card_mutations bulk) で編集系 revalidatePath が撤回可
- S-cache-3 (Dexie pre-sync) で dashboard 統計 / settings の server fetch を消せる
- 上記 (1) を Dexie 移行と並行で入れると、 (1) が即効性 (navigation 遅延)、 Dexie が中期 (server fetch 自体の縮小) で重ね順に効く

## 6. 検証手法 (再現用)

### Playwright MCP で直接 RSC fetch (cache MISS)

```js
async () => {
  const targets = ['/app', '/app/exams', '/app/study/smart', '/app/settings']
  const results = []
  for (const p of targets) {
    const url = `${location.origin}${p}?_rsc=measure${Date.now()}`
    const t0 = performance.now()
    const res = await fetch(url, { headers: { 'rsc': '1', /* router-state-tree */ } })
    const t1 = performance.now()
    const body = await res.text()
    const t2 = performance.now()
    results.push({
      path: p,
      ttfb_total_ms: Math.round(t1 - t0),
      body_ms: Math.round(t2 - t1),
      sizeBytes: body.length,
      cache: res.headers.get('x-vercel-cache'),
    })
  }
  return results
}
```

### Resource Timing で navigation 影響を切り分け

```js
() => {
  const r = performance.getEntriesByType('resource')
  const rsc = r.filter((e) => /\?_rsc=/.test(e.name))
  return {
    rscPrefetchCount: rsc.length,
    rscPrefetchPaths: rsc.map((e) =>
      new URL(e.name).pathname + ` (${Math.round(e.duration)}ms)`
    ),
  }
}
```

これで「navigation 1 回でどの page が prefetch され、 各々何 ms かかったか」 を一発で取れる。 ぜひ将来の perf 調査でも使い回す。

## 7. 参照 file

- 計測 raw: `.playwright-mcp/console-2026-05-25T12-56-39-712Z.log`
- 関連 lesson: `lessons/2026-05-25-link-prefetch-amplifies-server-load.md`
- 関連 source:
  - `lib/auth/ensure-user.ts:29-42` getCurrentUser
  - `app/(app)/app/layout.tsx:23-52` layout
  - `lib/db/streak.ts:67-97` dashboard streak (主要 hotspot)
  - `lib/exams/list.ts:39-54` exams 一覧 (B1 / S2.0c で denormalized 済、 これ自体は高速)
  - `middleware.ts` clerkMiddleware + auth.protect()
  - `next.config.ts` (`experimental.staleTimes` 未設定 = Next.js 15 default `dynamic=0`)
  - `app/(app)/app/_components/app-header.tsx` header 5 Link (prefetch default 現状)
  - `app/(app)/app/_components/dashboard-actions.tsx` dashboard CTA Link
- 関連 spec:
  - `docs/02-tech-spec.md` §9.1 PWA キャッシュ戦略 / §14.7.1 演習トリガ
  - `docs/02-tech-spec.md` §13.14 local-first 設計
