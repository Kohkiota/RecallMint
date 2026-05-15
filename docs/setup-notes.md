# プロジェクト立ち上げ時の必須修正ノート

このファイルは **新規プロジェクト立ち上げ時に 1 回だけ参照** する。
`pnpm create next-app` 直後、以下 3 点を必ず実施すること。
Drizzle + Neon serverless と Playwright MCP との組み合わせで、
scaffold デフォルトのままでは動かない / dev server が無限ループする
箇所がある。スキップしないこと。

## 1. bufferutil / utf-8-validate の追加

Neon serverless driver の WebSocket 接続には `bufferutil` と
`utf-8-validate` の native binding が必須。これ無しだと初回クエリで
`TypeError: bufferUtil.mask is not a function` で落ちる。

```bash
pnpm add bufferutil utf-8-validate
```

さらに `package.json` に以下を追記すること（pnpm は native binding を
明示承認しないとビルドしないため、漏らすと無音で動かない）:

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["bufferutil", "utf-8-validate"]
  }
}
```

scaffold 後、Neon に対して `SELECT 1 AS ok` を投げる疎通スクリプトで
ドライバが動くことを確認してから先に進むこと。

## 2. `next.config.ts` の watchOptions 設定

Playwright MCP は `.playwright-mcp/` 以下に browser snapshot を大量生成する。
Next.js dev がこれを watch すると Compile が無限ループに入って開発が止まる。

`next.config.ts` に以下を追加すること:

```ts
const nextConfig: NextConfig = {
  watchOptions: {
    ignored: ["**/.playwright-mcp/**"],
  },
};
```

## 3. `.gitignore` への追加

scaffold デフォルトの `.gitignore` に以下 2 行を追加すること:

```
.playwright-mcp/
tsconfig.tsbuildinfo
```

`.playwright-mcp/` は MCP の作業ディレクトリ、`tsconfig.tsbuildinfo` はTypeScript の incremental build キャッシュ。どちらも commit するとdiff を汚すだけ。
