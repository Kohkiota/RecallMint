import { describe, it, expect } from 'vitest'
import {
  isSweepEligible,
  shouldMarkUnreferenced,
  shouldClearUnreferenced,
  isFinalized,
  canFinalize,
  canPromoteToDeleting,
  canSweepDelete,
  allowsNewReference,
  type AssetStatus,
} from './asset-state'

const ALL_STATUSES: AssetStatus[] = ['reserved', 'ready', 'deleting', 'deleted']

describe('isSweepEligible', () => {
  const graceDays = 30
  const now = new Date('2026-07-14T00:00:00.000Z')

  it('unreferencedAt が null なら false (未マークは対象外)', () => {
    expect(isSweepEligible(null, graceDays, now)).toBe(false)
  })

  it('grace 未満の経過 (29 日前) は false', () => {
    const unreferencedAt = new Date('2026-06-15T00:00:00.000Z') // 29 days before now
    expect(isSweepEligible(unreferencedAt, graceDays, now)).toBe(false)
  })

  it('ちょうど grace 境界 (30 日前 = 差が正確に interval) は false (spec §4.4 の `<` = strict older に揃える)', () => {
    const unreferencedAt = new Date('2026-06-14T00:00:00.000Z') // exactly 30 days before now
    expect(isSweepEligible(unreferencedAt, graceDays, now)).toBe(false)
  })

  it('grace を 1ms でも超えた経過は true', () => {
    const unreferencedAt = new Date('2026-06-13T23:59:59.999Z') // 30 days + 1ms before now
    expect(isSweepEligible(unreferencedAt, graceDays, now)).toBe(true)
  })

  it('grace を大幅に超えた経過 (60 日前) は true', () => {
    const unreferencedAt = new Date('2026-05-15T00:00:00.000Z')
    expect(isSweepEligible(unreferencedAt, graceDays, now)).toBe(true)
  })

  it('graceDays 0 の場合、unreferencedAt が now と同一瞬間なら false (strict older)', () => {
    expect(isSweepEligible(now, 0, now)).toBe(false)
  })

  it('graceDays 0 の場合、unreferencedAt が過去なら true', () => {
    const unreferencedAt = new Date('2026-07-13T23:59:59.999Z')
    expect(isSweepEligible(unreferencedAt, 0, now)).toBe(true)
  })
})

describe('shouldMarkUnreferenced', () => {
  const marked = new Date('2026-07-01T00:00:00.000Z')

  it('mark-eligible status + 参照ゼロ + 未マークなら true', () => {
    expect(shouldMarkUnreferenced('reserved', false, null)).toBe(true)
    expect(shouldMarkUnreferenced('ready', false, null)).toBe(true)
  })

  it('参照ありなら false (hasRefs=true は set 対象外)', () => {
    expect(shouldMarkUnreferenced('reserved', true, null)).toBe(false)
    expect(shouldMarkUnreferenced('ready', true, null)).toBe(false)
  })

  it('既にマーク済み (unreferencedAt 非 null) なら false (二重 set 防止)', () => {
    expect(shouldMarkUnreferenced('reserved', false, marked)).toBe(false)
    expect(shouldMarkUnreferenced('ready', false, marked)).toBe(false)
  })

  it('mark-eligible でない status (deleting / deleted) は常に false', () => {
    expect(shouldMarkUnreferenced('deleting', false, null)).toBe(false)
    expect(shouldMarkUnreferenced('deleted', false, null)).toBe(false)
  })

  it('deleting/deleted は他条件を満たしても false (promote 済ゆえ mark 対象外)', () => {
    expect(shouldMarkUnreferenced('deleting', true, marked)).toBe(false)
    expect(shouldMarkUnreferenced('deleted', true, marked)).toBe(false)
  })
})

describe('shouldClearUnreferenced', () => {
  const marked = new Date('2026-07-01T00:00:00.000Z')

  it('再参照 + 現在マーク済みなら true (self-heal)', () => {
    expect(shouldClearUnreferenced(true, marked)).toBe(true)
  })

  it('参照が戻っていない (hasRefs=false) なら false', () => {
    expect(shouldClearUnreferenced(false, marked)).toBe(false)
  })

  it('未マーク (unreferencedAt=null) なら clear 不要ゆえ false', () => {
    expect(shouldClearUnreferenced(true, null)).toBe(false)
    expect(shouldClearUnreferenced(false, null)).toBe(false)
  })
})

describe('isFinalized', () => {
  it('ready のみ true', () => {
    expect(isFinalized('ready')).toBe(true)
  })

  it('ready 以外 (reserved / deleting / deleted) は false', () => {
    expect(isFinalized('reserved')).toBe(false)
    expect(isFinalized('deleting')).toBe(false)
    expect(isFinalized('deleted')).toBe(false)
  })
})

describe('canFinalize (reserved -> ready)', () => {
  it('reserved からのみ finalize 可', () => {
    expect(canFinalize('reserved')).toBe(true)
  })

  it('reserved 以外は不可 (ready は別途冪等 no-op として isFinalized で判定)', () => {
    expect(canFinalize('ready')).toBe(false)
    expect(canFinalize('deleting')).toBe(false)
    expect(canFinalize('deleted')).toBe(false)
  })
})

describe('canPromoteToDeleting (reserved|ready -> deleting)', () => {
  it('reserved / ready から promote 可', () => {
    expect(canPromoteToDeleting('reserved')).toBe(true)
    expect(canPromoteToDeleting('ready')).toBe(true)
  })

  it('deleting / deleted からは不可 (既に deleting 以降)', () => {
    expect(canPromoteToDeleting('deleting')).toBe(false)
    expect(canPromoteToDeleting('deleted')).toBe(false)
  })
})

describe('canSweepDelete (deleting|deleted は sweep collect 対象)', () => {
  it('deleting / deleted は sweep 対象', () => {
    expect(canSweepDelete('deleting')).toBe(true)
    expect(canSweepDelete('deleted')).toBe(true)
  })

  it('reserved / ready は sweep 対象外 (promote 未経由)', () => {
    expect(canSweepDelete('reserved')).toBe(false)
    expect(canSweepDelete('ready')).toBe(false)
  })
})

describe('allowsNewReference (新規参照を許すか)', () => {
  it('ready のみ true', () => {
    expect(allowsNewReference('ready')).toBe(true)
  })

  it('ready 以外は false (reserved はアップロード直後で未 finalize、deleting/deleted は回収済で取得権限失効)', () => {
    expect(allowsNewReference('reserved')).toBe(false)
    expect(allowsNewReference('deleting')).toBe(false)
    expect(allowsNewReference('deleted')).toBe(false)
  })

  it('全 status を尽くしても ready 以外は一貫して false', () => {
    const nonReady = ALL_STATUSES.filter((s) => s !== 'ready')
    for (const status of nonReady) {
      expect(allowsNewReference(status)).toBe(false)
    }
  })
})
