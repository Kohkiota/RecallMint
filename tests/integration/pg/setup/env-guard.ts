import { hardSetTestDatabaseUrl } from './db-url'

// PG suite の setupFile。 setupFiles 配列で vitest.setup.ts より前に置くことで、 real
// test DB を指す DATABASE_URL_APP を先に hard-set する (以降 vitest.setup.ts の ??= は
// no-op)。 @/lib/db は mock せず、 getDb() が実 test DB (app role) を掴む。
hardSetTestDatabaseUrl()
