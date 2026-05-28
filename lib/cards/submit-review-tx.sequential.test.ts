// 同一 card への複数 submitReviewTx 順次 apply の invariant test。
// 既存 submit-review-tx.test.ts は @/lib/fsrs を mock して reps 固定値にするため
// 「reps が apply 数分 increment する」累積挙動が確認できない。
// 本ファイルは @/lib/fsrs を mock せず実 ts-fsrs rate() を使い、
// stateful tx mock で「前 apply の結果を次 select に反映」させることで
// 実 DB なしに同 card 順次 apply の正しさを保証する回帰 guard とする。

import { describe, it, expect } from 'vitest'
import type { RatingInt } from '@/lib/fsrs'

// drizzle-orm sql テンプレートを stub — 実 DB は使わない
import { vi } from 'vitest'
vi.mock('drizzle-orm', async (importActual) => {
  const real = await importActual<typeof import('drizzle-orm')>()
  return {
    ...real,
    sql: Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => ({
        __sql: strings.join('?'),
      }),
      real.sql,
    ),
  }
})

// @/lib/fsrs は mock しない — 実 ts-fsrs rate() で累積 FSRS state を検証する

import { submitReviewTx } from './submit-review-tx'

// -----------------------------------------------------------------------
// Stateful tx mock
// 「現在の card 行」を変数に保持し、update で書き換え、select で返す。
// これで実 DB なしに同 card への順次 apply を再現する。
// -----------------------------------------------------------------------
type CardRow = {
  id: string
  userId: string
  due: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  reps: number
  lapses: number
  state: 0 | 1 | 2 | 3
  learningSteps: number
  lastReview: Date | null
  answered: boolean
  lastCorrect: boolean | null
  currentStreak: number
}

function makeStatefulTx(initialRow: CardRow) {
  // 「現在の card 行」を closure で保持する
  let currentRow: CardRow = { ...initialRow }

  const tx = {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => Promise.resolve([{ ...currentRow }]),
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        // update の set 値を currentRow に反映 — 次の select に引き継がれる
        currentRow = { ...currentRow, ...(vals as Partial<CardRow>) }
        return {
          where: (_cond: unknown) => Promise.resolve(),
        }
      },
    }),
    insert: (_table: unknown) => ({
      values: (_vals: unknown) => ({
        onConflictDoUpdate: (_conf: unknown) => Promise.resolve(),
      }),
    }),
    // distinct count は invariant 対象外のため固定値を返す
    execute: (_query: unknown) => Promise.resolve([{ c: 1 }]),
    // 現在の card row を読み出す (検証用)
    _currentRow: () => currentRow,
  }

  return tx
}

// 新規 card 相当の初期 row — ts-fsrs createEmptyCard() と同等の値
function makeNewCardRow(overrides: Partial<CardRow> = {}): CardRow {
  return {
    id: 'card-seq',
    userId: 'user-seq',
    due: new Date('2026-05-28T00:00:00Z'),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    reps: 0,
    lapses: 0,
    state: 0,
    learningSteps: 0,
    lastReview: null,
    answered: false,
    lastCorrect: null,
    currentStreak: 0,
    ...overrides,
  }
}

// -----------------------------------------------------------------------
// Case A: 全 correct — Hard(2) → Good(3) → Easy(4)
// -----------------------------------------------------------------------
describe('同一 card 順次 apply: ケース A (全 correct)', () => {
  it('reps が apply 数分 increment し、streak が連続 correct で増加し、due が各 now より将来になる', async () => {
    const initialRow = makeNewCardRow()
    const initialReps = initialRow.reps // = 0

    const tx = makeStatefulTx(initialRow)

    const ratings: RatingInt[] = [2, 3, 4] // Hard → Good → Easy
    const nows = [
      new Date('2026-05-28T10:00:00Z'),
      new Date('2026-05-28T10:01:00Z'),
      new Date('2026-05-28T10:02:00Z'),
    ]

    const streakHistory: number[] = []
    const dueHistory: Date[] = []

    for (let i = 0; i < ratings.length; i++) {
      await submitReviewTx(tx as never, {
        userId: 'user-seq',
        cardId: 'card-seq',
        rating: ratings[i],
        now: nows[i],
      })
      // 各 apply 直後の state を記録
      streakHistory.push(tx._currentRow().currentStreak)
      dueHistory.push(tx._currentRow().due)
    }

    // reps が apply 数分 increment している (初期 reps からの増分 = apply 回数)
    const finalReps = tx._currentRow().reps
    expect(finalReps - initialReps).toBe(ratings.length)

    // currentStreak が correct 連続で単調増加 (0→1→2→3)
    expect(streakHistory[0]).toBe(1)
    expect(streakHistory[1]).toBe(2)
    expect(streakHistory[2]).toBe(3)

    // 各 apply 後の due が適用時の now より将来である
    for (let i = 0; i < ratings.length; i++) {
      expect(dueHistory[i].getTime()).toBeGreaterThan(nows[i].getTime())
    }
  })
})

// -----------------------------------------------------------------------
// Case B: incorrect 混在 — Good(3) → Again(1) → Good(3)
// -----------------------------------------------------------------------
describe('同一 card 順次 apply: ケース B (incorrect 混在)', () => {
  it('Again で streak が 0 にリセットされ、その後の correct で再び 1 になる', async () => {
    const initialRow = makeNewCardRow()
    const tx = makeStatefulTx(initialRow)

    const ratings: RatingInt[] = [3, 1, 3] // Good → Again → Good
    const nows = [
      new Date('2026-05-28T10:00:00Z'),
      new Date('2026-05-28T10:01:00Z'),
      new Date('2026-05-28T10:02:00Z'),
    ]

    // 1 回目: Good(3) → correct → streak 1
    await submitReviewTx(tx as never, {
      userId: 'user-seq',
      cardId: 'card-seq',
      rating: ratings[0],
      now: nows[0],
    })
    expect(tx._currentRow().currentStreak).toBe(1)

    // 2 回目: Again(1) → incorrect → streak 0 にリセット
    await submitReviewTx(tx as never, {
      userId: 'user-seq',
      cardId: 'card-seq',
      rating: ratings[1],
      now: nows[1],
    })
    expect(tx._currentRow().currentStreak).toBe(0)

    // 3 回目: Good(3) → correct → streak 1 に再起動
    await submitReviewTx(tx as never, {
      userId: 'user-seq',
      cardId: 'card-seq',
      rating: ratings[2],
      now: nows[2],
    })
    expect(tx._currentRow().currentStreak).toBe(1)

    // reps は 3 回 apply 分 increment している (incorrect でも reps は増える)
    expect(tx._currentRow().reps - initialRow.reps).toBe(ratings.length)
  })
})
