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
