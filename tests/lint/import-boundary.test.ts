/**
 * import-boundary lint verification — ESLint Node API ("CLI smoke").
 *
 * Verifies the no-restricted-imports rules added to eslint.config.mjs:
 *   Block A — lib/ and components/ must not import @/app/**
 *   Block B — app/ must not use deep relative imports (3+ levels)
 *   Per-file allowlist overrides — the remaining real violations are exempted (P3 target)
 *
 * WHY ESLint Node API (not RuleTester):
 *   RuleTester tests rule logic in isolation and CANNOT verify flat-config
 *   `files:` glob escaping (e.g. `\\(app\\)` / `\\[id\\]`). The actual risk
 *   for this task is that the escaped per-file override globs silently fail to
 *   match — only a full config load catches that. ESLint.lintText/lintFiles
 *   exercises the real config pipeline end-to-end.
 *
 * PLACEMENT: tests/lint/ (NOT tests/contract/) — 責務分離.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { ESLint, type Linter } from 'eslint'
import { readFileSync } from 'fs'
import path from 'path'

const ROOT = path.resolve(import.meta.dirname, '../..')

/** Extract no-restricted-imports messages from lint results. */
function restrictedMessages(results: ESLint.LintResult[]): Linter.LintMessage[] {
  return results.flatMap(r => r.messages).filter(m => m.ruleId === 'no-restricted-imports')
}

describe('import-boundary: Block A — lib/components must not import @/app', () => {
  let eslint: ESLint

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  })

  it('flags a lib/ file importing @/app/...', async () => {
    const code = `import { something } from '@/app/some-feature/module'\nexport {}\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/synthetic-boundary-test.ts'),
    })
    const restricted = restrictedMessages(results)
    expect(restricted.length, 'Expected no-restricted-imports violation in lib/ → @/app').toBeGreaterThan(0)
  })

  it('flags a components/ file importing @/app/...', async () => {
    const code = `import { something } from '@/app/some-feature/module'\nexport {}\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'components/synthetic-boundary-test.tsx'),
    })
    const restricted = restrictedMessages(results)
    expect(restricted.length, 'Expected no-restricted-imports violation in components/ → @/app').toBeGreaterThan(0)
  })

  it('flags a components/ file importing app/ via relative parent traversal', async () => {
    // Ensures the relative-path bypass is blocked: `../../app/some-feature/module`
    // must be caught by the `../app/**` / `../**/app/**` patterns in Block A.
    const code = `import { someAction } from '../../app/some-feature/module'\nexport {}\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'components/marketing/synthetic-relative-test.tsx'),
    })
    const restricted = restrictedMessages(results)
    expect(restricted.length, 'Expected no-restricted-imports violation for relative traversal into app/ from components/').toBeGreaterThan(0)
  })
})

describe('import-boundary: Block B — app/ deep relative imports (3+ levels)', () => {
  let eslint: ESLint

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  })

  it('flags 3-level relative import (../../../foo)', async () => {
    const code = `import { something } from '../../../some-module'\nexport {}\n`
    const results = await eslint.lintText(code, {
      // Use a deeply nested path so the 3-level import makes structural sense.
      filePath: path.join(ROOT, 'app/(app)/app/feature/_components/synthetic-test.tsx'),
    })
    const restricted = restrictedMessages(results)
    expect(restricted.length, 'Expected no-restricted-imports for 3-level relative').toBeGreaterThan(0)
  })

  it('flags 4-level relative import (../../../../foo) — catches deeper than 3', async () => {
    const code = `import { something } from '../../../../some-module'\nexport {}\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'app/(app)/app/feature/_components/synthetic-test.tsx'),
    })
    const restricted = restrictedMessages(results)
    // This proves `../../../**` catches 4-level imports:
    // `../../../../foo` = `../../../` prefix + `../foo` remainder, matched by `**`.
    expect(restricted.length, 'Expected no-restricted-imports for 4-level relative').toBeGreaterThan(0)
  })
})

describe('import-boundary: per-file allowlist overrides (real files must NOT be flagged)', () => {
  let eslint: ESLint

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  })

  it('get-custom-session-cards.ts: reverse-dependency removed — no @/app import, zero restricted messages', async () => {
    // Task 5 (P1) moved card-filter-predicates app→lib, so get-custom-session-cards now
    // imports it lib→lib. The single lib→@/app reverse-dependency (and its allowlist
    // entry) is GONE. Assert the *condition* (no @/app import + zero restricted messages),
    // NOT a hardcoded allowlist count — so future P2+ allowlist changes can't falsely fail.
    const source = readFileSync(
      path.join(ROOT, 'lib/cards/get-custom-session-cards.ts'),
      'utf8',
    )
    expect(
      source,
      'get-custom-session-cards.ts must not import from @/app (reverse-dependency removed)',
    ).not.toMatch(/from ['"]@\/app\//)

    const results = await eslint.lintFiles([
      path.join(ROOT, 'lib/cards/get-custom-session-cards.ts'),
    ])
    const restricted = restrictedMessages(results)
    expect(
      restricted,
      'get-custom-session-cards.ts should produce zero no-restricted-imports messages (reverse-dep gone, no allowlist needed)',
    ).toHaveLength(0)
  })

  it('contact-form.tsx: @/app import removed — no override needed, zero restricted messages (P4 W5)', async () => {
    // P4 W5 (Task 7): submitContact action moved to lib/actions/contact.ts; contact-form.tsx
    // now imports @/lib/actions/contact. The Block A allowlist override for contact-form.tsx
    // was REMOVED. Assert: (a) source no longer has @/app import, (b) the file produces zero
    // restricted messages WITHOUT any override — proving the clean import (not an exemption)
    // is what makes it pass.
    const source = readFileSync(
      path.join(ROOT, 'components/marketing/contact-form.tsx'),
      'utf8',
    )
    expect(
      source,
      'contact-form.tsx must not import from @/app (action moved to lib/actions/contact.ts)',
    ).not.toMatch(/from ['"]@\/app\//)
    const results = await eslint.lintFiles([
      path.join(ROOT, 'components/marketing/contact-form.tsx'),
    ])
    const restricted = restrictedMessages(results)
    expect(restricted, 'contact-form.tsx should have zero restricted messages (no @/app import, no override needed)').toHaveLength(0)
  })

  it('exam-detail-view.tsx: uses @/ alias for AppContainer — passes Block B WITHOUT an override (P3 W7)', async () => {
    // P3 W7 (Task 8): the deep-relative `../../../_components/app-container` was replaced
    // by the `@/app/(app)/app/_components/app-container` alias and the per-file `off`
    // override was REMOVED. Assert BOTH: (a) the source no longer uses a deep relative and
    // does use the alias, (b) the file produces zero restricted messages even though it is
    // no longer allowlisted — proving the alias (not an exemption) is what makes it pass.
    const source = readFileSync(
      path.join(ROOT, 'app/(app)/app/exams/[id]/_components/exam-detail-view.tsx'),
      'utf8',
    )
    expect(source, 'exam-detail-view.tsx must not use a 3-level deep relative for app-container').not.toMatch(
      /from ['"]\.\.\/\.\.\/\.\.\//,
    )
    expect(source, 'exam-detail-view.tsx must import AppContainer via the @/ alias').toMatch(
      /from ['"]@\/app\/\(app\)\/app\/_components\/app-container['"]/,
    )
    const results = await eslint.lintFiles([
      path.join(ROOT, 'app/(app)/app/exams/[id]/_components/exam-detail-view.tsx'),
    ])
    const restricted = restrictedMessages(results)
    expect(restricted, 'exam-detail-view.tsx should have zero restricted messages via the alias (no override)').toHaveLength(0)
  })

  it('upload result page.tsx: uses @/ alias for AppContainer — passes Block B WITHOUT an override (P3 W7)', async () => {
    const source = readFileSync(
      path.join(ROOT, 'app/(app)/app/upload/result/[sourceDocumentId]/page.tsx'),
      'utf8',
    )
    expect(source, 'upload result page.tsx must not use a 3-level deep relative for app-container').not.toMatch(
      /from ['"]\.\.\/\.\.\/\.\.\//,
    )
    expect(source, 'upload result page.tsx must import AppContainer via the @/ alias').toMatch(
      /from ['"]@\/app\/\(app\)\/app\/_components\/app-container['"]/,
    )
    const results = await eslint.lintFiles([
      path.join(ROOT, 'app/(app)/app/upload/result/[sourceDocumentId]/page.tsx'),
    ])
    const restricted = restrictedMessages(results)
    expect(restricted, 'upload result page.tsx should have zero restricted messages via the alias (no override)').toHaveLength(0)
  })

  it('shared app-shell (@/app/(app)/app/_components/app-container) is NOT flagged as cross-feature', async () => {
    // The alias swap in Part A relies on the app-shell import being legitimate. The
    // CROSS_FEATURE_PRIVATE_COMPONENTS pattern requires a FEATURE segment before
    // `_components`, so the shared shell (no feature segment) must pass from any app file.
    const code = `import { AppContainer } from '@/app/(app)/app/_components/app-container'\nexport const X = AppContainer\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'app/(app)/app/some-feature/_components/synthetic-shell-import.tsx'),
    })
    const restricted = restrictedMessages(results)
    expect(restricted, 'the shared app-shell import must NOT be treated as a cross-feature violation').toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Cross-feature visualization allowlist (P3 W7 / Task 8).
// Each entry is proven twice:
//   (a) GENERAL FLAG — a synthetic, NON-allowlisted file importing the same
//       cross-feature pattern IS flagged (the rule works in general), and
//   (b) EXEMPTION — the real allowlisted file produces ZERO restricted messages
//       (the escaped per-file `off` glob actually applies).
// Together (a)+(b) prove the glob escaping is correct: if the escapes were wrong,
// either the general rule would not fire (a fails) or the real file would be
// flagged despite its override (b fails).
// ---------------------------------------------------------------------------
describe('import-boundary: cross-feature visualization allowlist (P3 W7)', () => {
  let eslint: ESLint

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  })

  // --- Entry 1: study/custom → exams/[id]/_components (2-segment feature) ---
  it('GENERAL: a non-allowlisted study file importing exams/[id]/_components IS flagged', async () => {
    const code = `import { CardTagAddPopover } from '@/app/(app)/app/exams/[id]/_components/card-tag-add-popover'\nexport const X = CardTagAddPopover\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'app/(app)/app/study/custom/_components/synthetic-crossfeature.tsx'),
    })
    expect(
      restrictedMessages(results),
      'cross-feature import into exams/[id]/_components must be flagged in a non-allowlisted file',
    ).not.toHaveLength(0)
  })

  it('EXEMPT: real custom-filter-form.tsx (study → exams) is allowlisted → zero restricted', async () => {
    const results = await eslint.lintFiles([
      path.join(ROOT, 'app/(app)/app/study/custom/_components/custom-filter-form.tsx'),
    ])
    expect(
      restrictedMessages(results),
      'custom-filter-form.tsx should be allowlisted (escaped glob applies)',
    ).toHaveLength(0)
  })

  // --- Entries 2 & 3: exams/[id] → tags/_components (1-segment feature) ---
  it('GENERAL: a non-allowlisted exams file importing tags/_components IS flagged', async () => {
    const code = `import { ColorPalettePopover } from '@/app/(app)/app/tags/_components/color-palette-popover'\nexport const X = ColorPalettePopover\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'app/(app)/app/exams/[id]/_components/synthetic-crossfeature.tsx'),
    })
    expect(
      restrictedMessages(results),
      'cross-feature import into tags/_components must be flagged in a non-allowlisted file',
    ).not.toHaveLength(0)
  })

  it('EXEMPT: real card-tag-edit-fields.tsx (exams → tags, 2 imports) is allowlisted → zero restricted', async () => {
    const results = await eslint.lintFiles([
      path.join(ROOT, 'app/(app)/app/exams/[id]/_components/card-tag-edit-fields.tsx'),
    ])
    expect(
      restrictedMessages(results),
      'card-tag-edit-fields.tsx should be allowlisted (escaped glob applies)',
    ).toHaveLength(0)
  })

  // --- Entry 4: exams/[id]/_lib → ../_components (reverse-layering, Block C) ---
  it('GENERAL: a non-allowlisted _lib file importing ../_components IS flagged (Block C)', async () => {
    const code = `import { cols } from '../_components/some-columns'\nexport const X = cols\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'app/(app)/app/exams/[id]/_lib/synthetic-reverse-dep.ts'),
    })
    expect(
      restrictedMessages(results),
      'a _lib file importing ../_components must be flagged by Block C (files: app/**/_lib/**)',
    ).not.toHaveLength(0)
  })

  it('EXEMPT: real column-pinning.ts (_lib → _components, intentional) is allowlisted → zero restricted', async () => {
    const results = await eslint.lintFiles([
      path.join(ROOT, 'app/(app)/app/exams/[id]/_lib/column-pinning.ts'),
    ])
    expect(
      restrictedMessages(results),
      'column-pinning.ts should be allowlisted (escaped glob applies)',
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// getDb repo-wide ban (RLS-P3 Task 4). Tasks 1-3 converted every structural
// site so raw getDb() is now used ONLY inside lib/db/**; this rule ENFORCES
// that permanently. Each assertion mirrors the GENERAL/EXEMPT pairing already
// established above: a synthetic non-exempt site proves the rule fires, and a
// real exempt site proves the carve-out actually applies.
// ---------------------------------------------------------------------------
describe('import-boundary: getDb repo-wide ban (RLS-P3 Task 4)', () => {
  let eslint: ESLint

  beforeAll(() => {
    eslint = new ESLint({ cwd: ROOT })
  })

  it('GENERAL: a lib/ file (outside lib/db/) importing getDb via the @/lib/db alias IS flagged', async () => {
    const code = `import { getDb } from '@/lib/db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/exams/synthetic-getdb-test.ts'),
    })
    expect(
      restrictedMessages(results),
      'getDb import outside lib/db/ must be flagged',
    ).not.toHaveLength(0)
  })

  it('GENERAL: an app/ file importing getDb via the @/lib/db alias IS flagged', async () => {
    const code = `import { getDb } from '@/lib/db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'app/(app)/app/exams/_actions/synthetic-getdb-test.ts'),
    })
    expect(
      restrictedMessages(results),
      'getDb import in app/ must be flagged',
    ).not.toHaveLength(0)
  })

  it('GENERAL: the @/lib/db/index subpath bypass IS flagged', async () => {
    const code = `import { getDb } from '@/lib/db/index'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/exams/synthetic-getdb-subpath-test.ts'),
    })
    expect(
      restrictedMessages(results),
      '@/lib/db/index subpath bypass must be flagged',
    ).not.toHaveLength(0)
  })

  it('GENERAL: a relative ../db bypass (from a lib/ subdir) IS flagged', async () => {
    const code = `import { getDb } from '../db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/exams/synthetic-getdb-relative-test.ts'),
    })
    expect(
      restrictedMessages(results),
      'relative ../db bypass must be flagged',
    ).not.toHaveLength(0)
  })

  it('GENERAL: the @/lib/db/ trailing-slash alias bypass IS flagged', async () => {
    const code = `import { getDb } from '@/lib/db/'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/exams/synthetic-getdb-trailingslash-test.ts'),
    })
    expect(
      restrictedMessages(results),
      '@/lib/db/ trailing-slash bypass must be flagged',
    ).not.toHaveLength(0)
  })

  it('GENERAL: a relative ../db/ trailing-slash bypass IS flagged', async () => {
    const code = `import { getDb } from '../db/'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/exams/synthetic-getdb-relslash-test.ts'),
    })
    expect(
      restrictedMessages(results),
      'relative ../db/ trailing-slash bypass must be flagged',
    ).not.toHaveLength(0)
  })

  it('GENERAL: a root-level production entrypoint (proxy.ts) importing getDb IS flagged', async () => {
    const code = `import { getDb } from '@/lib/db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'proxy.ts'),
    })
    expect(
      restrictedMessages(results),
      'getDb in a root-level production file (proxy.ts / instrumentation.ts) must be flagged',
    ).not.toHaveLength(0)
  })

  it('EXEMPT: a root-level test file (proxy.test.ts) importing getDb is NOT flagged', async () => {
    const code = `import { getDb } from '@/lib/db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'proxy.test.ts'),
    })
    expect(
      restrictedMessages(results).filter((m) => /getDb/.test(m.message)),
      'root-level test files legitimately connect as the app-role via getDb',
    ).toHaveLength(0)
  })

  it('GENERAL: an ops script (scripts/*.ts) importing getDb IS flagged', async () => {
    const code = `import { getDb } from '@/lib/db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'scripts/synthetic-getdb-script.ts'),
    })
    expect(
      restrictedMessages(results),
      'getDb in an ops script must be flagged (scripts use getAdminDb, not raw getDb)',
    ).not.toHaveLength(0)
  })

  it('EXEMPT: getAdminDb in an ops script (scripts/*.ts) is NOT flagged', async () => {
    const code = `import { getAdminDb } from '@/lib/db'\nexport const x = () => getAdminDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'scripts/synthetic-getadmindb-script.ts'),
    })
    expect(
      restrictedMessages(results).filter((m) => /getDb/.test(m.message)),
      'getAdminDb is the sanctioned owner handle for ops scripts and must NOT be flagged',
    ).toHaveLength(0)
  })

  it('getNonTenantDb import (same location as the flagged getDb case) is NOT flagged', async () => {
    const code = `import { getNonTenantDb } from '@/lib/db'\nexport const x = () => getNonTenantDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/exams/synthetic-getnontenantdb-test.ts'),
    })
    expect(
      restrictedMessages(results),
      'getNonTenantDb must NOT be flagged — the ban is getDb-specific',
    ).toHaveLength(0)
  })

  it('`import type { DB }` (same location) is NOT flagged — type imports stay legal', async () => {
    const code = `import type { DB } from '@/lib/db'\nexport type X = DB\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/exams/synthetic-dbtype-test.ts'),
    })
    expect(
      restrictedMessages(results),
      'import type { DB } must NOT be flagged',
    ).toHaveLength(0)
  })

  it('REGRESSION GUARD: a namespace import of an unrelated lib/db subpath (@/lib/db/schema) is NOT flagged', async () => {
    // Guards against the gitignore-glob pitfall found while implementing this
    // task: a `group`-style pattern like `@/lib/db/*` (or a bare `*/lib/db` /
    // `**/lib/db`) recursively matches EVERY subpath under lib/db (gitignore
    // directory semantics), so `import * as schema from '@/lib/db/schema'`
    // got flagged even though schema.ts doesn't export getDb. The rule
    // config uses an anchored `regex` (exact-match, no recursion) instead —
    // this test pins that fix.
    const code = `import * as schema from '@/lib/db/schema'\nexport const x = schema\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/exams/synthetic-schema-namespace-test.ts'),
    })
    expect(
      restrictedMessages(results),
      'namespace import of @/lib/db/schema must NOT be flagged (real regression: tests/integration/pg/setup/completeness.ts)',
    ).toHaveLength(0)
  })

  it('EXEMPT: real lib/db/tenant-tx.ts (internal relative getDb import) is NOT flagged', async () => {
    const results = await eslint.lintFiles([path.join(ROOT, 'lib/db/tenant-tx.ts')])
    const restricted = restrictedMessages(results).filter(m =>
      /getDb/.test(m.message),
    )
    expect(
      restricted,
      'lib/db/tenant-tx.ts legitimately imports getDb internally and must not be flagged',
    ).toHaveLength(0)
  })

  it('EXEMPT: real test file outside lib/db/ importing getDb (lib/exams/list.owner-isolation.test.ts) is NOT flagged', async () => {
    const results = await eslint.lintFiles([
      path.join(ROOT, 'lib/exams/list.owner-isolation.test.ts'),
    ])
    const restricted = restrictedMessages(results).filter(m => /getDb/.test(m.message))
    expect(
      restricted,
      'test files legitimately connect as the app-role via getDb and must not be flagged',
    ).toHaveLength(0)
  })

  it('EXEMPT: the integration setup fixture (tests/integration/pg/setup/fixture.ts) is NOT flagged', async () => {
    const results = await eslint.lintFiles([
      path.join(ROOT, 'tests/integration/pg/setup/fixture.ts'),
    ])
    const restricted = restrictedMessages(results).filter(m => /getDb/.test(m.message))
    expect(
      restricted,
      'the H2 2-tenant fixture is the one deliberate non-.test.ts exemption under tests/**',
    ).toHaveLength(0)
  })

  it('FIXED SITE: lib/clerk/handle-clerk-event.ts no longer imports getDb (Task 4 fix) and is not flagged', async () => {
    const source = readFileSync(
      path.join(ROOT, 'lib/clerk/handle-clerk-event.ts'),
      'utf8',
    )
    expect(
      source,
      'handle-clerk-event.ts must not import getDb — it used ReturnType<typeof getDb> purely for typing and now uses the exported DB type instead',
    ).not.toMatch(/import\s*\{[^}]*\bgetDb\b/)
    const results = await eslint.lintFiles([
      path.join(ROOT, 'lib/clerk/handle-clerk-event.ts'),
    ])
    const restricted = restrictedMessages(results).filter(m => /getDb/.test(m.message))
    expect(restricted, 'handle-clerk-event.ts should have zero getDb-related restricted messages').toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Bypass-gap regression pins (RLS-P3 Task 4 review follow-up). Three latent
  // bypasses were closed after the initial implementation:
  //   Gap 1 — the 4 per-file allowlists set no-restricted-imports to `off`,
  //           which ALSO wiped the getDb ban for those production app files.
  //   Gap 2 — the 5 domain-purity blocks banned the exact `@/lib/db` alias but
  //           NOT its subpath (`@/lib/db/index`) / relative (`../../db`) getDb
  //           forms.
  //   Gap 3 — the ban regex omitted `./db` (a file directly in lib/ root
  //           reaching lib/db/index.ts).
  // Each is pinned below: flagged where it must be, and NOT over-reaching to
  // getNonTenantDb / import type.
  // -------------------------------------------------------------------------

  it('GAP-1: an allowlisted app file (custom-filter-form.tsx path) importing getDb IS flagged', async () => {
    // The per-file allowlist now re-sets the rule to the getDb ban only (was
    // `off`, which dropped the ban). getDb must be flagged even though the
    // file's own cross-feature exemption is preserved.
    const code = `import { getDb } from '@/lib/db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'app/(app)/app/study/custom/_components/custom-filter-form.tsx'),
    })
    expect(
      restrictedMessages(results),
      'getDb in an allowlisted file must be flagged (allowlist keeps only the getDb ban)',
    ).not.toHaveLength(0)
  })

  it('GAP-1: an allowlisted app file importing getNonTenantDb / import type DB is NOT flagged', async () => {
    // The allowlist retains ONLY the getDb ban — it must not over-reach to other
    // @/lib/db symbols, and type imports stay legal.
    const fp = path.join(ROOT, 'app/(app)/app/study/custom/_components/custom-filter-form.tsx')
    const nonTenant = `import { getNonTenantDb } from '@/lib/db'\nexport const y = () => getNonTenantDb()\n`
    const typeOnly = `import type { DB } from '@/lib/db'\nexport type Z = DB\n`
    expect(
      restrictedMessages(await eslint.lintText(nonTenant, { filePath: fp })),
      'getNonTenantDb must NOT be flagged in an allowlisted file (ban is getDb-specific)',
    ).toHaveLength(0)
    expect(
      restrictedMessages(await eslint.lintText(typeOnly, { filePath: fp })),
      'import type { DB } must NOT be flagged in an allowlisted file',
    ).toHaveLength(0)
  })

  it('GAP-2: a domain-dir file importing getDb via the @/lib/db/index subpath IS flagged', async () => {
    // Domain-purity blocks ban the exact `@/lib/db` alias but NOT the subpath;
    // the composed GETDB_BAN.patterns close that in every domain dir.
    const code = `import { getDb } from '@/lib/db/index'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/stripe/domain/synthetic-getdb-subpath.ts'),
    })
    expect(
      restrictedMessages(results),
      'domain-dir @/lib/db/index getDb bypass must be flagged',
    ).not.toHaveLength(0)
  })

  it('GAP-2: a domain-dir file importing getDb via a relative ../../db IS flagged', async () => {
    // lib/stripe/domain/x.ts → ../../db === lib/db. The domain infra ban doesn't
    // match this source string; GETDB_BAN.patterns does.
    const code = `import { getDb } from '../../db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/stripe/domain/synthetic-getdb-relative.ts'),
    })
    expect(
      restrictedMessages(results),
      'domain-dir ../../db getDb bypass must be flagged',
    ).not.toHaveLength(0)
  })

  it('GAP-2: a domain-dir getNonTenantDb (subpath) / import type DB is NOT flagged — ban stays getDb-specific', async () => {
    const fp = path.join(ROOT, 'lib/stripe/domain/synthetic-getnontenant.ts')
    const nonTenant = `import { getNonTenantDb } from '@/lib/db/index'\nexport const y = () => getNonTenantDb()\n`
    const typeOnly = `import type { DB } from '@/lib/db'\nexport type Z = DB\n`
    expect(
      restrictedMessages(await eslint.lintText(nonTenant, { filePath: fp })),
      'getNonTenantDb via subpath must NOT be flagged by the getDb ban',
    ).toHaveLength(0)
    expect(
      restrictedMessages(await eslint.lintText(typeOnly, { filePath: fp })),
      'import type { DB } must NOT be flagged in a domain dir (allowTypeImports)',
    ).toHaveLength(0)
  })

  it('GAP-3: a lib/-root file importing getDb via ./db IS flagged', async () => {
    // A file sitting directly in lib/ root can reach lib/db/index.ts via `./db`
    // — the regex now covers `./db` / `./db/index`.
    const code = `import { getDb } from './db'\nexport const x = () => getDb()\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'lib/synthetic-getdb-libroot.ts'),
    })
    expect(
      restrictedMessages(results),
      'lib/-root ./db getDb bypass must be flagged',
    ).not.toHaveLength(0)
  })
})
