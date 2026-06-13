// inDateList helper unit tests。
//
// 注意: render shape assertion は **補助検証** (前回 d1987da の false
// confidence 教訓: local PgDialect の render は valid に見えても postgres-js
// 3.4.9 + Supabase Transaction pooler では driver serializer 経路で死ぬ)。
// **合否本体は実機 smoke** (T-B2 stg 反映後の OT smoke)。 本 unit test は
// 「helper の入力 → drizzle SQL object 構築まで」 の正しさを補助確認する。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { inDateList } from './in-date-list'

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('inDateList', () => {
  it('通常: ${d}::date 形で個別 param 展開 (sql.join 経由)', () => {
    const stmt = inDateList(
      sql`(reviewed_at AT TIME ZONE 'Asia/Tokyo')::date`,
      ['2026-06-13', '2026-06-12'],
    )
    const { sql: rendered, params } = new PgDialect().sqlToQuery(stmt)
    // 補助: param 数 = days.length と一致 (= 配列 1 param bind ではなく個別展開)
    expect(params).toEqual(['2026-06-13', '2026-06-12'])
    // 補助: ::date cast が param に紐付く
    expect(rendered).toMatch(/\$\d+::date/)
    // 補助: 旧 broken 形 (ANY + array param cast) が混ざらない
    expect(rendered).not.toMatch(/ANY\(\$\d+::date\[\]\)/)
    // 補助: IN (...) 形であること
    expect(rendered).toMatch(/IN \(/)
  })

  it('空配列ガード: days.length === 0 → sql`false` (空 IN () syntax error 防止)', () => {
    const stmt = inDateList(sql`(reviewed_at)::date`, [])
    const { sql: rendered, params } = new PgDialect().sqlToQuery(stmt)
    expect(rendered).toBe('false')
    expect(params).toEqual([])
  })

  it('警戒ログ: days.length > 500 で logger.warn 発火 (IN list 膨張早期検知)', async () => {
    const { logger } = await import('@/lib/logger')
    const days = Array.from(
      { length: 501 },
      (_, i) => `2026-01-${((i % 28) + 1).toString().padStart(2, '0')}`,
    )
    inDateList(sql`(reviewed_at)::date`, days)
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith({
      event: 'in_date_list.large',
      count: 501,
    })
  })

  it('境界: days.length === 500 で警戒ログ発火しない', async () => {
    const { logger } = await import('@/lib/logger')
    const days = Array.from(
      { length: 500 },
      (_, i) => `2026-01-${((i % 28) + 1).toString().padStart(2, '0')}`,
    )
    inDateList(sql`(reviewed_at)::date`, days)
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
  })
})
