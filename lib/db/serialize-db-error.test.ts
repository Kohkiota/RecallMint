import { describe, it, expect, afterEach } from 'vitest'
import { serializeDbError } from './serialize-db-error'

const ORIG_ENV = process.env.BULK_FULL_PARAMS_LOG
afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env.BULK_FULL_PARAMS_LOG
  else process.env.BULK_FULL_PARAMS_LOG = ORIG_ENV
})

describe('serializeDbError', () => {
  it('Drizzle wrap の cause から postgres native field (code/severity/detail) を展開する', () => {
    // Drizzle DrizzleQueryError 相当: message は "Failed query"、 native は cause に隠れる。
    const native = Object.assign(new Error('column "due" is of type timestamp'), {
      code: '42804',
      severity: 'ERROR',
      detail: 'some native detail',
      constraint_name: null,
    })
    const wrapped = Object.assign(new Error('Failed query: update "cards" ...'), {
      cause: native,
      params: ['x'],
    })

    const out = serializeDbError(wrapped)
    expect(String(out.message)).toContain('Failed query')
    // native error は cause 配下で可視化される
    const cause = out.cause as Record<string, unknown>
    expect(cause.code).toBe('42804')
    expect(cause.severity).toBe('ERROR')
    expect(cause.detail).toBe('some native detail')
    expect(String(cause.message)).toContain('timestamp')
    // 出力は JSON 化可能 (Error instance を残さない)
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('params を要約する (count / 型分布 / anomaly / cardId 抽出)、 full params はデフォルト非出力', () => {
    const uuid = '0b3e8858-79c0-4eb0-8e3e-c12577ac23e0'
    const err = {
      message: 'boom',
      params: [uuid, 'str', 42, true, new Date('invalid'), undefined, null],
    }
    const out = serializeDbError(err, { cardIds: ['11111111-1111-4111-a111-111111111111'] })

    expect(out.paramsCount).toBe(7)
    expect(out.paramsTypeDistribution).toMatchObject({
      string: 2, // uuid + 'str'
      number: 1,
      boolean: 1,
      date: 1,
      undefined: 1,
      null: 1,
    })
    expect(out.paramsAnomaly).toEqual({
      hasUndefined: true,
      hasNull: true,
      hasInvalidDate: true,
    })
    // payload 由来 + params 由来の uuid 両方
    expect(out.cardIds).toEqual(
      expect.arrayContaining([uuid, '11111111-1111-4111-a111-111111111111']),
    )
    // env 未設定 → full params は出さない
    expect(out.fullParams).toBeUndefined()
  })

  it('BULK_FULL_PARAMS_LOG=1 のときだけ fullParams を出力する', () => {
    const err = { message: 'x', params: ['a', 1] }
    process.env.BULK_FULL_PARAMS_LOG = '1'
    expect(serializeDbError(err).fullParams).toEqual(['a', 1])
    process.env.BULK_FULL_PARAMS_LOG = '0'
    expect(serializeDbError(err).fullParams).toBeUndefined()
  })

  it('循環参照 / 非 Error 入力でも throw せず JSON 化可能な object を返す', () => {
    const circular: Record<string, unknown> = { message: 'c' }
    circular.self = circular
    const out = serializeDbError(circular)
    expect(() => JSON.stringify(out)).not.toThrow()

    const out2 = serializeDbError('plain string error')
    expect(() => JSON.stringify(out2)).not.toThrow()
    expect(out2.paramsCount).toBe(0)
  })
})
