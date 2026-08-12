// classifyBulkError の単体 test。
//
// 列の判定方針 (helper header と同):
// - PG SQLSTATE code: 40001 / 40P01 / 57014 / 08000 / 08003 / 08006 / 53300 / 57P03 → transient
// - postgres-js ConnectionError (code が CONNECTION_DESTROYED 等の文字列) → transient
// - PG SQLSTATE code: 23514 / 23502 / 22P02 / 22001 / 22003 → permanent-4xx (spec §2、
//   契約 drift = client/server payload 契約が現 schema と食い違うバグの signal)
// - 42xxx (server/deploy 欠陥) と 23503 / 23505 (DB 状態依存) は意図的に transient のまま
//   (spec §2 — retry で解消しうる失敗を 400 に倒すと server 欠陥を client 責任に転嫁する)
// - Drizzle DrizzleQueryError は cause を unwrap して上記 code を判定
// - ZodError instance → permanent-4xx (caller は 400 系を維持)
// - その他 unknown DB error の default → transient (silent lost write 回避、
//   outbox 再送収束性を壊さない、 spec §1.1 目的 3 整合)

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { classifyBulkError, BULK_TRANSIENT_RETRY_SEC } from './classify-bulk-error'

// PG error 生成 helper (postgres-js PostgresError の形を duck-type で再現)。
// 実 DB 接続なしで判定対象 code を網羅する。
function makePgError(code: string, message = `pg error ${code}`): Error {
  const err = new Error(message)
  ;(err as Error & { code: string }).code = code
  return err
}

describe('BULK_TRANSIENT_RETRY_SEC', () => {
  it('30 秒固定 (load test 結果で後日調整可、 magic number 化せず定数で固定)', () => {
    expect(BULK_TRANSIENT_RETRY_SEC).toBe(30)
  })
})

describe('classifyBulkError - transient PG codes', () => {
  it("40001 (serialization failure) → 'transient'", () => {
    expect(classifyBulkError(makePgError('40001'))).toBe('transient')
  })

  it("40P01 (deadlock_detected) → 'transient'", () => {
    expect(classifyBulkError(makePgError('40P01'))).toBe('transient')
  })

  it("57014 (statement_timeout / query_canceled) → 'transient'", () => {
    expect(classifyBulkError(makePgError('57014'))).toBe('transient')
  })

  it("08000 (connection_exception class 08) → 'transient'", () => {
    expect(classifyBulkError(makePgError('08000'))).toBe('transient')
  })

  it("08003 (connection_does_not_exist) → 'transient'", () => {
    expect(classifyBulkError(makePgError('08003'))).toBe('transient')
  })

  it("08006 (connection_failure) → 'transient'", () => {
    expect(classifyBulkError(makePgError('08006'))).toBe('transient')
  })

  it("53300 (too_many_connections) → 'transient'", () => {
    expect(classifyBulkError(makePgError('53300'))).toBe('transient')
  })

  it("57P03 (cannot_connect_now) → 'transient'", () => {
    expect(classifyBulkError(makePgError('57P03'))).toBe('transient')
  })
})

describe('classifyBulkError - postgres-js ConnectionError-shaped errors', () => {
  it("CONNECTION_DESTROYED (postgres-js ConnectionError code) → 'transient'", () => {
    expect(classifyBulkError(makePgError('CONNECTION_DESTROYED'))).toBe(
      'transient',
    )
  })

  it("CONNECT_TIMEOUT → 'transient'", () => {
    expect(classifyBulkError(makePgError('CONNECT_TIMEOUT'))).toBe('transient')
  })

  it("CONNECTION_CLOSED → 'transient'", () => {
    expect(classifyBulkError(makePgError('CONNECTION_CLOSED'))).toBe(
      'transient',
    )
  })

  it("CONNECTION_ENDED → 'transient'", () => {
    expect(classifyBulkError(makePgError('CONNECTION_ENDED'))).toBe('transient')
  })
})

describe('classifyBulkError - permanent PG codes (spec §2)', () => {
  it("23514 (check_violation) → 'permanent-4xx'", () => {
    expect(classifyBulkError(makePgError('23514'))).toBe('permanent-4xx')
  })

  it("23502 (not_null_violation) → 'permanent-4xx'", () => {
    expect(classifyBulkError(makePgError('23502'))).toBe('permanent-4xx')
  })

  it("22P02 (invalid_text_representation) → 'permanent-4xx'", () => {
    expect(classifyBulkError(makePgError('22P02'))).toBe('permanent-4xx')
  })

  it("22001 (string_data_right_truncation) → 'permanent-4xx'", () => {
    expect(classifyBulkError(makePgError('22001'))).toBe('permanent-4xx')
  })

  it("22003 (numeric_value_out_of_range) → 'permanent-4xx'", () => {
    expect(classifyBulkError(makePgError('22003'))).toBe('permanent-4xx')
  })
})

describe('classifyBulkError - 意図的に transient のまま (spec §2)', () => {
  it("42601 (syntax_error) → 'transient' (server/deploy 欠陥は修正 deploy 後に retry で解消する)", () => {
    expect(classifyBulkError(makePgError('42601'))).toBe('transient')
  })

  it("42703 (undefined_column) → 'transient'", () => {
    expect(classifyBulkError(makePgError('42703'))).toBe('transient')
  })

  it("42P01 (undefined_table) → 'transient'", () => {
    expect(classifyBulkError(makePgError('42P01'))).toBe('transient')
  })

  it("42883 (undefined_function) → 'transient'", () => {
    expect(classifyBulkError(makePgError('42883'))).toBe('transient')
  })

  it("23503 (foreign_key_violation) → 'transient' (DB 状態依存 = 順序競合・並走で発生しうる)", () => {
    expect(classifyBulkError(makePgError('23503'))).toBe('transient')
  })
  // 23505 (unique_violation) → 'transient' は既存 'unknown DB error default' 節で
  // カバー済み (下記参照)。
})

describe('classifyBulkError - Drizzle wrap (cause unwrap)', () => {
  it("DrizzleQueryError が cause に PG 40001 を持つ場合 → 'transient'", () => {
    const cause = makePgError('40001')
    const wrapped = new DrizzleQueryError('SELECT 1', [], cause)
    expect(classifyBulkError(wrapped)).toBe('transient')
  })

  it("DrizzleQueryError が cause に postgres-js CONNECTION_CLOSED を持つ場合 → 'transient'", () => {
    const cause = makePgError('CONNECTION_CLOSED')
    const wrapped = new DrizzleQueryError('SELECT 1', [], cause)
    expect(classifyBulkError(wrapped)).toBe('transient')
  })

  it("DrizzleQueryError が cause に ZodError を持つ場合 → 'permanent-4xx' (内側を優先)", () => {
    // 実運用では発生しにくい (drizzle が zod を包むことはない) が、
    // 入れ子 chain で 4xx 性を喪失しないことを assert (誤って 503 に倒さない)。
    const zodErr = (() => {
      try {
        z.uuid().parse('not-a-uuid')
        return new Error('unreachable')
      } catch (e) {
        return e
      }
    })()
    const wrapped = new DrizzleQueryError('SELECT 1', [], zodErr as Error)
    expect(classifyBulkError(wrapped)).toBe('permanent-4xx')
  })

  it("DrizzleQueryError が cause に PG 23502 (not_null_violation) を持つ場合 → 'permanent-4xx'", () => {
    const cause = makePgError('23502')
    const wrapped = new DrizzleQueryError('INSERT ...', [], cause)
    expect(classifyBulkError(wrapped)).toBe('permanent-4xx')
  })
})

describe('classifyBulkError - 非 Drizzle wrap の cause chain (step 4 再帰)', () => {
  it('.cause に permanent PG code を持つ素の Error wrap → permanent-4xx (Drizzle 以外の wrap でも整合)', () => {
    const inner = makePgError('23514')
    const outer = new Error('wrapped by something other than Drizzle')
    ;(outer as Error & { cause: unknown }).cause = inner
    expect(classifyBulkError(outer)).toBe('permanent-4xx')
  })

  it('.cause に transient PG code を持つ素の Error wrap → transient', () => {
    const inner = makePgError('40001')
    const outer = new Error('wrapped by something other than Drizzle')
    ;(outer as Error & { cause: unknown }).cause = inner
    expect(classifyBulkError(outer)).toBe('transient')
  })
})

describe('classifyBulkError - depth 上限 (cycle 安全)', () => {
  it('permanent code が depth 上限より奥の cause にある場合 → 到達前に transient default で打ち切る', () => {
    // classifyChain の depth cap は `depth > 5` で即 transient を返す。 top-level err
    // (depth=0) から .cause を辿るたびに depth+1 されるため、 6 段ネストした
    // cause chain の最奥 (depth=6 で判定される object) に permanent code を置くと、
    // cap がその object の code を見る前に打ち切る (= permanent-4xx にならない) ことを pin する。
    let bottom: Error = makePgError('23502') // 最奥 (permanent code だが到達しない想定)
    for (let i = 0; i < 6; i++) {
      const wrapper = new Error(`nest ${i}`)
      ;(wrapper as Error & { cause: unknown }).cause = bottom
      bottom = wrapper
    }
    expect(classifyBulkError(bottom)).toBe('transient')
  })
})

describe('classifyBulkError - permanent 4xx', () => {
  it("ZodError instance (validation failure) → 'permanent-4xx' (caller は 400 系を維持)", () => {
    let zodErr: unknown
    try {
      z.uuid().parse('not-a-uuid')
    } catch (e) {
      zodErr = e
    }
    expect(classifyBulkError(zodErr)).toBe('permanent-4xx')
  })
})

describe('classifyBulkError - unknown DB error default', () => {
  it("plain Error (unknown DB error) → 'transient' (default、 silent lost write 回避)", () => {
    // unknown DB error を permanent 扱いすると、 transient 由来の失敗が outbox を
    // 削除されて silent lost write の再来になる。 default = transient に倒すことで
    // 再送収束性を壊さない (spec §1.1 目的 3)。
    expect(classifyBulkError(new Error('something else went wrong'))).toBe(
      'transient',
    )
  })

  it("code を持たない object (unknown shape) → 'transient' (default)", () => {
    expect(classifyBulkError({ what: 'is this' })).toBe('transient')
  })

  it("null / undefined → 'transient' (default、 caller は 503 を返す)", () => {
    expect(classifyBulkError(null)).toBe('transient')
    expect(classifyBulkError(undefined)).toBe('transient')
  })

  it("non-transient SQLSTATE (例: 23505 unique_violation) → 'transient' default", () => {
    // unique_violation 等は本来 permanent 寄りだが、 spec §1.1 目的 3 整合のため
    // default transient で 503 を返す (caller の 503 経路に倒す = retry で
    // 再度 unique_violation を引いて log に残り、 outbox 経路の自然冪等が効く)。
    // 厳密な permanent 判定は将来 production log 観測で個別追加する方針。
    expect(classifyBulkError(makePgError('23505'))).toBe('transient')
  })
})
