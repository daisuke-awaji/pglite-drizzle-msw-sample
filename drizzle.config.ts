import { defineConfig } from 'drizzle-kit'

// マイグレーション SQL の生成だけに使う（`npm run db:generate`）。
// 生成された drizzle/*.sql は、ブラウザ（PGlite）でも本番の PostgreSQL でも同じものを流す。
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
