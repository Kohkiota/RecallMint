// createOriginNormalizer の unit test (Dash-1 Home v1 spec §11.3/§11.4)。
//
// processAnswerEvents 本体 (DB tx を要する) は iso 側
// (tests/integration/pg/answer-events-serialization.test.ts) が担当する。ここで見るのは
// DB 非依存のロジック — 正規化そのもの (normalizeOriginValue への委譲) ではなく、
// 「batch につき 1 行」契約を作っている buildLog の集約挙動 (event 名 / 1 payload に
// 複数未知値を集約 / 回答内容を含めない) を直接 pin する。

import { describe, it, expect } from 'vitest'
import { createOriginNormalizer, MAX_LOGGED_ORIGIN_VALUES } from './ingest-review-events'

describe('createOriginNormalizer', () => {
  it('既知値はそのまま返し、未知値として集計しない (buildLog は null)', () => {
    const { normalizeOrigin, buildLog } = createOriginNormalizer()
    expect(normalizeOrigin('home_today')).toBe('home_today')
    expect(normalizeOrigin('custom')).toBe('custom')
    expect(buildLog('user-1')).toBeNull()
  })

  it('undefined (欠落) は null を返し、未知値として集計しない', () => {
    const { normalizeOrigin, buildLog } = createOriginNormalizer()
    expect(normalizeOrigin(undefined)).toBeNull()
    expect(buildLog('user-1')).toBeNull()
  })

  it('未知値は null に正規化され、batch 終端の buildLog が正確な event 名を持つ 1 payload を返す', () => {
    const { normalizeOrigin, buildLog } = createOriginNormalizer()
    expect(normalizeOrigin('bogus_a')).toBeNull()

    const log = buildLog('user-1')
    expect(log).not.toBeNull()
    // event 名は仕様の固定文字列 (review_events.bulk.* の既存系列・spec §11.3)。
    expect(log!.event).toBe('review_events.bulk.origin_normalized')
    expect(log!.userId).toBe('user-1')
  })

  it('複数の未知値 (重複含む) を観測しても、1 event = 1 行にならず 1 batch = 1 payload に集約される', () => {
    const { normalizeOrigin, buildLog } = createOriginNormalizer()
    normalizeOrigin('bogus_a')
    normalizeOrigin('bogus_b')
    normalizeOrigin('bogus_a') // 重複 raw 値

    const log = buildLog('user-1')!
    // 3 回未知値を観測したが payload は (前 2 test 同様) 呼出 1 回分のみ。
    expect(log.count).toBe(3)
    // values は distinct (重複 raw 値は 1 個にまとまる)。
    expect([...log.values].sort()).toEqual(['bogus_a', 'bogus_b'])
  })

  it('payload に回答内容を含めない (高カーディナリティ/注入回避・spec §11.3)', () => {
    const { normalizeOrigin, buildLog } = createOriginNormalizer()
    normalizeOrigin('bogus')
    const log = buildLog('user-1')!
    expect(Object.keys(log).sort()).toEqual(['count', 'event', 'userId', 'values'])
  })

  it('未知 distinct 値が上限 (MAX_LOGGED_ORIGIN_VALUES) を超えても values は先頭 N 件に切り詰められ、count は総観測数を正確に保つ (Codex M-2: batch 最大 1000 event で単一 log 行が肥大化するのを防ぐ)', () => {
    const { normalizeOrigin, buildLog } = createOriginNormalizer()
    const total = MAX_LOGGED_ORIGIN_VALUES + 5
    for (let i = 0; i < total; i++) normalizeOrigin(`bogus_${i}`)

    const log = buildLog('user-1')!
    // count は切り詰めない (何件あったかは正確に分かる)。
    expect(log.count).toBe(total)
    // values は先頭 N 件のみ (何であったかは一部のみ)。
    expect(log.values).toHaveLength(MAX_LOGGED_ORIGIN_VALUES)
  })
})
