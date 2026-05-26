// vitest 用 stub。 server-only package の `react-server` export condition で
// 配布される empty.js (no-op) と同等内容。
// 実 runtime (Next.js client bundle) では server-only/index.js が throw する
// guard を介して client への漏出を build 時に検出する。 一方 vitest は node env で
// 全 module を node として評価するため、 同 guard を経由するだけで test が全部
// 落ちる。 そこで vitest.config.ts の resolve.alias で本 stub を指定する。
//
// 副作用なし、 export なし。 import 'server-only' をただの no-op に倒すだけ。
