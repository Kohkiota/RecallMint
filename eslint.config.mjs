// recallmint flat ESLint config (波2)。
// 詳細: docs/superpowers/specs/2026-06-10-eslint-ci-gate-design.md
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

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
  // Block B: app/ must not use deep relative imports (3+ levels up).
  // Pattern `../../../**` catches 3 levels (`../../../foo`) AND 4+ levels
  // (`../../../../foo` = `../../../` + `../foo`; minimatch `**` matches `../foo`
  // because `**` crosses `/` and treats `..` as a regular path segment).
  // Violations are allowlisted per-file below (P3 refactor target).
  // ---------------------------------------------------------------------------
  {
    files: ['app/**/*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../../**'],
              message:
                'Deep relative imports (3+ levels up) are forbidden in app/. Use the @/ alias instead. (2 known violations are allowlisted per-file below — P3 refactor target)',
            },
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
  // Deferred to P3 — fix = move action to lib/ or create dedicated shared action.
  {
    files: ['components/marketing/contact-form.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // app deep relative: exam-detail-view.tsx imports ../../../_components/app-container.
  // `(app)` → `\\(app\\)`, `[id]` → `\\[id\\]` per minimatch escape rule (same as use-card-options below).
  // Deferred to P3 — fix = use @/ alias.
  {
    files: ['app/\\(app\\)/app/exams/\\[id\\]/_components/exam-detail-view.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // app deep relative: upload result page.tsx imports ../../../_components/app-container.
  // `(app)` → `\\(app\\)`, `[sourceDocumentId]` → `\\[sourceDocumentId\\]` per minimatch escape rule.
  // Deferred to P3 — fix = use @/ alias.
  {
    files: ['app/\\(app\\)/app/upload/result/\\[sourceDocumentId\\]/page.tsx'],
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
