// @vitest-environment jsdom
// waitForExamInMirror の test (Grid-3 T6 fix round 3)。
//
// 待機の 3 性質を pin する:
//   ① 既に mirror にある → **1 度も待たない** (不要な遅延を入れない)
//   ② 待っている間に現れる → 再クリックなしで true になる (現れるまでの回数だけ待つ)
//   ③ 現れないまま上限に達する → false で打ち切る (待機回数 = 上限 - 1)
// mirror は fake-indexeddb の実 read。待機は seam (`wait`) を注入して実時間で待たない。

import { describe, it, expect, beforeEach } from 'vitest'

import { getClientDb, type ClientExam } from '@/lib/client-db'
import {
  waitForExamInMirror,
  EXAM_MIRROR_POLL_ATTEMPTS,
  EXAM_MIRROR_POLL_INTERVAL_MS,
} from './wait-for-exam-mirror'

const USER_ID = 'user-wait'
const EXAM_ID = 'exam-wait'

function makeExam(id: string, userId = USER_ID): ClientExam {
  return {
    id,
    user_id: userId,
    name: '無題の試験',
    content_version: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

/** 呼出間隔を記録するだけの no-op 待機 (実時間で待たない)。 */
function makeWaitSpy(onWait?: (calls: number) => Promise<void> | void) {
  const intervals: number[] = []
  const wait = async (ms: number) => {
    intervals.push(ms)
    await onWait?.(intervals.length)
  }
  return { wait, intervals }
}

beforeEach(async () => {
  await getClientDb().exams.clear()
})

describe('waitForExamInMirror', () => {
  it('既に mirror にあれば待たずに true を返す', async () => {
    await getClientDb().exams.put(makeExam(EXAM_ID))
    const { wait, intervals } = makeWaitSpy()

    await expect(waitForExamInMirror(EXAM_ID, USER_ID, wait)).resolves.toBe(true)

    expect(intervals).toHaveLength(0)
  })

  it('待っている間に現れたら true を返す (現れるまでの回数だけ待つ)', async () => {
    const { wait, intervals } = makeWaitSpy(async (calls) => {
      // 2 回目の待機中に pull が着地したことにする。
      if (calls === 2) await getClientDb().exams.put(makeExam(EXAM_ID))
    })

    await expect(waitForExamInMirror(EXAM_ID, USER_ID, wait)).resolves.toBe(true)

    expect(intervals).toEqual([
      EXAM_MIRROR_POLL_INTERVAL_MS,
      EXAM_MIRROR_POLL_INTERVAL_MS,
    ])
  })

  it('現れないまま上限に達したら false で打ち切る', async () => {
    const { wait, intervals } = makeWaitSpy()

    await expect(waitForExamInMirror(EXAM_ID, USER_ID, wait)).resolves.toBe(false)

    // 確認 ATTEMPTS 回 = 待機はその間の ATTEMPTS - 1 回 (最後の確認後は待たない)。
    expect(intervals).toHaveLength(EXAM_MIRROR_POLL_ATTEMPTS - 1)
    // 上限は「有限」だけでなく **主操作が待てる長さ** であること。定数を緩めても
    // 相対 assertion は追随してしまうため、総待機予算を絶対値で押さえる。
    expect(EXAM_MIRROR_POLL_ATTEMPTS * EXAM_MIRROR_POLL_INTERVAL_MS).toBeLessThanOrEqual(2_000)
  })

  it('他 user の行は見つけたことにしない (owner scope)', async () => {
    await getClientDb().exams.put(makeExam(EXAM_ID, 'other-user'))
    const { wait, intervals } = makeWaitSpy()

    await expect(waitForExamInMirror(EXAM_ID, USER_ID, wait)).resolves.toBe(false)

    expect(intervals).toHaveLength(EXAM_MIRROR_POLL_ATTEMPTS - 1)
  })
})
