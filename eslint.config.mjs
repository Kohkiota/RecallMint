// recallmint flat ESLint config (波2)。
// 詳細: docs/superpowers/specs/2026-06-10-eslint-ci-gate-design.md
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

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
  // Shared logic belongs in lib/; violations are allowlisted per-file below (P3 送り).
  // ---------------------------------------------------------------------------
  {
    files: ['lib/**/*', 'components/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/app/*', '@/app/**', '../app/**', '../**/app/**'],
              message:
                'lib/ and components/ must not import from the app/ layer. Move shared logic to lib/ instead. (3 known violations are allowlisted per-file below — P3 refactor target)',
            },
          ],
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

  // components → @/app: contact-form.tsx imports server action from app layer.
  // Deferred to P4 — fix = move action to lib/ or create dedicated shared action.
  {
    files: ['components/marketing/contact-form.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // NOTE (P3 W7): the two former deep-relative overrides (exam-detail-view.tsx +
  // upload/result/[sourceDocumentId]/page.tsx) were REMOVED — both now import
  // AppContainer via the `@/app/(app)/app/_components/app-container` alias and pass
  // Block B without any exemption.

  // ---------- Cross-feature visualization allowlist (P3 W7) ----------
  // These sites are FLAGGED by CROSS_FEATURE_PRIVATE_COMPONENTS / LIB_REVERSE_DEP_COMPONENTS
  // above and exempted here so they are tracked (not silently ignored) but not errors.
  // Each `off` disables no-restricted-imports for the whole file (same side-effect as
  // the contact-form override) — acceptable as none of these files also have a deep-relative.
  // 分類:
  //   study/custom→exams・exams→tags (下記 2 block) = 一時的負債 / 機能境界強化時に再評価
  //   column-pinning _lib→_components               = 意図的設計 (columns-as-data SSoT)

  // 一時的負債: custom-filter-form.tsx imports exams/[id]/_components/card-tag-add-popover
  // (study → exams cross-feature). Fix = extract CardTagAddPopover to a shared location.
  {
    files: ['app/\\(app\\)/app/study/custom/_components/custom-filter-form.tsx'],
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
    ignores: ['.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'coverage/**'],
  },
]

export default config
