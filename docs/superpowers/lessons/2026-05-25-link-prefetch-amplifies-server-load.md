# `<Link>` default prefetch が dynamic page で server 並列負荷を増幅する

> **Source**: stg 上の S-cache-1 smoke 後の perf 調査 (2026-05-25)。 詳細データは
> `sessions/2026-05-25-stg-perf-rsc-prefetch-amplification.md`。

## 1. 背景

stg `https://stg.recallmint.nekotest.net` の主要 page (`/app` / `/app/exams` /
`/app/study/smart` / `/app/settings` 等) で navigation が体感的に遅い。 Playwright
+ Resource Timing で計測したところ、 navigation 1 回ごとに `?_rsc=...` 付きの
GET が **5〜9 並列**で server に飛んでおり、 server は各 page を full SSR して
RSC payload を返していた (各 400-650 ms TTFB、 cold 時は 1000-2000 ms)。

正体は Next.js の `<Link>` default `prefetch={true}` 挙動。 viewport に入った
時点で全 link の destination を裏で prefetch し、 dynamic page では full RSC
payload を server に要求する。 dynamic page は cookies (Clerk auth) を読むため
全 page が dynamic に倒れており、 prefetch 1 件あたり「`auth()` + `users` SELECT
+ page 固有 DB query」 一式が server で走る。

## 2. Lessons Learned

### 2.1 「dynamic page × default prefetch」 は並列度が掛け算で増える

`<Link>` を view にいくつ並べたかが、 prefetch 並列度になる。 mcq-platform の
実測:

- dashboard を開く → header 5 link を prefetch → **5 並列 RSC SSR**
- 試験一覧を開く → header 4 link + 試験 N 件の link を prefetch → **(4 + N) 並列**
  (試験 3 件で 7 並列を観測)
- 設定 page → header 4 + 法的 4 + upgrade で **9 並列**

並列度はあくまで「同時 fetch 数」 だが、 server が serverless function (Vercel) の
場合は per-instance request limit + Neon serverless connection 数 + 各 page の
SSR コストの合計で「実体感としての navigation 遅延」 を作る。

### 2.2 dynamic page では `React.cache` は cross-render を救えない

`getCurrentUser()` を `React.cache()` で wrap しているが、 cache の射程は
**同一 RSC render tree 内のみ**。 `<Link>` prefetch される別 page の RSC は別
render tree なので、 `auth()` + `users` SELECT は **並列発火回数分**実行される。

「layout + page で同じ user を引かないように React.cache で守る」 は dev 期に
有効でも、 prefetch 並列度を増やすと無意味になる。 cross-render で守るには
`unstable_cache` + `revalidateTag` が必要。

### 2.3 「dashboard 体感遅い」 の犯人は dashboard 自身ではなく header 5 link

dashboard 単体の RSC SSR は ~2000 ms だが、 navigation 体感遅延の主因は
「dashboard 開いた瞬間に他 5 page を同時に SSR している」 ことの方が大きい。
1 page の SSR を 500 ms 短縮するよりも、 prefetch 5 並列を 0 に倒す方が
体感改善は早い。

### 2.4 改善は「dynamic page なら prefetch={false}」 から

5 行程度の変更で 1-2 秒の navigation 体感改善が見込める:

```tsx
<Link href="/app/exams" prefetch={false}>試験</Link>
```

または Next.js 15 で導入された `prefetch="hover"` (意図的 hover / focus 時のみ
prefetch) を使う。

dynamic page を頻繁に並べる場所 (header / footer / 法的 link / 一覧の各行 link)
は default prefetch を切るのを基本にする。 static page (`/contact` 等) は
default で良い。

### 2.5 計測 snippet を残す (再現性)

将来の perf 調査で何度も書き直さないため:

```js
// 直接 RSC fetch (cold cache 計測)
async function probeRsc(paths) {
  const out = []
  for (const p of paths) {
    const url = `${location.origin}${p}?_rsc=measure${Date.now()}`
    const t0 = performance.now()
    const res = await fetch(url, { headers: { 'rsc': '1' } })
    const t1 = performance.now()
    const body = await res.text()
    const t2 = performance.now()
    out.push({
      path: p,
      ttfb_ms: Math.round(t1 - t0),
      body_ms: Math.round(t2 - t1),
      sizeBytes: body.length,
      cache: res.headers.get('x-vercel-cache'),
    })
  }
  return out
}

// navigation 1 回ごとの並列 prefetch を一発で観測
function probePrefetch() {
  const r = performance.getEntriesByType('resource')
  const rsc = r.filter((e) => /\?_rsc=/.test(e.name))
  return {
    count: rsc.length,
    paths: rsc.map((e) => new URL(e.name).pathname + ` (${Math.round(e.duration)}ms)`),
  }
}
```

Playwright MCP の `browser_evaluate` から流すと数秒で計測完了。

## 3. 適用範囲

- Next.js 15 App Router + Clerk (auth で cookies を読む) + Drizzle / Neon
- 同 stack の別 project (devcontainer-template 系) でも同じ pitfall を踏む
- production / preview / stg 全 environment で起こる (Vercel cache MISS 時に
  最大の影響)

## 4. 関連

- `docs/superpowers/sessions/2026-05-25-stg-perf-rsc-prefetch-amplification.md` (本 lesson の元データ)
- `docs/02-tech-spec.md` §9.1 PWA キャッシュ戦略 (Dexie 化で server fetch 自体を縮小する中期方針)
- `docs/02-tech-spec.md` §13.14 local-first 設計
