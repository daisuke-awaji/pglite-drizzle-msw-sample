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
  // 失敗した Promise を持ち続けると、再読み込みするまで二度と開けないので、失敗したら捨てる
  dbPromise ??= createDb().catch((e: unknown) => {
    dbPromise = undefined
    throw e
  })
  return dbPromise
}
