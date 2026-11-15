import { boolean, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

// 本番の PostgreSQL でもこのファイルをそのまま使う。
export const todos = pgTable('todos', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  done: boolean('done').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TodoRow = typeof todos.$inferSelect
