import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit is a standalone CLI (not run via Next.js), so .env.local is not
// auto-loaded. Explicitly load it here so `pnpm db:generate` / `db:migrate` /
// `db:studio` see DATABASE_URL_ADMIN.
config({ path: '.env.local' })

// RLS-P1: migration/DDL is an owner (postgres) operation, not app runtime —
// uses DATABASE_URL_ADMIN, not the least-privilege DATABASE_URL_APP.
if (!process.env.DATABASE_URL_ADMIN) {
  throw new Error('DATABASE_URL_ADMIN is not set')
}

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_ADMIN,
  },
})
