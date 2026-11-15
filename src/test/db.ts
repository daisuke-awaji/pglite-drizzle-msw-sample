import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import * as schema from '../db/schema'
import { seed } from '../server/seed'

// テストは本物の PostgreSQL（メモリ上の PGlite）に、本番と同じマイグレーションを流して行う
export async function createTestDb({ withSeed = true } = {}) {
  const db = drizzle({ client: new PGlite(), schema })
  await migrate(db, { migrationsFolder: './drizzle' })
  if (withSeed) await seed(db, new Date('2026-11-15T09:00:00'))
  return db
}
