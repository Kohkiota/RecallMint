import { describe, it, expect } from 'vitest'
import {
  isPastGrace,
  isStaleReservedEligible,
  isTerminalOpReadyEligible,
  isSourceAssetGcEligible,
  canSweepDeleteSource,
  type OwningOpInfo,
} from './source-asset-state'

// Task 14b′(軸反転): 旧テストは「source を残す(RETAIN)」ことを pin していた。
// 新軸は逆(「source を消す」)なので期待値を反転して書き換える(削除でなく反転
// — brief「撤回で壊れる既存 test」節)。

const MIN_MS = 60 * 1000
const NOW = new Date('2026-08-03T00:00:00.000Z')
const MARGIN = 16 * MIN_MS // source-purge.ts の SOURCE_RESERVED_NET_GRACE_MS と同値

const LIVE_OP: OwningOpInfo = { status: 'awaiting_sources', isLive: true }
const DEAD_CLAIMED_OP: OwningOpInfo = { status: 'claimed', isLive: false }
const COMPLETED_OP: OwningOpInfo = { status: 'completed', isLive: false }
const TERMINAL_OP: OwningOpInfo = { status: 'terminal_failed', isLive: false }

describe('isPastGrace', () => {
  it('margin 超(20分前)は true', () => {
    expect(isPastGrace(new Date(NOW.getTime() - 20 * MIN_MS), MARGIN, NOW)).toBe(true)
  })
  it('margin 未満(5分前)は false', () => {
    expect(isPastGrace(new Date(NOW.getTime() - 5 * MIN_MS), MARGIN, NOW)).toBe(false)
  })
  it('境界ちょうど(16分前)は false(strict older・未満扱い)', () => {
    expect(isPastGrace(new Date(NOW.getTime() - MARGIN), MARGIN, NOW)).toBe(false)
  })
  it('境界 1ms 超(16分+1ms前)は true(strict older を満たす)', () => {
    expect(isPastGrace(new Date(NOW.getTime() - MARGIN - 1), MARGIN, NOW)).toBe(true)
  })
})

describe('isStaleReservedEligible — Class A(網・reserved-not-live)', () => {
  const OLD = new Date(NOW.getTime() - 40 * MIN_MS)
  const RECENT = new Date(NOW.getTime() - 5 * MIN_MS)

  it('margin 超 + op 無し(SET NULL 等) → eligible(abandoned 扱いの防御既定)', () => {
    expect(isStaleReservedEligible(OLD, MARGIN, NOW, null)).toBe(true)
  })
  it('margin 超 + op が terminal(dead) → eligible', () => {
    expect(isStaleReservedEligible(OLD, MARGIN, NOW, DEAD_CLAIMED_OP)).toBe(true)
  })
  // 軸反転(旧 Finding 2 の completed-retain を撤回): completed は
  // isLiveUploadOperationCondition() の対象外(awaiting_sources/claimed/prepared
  // にしか成立しない)ため isLive は元々 false — !op.isLive だけで eligible になる。
  it('margin 超 + op が completed → eligible(旧 RETAIN-completed を撤回・新軸は購入対象)', () => {
    expect(isStaleReservedEligible(OLD, MARGIN, NOW, COMPLETED_OP)).toBe(true)
  })
  it('margin 超 + op が live → NOT eligible(live-op 除外は維持・in-flight を巻き込まない)', () => {
    expect(isStaleReservedEligible(OLD, MARGIN, NOW, LIVE_OP)).toBe(false)
  })
  it('margin 未満(まだ猶予) + op 無し → NOT eligible', () => {
    expect(isStaleReservedEligible(RECENT, MARGIN, NOW, null)).toBe(false)
  })
  it('margin 境界ちょうど → NOT eligible(strict older)', () => {
    expect(isStaleReservedEligible(new Date(NOW.getTime() - MARGIN), MARGIN, NOW, null)).toBe(
      false,
    )
  })
})

describe('isTerminalOpReadyEligible — Class B(網・terminal-op ready、grace なし)', () => {
  it('op terminal_failed → eligible', () => {
    expect(isTerminalOpReadyEligible(TERMINAL_OP)).toBe(true)
  })
  // 軸反転(旧 completed-retain を撤回・brief「新軸」冒頭の最重要違反の裏返し):
  // 正常完走 source も grace なしで即 eligible。
  it('op completed → eligible(旧 RETAIN を撤回・正常完走 source も purge 対象)', () => {
    expect(isTerminalOpReadyEligible(COMPLETED_OP)).toBe(true)
  })
  it('op live → NOT eligible(処理継続中は触らない)', () => {
    expect(isTerminalOpReadyEligible(LIVE_OP)).toBe(false)
  })
  it('op が claimed(非 live・非 terminal)→ NOT eligible(terminal でも live でもない中間状態)', () => {
    expect(isTerminalOpReadyEligible(DEAD_CLAIMED_OP)).toBe(false)
  })
  it('op 無し → NOT eligible(保守的防御既定: positive な terminal 証拠なしに消さない)', () => {
    expect(isTerminalOpReadyEligible(null)).toBe(false)
  })
})

describe('isSourceAssetGcEligible — status dispatch', () => {
  const OLD = new Date(NOW.getTime() - 40 * MIN_MS)

  it('reserved は Class A(isStaleReservedEligible)に委譲', () => {
    expect(isSourceAssetGcEligible('reserved', OLD, MARGIN, NOW, null)).toBe(true)
    expect(isSourceAssetGcEligible('reserved', OLD, MARGIN, NOW, LIVE_OP)).toBe(false)
  })
  it('ready は Class B(isTerminalOpReadyEligible)に委譲・grace 無視(margin 未満でも判定に影響しない)', () => {
    const RECENT = new Date(NOW.getTime() - 1 * MIN_MS)
    expect(isSourceAssetGcEligible('ready', RECENT, MARGIN, NOW, TERMINAL_OP)).toBe(true)
    expect(isSourceAssetGcEligible('ready', OLD, MARGIN, NOW, LIVE_OP)).toBe(false)
  })
  it('deleting は promote 済ゆえ常に false(op/grace に関わらず)', () => {
    expect(isSourceAssetGcEligible('deleting', OLD, MARGIN, NOW, TERMINAL_OP)).toBe(false)
    expect(isSourceAssetGcEligible('deleting', OLD, MARGIN, NOW, null)).toBe(false)
  })
})

describe('canSweepDeleteSource', () => {
  it('deleting のみ true', () => {
    expect(canSweepDeleteSource('deleting')).toBe(true)
  })
  it('reserved / ready は false(promote を経ていない)', () => {
    expect(canSweepDeleteSource('reserved')).toBe(false)
    expect(canSweepDeleteSource('ready')).toBe(false)
  })
})
