# Vercel Functions 実行リージョンを東京 (hnd1) に固定

- 日時: 2026-05-29
- 種別: session log / deploy config 変更 (vercel.json)
- branch: develop
- 対象: 全 Vercel (serverless) Functions の実行リージョンを `hnd1` 単一に固定
- 結論: **`vercel.json` top-level `"regions": ["hnd1"]`** を採用 (route segment `preferredRegion` は非推奨のため不採用)

---

## 1. Context7 / 公式ドキュメント裏取り

### Next.js (`/vercel/next.js`、 本プロジェクト 15.5.15)

- **`preferredRegion` (route segment config) は DEPRECATED**。 公式 docs に「This export is deprecated and should be removed」「previously worked with the now-deprecated `edge` runtime」と明記。
- = App Router の `export const preferredRegion` は **使わない** (deprecated + edge runtime 前提の旧機構)。

### Vercel 公式 (Configuring regions for Vercel Functions、 2026-05 更新)

- `vercel.json` の top-level **`regions`** キーに region code を入れると、 **全 serverless functions の project-level default 実行 region** を指定できる。 既定は `iad1` (Washington D.C.)。
- 単一 region 固定 = `"regions": ["hnd1"]`。
- 複数 region は Pro (最大 3) / Enterprise (無制限)。 個別 function は `functions.<path>.regions` で override 可 (本件では不要)。

→ **「vercel.json regions」 と 「preferredRegion」 のどちらか** という問いの答え: **vercel.json regions** が正解 (preferredRegion は非推奨)。

---

## 2. runtime 判定 (実コード verify、 推測なし)

- API routes 9 本すべて `export const runtime = 'nodejs'` を宣言:
  `app/api/{webhooks/clerk, webhooks/stripe, dashboard/stats, review-events/bulk, cards/pull, exams/pull, exams/status, me/deletion-status, study-days/pull}/route.ts`
- `runtime = 'edge'` の宣言は **ゼロ** (grep 確認)。 `preferredRegion` 既存使用も **ゼロ**。
- DB 層 `lib/db/index.ts` は `drizzle-orm/postgres-js` + `import 'server-only'` = Node.js 専用 (Edge 不可)。 → API routes が Node.js runtime なのは必然。
- `middleware.ts` は `clerkMiddleware` (Edge runtime)。 middleware は設計上 edge で global 実行され、 `vercel.json regions` の対象外 (軽量 auth check のみ、 DB 非依存なので region pin 不要)。

→ **DB を触る重い処理 = 全部 Node.js serverless functions** = `vercel.json regions` の対象。 採用方法は runtime と整合。

---

## 3. 採用した設定と理由

`vercel.json` に top-level `"regions": ["hnd1"]` を追記 (既存 `$schema` / `functions` と共存):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["hnd1"],
  "functions": {
    "app/api/webhooks/clerk/route.ts": { "maxDuration": 60 },
    "app/api/webhooks/stripe/route.ts": { "maxDuration": 60 }
  }
}
```

- top-level `regions` は project-level default なので **全 functions に適用**。 既存 `functions` の 2 webhook entry は `maxDuration` のみで `regions` を持たないため、 top-level の `hnd1` を継承する (= 全 function が hnd1)。
- `preferredRegion` を全 route に撒く案は非推奨 API + メンテ煩雑のため不採用。 vercel.json 1 箇所で全体固定が公式推奨かつ最小変更。
- 単一 region 固定なので Vercel plan tier 制約 (複数 region = Pro+) には抵触しない。

### 期待効果 (要 OT 確認)

- 問題 3 before/after 計測で function region は `iad1` (US) だった (x-vercel-id `hnd1::iad1` = edge hnd1 / function iad1)。 これを `hnd1` (東京) に移すと、 **Supabase DB が東京/AP region にある場合 function↔DB RTT が短縮**し、 問題 3 で残った ~1.6s 上振れ (cross-region RTT 由来の疑い) の改善が期待できる。
- ただし latency 改善量は **DB の実 region 次第** (DB が US なら逆効果)。 DB region と実 VERCEL_REGION は OT が deploy 後に確認。

---

## 4. 検証

- `vercel.json` は valid JSON (`node -e require` で確認)。 `$schema` 準拠 (`regions` は公式キー)。
- `pnpm build` → **exit 0** (クリーン)。 ※ `next build` は vercel.json を読まないため build はリグレッション無確認用。 region 設定自体の検証は deploy 後。
- **未実施 (OT 担当)**: deploy 後に `process.env.VERCEL_REGION` が `hnd1` を返すこと / function↔DB RTT の実測。

---

## 5. スコープ / 制約

- 変更は `vercel.json` 1 ファイル + 本 session log のみ。 アプリコード非変更。
- commit のみ、 push は OT (commit-only)。
- middleware (Edge) は対象外 (設計通り global edge 実行)。
