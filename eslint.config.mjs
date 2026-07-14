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
          paths: DOMAIN_NO_INFRA_IMPORTS.paths,
          patterns: [LIB_NO_APP_IMPORTS, ...DOMAIN_NO_INFRA_IMPORTS.patterns],
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
          paths: SESSION_DOMAIN_NO_INFRA_IMPORTS.paths,
          patterns: [LIB_NO_APP_IMPORTS, ...SESSION_DOMAIN_NO_INFRA_IMPORTS.patterns],
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
          paths: CARD_DOMAIN_NO_INFRA_IMPORTS.paths,
          patterns: [LIB_NO_APP_IMPORTS, ...CARD_DOMAIN_NO_INFRA_IMPORTS.patterns],
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
          paths: TAG_DOMAIN_NO_INFRA_IMPORTS.paths,
          patterns: [LIB_NO_APP_IMPORTS, ...TAG_DOMAIN_NO_INFRA_IMPORTS.patterns],
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
          paths: MEDIA_DOMAIN_NO_INFRA_IMPORTS.paths,
          patterns: [LIB_NO_APP_IMPORTS, ...MEDIA_DOMAIN_NO_INFRA_IMPORTS.patterns],
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
  // Block C: app/**/_lib/ reverse-layering guard (must come AFTER Block B so it
  // wins for `_lib/` files). Flat-config rule options REPLACE (not merge) per
  // file, so this block re-includes Block B's patterns to preserve coverage for
  // `_lib/` files, then adds LIB_REVERSE_DEP_COMPONENTS on top.
  // The `app/**/_lib/**` glob uses `**` (not literal `(app)`/`[id]`) so no escaping
  // is required — `**` spans the route group / dynamic segment as literal dirs.
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/_lib/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            DEEP_RELATIVE_IMPORTS,
            CROSS_FEATURE_PRIVATE_COMPONENTS,
            LIB_REVERSE_DEP_COMPONENTS,
          ],
        },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // Per-file allowlists (placed AFTER forbidding blocks so they win).
  // Each turns `no-restricted-imports` fully off for that file.
  // SIDE-EFFECT NOTE (§B / T9): `off` disables the whole rule for the file,
  // not just the specific pattern — meaning app-to-app cross-feature imports
  // (P0 out-of-scope / P3 target) inside these files are also unguarded.
  // See §B handoff in task-7-report.md for details.
  // ---------------------------------------------------------------------------

  // NOTE (P3 W7): the two former deep-relative overrides (exam-detail-view.tsx +
  // upload/result/[sourceDocumentId]/page.tsx) were REMOVED — both now import
  // AppContainer via the `@/app/(app)/app/_components/app-container` alias and pass
  // Block B without any exemption.

  // ---------- Cross-feature visualization allowlist (P3 W7) ----------
  // These sites are FLAGGED by CROSS_FEATURE_PRIVATE_COMPONENTS / LIB_REVERSE_DEP_COMPONENTS
  // above and exempted here so they are tracked (not silently ignored) but not errors.
  // Each `off` disables no-restricted-imports for the whole file (the rule is turned off
  // entirely, not just the flagged pattern) — acceptable as none of these files also have
  // a deep-relative import that would otherwise need Block B enforcement.
  // 分類:
  //   study/custom→exams・exams→tags (下記 2 block) = 一時的負債 / 機能境界強化時に再評価
  //   column-pinning _lib→_components               = 意図的設計 (columns-as-data SSoT)

  // 一時的負債: custom-filter-form.tsx imports exams/[id]/_components/card-tag-add-popover
  // (study → exams cross-feature). Fix = extract CardTagAddPopover to a shared location.
  {
    files: ['app/\\(app\\)/app/study/custom/_components/custom-filter-form.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // 一時的負債: session-runner.tsx imports exams/[id]/_components/card-image-gallery
  // (study → exams cross-feature、 画像フェーズ A Task 11 / spec §5)。 brief で明示的に
  // Task 10 の CardImageGallery を再利用する設計のため許容。 Fix = 共有コンポーネントを
  // shared location へ抽出。
  {
    files: ['app/\\(app\\)/app/study/smart/_components/session-runner.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // 一時的負債: card-tag-edit-fields.tsx imports tags/_components/color-palette-popover
  // + tags/_components/delete-confirm-dialog (exams → tags cross-feature, 2 imports).
  // Fix = extract those popovers/dialogs to a shared location.
  {
    files: ['app/\\(app\\)/app/exams/\\[id\\]/_components/card-tag-edit-fields.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // 意図的設計 (columns-as-data SSoT): column-pinning.ts (_lib) imports
  // ../_components/exam-card-table-columns to derive column order from the single
  // source of truth. Intentional reverse-dep — see the file's header comment.
  {
    files: ['app/\\(app\\)/app/exams/\\[id\\]/_lib/column-pinning.ts'],
    rules: { 'no-restricted-imports': 'off' },
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
    ],
  },
]

export default config
