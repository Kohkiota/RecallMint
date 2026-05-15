// TODO Sprint A-3+: `words` フィールドは vocab 撤去 (Sprint A-2) で dead。
// mcq では Tech Spec §6 (OCR pages 月次上限 + 試験数) に置換される。
// Sprint A-3+ の subscription 配線で再定義予定、 それまで型互換のため残置。
export const PLAN_LIMITS = {
  free: { words: 100, aiGenPerDay: 10 },
  pro: { words: 2000, aiGenPerDay: 100 },
} as const

export type Plan = keyof typeof PLAN_LIMITS

export function limitsFor(plan: Plan): (typeof PLAN_LIMITS)[Plan] {
  return PLAN_LIMITS[plan]
}
