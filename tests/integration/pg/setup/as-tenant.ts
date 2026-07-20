// RLS-P2: iso test 内で「刺激 (app 関数 under test)」を app role + tenant context で
// 走らせる boilerplate 削減 helper。本番の owner-scoped 経路 (read=Task3 / write=Task4
// 等) が withTenantTx で app.user_id GUC を張るのと同じ配線を test でも再現する。
//
// 使い分け (brief の原則):
//   - 刺激 (getActiveExamsForUser / applyCardDelete 等・db/tx を受ける helper) = asTenant。
//   - 観測 (ground-truth な行状態 read) + seed = owner (getFixtureOwnerDb)。RLS を bypass。
//   - 自前で withTenantTx / setTenantContext する server 関数 (deleteExam /
//     completeUploadTx 等) は既に内部で context を張るため asTenant で二重に包まない。
import { getDb } from '@/lib/db'
import { withTenantTx, type TenantTx } from '@/lib/db/tenant-tx'

export function asTenant<T>(
  userId: string,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return withTenantTx(getDb(), userId, fn)
}
