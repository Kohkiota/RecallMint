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
    const code = `import { something } from '@/app/(marketing)/contact/actions'\nexport {}\n`
    const results = await eslint.lintText(code, {
      filePath: path.join(ROOT, 'components/synthetic-boundary-test.tsx'),
    })
    const restricted = restrictedMessages(results)
    expect(restricted.length, 'Expected no-restricted-imports violation in components/ → @/app').toBeGreaterThan(0)
  })

  it('flags a components/ file importing app/ via relative parent traversal', async () => {
    // Ensures the relative-path bypass is blocked: `../../app/(marketing)/contact/actions`
    // must be caught by the `../app/**` / `../**/app/**` patterns in Block A.
    const code = `import { someAction } from '../../app/(marketing)/contact/actions'\nexport {}\n`
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

  it('contact-form.tsx: @/app import NOT flagged (components → @/app allowlisted)', async () => {
    // Linting the real file exercises the `files: ['components/marketing/contact-form.tsx']` override.
    const results = await eslint.lintFiles([
      path.join(ROOT, 'components/marketing/contact-form.tsx'),
    ])
    const restricted = restrictedMessages(results)
    expect(restricted, 'contact-form.tsx should have no-restricted-imports allowlisted').toHaveLength(0)
  })

  it('exam-detail-view.tsx: deep relative import NOT flagged (escaped override applies)', async () => {
    // Linting the real file exercises the escaped glob:
    //   `app/\\(app\\)/app/exams/\\[id\\]/_components/exam-detail-view.tsx`
    // If the escapes are wrong, this file gets the Block B rule applied → test fails.
    const results = await eslint.lintFiles([
      path.join(ROOT, 'app/(app)/app/exams/[id]/_components/exam-detail-view.tsx'),
    ])
    const restricted = restrictedMessages(results)
    expect(restricted, 'exam-detail-view.tsx should have no-restricted-imports allowlisted').toHaveLength(0)
  })

  it('upload result page.tsx: deep relative import NOT flagged (escaped override applies)', async () => {
    // Linting the real file exercises the escaped glob:
    //   `app/\\(app\\)/app/upload/result/\\[sourceDocumentId\\]/page.tsx`
    const results = await eslint.lintFiles([
      path.join(ROOT, 'app/(app)/app/upload/result/[sourceDocumentId]/page.tsx'),
    ])
    const restricted = restrictedMessages(results)
    expect(restricted, 'upload result page.tsx should have no-restricted-imports allowlisted').toHaveLength(0)
  })
})
