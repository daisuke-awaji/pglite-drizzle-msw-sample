import { Client } from 'pg'

// TEST_DATABASE_URL で本物の PostgreSQL に結合テストを流すときだけ使う（vitest.config.ts）。
// テストごとに複製した DB（t_ で始まる名前。src/test/db.ts）を、実行の前後に消す。
// 途中で止めたテストの DB が残っていても、次の実行の前に片付く
async function dropTestDatabases(url: string) {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    const { rows } = await client.query<{ datname: string }>(
      String.raw`SELECT datname FROM pg_database WHERE datname LIKE 't\_%' AND NOT datistemplate`,
    )
    for (const { datname } of rows) await client.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  } finally {
    await client.end()
  }
}

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) return
  const client = new Client({ connectionString: url })
  await client.connect()
  const { rows } = await client.query<{ server_version: string }>('SHOW server_version')
  await client.end()
  // どの PostgreSQL で確かめたかを、CI のログに残す
  console.warn(`[integration] PostgreSQL ${rows[0]!.server_version} (${new URL(url).host})`)
  await dropTestDatabases(url)
  return () => dropTestDatabases(url)
}
