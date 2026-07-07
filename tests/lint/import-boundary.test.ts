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
