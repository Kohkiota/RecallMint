// RLS-P2 Task 9: 新規 behavioral test 群が共有する SQLSTATE 判定 helper。
// 既存 rls-functions.test.ts / role-privilege.test.ts が file-local に持つ
// cause-chain walker と同型だが、Task 9 の 3 file (per-command / context / ghost)
// が同じ 2 種の reject を assert するため共有化する (rule of three)。
//
// RLS-P3 Task 7: hasSqlState / isP0RLS は production (lib/db/p0rls.ts) へ移し、
// P0RLS loud alert (reportRlsContextFailure) と同一実装を共有する。test はそこから
// re-export し、既存 import 面 (`from './setup/rls-assert'`) を維持する。依存方向は
// production ← test の一方向 (production は tests/ に依存しない)。
import { hasSqlState, isP0RLS } from '@/lib/db/p0rls'

export { hasSqlState, isP0RLS }

// RLS の WITH CHECK 違反 (INSERT / user_id 付替え UPDATE の new row が policy を
// 満たさない) は SQLSTATE 42501 + message 'new row violates row-level security
// policy for table ...'。42501 は permission-denied とも重なるため、本 suite の
// 刺激 (app-role は DML 権限を持つ = 42501 の出所は RLS のみ) では code で足りるが、
// 環境差の message ゆらぎに備え RLS 固有 message も OR で許容する。
export function isRlsViolation(err: unknown): boolean {
  if (hasSqlState(err, '42501')) return true
  const message = err instanceof Error ? err.message : String(err)
  return /row-level security/i.test(message)
}

async function assertRejectsWith(
  op: () => Promise<unknown>,
  predicate: (err: unknown) => boolean,
  label: string,
): Promise<void> {
  let caught: unknown
  let resolved = false
  try {
    await op()
    resolved = true
  } catch (e) {
    caught = e
  }
  if (resolved) {
    throw new Error(`expected the operation to reject with ${label}, but it resolved`)
  }
  if (!predicate(caught)) {
    throw new Error(`expected ${label}, got ${String(caught)}`)
  }
}

// context 未設定/空文字での P0RLS RAISE を assert する。
export function assertRejectsWithP0RLS(op: () => Promise<unknown>): Promise<void> {
  return assertRejectsWith(op, isP0RLS, 'SQLSTATE P0RLS')
}

// WITH CHECK 違反 (RLS policy 違反) での reject を assert する。
export function assertRejectsWithRlsViolation(
  op: () => Promise<unknown>,
): Promise<void> {
  return assertRejectsWith(op, isRlsViolation, 'an RLS policy violation (42501)')
}
