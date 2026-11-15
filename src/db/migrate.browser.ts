import type { MigrationMeta } from 'drizzle-orm/migrator'
import type { PgliteDatabase } from 'drizzle-orm/pglite'
import journal from '../../drizzle/meta/_journal.json'

// drizzle-orm/pglite/migrator は Node の fs で drizzle/ フォルダを読むため、ブラウザでは使えない。
// 代わりに Vite でビルド時に SQL を取り込み、Drizzle 本体と同じ形（MigrationMeta）に組み立てて
// 同じ処理（dialect.migrate）を呼ぶ。履歴は本番と同じ drizzle.__drizzle_migrations に残る。
const sqlFiles = import.meta.glob<string>('../../drizzle/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
})

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function loadMigrations(): Promise<MigrationMeta[]> {
  return Promise.all(
    journal.entries.map(async (entry) => {
      const query = sqlFiles[`../../drizzle/${entry.tag}.sql`]
      if (query === undefined) throw new Error(`migration not found: ${entry.tag}.sql`)
      return {
        sql: query.split('--> statement-breakpoint'),
        bps: entry.breakpoints,
        folderMillis: entry.when,
        hash: await sha256Hex(query),
      }
    }),
  )
}

type DrizzleInternals = {
  dialect: { migrate(m: MigrationMeta[], session: unknown, config: object): Promise<void> }
  session: unknown
}

export async function migrate(db: PgliteDatabase<Record<string, unknown>>): Promise<void> {
  const migrations = await loadMigrations()
  // dialect / session は Drizzle の内部プロパティ（公式の pglite migrator も同じものを使う）
  const { dialect, session } = db as unknown as DrizzleInternals
  await dialect.migrate(migrations, session, {})
}
