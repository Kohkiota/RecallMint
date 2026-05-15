import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit is a standalone CLI (not run via Next.js), so .env.local is not
// auto-loaded. Explicitly load it here so `pnpm db:generate` / `db:migrate` /
// `db:studio` see DATABASE_URL.
config({ path: '.env.local' })

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
})
