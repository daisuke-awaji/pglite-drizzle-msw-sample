import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type pg from 'pg'

// マイグレーションの実行役が共通で使うもの（migrate.ts と pre-sql.ts）

/** このアプリのマイグレーション用の advisory lock の番号（固定。migrate と事前の SQL の両方で取る） */
export const LOCK_ID = 727_001

export type Journal = { entries: { idx: number; when: number; tag: string }[] }

export function readJournal(migrationsFolder: string): Journal {
  return JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as Journal
}

/**
 * まだ流していないマイグレーションのタグ。Drizzle と同じ決め方（最後に流したものの created_at より when が新しいもの）。
 * drizzle.__drizzle_migrations がなければ、全部がまだ
 */
export async function pendingTags(client: pg.Client, journal: Journal): Promise<string[]> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists`,
  )
  let last = -Infinity
  if (rows[0]?.exists) {
    const r = await client.query<{ last: string | null }>('SELECT max(created_at)::text AS last FROM drizzle.__drizzle_migrations')
    if (r.rows[0]?.last != null) last = Number(r.rows[0].last)
  }
  return journal.entries.filter((e) => e.when > last).map((e) => e.tag)
}

/** drizzle/pre/ にある事前の SQL のタグ */
export function preSqlTags(migrationsFolder: string): Set<string> {
  try {
    return new Set(readdirSync(join(migrationsFolder, 'pre')).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4)))
  } catch {
    return new Set()
  }
}

/** drizzle-kit と同じ区切り（--> statement-breakpoint）で文に分ける。空の文は捨てる */
export function splitStatements(sql: string): string[] {
  return sql
    .split(/-->\s*statement-breakpoint/)
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, '').trim() !== '')
}

/** 事前の SQL が作る索引の名前（CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS "名前"） */
export function concurrentIndexNames(sql: string): string[] {
  return [...sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"?([A-Za-z0-9_]+)"?/gi)].map((m) => m[1]!)
}

export const pgErrorCode = (e: unknown): string | undefined => {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null
  const code = err?.code ?? err?.cause?.code
  return typeof code === 'string' ? code : undefined
}

/** 55P03 = lock_timeout。変更は全部戻っているので、待ってやり直してよい */
export const LOCK_TIMEOUT = '55P03'

export type RunOptions = {
  /** 接続を 1 本作る（advisory lock と SET はその接続にだけ効くので、プールは使わない） */
  connect: () => Promise<pg.Client>
  migrationsFolder: string
  /** この時刻（ms）までに終わらせる。Lambda では呼び出しの残り時間から決める */
  deadline: number
  /** 接続のあとに SET ROLE する利用者（ローテーションで複製された利用者でも、作る表の持ち主をそろえる） */
  role?: string
  lockTimeout?: string
  statementTimeout?: string
  /** 1 回目の待ち。2 回目以降は回数倍にする */
  retryDelayMs?: number
  maxAttempts?: number
  /** 1 つの文に見込む最大の時間（statementTimeout と同じ）。これが残っていなければやり直さない */
  statementBudgetMs?: number
  log?: (fields: Record<string, unknown>) => void
}

export const DEFAULTS = {
  lockTimeout: '5s',
  statementTimeout: '10min',
  retryDelayMs: 5_000,
  maxAttempts: 5,
  statementBudgetMs: 11 * 60_000,
}

/** 接続し、ロックと設定をしてから run を呼ぶ。lock_timeout なら、残り時間があるうちは待ってやり直す */
export async function withMigrationLock<T>(
  options: RunOptions,
  run: (client: pg.Client) => Promise<T>,
): Promise<{ result: T; attempts: number }> {
  const o = { ...DEFAULTS, ...options }
  for (let attempt = 1; ; attempt++) {
    const client = await o.connect()
    try {
      // 同時に流さない（2 つ目は 1 つ目が終わるのを待つ）。接続が切れればロックも外れる
      await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID])
      if (o.role) await client.query(`SET ROLE ${client.escapeIdentifier(o.role)}`)
      // ロックを待つ間、ほかの読み書きを止めない。Lambda の 15 分より前に止める
      await client.query(`SET lock_timeout = ${client.escapeLiteral(o.lockTimeout)}`)
      await client.query(`SET statement_timeout = ${client.escapeLiteral(o.statementTimeout)}`)
      return { result: await run(client), attempts: attempt }
    } catch (e) {
      const delay = o.retryDelayMs * attempt
      const retryable = pgErrorCode(e) === LOCK_TIMEOUT && attempt < o.maxAttempts && Date.now() + delay + o.statementBudgetMs <= o.deadline
      o.log?.({ type: 'migrate.attempt-failed', attempt, code: pgErrorCode(e), message: (e as Error).message, retry: retryable })
      if (!retryable) throw e
      await new Promise((r) => setTimeout(r, delay))
    } finally {
      await client.end().catch(() => {})
    }
  }
}
