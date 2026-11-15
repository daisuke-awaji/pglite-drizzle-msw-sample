import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { isEmpty, seed } from '../server/seed'
import { migrate } from './migrate.browser'
import * as schema from './schema'

// ブラウザ内の PostgreSQL（PGlite）。データは IndexedDB に保存されるので、リロードしても残る。
// 本番ではこのファイルの代わりに、例えば次のような接続を用意するだけでよい:
//   import { drizzle } from 'drizzle-orm/node-postgres'
//   export const db = drizzle(process.env.DATABASE_URL!, { schema })
const DATA_DIR = 'idb://starter-kit'

let dbPromise: Promise<BrowserDb> | undefined

export type BrowserDb = Awaited<ReturnType<typeof createDb>>

async function createDb() {
  const client = await PGlite.create(DATA_DIR)
  const db = drizzle({ client, schema })
  await migrate(db)
  if (await isEmpty(db)) await seed(db)
  return db
}

export function getDb(): Promise<BrowserDb> {
  dbPromise ??= createDb()
  return dbPromise
}
