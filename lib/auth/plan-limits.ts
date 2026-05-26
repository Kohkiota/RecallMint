// Plan limits — mcq-platform (Sprint A-3.2 rewrite)
//
// ocrPagesPerMonth は AI OCR の月次上限 (Free 30 / Standard 300 / Pro = null
// は「公平利用 = 上限なし」、Tech Spec で月間運用上限の運用ガード後付け予定)。
// 旧 PLAN_LIMITS の words / aiGenPerDay は vocab 撤去 (Sprint A-2) で消滅、
// mcq では本構造に置換される。
//
// 月次ページ数チェック / 同時実行 1 OCR ジョブ / Edge レート制限 等の制限機構
// 本体は Sprint B / E で実装、本 file は値の定義のみ持つ。
export const PLAN_LIMITS = {
  free: { ocrPagesPerMonth: 30 },
  standard: { ocrPagesPerMonth: 300 },
  pro: { ocrPagesPerMonth: null },
} as const

export type Plan = keyof typeof PLAN_LIMITS

export function limitsFor(plan: Plan): (typeof PLAN_LIMITS)[Plan] {
  return PLAN_LIMITS[plan]
}

// `limitsFor` の safety net 版。 plan が undefined / null / 未知の文字列だった
// 場合に「free」 にフォールバックする。 SSR 経路 (例: /app/upload page.tsx) で
// JWT claim 未浸透 / DB 値の異常などで Plan 型を満たさない値が runtime で漏れて
// きたとき、 `PLAN_LIMITS[plan]` が undefined を返して
// 「Cannot read properties of undefined (reading 'ocrPagesPerMonth')」 で
// 画面全体が落ちる事故を構造的に防ぐ。
//
// 設計判断:
// - default は安全側 (= 厳しい側) で `free`。 paid plan を誤って与えて quota
//   増を許す方向には倒さない。
// - 「未確定」 と「明示的に既知 plan」 の区別が呼出側で必要な場合は本関数を
//   使わず限定的に分岐すること (本関数はあくまで最終防護網)。
export function limitsForOrFree(
  plan: Plan | string | null | undefined,
): (typeof PLAN_LIMITS)[Plan] {
  if (plan && (plan === 'free' || plan === 'standard' || plan === 'pro')) {
    return PLAN_LIMITS[plan]
  }
  return PLAN_LIMITS.free
}
