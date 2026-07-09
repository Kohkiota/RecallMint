// Session value objects (pure)。 session 行の状態規則を DB I/O から切り離した
// 純粋 domain module。 runtime import ゼロ (許可は `import type` のみ) —
// drizzle / @/lib/db / logger / next / zod は import しない。
//
// 挙動不変制約: 遷移規則は spec §3.1・§6.1 の遷移表を verbatim に表す。
// R phase は additive only — 本 module は誰からも import されない (配線は W)。

// StudySession.status の 3 値 (schema $type と同値)。
export type SessionStatus = 'active' | 'completed' | 'abandoned'

// status 書込の許否を判定する遷移規則の唯一の定義 (spec §3.1)。
//   - current === 'active'  → 常に true (前進・abandoned 化・active 再送すべて)
//   - current が terminal    → incoming === current のみ true (冪等再送)
//   - それ以外 (terminal→別値) → false = 後退遷移
// fresh insert (既存行なし) は遷移概念なし = ガード対象外 (規則は conflict 時のみ・
// 呼ぶ側 = repository の upsertSessionGuarded が judge する)。
//
// completed_at の規則 (status と別に明示・spec §3.1 verbatim): completed_at は
// set 節ごと status ガードに従属する。ガード通過時 (same-status 再送含む) は
// 現行どおり LWW (payload 値で更新)、ガード不発時は status とともに保護
// (null 上書き・巻き戻し不可)。terminal timestamp の初回凍結はしない (挙動変更は
// status のみ)。active→abandoned の completed_at は現行どおり payload 依存
// (client の abandon は completed_at を送らない → null。abandoned_at 列は追加しない)。
// canApplyStatusWrite 自体は status のみを判定する純関数 — completed_at は
// 呼ぶ側 (repository) が set 節に含める/含めないで従属させる。
export function canApplyStatusWrite(
  current: SessionStatus,
  incoming: SessionStatus,
): boolean {
  if (current === 'active') return true
  // current が terminal (completed / abandoned): 同一 status の冪等再送のみ許可
  return incoming === current
}
