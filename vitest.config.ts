import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'lib/**/*.test.ts',
      'lib/**/*.test.tsx',
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'app/**/*.test.ts',
      'app/**/*.test.tsx',
      'components/**/*.test.tsx',
      'components/**/*.test.ts',
      'scripts/**/*.test.ts',
      'instrumentation.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // server-only package は default export で throw する runtime guard を持つ
      // (`import 'server-only'` を client bundle で評価したら build を失敗させる仕様)。
      // vitest は node env で評価するため、 そのままだと server-only を import する
      // module の test が全て module load 時に throw する。 in-repo の no-op stub に
      // alias して test 時に guard を無効化する (pnpm cache path 依存を回避)。
      'server-only': path.resolve(__dirname, 'vitest-stubs/server-only.js'),
    },
  },
})
