// recallmint flat ESLint config (波2)。
// 詳細: docs/superpowers/specs/2026-06-10-eslint-ci-gate-design.md
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

// ---------------------------------------------------------------------------
// Block A pattern: lib/ and components/ must not import from the app/ layer.
// Extracted to a shared const so the Subscription domain block below can
// re-include it (flat-config rule options REPLACE per file — see Block C note).
// ---------------------------------------------------------------------------
const LIB_NO_APP_IMPORTS = {
  group: ['@/app/*', '@/app/**', '../app/**', '../**/app/**'],
  message:
    'lib/ and components/ must not import from the app/ layer. Move shared logic to lib/ instead. (No per-file allowlists remain — Block A is clean as of P4 W5.)',
}

// ---------------------------------------------------------------------------
// Subscription domain purity: `lib/stripe/domain/**` is pure domain and must not
// RUNTIME-import infra / orchestration modules. `import type` is always allowed
// (allowTypeImports) and intra-domain runtime imports (`./subscription-values`)
// are NOT listed, so they pass. Forbidden runtime targets = infra (db / drizzle /
// ops / next / price-mapping / server-only) + orchestration (handle-stripe-event /
// subscription / subscription-repository / project-subscription).
// ---------------------------------------------------------------------------
const DOMAIN_NO_INFRA_IMPORTS = {
  paths: [
    { name: '@/lib/db', allowTypeImports: true, message: 'Subscription domain must not runtime-import infra (@/lib/db).' },
    { name: 'drizzle-orm', allowTypeImports: true, message: 'Subscription domain must not runtime-import infra (drizzle-orm).' },
    { name: '@/lib/ops', allowTypeImports: true, message: 'Subscription domain must not runtime-import infra (@/lib/ops).' },
    { name: '@/lib/stripe/price-mapping', allowTypeImports: true, message: 'Subscription domain must not runtime-import infra (price-mapping); inject price resolution instead.' },
    { name: 'server-only', allowTypeImports: true, message: 'Subscription domain must stay environment-agnostic (no server-only).' },
    { name: '@/lib/stripe/handle-stripe-event', allowTypeImports: true, message: 'Subscription domain must not runtime-import orchestration (handle-stripe-event).' },
    { name: '@/lib/stripe/subscription', allowTypeImports: true, message: 'Subscription domain must not runtime-import orchestration (subscription).' },
    { name: '@/lib/stripe/subscription-repository', allowTypeImports: true, message: 'Subscription domain must not runtime-import orchestration (subscription-repository).' },
    { name: '@/lib/stripe/project-subscription', allowTypeImports: true, message: 'Subscription domain must not runtime-import orchestration (project-subscription).' },
  ],
  patterns: [
    {
      group: ['next', 'next/*'],
      allowTypeImports: true,
      message: 'Subscription domain must not runtime-import framework (next / next/*).',
    },
  ],
}

// ---------------------------------------------------------------------------
// Session domain purity: `lib/reviews/domain/**` is pure domain and must not
// RUNTIME-import infra / orchestration modules (mirrors the Subscription block
// above). `import type` is always allowed (allowTypeImports) and intra-domain
// runtime imports (`./session-values` / `./session-aggregate`) are NOT listed,
// so they pass — as do pure siblings (@/lib/cards/replay-card / @/lib/jst /
// @/lib/fsrs). Forbidden runtime targets = infra (db / drizzle / logger /
// server-only) + zod (domain is zod-free — spec §3, structural types defined
// in-domain) + orchestration (ingest-review-events / session-repository).
// ---------------------------------------------------------------------------
const SESSION_DOMAIN_NO_INFRA_IMPORTS = {
  paths: [
    { name: '@/lib/db', allowTypeImports: true, message: 'Session domain must not runtime-import infra (@/lib/db).' },
    { name: 'drizzle-orm', allowTypeImports: true, message: 'Session domain must not runtime-import infra (drizzle-orm).' },
    { name: '@/lib/logger', allowTypeImports: true, message: 'Session domain must not runtime-import infra (@/lib/logger).' },
    { name: 'server-only', allowTypeImports: true, message: 'Session domain must stay environment-agnostic (no server-only).' },
    { name: 'zod', allowTypeImports: true, message: 'Session domain must not runtime-import zod; define structural types in-domain (spec §3).' },
    { name: '@/lib/reviews/ingest-review-events', allowTypeImports: true, message: 'Session domain must not runtime-import orchestration (ingest-review-events).' },
    { name: '@/lib/reviews/session-repository', allowTypeImports: true, message: 'Session domain must not runtime-import orchestration (session-repository).' },
  ],
  patterns: [
    {
      group: ['next', 'next/*'],
      allowTypeImports: true,
      message: 'Session domain must not runtime-import framework (next / next/*).',
    },
  ],
}

// ---------------------------------------------------------------------------
// Card domain purity (F3 R7): `lib/cards/domain/**` is pure domain and must not
// RUNTIME-import infra / framework / orchestration modules (mirrors the Session
// block above). `import type` is always allowed (allowTypeImports) — this is the
// crux for two legitimate existing imports: `card-rules.ts` does
// `import type { CardOption } from '@/lib/db/schema'` and `card-tag-constraint.ts`
// does `import type { SelectType } from '@/lib/tags/domain/tag-values'`; both stay
// legal, but a RUNTIME import from those targets is denied. Forbidden runtime
// targets = infra (db / drizzle / logger / server-only) + zod + framework (next /
// next/*) + cross-domain (@/lib/tags/domain, runtime only) + orchestration
// back-flow (apply-card-mutation / card-field-handlers).
// ---------------------------------------------------------------------------
const CARD_DOMAIN_NO_INFRA_IMPORTS = {
  paths: [
    { name: '@/lib/db', allowTypeImports: true, message: 'Card domain must not runtime-import infra (@/lib/db).' },
    { name: 'drizzle-orm', allowTypeImports: true, message: 'Card domain must not runtime-import infra (drizzle-orm).' },
    { name: '@/lib/logger', allowTypeImports: true, message: 'Card domain must not runtime-import infra (@/lib/logger).' },
    { name: 'server-only', allowTypeImports: true, message: 'Card domain must stay environment-agnostic (no server-only).' },
    { name: 'zod', allowTypeImports: true, message: 'Card domain must not runtime-import zod; define structural types in-domain.' },
    { name: '@/lib/tags/domain', allowTypeImports: true, message: 'Card domain must not runtime-import the tags domain; cross-domain coupling is type-only (import type).' },
    { name: '@/lib/cards/apply-card-mutation', allowTypeImports: true, message: 'Card domain must not runtime-import orchestration (apply-card-mutation).' },
    { name: '@/lib/cards/card-field-handlers', allowTypeImports: true, message: 'Card domain must not runtime-import orchestration (card-field-handlers).' },
  ],
  patterns: [
    {
      group: ['next', 'next/*'],
      allowTypeImports: true,
      message: 'Card domain must not runtime-import framework (next / next/*).',
    },
    {
      group: ['@/lib/tags/domain/*'],
      allowTypeImports: true,
      message: 'Card domain must not runtime-import the tags domain; cross-domain coupling is type-only (import type).',
    },
  ],
}

// ---------------------------------------------------------------------------
// Tag domain purity (F3 R7): `lib/tags/domain/**` is pure domain and must not
// RUNTIME-import infra / framework / orchestration modules (mirrors the Card block
// above). `import type` is always allowed (allowTypeImports). tag-values.ts
// currently has no imports, so the orchestration back-flow deny
// (@/lib/tags/apply-tag-mutation) is symmetric future-proofing. Forbidden runtime
// targets = infra (db / drizzle / logger / server-only) + zod + framework (next /
// next/*) + orchestration back-flow (apply-tag-mutation).
// ---------------------------------------------------------------------------
const TAG_DOMAIN_NO_INFRA_IMPORTS = {
  paths: [
    { name: '@/lib/db', allowTypeImports: true, message: 'Tag domain must not runtime-import infra (@/lib/db).' },
    { name: 'drizzle-orm', allowTypeImports: true, message: 'Tag domain must not runtime-import infra (drizzle-orm).' },
    { name: '@/lib/logger', allowTypeImports: true, message: 'Tag domain must not runtime-import infra (@/lib/logger).' },
    { name: 'server-only', allowTypeImports: true, message: 'Tag domain must stay environment-agnostic (no server-only).' },
    { name: 'zod', allowTypeImports: true, message: 'Tag domain must not runtime-import zod; define structural types in-domain.' },
    { name: '@/lib/tags/apply-tag-mutation', allowTypeImports: true, message: 'Tag domain must not runtime-import orchestration (apply-tag-mutation).' },
  ],
  patterns: [
    {
      group: ['next', 'next/*'],
      allowTypeImports: true,
      message: 'Tag domain must not runtime-import framework (next / next/*).',
    },
  ],
}

// ---------------------------------------------------------------------------
// Media domain purity (画像 GC v2 Task G2): `lib/media/domain/**` is pure domain
// and must not RUNTIME-import infra / framework / orchestration modules (mirrors
// the Card/Tag blocks above). `import type` is always allowed (allowTypeImports).
// asset-state.ts has no imports at all (in-domain AssetStatus union per brief),
// so the orchestration back-flow deny (@/lib/media/asset-actions) is symmetric
// future-proofing for when R1/G5/W2 wire consumers. Forbidden runtime targets =
// infra (db / drizzle / logger / server-only) + zod + framework (next / next/*) +
// orchestration back-flow (asset-actions).
// ---------------------------------------------------------------------------
const MEDIA_DOMAIN_NO_INFRA_IMPORTS = {
  paths: [
    { name: '@/lib/db', allowTypeImports: true, message: 'Media domain must not runtime-import infra (@/lib/db).' },
    { name: 'drizzle-orm', allowTypeImports: true, message: 'Media domain must not runtime-import infra (drizzle-orm).' },
    { name: '@/lib/logger', allowTypeImports: true, message: 'Media domain must not runtime-import infra (@/lib/logger).' },
    { name: 'server-only', allowTypeImports: true, message: 'Media domain must stay environment-agnostic (no server-only).' },
    { name: 'zod', allowTypeImports: true, message: 'Media domain must not runtime-import zod; define structural types in-domain.' },
    { name: '@/lib/media/asset-actions', allowTypeImports: true, message: 'Media domain must not runtime-import orchestration (asset-actions).' },
  ],
  patterns: [
    {
      group: ['next', 'next/*'],
      allowTypeImports: true,
      message: 'Media domain must not runtime-import framework (next / next/*).',
    },
    // `paths: '@/lib/db'` above only matches the exact source string, so a runtime
    // `import { x } from '@/lib/db/schema'` (subpath) would slip through. This
    // pattern closes that hole while keeping `import type` legal (Card domain
    // pulls CardOption from '@/lib/db/schema' this way). Intentionally stricter
    // than the 4 sibling domain blocks (which share this pre-existing gap) — this
    // is the new module; the others are not touched here.
    {
      group: ['@/lib/db/*'],
      allowTypeImports: true,
      message: 'Media domain must not runtime-import infra subpaths (@/lib/db/*); import type only.',
    },
  ],
}

// ---------------------------------------------------------------------------
// Shared no-restricted-imports pattern groups (composed per files-scope below).
// NOTE on matching semantics: `no-restricted-imports` `group` patterns match the
// IMPORT SOURCE STRING (not a filesystem path). In that matcher `(app)` / `[id]`
// are treated LITERALLY and `*` matches a single path segment (`[id]` included),
// so no `\\(...\\)` / `\\[...\\]` escaping is used here — the escaping rule only
// applies to the flat-config `files:` field (see the per-file overrides below).
// ---------------------------------------------------------------------------

// Block B pattern: deep relative imports (3+ levels up) in app/.
// `../../../**` catches 3 levels AND 4+ (minimatch `**` crosses `/` and treats
// `..` as a normal segment). Fix = use the @/ alias.
const DEEP_RELATIVE_IMPORTS = {
  group: ['../../../**'],
  message:
    'Deep relative imports (3+ levels up) are forbidden in app/. Use the @/ alias instead.',
}

// Cross-feature imports into another feature's private `_components/` namespace.
// `*/_components/**` catches a 1-segment feature (e.g. `tags/_components/...`);
// `*/*/_components/**` catches a 2-segment feature (e.g. `exams/[id]/_components/...`).
// The shared app-shell at `@/app/(app)/app/_components/app-container` has NO feature
// segment before `_components`, so it is intentionally NOT matched (legitimate import).
// 分類: 一時的負債 / 機能境界強化時に再評価 (3 known sites allowlisted per-file below).
const CROSS_FEATURE_PRIVATE_COMPONENTS = {
  group: ['@/app/(app)/app/*/_components/**', '@/app/(app)/app/*/*/_components/**'],
  message:
    "Cross-feature import into another feature's private _components/ namespace. " +
    'Move the shared component to components/ or a shared location. ' +
    '(3 files / 4 import violations are allowlisted per-file below — 一時的負債 / 機能境界強化時に再評価.)',
}

// Reverse-layering: a feature `_lib/` module importing its sibling `_components/`.
// Scoped to `_lib/` files only (Block C) so the ~8 legitimate feature pages that
// import the shared shell via `../_components/app-container` are NOT affected.
// 分類: 意図的設計 (columns-as-data SSoT — see column-pinning.ts header).
const LIB_REVERSE_DEP_COMPONENTS = {
  group: ['../_components/**'],
  message:
    'A feature _lib/ module importing its _components/ is a reverse-layering dependency. ' +
    '(1 known site — column-pinning.ts, columns-as-data SSoT — allowlisted per-file below.)',
}

// ---------------------------------------------------------------------------
// getDb repo-wide ban (RLS-P3 Task 4, Codex#2.1/#2.2). Tasks 1-3 converted every
// structural site so raw `getDb()` is now used ONLY inside `lib/db/**` (verified
// by repo-wide grep). This block ENFORCES that permanently: production code
// must use `withTenantTx(userId, fn)` (tenant path) or `getNonTenantDb()`
// (non-tenant path) — never import `getDb` directly. `getDb` itself stays
// exported (lib/db internals use it via relative import, e.g.
// `lib/db/tenant-tx.ts`'s `import { getDb } from './index'`) — the restriction
// is lint-only, not a removed export (Codex#2.2). Only the named symbol
// `getDb` is restricted — `getNonTenantDb` / `withTenantTx` / `getAdminDb` /
// `closeDb` / the `DB` type are all unrestricted, and `import type` is always
// allowed (allowTypeImports).
//
// Bypass-route coverage (Codex#2.1): `paths` restricts the exact `@/lib/db`
// alias named-import. `patterns` closes the subpath (`@/lib/db/index`) and
// relative-import bypasses (`../db`, `../../db` [+ /index variants], and the
// `../lib/db` [+ /index] forms reachable from lib/'s sibling directories, plus
// `./index` per the brief's defensive suggestion).
//
// NOTE (gitignore-glob pitfall, found + fixed while implementing this task):
// a `patterns.group` glob-style entry (`@/lib/db/*`, or even a bare `*/lib/db`
// / `**/lib/db`) FALSE-POSITIVED on `import * as schema from '@/lib/db/schema'`
// (tests/integration/pg/setup/completeness.ts). Two compounding reasons: (1)
// `no-restricted-imports`'s `group` matcher is the `ignore` npm package
// (gitignore semantics), where a pattern matching a "directory" path
// (`@/lib/db`) recursively matches everything nested under it
// (`@/lib/db/schema` included) — there is no glob syntax to match a path
// WITHOUT its descendants; (2) separately, the rule always conservatively
// flags a NAMESPACE import (`import * as x`) against every configured
// `importNames` for any matching source, since it cannot statically prove the
// namespace isn't used to reach the restricted name — even though
// `@/lib/db/schema` doesn't export `getDb` at all. Fix: switch the subpath /
// relative-bypass entry from `group` (glob) to `regex` (anchored `^...$`,
// exact-match only, no directory recursion) — `no-restricted-imports` supports
// either on a pattern entry, both composable with `importNames` /
// `allowTypeImports`. Verified with the `ignore` package directly (matches
// `@/lib/db` and `../db` but NOT `@/lib/db/schema` / `../db/schema`).
// Dynamic `import()` / `require()` of getDb are NOT used anywhere in the
// codebase (grep-verified 2026-07-21) — no additional detection is added for
// them (over-engineering beyond what static `no-restricted-imports` covers).
// ---------------------------------------------------------------------------
const GETDB_BAN_MESSAGE =
  'getDb is restricted to lib/db/ internals (RLS-P3 Task 4). Use withTenantTx(userId, fn) for the tenant path, or getNonTenantDb() for the non-tenant path.'

const GETDB_BAN = {
  paths: [
    {
      name: '@/lib/db',
      importNames: ['getDb'],
      allowTypeImports: true,
      message: GETDB_BAN_MESSAGE,
    },
  ],
  patterns: [
    {
      // Anchored (^...$) exact-match regex — deliberately NOT a `group` glob
      // (see NOTE above for why glob recurses into unrelated subpaths like
      // `@/lib/db/schema`). Matches the source strings that resolve to
      // lib/db/index.ts and could import getDb: the alias with subpath or
      // trailing slash (`@/lib/db/index`, `@/lib/db/`); relative via an
      // explicit `lib/db` segment (`../lib/db`, `../../lib/db`); relative
      // assuming the importer sits inside lib/ (`../db`, `../../db`); and
      // same-directory `./db` from a file in lib/ root (a real bypass a future
      // `lib/foo.ts` alongside `lib/ai-usage-mcq.ts` could use). The trailing
      // `(?:/index)?/?` covers the optional `/index` subpath and directory
      // trailing-slash forms (`@/lib/db/`, `../db/`, `./db/`). The `$` anchor
      // keeps it from over-matching `@/lib/db/schema` / `./db/schema`, and
      // `importNames: ['getDb']` keeps a `./db` in a non-lib dir (no getDb
      // export) from ever firing.
      regex:
        '^(?:@/lib/db|(?:\\.\\./)+lib/db|(?:\\.\\./)+db|\\./db)(?:/index)?/?$',
      caseSensitive: true,
      importNames: ['getDb'],
      allowTypeImports: true,
      message: GETDB_BAN_MESSAGE,
    },
  ],
}

const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // `_` prefix の意図的 unused (test mock 等) を許容。 preset は default で
      // ignore しないため明示。
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // React Compiler OFF 制約 (recallmint-deps-target-matrix v1.1) と紐づく
      // 一時 off。 Compiler 採用 sprint で再有効化 + 手動 memo 修正。
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  // ---------------------------------------------------------------------------
  // Block A: lib/ and components/ must not import from app/ layer.
  // Shared logic belongs in lib/. NO per-file allowlists remain — Block A is clean
  // (the last one, contact-form.tsx, was resolved in P4 W5 by moving its server
  // action to lib/actions/. See P4 plan Task7).
  // ---------------------------------------------------------------------------
  {
    files: ['lib/**/*', 'components/**/*'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [LIB_NO_APP_IMPORTS] }],
    },
  },
  // ---------------------------------------------------------------------------
  // Block A-getdb: repo-wide getDb ban applied to lib/**/components/** (RLS-P3
  // Task 4). Must come AFTER Block A (flat-config rule options REPLACE, not
  // merge, per file — same caveat the domain blocks below document) so it wins
  // for non-exempt files; re-includes LIB_NO_APP_IMPORTS so Block A's
  // app/-layer boundary is not lost for those files. `ignores` exempts
  // `lib/db/**` (internal legitimate getDb use — e.g. tenant-tx.ts) and test
  // files (`**/*.test.ts`/`**/*.test.tsx` — e.g. lib/ai-usage-counter.test.ts
  // connects as the app-role via getDb); for those files Block A's original
  // (unignored) rule value remains in effect, unchanged from before this task.
  // The Subscription/Session/Card/Tag/Media domain-purity blocks (A' below)
  // REPLACE this block for their narrower scope. Their whole-`@/lib/db` deny
  // covers the alias named-import, but NOT the subpath (`@/lib/db/index`) /
  // relative (`../../db`) getDb bypass forms — so each domain block now
  // explicitly composes `...GETDB_BAN.paths` / `...GETDB_BAN.patterns` (Gap-2
  // fix) to inherit the exact same getDb coverage as this block.
  // ---------------------------------------------------------------------------
  {
    files: ['lib/**/*', 'components/**/*'],
    ignores: ['lib/db/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: GETDB_BAN.paths,
          patterns: [LIB_NO_APP_IMPORTS, ...GETDB_BAN.patterns],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block A': Subscription domain purity guard (must come AFTER Block A so it wins
  // for `lib/stripe/domain/**` files). Flat-config rule options REPLACE (not merge)
  // per file — same caveat as Block C — so this block re-includes Block A's
  // LIB_NO_APP_IMPORTS pattern to preserve the app/-layer boundary, then adds the
  // domain infra/orchestration deny (paths + next/* pattern) on top.
  // Scope excludes *.test.ts: domain tests legitimately import vitest and pull VOs
  // via `@/lib/stripe/domain/*`, which are not the runtime-purity concern here.
  // The `lib/stripe/domain/**` glob has no route group / dynamic segment → no escaping.
  // ---------------------------------------------------------------------------
  {
    files: ['lib/stripe/domain/**/*.ts'],
    ignores: ['lib/stripe/domain/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...DOMAIN_NO_INFRA_IMPORTS.paths, ...GETDB_BAN.paths],
          patterns: [LIB_NO_APP_IMPORTS, ...DOMAIN_NO_INFRA_IMPORTS.patterns, ...GETDB_BAN.patterns],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block A'': Session domain purity guard (F2 R4). Same structure/rationale as
  // Block A' above but scoped to `lib/reviews/domain/**` — must come AFTER Block A
  // so it wins for those files. Flat-config rule options REPLACE (not merge) per
  // file, so this re-includes Block A's LIB_NO_APP_IMPORTS pattern to keep the
  // app/-layer boundary, then layers the Session domain infra/orchestration/zod
  // deny (paths + next/* pattern) on top. Scope excludes *.test.ts (domain tests
  // import vitest and pull VOs via `@/lib/reviews/domain/*` — not the runtime-purity
  // concern). The `lib/reviews/domain/**` glob has no route group / dynamic
  // segment → no `\\(...\\)` / `\\[...\\]` escaping needed.
  // ---------------------------------------------------------------------------
  {
    files: ['lib/reviews/domain/**/*.ts'],
    ignores: ['lib/reviews/domain/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...SESSION_DOMAIN_NO_INFRA_IMPORTS.paths, ...GETDB_BAN.paths],
          patterns: [LIB_NO_APP_IMPORTS, ...SESSION_DOMAIN_NO_INFRA_IMPORTS.patterns, ...GETDB_BAN.patterns],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block A''': Card domain purity guard (F3 R7). Same structure/rationale as
  // Block A'' above but scoped to `lib/cards/domain/**` — must come AFTER Block A
  // so it wins for those files. Flat-config rule options REPLACE (not merge) per
  // file, so this re-includes Block A's LIB_NO_APP_IMPORTS pattern to keep the
  // app/-layer boundary, then layers the Card domain infra/framework/cross-domain/
  // orchestration deny (paths + next/* + @/lib/tags/domain/* patterns) on top.
  // Scope excludes *.test.ts (domain tests import vitest and pull VOs via
  // `@/lib/cards/domain/*` — not the runtime-purity concern). The
  // `lib/cards/domain/**` glob has no route group / dynamic segment → no
  // `\\(...\\)` / `\\[...\\]` escaping needed.
  // ---------------------------------------------------------------------------
  {
    files: ['lib/cards/domain/**/*.ts'],
    ignores: ['lib/cards/domain/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...CARD_DOMAIN_NO_INFRA_IMPORTS.paths, ...GETDB_BAN.paths],
          patterns: [LIB_NO_APP_IMPORTS, ...CARD_DOMAIN_NO_INFRA_IMPORTS.patterns, ...GETDB_BAN.patterns],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block A'''': Tag domain purity guard (F3 R7). Same structure/rationale as
  // Block A''' above but scoped to `lib/tags/domain/**` — must come AFTER Block A
  // so it wins for those files. Flat-config rule options REPLACE (not merge) per
  // file, so this re-includes Block A's LIB_NO_APP_IMPORTS pattern to keep the
  // app/-layer boundary, then layers the Tag domain infra/framework/orchestration
  // deny (paths + next/* pattern) on top. Scope excludes *.test.ts (domain tests
  // import vitest and pull VOs via `@/lib/tags/domain/*` — not the runtime-purity
  // concern). The `lib/tags/domain/**` glob has no route group / dynamic segment →
  // no `\\(...\\)` / `\\[...\\]` escaping needed.
  // ---------------------------------------------------------------------------
  {
    files: ['lib/tags/domain/**/*.ts'],
    ignores: ['lib/tags/domain/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...TAG_DOMAIN_NO_INFRA_IMPORTS.paths, ...GETDB_BAN.paths],
          patterns: [LIB_NO_APP_IMPORTS, ...TAG_DOMAIN_NO_INFRA_IMPORTS.patterns, ...GETDB_BAN.patterns],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block A''''': Media domain purity guard (画像 GC v2 Task G2). Same
  // structure/rationale as Block A'''' above but scoped to `lib/media/domain/**`
  // — must come AFTER Block A so it wins for those files. Flat-config rule
  // options REPLACE (not merge) per file, so this re-includes Block A's
  // LIB_NO_APP_IMPORTS pattern to keep the app/-layer boundary, then layers the
  // Media domain infra/framework/orchestration deny (paths + next/* pattern) on
  // top. Scope excludes *.test.ts (domain tests import vitest — not the
  // runtime-purity concern). The `lib/media/domain/**` glob has no route group /
  // dynamic segment → no `\\(...\\)` / `\\[...\\]` escaping needed.
  // ---------------------------------------------------------------------------
  {
    files: ['lib/media/domain/**/*.ts'],
    ignores: ['lib/media/domain/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...MEDIA_DOMAIN_NO_INFRA_IMPORTS.paths, ...GETDB_BAN.paths],
          patterns: [LIB_NO_APP_IMPORTS, ...MEDIA_DOMAIN_NO_INFRA_IMPORTS.patterns, ...GETDB_BAN.patterns],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block B: app/ import boundaries.
  //  - deep relative imports (3+ levels up) — DEEP_RELATIVE_IMPORTS
  //  - cross-feature imports into another feature's private _components/ —
  //    CROSS_FEATURE_PRIVATE_COMPONENTS (P3 W7: visualized, NOT yet resolved)
  // Remaining real violations are allowlisted per-file below.
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [DEEP_RELATIVE_IMPORTS, CROSS_FEATURE_PRIVATE_COMPONENTS] },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block B-getdb: repo-wide getDb ban applied to app/**/* (RLS-P3 Task 4).
  // Same REPLACE-semantics rationale as Block A-getdb above — must come AFTER
  // Block B so it wins for non-exempt files, re-includes Block B's patterns so
  // the deep-relative / cross-feature boundaries are not lost. `ignores`
  // exempts test files (no lib/db/** under app/, so that ignore is not
  // needed here).
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/*'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: GETDB_BAN.paths,
          patterns: [
            DEEP_RELATIVE_IMPORTS,
            CROSS_FEATURE_PRIVATE_COMPONENTS,
            ...GETDB_BAN.patterns,
          ],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block C: app/**/_lib/ reverse-layering guard (must come AFTER Block B /
  // Block B-getdb so it wins for `_lib/` files). Flat-config rule options
  // REPLACE (not merge) per file, so this block re-includes Block B's patterns
  // AND the Block B-getdb getDb-ban patterns to preserve coverage for `_lib/`
  // files, then adds LIB_REVERSE_DEP_COMPONENTS on top. `ignores` exempts test
  // files, mirroring Block B-getdb (no known `_lib/**/*.test.ts` site imports
  // getDb — grep-verified 2026-07-21 — but the exemption is added for
  // consistency with the other getDb-ban blocks).
  // The `app/**/_lib/**` glob uses `**` (not literal `(app)`/`[id]`) so no escaping
  // is required — `**` spans the route group / dynamic segment as literal dirs.
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/_lib/**'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: GETDB_BAN.paths,
          patterns: [
            DEEP_RELATIVE_IMPORTS,
            CROSS_FEATURE_PRIVATE_COMPONENTS,
            LIB_REVERSE_DEP_COMPONENTS,
            ...GETDB_BAN.patterns,
          ],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block D: getDb ban for tests/** (RLS-P3 Task 4). `tests/**` is not matched
  // by any block above (it is a top-level dir, sibling to lib/app/components),
  // so this has no REPLACE conflict. Test 除外は最小限 (Codex#2.3/#4 —
  // production→test helper 逆流がないことを担保するため, blanket `tests/**`
  // ignore is NOT used): `**/*.test.ts`/`**/*.test.tsx` plus exactly one
  // non-test.ts site that legitimately imports real getDb() —
  // `tests/integration/pg/setup/fixture.ts` (2-tenant H2 fixture, connects as
  // the app-role) — grep-verified 2026-07-21 to be the ONLY such site under
  // tests/**.
  // ---------------------------------------------------------------------------
  {
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    ignores: [
      '**/*.test.ts',
      '**/*.test.tsx',
      'tests/integration/pg/setup/fixture.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: GETDB_BAN.paths, patterns: GETDB_BAN.patterns },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block getDb-scripts: repo-wide getDb ban for ops scripts (seed / GC /
  // backfill). scripts/** are operator tooling that today connect via
  // getAdminDb (owner) — never raw getDb — so this is latent; it forces any
  // future script needing app-role access to use getNonTenantDb/withTenantTx
  // instead of raw getDb. Exempts scripts/**/*.test.ts. Completes executable-
  // scope coverage: lib/components/app/tests/root + scripts (types/*.d.ts have
  // no runtime imports).
  // ---------------------------------------------------------------------------
  {
    files: ['scripts/**/*.ts'],
    ignores: ['scripts/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: GETDB_BAN.paths, patterns: GETDB_BAN.patterns },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block getDb-root: repo-wide getDb ban for root-level production entrypoints
  // (proxy.ts, instrumentation.ts) + root config .ts (Codex#2.2 round-3). Root
  // files sit outside the lib/app/components/tests globs above, so without this
  // they could import getDb. `files: ['*.ts']` matches ROOT-level only (flat
  // config: `*` is non-recursive; `**/*` would be recursive). Exempts root
  // `*.test.ts` (tests connect as the app-role) and `*.d.ts` (type decls, no
  // runtime imports). None of these files import getDb today (grep-verified).
  // ---------------------------------------------------------------------------
  {
    files: ['*.ts'],
    ignores: ['*.test.ts', '*.d.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: GETDB_BAN.paths, patterns: GETDB_BAN.patterns },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block E1-render: 認証必須 route group (app/(app)/**) で静的レンダリング /
  // ISR を強制する segment config export を禁止する。認証必須ページを静的化 /
  // ISR 化すると、レンダリング層でユーザー間のキャッシュ漏れが起きうる (DB 層で
  // RLS が塞ぐのと同種の漏れが、レンダリング層には無防備で残る)。正本 =
  // docs/architecture.md §5。
  //
  // 禁止対象 (認証 group 配下の production route file のみ・test は ignore):
  //   - export const revalidate  (false=永久 cache / N=ISR、値によらず static cache 化)
  //   - export const dynamic     (force-static 等の静的強制。値判定でなく export 自体を
  //                               禁止 = computed 値も塞ぐ robust 側。既に auth() で全
  //                               dynamic ゆえ force-dynamic 等の明示は不要・冗長)
  //   - generateStaticParams     (function / const いずれの export 形も。動的 route の SSG 化)
  // 例外が要る場合は当該行に `// eslint-disable-next-line no-restricted-syntax` +
  // 理由コメントを付す (getDb ban と同じ escape hatch 運用)。
  //
  // scope 外 (非認証 = (marketing) / (auth) / api) は禁止しない (将来 LP を静的化する
  // 余地を残す)。`no-restricted-syntax` は他 block の `no-restricted-imports` と別 rule
  // key ゆえ REPLACE 干渉なし (別 key は flat-config で merge される)。route group
  // `(app)` は minimatch で `\\(app\\)` escape (escape 不在で silent に不発)。
  //
  // 残余 (accepted): `const x = ...; export { x }` の re-export 形は inline export
  // selector に載らない (getDb ban の dynamic-form 残余受容と同思想)。実在する authoring
  // 形は全て inline export ゆえ実害なし。segment config より下層の cache 経路
  // (`'use cache'` / `unstable_cache` / `cacheLife`) は AST 上の別形で本 rule の視界外
  // (grep 上 (app) 配下は現状ゼロ)。user-scoped data にこれらを採用する時は同種の
  // cross-user 漏れが再発しうるため、導入時に別途 guard を検討する (本 sprint 対象外)。
  // ---------------------------------------------------------------------------
  {
    files: ['app/\\(app\\)/**/*.ts', 'app/\\(app\\)/**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name="revalidate"]',
          message:
            '認証必須 route group で `export const revalidate` は禁止 (ISR / 永続 cache がユーザー間のキャッシュ漏れになる)。正本 = docs/architecture.md §5。',
        },
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name="dynamic"]',
          message:
            '認証必須 route group で `export const dynamic` は禁止 (force-static 等の静的化がユーザー間のキャッシュ漏れになる。既に auth() で全 dynamic)。真に必要なら eslint-disable + 理由。正本 = docs/architecture.md §5。',
        },
        {
          selector:
            'ExportNamedDeclaration > FunctionDeclaration[id.name="generateStaticParams"]',
          message:
            '認証必須 route group で generateStaticParams は禁止 (動的 route の SSG 化がユーザー間のキャッシュ漏れになる)。正本 = docs/architecture.md §5。',
        },
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name="generateStaticParams"]',
          message:
            '認証必須 route group で generateStaticParams は禁止 (動的 route の SSG 化がユーザー間のキャッシュ漏れになる)。正本 = docs/architecture.md §5。',
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Block E2-useserver-typeexport: 'use server' file(_actions)から型を export しない。
  // Next 16 + Turbopack の 'use server' 変換は named type export/re-export を value export
  // と誤認し `registerServerReference(型名, …)` を生成する → built chunk で型名が裸参照
  // (runtime undefined)→ module load 時 ReferenceError → 実環境で 500(local build は
  // 成功するため smoke でしか表面化しない・②-4a-cutover の publish-prepared.ts で実発生)。
  // inline `export type X = {…}`(型宣言)は SWC が strip するため安全 = ban 対象外。
  // 共有型は _lib/(directive 無し)に定義し、定義元から直接 import すること。
  //
  // 本 block は _actions に scope。_actions は app/(app) 配下ゆえ Block E1-render とも重なり、
  // 同一 rule key(no-restricted-syntax)は flat-config で REPLACE(merge されない)。
  // E1-render の route-segment selector は 'use server' 関数 file には無関係(route segment
  // config を持たない)で vacuous だが、silent gap を避けるため re-include する
  // (getDb ban 系 block と同じ re-include 規律)。
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/_actions/**/*.ts', 'app/**/_actions/**/*.tsx'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        // re-include: Block E1-render の 4 selector(_actions では vacuous だが REPLACE 対策)。
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name="revalidate"]',
          message:
            '認証必須 route group で `export const revalidate` は禁止 (ISR / 永続 cache がユーザー間のキャッシュ漏れになる)。正本 = docs/architecture.md §5。',
        },
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name="dynamic"]',
          message:
            '認証必須 route group で `export const dynamic` は禁止 (force-static 等の静的化がユーザー間のキャッシュ漏れになる。既に auth() で全 dynamic)。真に必要なら eslint-disable + 理由。正本 = docs/architecture.md §5。',
        },
        {
          selector:
            'ExportNamedDeclaration > FunctionDeclaration[id.name="generateStaticParams"]',
          message:
            '認証必須 route group で generateStaticParams は禁止 (動的 route の SSG 化がユーザー間のキャッシュ漏れになる)。正本 = docs/architecture.md §5。',
        },
        {
          selector:
            'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name="generateStaticParams"]',
          message:
            '認証必須 route group で generateStaticParams は禁止 (動的 route の SSG 化がユーザー間のキャッシュ漏れになる)。正本 = docs/architecture.md §5。',
        },
        // new(②-4a-cutover): 'use server' file の型 export/re-export ban。
        {
          selector: 'ExportNamedDeclaration[exportKind="type"]:not([declaration])',
          message:
            "'use server' file(_actions)から型を named export/re-export(`export type { … }`)しない。Next 16 + Turbopack が型を server reference 登録し runtime ReferenceError → 500 になる(②-4a-cutover・publish-prepared.ts で実発生)。共有型は _lib/ に定義し定義元から直接 import。inline `export type X = {…}` は可。",
        },
        {
          selector: 'ExportSpecifier[exportKind="type"]',
          message:
            "'use server' file(_actions)から型を export(`export { type … }`)しない。同上の理由で runtime ReferenceError → 500 リスク。共有型は _lib/ に置き定義元から import。",
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Per-file allowlists (placed AFTER forbidding blocks so they win).
  // Each RE-SETS `no-restricted-imports` to keep ONLY the repo-wide getDb ban
  // (GETDB_BAN.paths/patterns) while exempting the cross-feature / reverse-dep
  // import each file legitimately needs (Gap-1 fix — a bare `off` would have
  // silently dropped the getDb ban for these production app files too).
  // SIDE-EFFECT NOTE (§B / T9): app-to-app cross-feature imports (P0
  // out-of-scope / P3 target) inside these files remain unguarded (that is the
  // intended exemption); only the getDb ban is retained.
  // See §B handoff in task-7-report.md for details.
  // ---------------------------------------------------------------------------

  // NOTE (P3 W7): the two former deep-relative overrides (exam-detail-view.tsx +
  // upload/result/[sourceDocumentId]/page.tsx) were REMOVED — both now import
  // AppContainer via the `@/app/(app)/app/_components/app-container` alias and pass
  // Block B without any exemption.

  // ---------- Cross-feature visualization allowlist (P3 W7) ----------
  // These sites are FLAGGED by CROSS_FEATURE_PRIVATE_COMPONENTS / LIB_REVERSE_DEP_COMPONENTS
  // above and exempted here so they are tracked (not silently ignored) but not errors.
  // Each block RE-SETS no-restricted-imports to the getDb ban only (Gap-1 fix): the
  // cross-feature/reverse-dep pattern stays exempted (acceptable as none of these files
  // also has a deep-relative import that would otherwise need Block B enforcement), while
  // the repo-wide getDb ban is preserved instead of being dropped by a bare `off`.
  // 分類:
  //   study/custom→exams・exams→tags (下記 2 block) = 一時的負債 / 機能境界強化時に再評価
  //   column-pinning _lib→_components               = 意図的設計 (columns-as-data SSoT)

  // 一時的負債: custom-filter-form.tsx imports exams/[id]/_components/card-tag-add-popover
  // (study → exams cross-feature). Fix = extract CardTagAddPopover to a shared location.
  {
    files: ['app/\\(app\\)/app/study/custom/_components/custom-filter-form.tsx'],
    // getDb ban is preserved here (Gap-1 fix): `off` would have wiped the
    // repo-wide getDb ban for this file too. We keep ONLY the getDb ban and
    // still exempt whatever cross-feature/reverse-dep import this file legitimately
    // needed exempted (that restriction is intentionally NOT re-introduced).
    rules: {
      'no-restricted-imports': ['error', { paths: GETDB_BAN.paths, patterns: GETDB_BAN.patterns }],
    },
  },
  // 一時的負債: session-runner.tsx imports exams/[id]/_components/card-image-gallery
  // (study → exams cross-feature、 画像フェーズ A Task 11 / spec §5)。 brief で明示的に
  // Task 10 の CardImageGallery を再利用する設計のため許容。 Fix = 共有コンポーネントを
  // shared location へ抽出。
  {
    files: ['app/\\(app\\)/app/study/smart/_components/session-runner.tsx'],
    // getDb ban is preserved here (Gap-1 fix): `off` would have wiped the
    // repo-wide getDb ban for this file too. We keep ONLY the getDb ban and
    // still exempt whatever cross-feature/reverse-dep import this file legitimately
    // needed exempted (that restriction is intentionally NOT re-introduced).
    rules: {
      'no-restricted-imports': ['error', { paths: GETDB_BAN.paths, patterns: GETDB_BAN.patterns }],
    },
  },
  // 一時的負債: card-tag-edit-fields.tsx imports tags/_components/color-palette-popover
  // + tags/_components/delete-confirm-dialog (exams → tags cross-feature, 2 imports).
  // Fix = extract those popovers/dialogs to a shared location.
  {
    files: ['app/\\(app\\)/app/exams/\\[id\\]/_components/card-tag-edit-fields.tsx'],
    // getDb ban is preserved here (Gap-1 fix): `off` would have wiped the
    // repo-wide getDb ban for this file too. We keep ONLY the getDb ban and
    // still exempt whatever cross-feature/reverse-dep import this file legitimately
    // needed exempted (that restriction is intentionally NOT re-introduced).
    rules: {
      'no-restricted-imports': ['error', { paths: GETDB_BAN.paths, patterns: GETDB_BAN.patterns }],
    },
  },
  // 意図的設計 (columns-as-data SSoT): column-pinning.ts (_lib) imports
  // ../_components/exam-card-table-columns to derive column order from the single
  // source of truth. Intentional reverse-dep — see the file's header comment.
  {
    files: ['app/\\(app\\)/app/exams/\\[id\\]/_lib/column-pinning.ts'],
    // getDb ban is preserved here (Gap-1 fix): `off` would have wiped the
    // repo-wide getDb ban for this file too. We keep ONLY the getDb ban and
    // still exempt whatever cross-feature/reverse-dep import this file legitimately
    // needed exempted (that restriction is intentionally NOT re-introduced).
    rules: {
      'no-restricted-imports': ['error', { paths: GETDB_BAN.paths, patterns: GETDB_BAN.patterns }],
    },
  },
  {
    // TODO(Sync-fix-1): use-card-options.ts の refs structural fix は
    // optimistic 経路収束 (event handler 書換) と同 working set のため波2 では
    // 直さない。 Edit-2 T1 で inline-option-row.tsx から hook へ移送、違反箇所は
    // use-card-options.ts の `optionsRef.current = options` 単独。
    // Sync-fix-1 完了後この override block を削除。
    //
    // P3 W3 (Task 4, 2026-07-07) 再評価: 本 task は pure domain logic のみ carve
    // (deriveCorrectAnswerIds 移送) し optionsRef パターン自体は不変。 off の解消は
    // `optionsRef.current = options` の render-phase 同期更新を撤去する構造変更を要し、
    // debounce commit / latest-value 読取の re-render・timing 挙動を変える (P3 =
    // behavior-preserving に反する) ため据え置き継続。 次工程 = Sync-fix-1 または
    // P4 の別 task で ref パターン再設計と併せて解消する。
    // glob の `(...)` `[...]` は minimatch では alternation / character class と
    // 解釈されるため、 Next route group と dynamic segment は `\\(...\\)` `\\[...\\]`
    // で escape する (escape 不在で silent に override 効かず → gate 立ち上げ時 fail)。
    files: ['app/\\(app\\)/app/exams/\\[id\\]/_hooks/use-card-options.ts'],
    rules: { 'react-hooks/refs': 'off' },
  },
  {
    // public/vendor/** は self-host した third-party 配布物 (browser-image-compression
    // の minified dist・画像フェーズ A spec §4)。 生成物ゆえ lint 対象外 (.next 等と同扱い)。
    ignores: [
      '.next/**',
      'out/**',
      'build/**',
      'next-env.d.ts',
      'coverage/**',
      'public/vendor/**',
      '.devcontainer/**', // ops scripts (app source でない。React/Next 前提 rule と不整合)
    ],
  },
]

export default config
