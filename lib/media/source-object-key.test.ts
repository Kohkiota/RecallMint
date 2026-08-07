import { describe, it, expect } from 'vitest'
import { sourcePdfObjectKey } from './source-object-key'

// 3 引数それぞれの独立検証を pin する。 red 実証(task-3-report.md 参照)は
// `assertUuidV4` 呼出を 1 つずつコメントアウトし、対応する reject test だけが
// fail することを個別に確認した(feedback_mutate_gates_individually_in_red_verification)。

const VALID_USER_ID = '11111111-1111-4111-8111-111111111111'
const VALID_IDEMPOTENCY_KEY = '22222222-2222-4222-8222-222222222222'
const VALID_FILE_ID = '33333333-3333-4333-8333-333333333333'

// v4 uuid でない文字列(path injection を模した値を含む)。
const NOT_UUID = '../../etc/passwd'
// v1 uuid(version nibble が '1')— shape は uuid だが v4 でないため reject 対象。
const V1_UUID = '11111111-1111-1111-8111-111111111111'

describe('sourcePdfObjectKey', () => {
  it('builds src/{userId}/{idempotencyKey}/{fileId}.pdf for valid v4 uuids', () => {
    const key = sourcePdfObjectKey(VALID_USER_ID, VALID_IDEMPOTENCY_KEY, VALID_FILE_ID)
    expect(key).toBe(`src/${VALID_USER_ID}/${VALID_IDEMPOTENCY_KEY}/${VALID_FILE_ID}.pdf`)
  })

  it('generated key matches ^src/{uuid}/{uuid}/{uuid}\\.pdf$', () => {
    const key = sourcePdfObjectKey(VALID_USER_ID, VALID_IDEMPOTENCY_KEY, VALID_FILE_ID)
    const uuid = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
    expect(key).toMatch(new RegExp(`^src/${uuid}/${uuid}/${uuid}\\.pdf$`))
  })

  it('rejects a non-uuid userId (path injection guard)', () => {
    expect(() =>
      sourcePdfObjectKey(NOT_UUID, VALID_IDEMPOTENCY_KEY, VALID_FILE_ID),
    ).toThrow(/userId/)
  })

  it('rejects a non-uuid idempotencyKey (path injection guard)', () => {
    expect(() =>
      sourcePdfObjectKey(VALID_USER_ID, NOT_UUID, VALID_FILE_ID),
    ).toThrow(/idempotencyKey/)
  })

  it('rejects a non-uuid fileId (path injection guard)', () => {
    expect(() =>
      sourcePdfObjectKey(VALID_USER_ID, VALID_IDEMPOTENCY_KEY, NOT_UUID),
    ).toThrow(/fileId/)
  })

  it('rejects a non-v4 uuid (v1) for userId — v4 shape is strict, not "any uuid"', () => {
    expect(() =>
      sourcePdfObjectKey(V1_UUID, VALID_IDEMPOTENCY_KEY, VALID_FILE_ID),
    ).toThrow(/userId/)
  })

  it('does not include the raw offending value in the thrown error message', () => {
    expect.assertions(1)
    try {
      sourcePdfObjectKey(NOT_UUID, VALID_IDEMPOTENCY_KEY, VALID_FILE_ID)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain(NOT_UUID)
    }
  })
})
