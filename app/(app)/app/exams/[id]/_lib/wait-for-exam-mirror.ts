// waitForExamInMirror — 切り出し (Grid-3 spec §6.1) が「作成した exam が Dexie mirror に
// 載る」のを上限付きで待つ helper。
//
// なぜ pull の outcome を見ないか: `runGuardedPull` の `lock-busy` / `inflight-skip` は
// **別の pull が Web Lock を保持している常態**を表すだけで、間を置かず呼び直しても同じ
// skip が返る (即時 retry は実質機能しない)。移動が必要とするのは outcome ではなく
// **mirror に移動先 exam の行が居ること** なので、その前提を直接待つ。
//
// 上限は必ず有限 (無限待ち・無制限リトライにしない)。上限に達したら false を返し、呼出元は
// 従来どおり移動を試して失敗分岐 (ref の保持 / 破棄) に落とす。
//
// mirror へは **読みしか行わない** (exams は pull 上書きのみの read-only レーン)。

import { getClientDb } from '@/lib/client-db'

/** 1 回の待機間隔。 */
export const EXAM_MIRROR_POLL_INTERVAL_MS = 150
/** mirror を確認する回数の上限 (= 待機は最大 ATTEMPTS - 1 回 ≈ 1.35 秒)。 */
export const EXAM_MIRROR_POLL_ATTEMPTS = 10

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * `examId` の行が自 user のものとして mirror に現れたら true。上限まで現れなければ false。
 *
 * @param wait test が実時間で待たないための seam (既定は setTimeout)。呼出回数が
 *   そのまま「何回待ったか」= 上限の検証点になる。
 */
export async function waitForExamInMirror(
  examId: string,
  userId: string,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<boolean> {
  const db = getClientDb()
  for (let attempt = 0; attempt < EXAM_MIRROR_POLL_ATTEMPTS; attempt += 1) {
    // 先に確認する: 既に居るなら 1 度も待たない (不要な遅延を入れない)。
    const row = await db.exams.get(examId)
    if (row?.user_id === userId) return true
    if (attempt + 1 < EXAM_MIRROR_POLL_ATTEMPTS) await wait(EXAM_MIRROR_POLL_INTERVAL_MS)
  }
  return false
}
