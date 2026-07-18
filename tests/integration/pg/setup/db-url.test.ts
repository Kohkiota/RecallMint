import { afterEach, describe, expect, it } from 'vitest'

import {
  TEST_DATABASE_URL,
  assertLocalTestDb,
  hardSetTestDatabaseUrl,
} from './db-url'

describe('assertLocalTestDb', () => {
  it('passes the shipped TEST_DATABASE_URL constant', () => {
    expect(() => assertLocalTestDb(TEST_DATABASE_URL)).not.toThrow()
  })

  it('passes a local test DB url (postgres: scheme)', () => {
    expect(() =>
      assertLocalTestDb('postgres://u:p@127.0.0.1:5432/recallmint_test'),
    ).not.toThrow()
  })

  it('passes the postgresql: scheme variant', () => {
    expect(() =>
      assertLocalTestDb('postgresql://u:p@127.0.0.1:5432/recallmint_test'),
    ).not.toThrow()
  })

  it('throws for a Supabase-style remote host', () => {
    expect(() =>
      assertLocalTestDb('postgres://u:p@db.abcdefgh.supabase.co:5432/postgres'),
    ).toThrow()
  })

  it('throws for the localhost hostname (name-resolution dependent)', () => {
    expect(() =>
      assertLocalTestDb('postgres://u:p@localhost:5432/recallmint_test'),
    ).toThrow()
  })

  it('throws for a wrong port (5433)', () => {
    expect(() =>
      assertLocalTestDb('postgres://u:p@127.0.0.1:5433/recallmint_test'),
    ).toThrow()
  })

  it('throws for a different DB name (postgres)', () => {
    expect(() =>
      assertLocalTestDb('postgres://u:p@127.0.0.1:5432/postgres'),
    ).toThrow()
  })

  it('throws for a non-postgres protocol', () => {
    expect(() =>
      assertLocalTestDb('mysql://u:p@127.0.0.1:5432/recallmint_test'),
    ).toThrow()
  })

  it('throws for an unparseable string', () => {
    expect(() => assertLocalTestDb('not a url')).toThrow()
  })

  it('does not leak the password in the thrown message', () => {
    let message = ''
    try {
      assertLocalTestDb('postgres://admin:supersecret@db.x.supabase.co:5432/postgres')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).not.toContain('supersecret')
  })
})

describe('hardSetTestDatabaseUrl', () => {
  const original = process.env.DATABASE_URL
  afterEach(() => {
    process.env.DATABASE_URL = original
  })

  it('assigns process.env.DATABASE_URL to the guarded test DB url', () => {
    process.env.DATABASE_URL = 'postgres://someone:else@127.0.0.1:5432/other'
    hardSetTestDatabaseUrl()
    expect(process.env.DATABASE_URL).toBe(TEST_DATABASE_URL)
  })
})
