// verify-rls-state の pure 部分(カタログ突合 + 実効判定)の unit test。
// DB I/O は含まない — 実 DB 突合は tests/integration/pg/rls-drift.test.ts(同じカタログを
// import する)が local iso PG で担い、stg/prod は script 本体を operator が実行する。
//
// 本 test が守る中核 = **「決定的証拠が無い時に silent に PASS しない」**。no-context probe が
// raise しなかった場合、それは「qual はあるが評価されなかった」と「そもそも qual が無い
// (RLS 未適用)」の両方を含む — raise の有無は行数でなく実行計画依存ゆえ観測から区別できない
// (canonical review Minor#A・PG17 実測)。よって raise 無しは PASS の根拠にしない。

import { describe, expect, it } from 'vitest'

import {
  COMMON_FORM_RLS_TABLES,
  EXPECTED_GRANTS,
  EXPECTED_NON_RLS_TABLES,
  EXPECTED_POLICIES,
  EXPECTED_RLS_TABLES,
  TENANT_PRED,
  BOGUS_CONTEXT,
  compareGrants,
  comparePolicies,
  compareRlsTables,
  evaluateEffectiveness,
  describeTarget,
  formatTable,
  invalidUserIds,
  parseUserFlags,
  resolveUrl,
  type ContextObservation,
  type GrantRow,
  type NoContextProbe,
  type PolicyRow,
  type RelRow,
} from './verify-rls-state'

// --- 期待カタログどおりの「正常な実 DB」を組み立てる helper 群 ---
// 注意: これらは**期待カタログ自身から**生成しているため、「期待どおりなら findings 0」の
// test は比較器(comparator)の健全性しか見ていない — カタログの値が現実と合っているかの
// oracle は実 PG に当てる tests/integration/pg/rls-drift.test.ts と、実環境に当てる本 script
// 実走の側にある。ここでカタログ値を検証しているつもりにならないこと。

function healthyRelRows(): RelRow[] {
  return [
    ...EXPECTED_RLS_TABLES.map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: false,
    })),
    ...EXPECTED_NON_RLS_TABLES.map((relname) => ({
      relname,
      relrowsecurity: false,
      relforcerowsecurity: false,
    })),
  ]
}

function healthyPolicyRows(): PolicyRow[] {
  return Object.entries(EXPECTED_POLICIES).map(([key, tuple]) => {
    const [tablename, policyname] = key.split('|')
    return { tablename: tablename!, policyname: policyname!, ...tuple }
  })
}

function healthyGrantRows(): GrantRow[] {
  return Object.entries(EXPECTED_GRANTS).flatMap(([table_name, privs]) =>
    privs.map((privilege_type) => ({ table_name, privilege_type })),
  )
}

describe('期待カタログ自体の内部整合', () => {
  it('RLS 20 表 / 非 RLS 5 表 / policy 22 本(rls-drift.test.ts と同一 oracle)', () => {
    expect(EXPECTED_RLS_TABLES).toHaveLength(20)
    expect(EXPECTED_NON_RLS_TABLES).toHaveLength(5)
    expect(Object.keys(EXPECTED_POLICIES)).toHaveLength(22)
    // ②-4a の残る 2 表がカタログに載っていること(2026-08-04 の未適用検出の再発防止。
    // 3 表目は S-5 / migration 0032 で drop 済)。
    for (const t of ['upload_operations', 'asset_derivations']) {
      expect(EXPECTED_RLS_TABLES).toContain(t)
      expect(EXPECTED_POLICIES[`${t}|${t}_tenant`]).toBeDefined()
    }
  })

  it('RLS 表と非 RLS 表は排他', () => {
    for (const t of EXPECTED_NON_RLS_TABLES) expect(EXPECTED_RLS_TABLES).not.toContain(t)
  })

  it('oracle は入れ子まで凍結されている(期待 qual を緩める改変を封じる)', () => {
    // 封じたい改変 = EXPECTED_POLICIES[...].qual = 'true' にして comparePolicies に
    // 何でも通させること。浅い freeze だとこれが通ってしまう(canonical review Minor#B/#C)。
    expect(Object.isFrozen(EXPECTED_POLICIES)).toBe(true)
    expect(Object.isFrozen(EXPECTED_GRANTS)).toBe(true)
    expect(Object.isFrozen(EXPECTED_RLS_TABLES)).toBe(true)
    expect(Object.isFrozen(EXPECTED_NON_RLS_TABLES)).toBe(true)
    expect(Object.isFrozen(COMMON_FORM_RLS_TABLES)).toBe(true)
    expect(Object.isFrozen(EXPECTED_POLICIES['cards|cards_tenant'])).toBe(true)
    expect(Object.isFrozen(EXPECTED_POLICIES['cards|cards_tenant']!.roles)).toBe(true)
    expect(Object.isFrozen(EXPECTED_GRANTS['exams'])).toBe(true)
  })
})

describe('compareRlsTables', () => {
  it('期待どおりなら findings 0', () => {
    expect(compareRlsTables(healthyRelRows())).toEqual([])
  })

  it('RLS 対象表の RLS が無効なら検出する(2026-08-04 stg 実障害の再現)', () => {
    const rows = healthyRelRows().map((r) =>
      r.relname === 'asset_derivations' ? { ...r, relrowsecurity: false } : r,
    )
    const findings = compareRlsTables(rows)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ area: 'rls', subject: 'asset_derivations' })
    expect(findings[0]!.detail).toContain('RLS が無効')
  })

  it('表そのものが存在しない(migration 未適用)を検出する', () => {
    const rows = healthyRelRows().filter((r) => r.relname !== 'upload_operations')
    const findings = compareRlsTables(rows)
    expect(findings.map((f) => f.subject)).toContain('upload_operations')
    expect(findings.find((f) => f.subject === 'upload_operations')!.detail).toContain('存在しない')
  })

  it('FORCE RLS が有効なら検出する(設計は非 FORCE)', () => {
    const rows = healthyRelRows().map((r) =>
      r.relname === 'exams' ? { ...r, relforcerowsecurity: true } : r,
    )
    expect(compareRlsTables(rows).map((f) => f.detail)).toEqual([
      expect.stringContaining('FORCE RLS'),
    ])
  })

  it('非 RLS 表が RLS on に化けたら検出する', () => {
    const rows = healthyRelRows().map((r) =>
      r.relname === 'ai_usage' ? { ...r, relrowsecurity: true } : r,
    )
    expect(compareRlsTables(rows).map((f) => f.subject)).toEqual(['ai_usage'])
  })

  it('カタログ外の表が RLS on ならカタログ更新漏れとして検出する', () => {
    const rows = [
      ...healthyRelRows(),
      { relname: 'brand_new_table', relrowsecurity: true, relforcerowsecurity: false },
    ]
    expect(compareRlsTables(rows).map((f) => f.subject)).toEqual(['brand_new_table'])
  })
})

describe('comparePolicies', () => {
  it('期待どおりなら findings 0', () => {
    expect(comparePolicies(healthyPolicyRows())).toEqual([])
  })

  it('policy が存在しないなら検出する', () => {
    const rows = healthyPolicyRows().filter((p) => p.tablename !== 'asset_derivations')
    const findings = comparePolicies(rows)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.subject).toBe('asset_derivations|asset_derivations_tenant')
  })

  it('qual が緩い述語に化けたら検出する(名前と cmd は同じでも tenant 境界は無効化される)', () => {
    const rows = healthyPolicyRows().map((p) =>
      p.tablename === 'cards' ? { ...p, qual: 'true' } : p,
    )
    const findings = comparePolicies(rows)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.detail).toContain('qual: true !=')
  })

  it('roles に public が混入したら検出する', () => {
    const rows = healthyPolicyRows().map((p) =>
      p.tablename === 'exams' ? { ...p, roles: ['recallmint_app', 'public'] } : p,
    )
    expect(comparePolicies(rows)[0]!.detail).toContain('roles')
  })

  it('カタログに無い policy が増えていたら検出する', () => {
    const rows: PolicyRow[] = [
      ...healthyPolicyRows(),
      {
        tablename: 'exams',
        policyname: 'exams_backdoor',
        roles: ['recallmint_app'],
        cmd: 'ALL',
        permissive: 'PERMISSIVE',
        qual: TENANT_PRED,
        with_check: TENANT_PRED,
      },
    ]
    expect(comparePolicies(rows).map((f) => f.subject)).toEqual(['exams|exams_backdoor'])
  })
})

describe('compareGrants', () => {
  it('期待どおりなら findings 0', () => {
    expect(compareGrants(healthyGrantRows())).toEqual([])
  })

  it('grant 不足を検出する(経路が 42501 で壊れる側)', () => {
    const rows = healthyGrantRows().filter(
      (g) => !(g.table_name === 'asset_derivations' && g.privilege_type === 'DELETE'),
    )
    expect(compareGrants(rows).map((f) => f.subject)).toEqual(['asset_derivations'])
  })

  it('縮小した grant が戻っていたら検出する(phase3 REVOKE の巻き戻し)', () => {
    const rows: GrantRow[] = [
      ...healthyGrantRows(),
      { table_name: 'integration_failures', privilege_type: 'SELECT' },
    ]
    const findings = compareGrants(rows)
    expect(findings.map((f) => f.subject)).toEqual(['integration_failures'])
    expect(findings[0]!.detail).toContain('INSERT,SELECT')
  })

  it('カタログ外の新表に app role grant が付いていたら検出する(Codex P2)', () => {
    // base grants の ALTER DEFAULT PRIVILEGES で新表には自動で CRUD が付く。
    // カタログ更新を忘れた新表が「RLS 無し + grant フル」で素通りするのを防ぐ。
    const rows: GrantRow[] = [
      ...healthyGrantRows(),
      { table_name: 'brand_new_table', privilege_type: 'SELECT' },
      { table_name: 'brand_new_table', privilege_type: 'INSERT' },
    ]
    const findings = compareGrants(rows)
    expect(findings.map((f) => f.subject)).toEqual(['brand_new_table'])
    expect(findings[0]!.detail).toContain('カタログ外')
  })
})

describe('evaluateEffectiveness', () => {
  const noProbes: NoContextProbe[] = COMMON_FORM_RLS_TABLES.map((table) => ({
    table,
    raisedP0RLS: false,
    rows: 0,
  }))
  const emptyObservations: ContextObservation[] = COMMON_FORM_RLS_TABLES.map((table) => ({
    context: BOGUS_CONTEXT,
    kind: 'bogus' as const,
    table,
    visible: 0,
    foreign: 0,
  }))

  it('P0RLS を raise した表があれば PASS(行数に依らない決定的証拠)', () => {
    const probes = noProbes.map((p) =>
      p.table === 'asset_derivations' ? { ...p, raisedP0RLS: true } : p,
    )
    const result = evaluateEffectiveness(probes, emptyObservations)
    expect(result.verdict).toBe('PASS')
    expect(result.findings).toEqual([])
    expect(result.reason).toContain('asset_derivations')
  })

  it('全表 0 行・raise 無しは INCONCLUSIVE(silent PASS しない = 本 task の中核要件)', () => {
    const result = evaluateEffectiveness(noProbes, emptyObservations)
    expect(result.verdict).toBe('INCONCLUSIVE')
    expect(result.verdict).not.toBe('PASS')
    expect(result.reason).toContain('判定不能')
  })

  it('context 無しで行が見えたら FAIL(policy が評価されていない)', () => {
    const probes = noProbes.map((p) => (p.table === 'cards' ? { ...p, rows: 7 } : p))
    const result = evaluateEffectiveness(probes, emptyObservations)
    expect(result.verdict).toBe('FAIL')
    expect(result.findings[0]!.detail).toContain('7 行')
  })

  it('実在しない tenant context で行が見えたら FAIL', () => {
    const observations = emptyObservations.map((o) =>
      o.table === 'asset_derivations' ? { ...o, visible: 2 } : o,
    )
    const result = evaluateEffectiveness(noProbes, observations)
    expect(result.verdict).toBe('FAIL')
    expect(result.findings[0]!.detail).toContain('実在しない tenant context')
  })

  it('自分以外の所有者の行が見えたら FAIL(user context 指定時)', () => {
    const observations: ContextObservation[] = [
      ...emptyObservations,
      {
        context: '2ac594a5-7965-4323-b47d-1057abb54c26',
        kind: 'user',
        table: 'upload_operations',
        visible: 3,
        foreign: 2,
      },
    ]
    const result = evaluateEffectiveness(noProbes, observations)
    expect(result.verdict).toBe('FAIL')
    expect(result.findings[0]!.detail).toContain('他 tenant の行が 2 件')
  })

  it('漏れの証拠がある時は raise があっても FAIL が優先される', () => {
    const probes = noProbes.map((p) =>
      p.table === 'cards' ? { ...p, raisedP0RLS: true } : { ...p, rows: 1 },
    )
    expect(evaluateEffectiveness(probes, emptyObservations).verdict).toBe('FAIL')
  })

  it('実行できなかった probe/観測があれば、他表が P0RLS でも PASS にしない(Codex P1)', () => {
    // 例: --user に不正 uuid → 全 user 観測が cast で落ちる。無関係な表の raise だけで
    // PASS/exit 0 を返すと「未検証なのに合格」= false-green になる。
    const probes = noProbes.map((p) =>
      p.table === 'exams' ? { ...p, raisedP0RLS: true } : p,
    )
    const result = evaluateEffectiveness(probes, emptyObservations, [
      { table: 'upload_operations', context: 'not-a-uuid', detail: 'context 付き観測が失敗' },
    ])
    expect(result.verdict).toBe('FAIL')
    expect(result.verdict).not.toBe('PASS')
    expect(result.reason).toContain('完走できなかった')
    expect(result.findings[0]!.detail).toContain('検証不能')
    expect(result.findings[0]!.subject).toBe('upload_operations@not-a-uuid')
  })

  it('未検証と漏れが同時にある時は「漏れの証拠」を理由に出す', () => {
    const probes = noProbes.map((p) => (p.table === 'cards' ? { ...p, rows: 3 } : p))
    const result = evaluateEffectiveness(probes, emptyObservations, [
      { table: 'exams', detail: 'no-context probe が想定外エラー' },
    ])
    expect(result.verdict).toBe('FAIL')
    expect(result.reason).toContain('漏れの証拠')
  })

  it('failures 引数は省略可(既定 = 未検証なし)', () => {
    const probes = noProbes.map((p) => (p.table === 'exams' ? { ...p, raisedP0RLS: true } : p))
    expect(evaluateEffectiveness(probes, emptyObservations).verdict).toBe('PASS')
  })

  it('正常な user context(自分の行が見える・他所有ゼロ)は FAIL にしない', () => {
    // `--user` を渡した時の健全な形。visible>0 を一律 finding にする実装退行を防ぐ。
    const probes = noProbes.map((p) => (p.table === 'exams' ? { ...p, raisedP0RLS: true } : p))
    const observations: ContextObservation[] = [
      ...emptyObservations,
      {
        context: '2ac594a5-7965-4323-b47d-1057abb54c26',
        kind: 'user',
        table: 'exams',
        visible: 2,
        foreign: 0,
      },
    ]
    const result = evaluateEffectiveness(probes, observations)
    expect(result.verdict).toBe('PASS')
    expect(result.findings).toEqual([])
  })

  it('bogus context の漏れは 1 件だけ計上する(visible と foreign で二重に出さない)', () => {
    const observations = emptyObservations.map((o) =>
      o.table === 'cards' ? { ...o, visible: 4, foreign: 4 } : o,
    )
    const findings = evaluateEffectiveness(noProbes, observations).findings
    expect(findings).toHaveLength(1)
    expect(findings[0]!.detail).toContain('実在しない tenant context')
  })

  it('verdict 行に decisive / inconclusive の内訳を載せる(全表証明済と読ませない)', () => {
    const probes = noProbes.map((p) => (p.table === 'exams' ? { ...p, raisedP0RLS: true } : p))
    const result = evaluateEffectiveness(probes, emptyObservations)
    expect(result.reason).toContain(`decisive 1 / inconclusive ${COMMON_FORM_RLS_TABLES.length - 1}`)
    expect(result.reason).toContain('qual が評価されず runtime 証明なし')
  })

  describe('app_current_user_id() 前提 probe(canonical review Important#1)', () => {
    it('raise しないなら FAIL(no-context probe の解釈が成立しないため)', () => {
      // 行のある表でも「0 行・エラー無し」になり、空表と区別できなくなる = 推論の土台が壊れている。
      const probes = noProbes.map((p) => (p.table === 'exams' ? { ...p, raisedP0RLS: true } : p))
      const result = evaluateEffectiveness(probes, emptyObservations, [], {
        raisedP0RLS: false,
        detail: 'context 未設定でも例外なく値を返した',
      })
      expect(result.verdict).toBe('FAIL')
      expect(result.findings[0]!.subject).toBe('app_current_user_id()')
      expect(result.findings[0]!.detail).toContain('検証不能')
    })

    it('raise するなら判定に影響しない(PASS のまま)', () => {
      const probes = noProbes.map((p) => (p.table === 'exams' ? { ...p, raisedP0RLS: true } : p))
      const result = evaluateEffectiveness(probes, emptyObservations, [], {
        raisedP0RLS: true,
        detail: 'P0RLS',
      })
      expect(result.verdict).toBe('PASS')
      expect(result.findings).toEqual([])
    })

    it('全表 0 行でも raise 機構が健在なら、その旨を判定不能の理由に添える', () => {
      const result = evaluateEffectiveness(noProbes, emptyObservations, [], {
        raisedP0RLS: true,
        detail: 'P0RLS',
      })
      expect(result.verdict).toBe('INCONCLUSIVE')
      expect(result.reason).toContain('raise 機構は健在')
    })
  })
})

describe('describeTarget', () => {
  it('host / port / db を出し、password は含めない(証跡の自己識別)', () => {
    const out = describeTarget('postgresql://recallmint_app:s3cret@db.example.com:6543/postgres')
    expect(out).toBe('host=db.example.com port=6543 db=postgres')
    expect(out).not.toContain('s3cret')
  })

  it('解析できない値でも throw しない', () => {
    expect(describeTarget('not a url')).toBe('(接続文字列を解析できず)')
  })
})

describe('CLI 引数 / 接続文字列の解決', () => {
  it('--user を全て集める', () => {
    expect(parseUserFlags(['--user', 'a', '--user', 'b'])).toEqual(['a', 'b'])
    expect(parseUserFlags([])).toEqual([])
    // 値が無い末尾 --user は無視する(undefined を context に使わせない)。
    expect(parseUserFlags(['--user'])).toEqual([])
  })

  it('--user が uuid 形式でなければ前提エラーとして弾ける(Codex P1 の具体例)', () => {
    expect(invalidUserIds(['2ac594a5-7965-4323-b47d-1057abb54c26'])).toEqual([])
    expect(invalidUserIds(['not-a-uuid', '123'])).toEqual(['not-a-uuid', '123'])
    // 大文字も uuid として受ける(PG の uuid cast と同じ寛容さ)。
    expect(invalidUserIds(['2AC594A5-7965-4323-B47D-1057ABB54C26'])).toEqual([])
  })

  it('RLS_VERIFY_DATABASE_URL を優先し、無ければ DATABASE_URL_APP に落ちる', () => {
    expect(resolveUrl({ RLS_VERIFY_DATABASE_URL: 'x', DATABASE_URL_APP: 'y' })).toEqual({
      url: 'x',
      source: 'RLS_VERIFY_DATABASE_URL',
    })
    expect(resolveUrl({ DATABASE_URL_APP: 'y' })).toEqual({
      url: 'y',
      source: 'DATABASE_URL_APP',
    })
    expect(resolveUrl({})).toBeNull()
  })
})

describe('formatTable', () => {
  it('見出しと桁を揃えた表を返す(台帳へそのまま貼れる形)', () => {
    const out = formatTable(
      ['table', 'rls'],
      [
        ['exams', 'true'],
        ['upload_operations', 'false'],
      ],
    )
    expect(out.split('\n')).toEqual([
      'table             | rls  ',
      '------------------+------',
      'exams             | true ',
      'upload_operations | false',
    ])
  })
})
