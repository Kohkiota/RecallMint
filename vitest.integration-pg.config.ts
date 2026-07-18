import path from 'path'

import { defineConfig } from 'vitest/config'

// 実 PostgreSQL に接続する統合 suite 専用 config。 default の vitest.config.ts とは
// include / globalSetup / setupFiles / 直列実行が異なる。 単一 test DB を共有するため
// test 同士の DB 破壊を防ぐ「単一 fork・直列実行」を強制する:
//   pool: 'forks' + fileParallelism: false。
// Vitest 4 は旧 poolOptions.forks.singleFork を削除した (deprecation で無視される) が、
// fileParallelism: false は maxWorkers を 1 に上書きするため単一 fork が保証される
// (公式 doc の記述)。 これで全 test file が 1 fork 内で直列に走る。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/pg/**/*.test.ts'],
    globalSetup: ['./tests/integration/pg/setup/global-setup.ts'],
    // env-guard を先に置き real DATABASE_URL を hard-set → vitest.setup の ??= を no-op 化。
    setupFiles: ['./tests/integration/pg/setup/env-guard.ts', './vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // server-only の runtime guard を no-op stub へ (vitest.config.ts と同一)。
      'server-only': path.resolve(__dirname, 'vitest-stubs/server-only.js'),
    },
  },
})
