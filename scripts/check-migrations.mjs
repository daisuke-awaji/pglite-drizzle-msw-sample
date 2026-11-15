// @ts-check
// drizzle/ のマイグレーションを、本番に流す前に機械的に確かめる（docs/production.md の「マイグレーション」）。
//
// 失敗にするもの（Drizzle の migrator が黙って見逃すもの）:
//   - journal の when が増えていない。Drizzle は「最後に適用したものより when が新しいもの」だけを流すので、
//     並行して作ったブランチの順番が入れ替わると、古い when のマイグレーションは本番で黙って飛ばされる
//   - 基準のブランチ（既定は origin/main）にあるマイグレーションが書き換わっている・消えている。
//     Drizzle は適用済みのファイルの hash を照合しないので、書き換えても本番には反映されない
//   - CONCURRENTLY。Drizzle は保留中のマイグレーションを 1 つのトランザクションで流すので、必ず失敗する
// 警告にするもの（新しく足したマイグレーションだけ。ロックや互換性の点でレビューが要る ALTER）
//
// 使い方: node scripts/check-migrations.mjs [基準の ref]（既定は環境変数 MIGRATIONS_BASE_REF か origin/main）
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{ idx: number, when: number, tag: string }} JournalEntry
 * @typedef {{ entries: JournalEntry[] }} Journal
 * @typedef {{ journal: Journal, sql: Map<string, string> }} MigrationSet
 * @typedef {{ tag: string, message: string }} Finding
 */

const GUIDE = 'docs/production.md#alter-の書き方'

/**
 * 新しいマイグレーションで警告する ALTER。
 * 同じファイルで作った表に対するもの（drizzle-kit は外部キーを CREATE TABLE の後に ALTER で足す）は対象外にする
 * @type {{ pattern: RegExp, onExistingTableOnly?: boolean, message: string }[]}
 */
const RISKY = [
  {
    pattern: /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i,
    message: '列の型の変更は、多くの場合テーブル全体を書き直し、その間は読み書きが止まる',
  },
  {
    pattern: /\bSET\s+NOT\s+NULL\b/i,
    message: 'SET NOT NULL は全行を読み終わるまで読み書きを止める。CHECK (...) NOT VALID → VALIDATE → SET NOT NULL に分ける',
  },
  {
    pattern: /\bADD\s+COLUMN\b[^;]*\bDEFAULT\b[^;]*\b(gen_random_uuid|random|clock_timestamp|uuid_generate_v\d)\s*\(/i,
    message: '毎回違う値になる DEFAULT 付きの ADD COLUMN は、テーブル全体を書き直す。列を足してから別のジョブで埋める',
  },
  {
    pattern: /\bDROP\s+(COLUMN|TABLE)\b|\bRENAME\s+(COLUMN\b|TO\b)/i,
    message: '消す・名前を変えると、ローリング更新中の旧バージョンと、開いたままの画面が壊れる。使うのをやめたリリースの次で消す',
  },
  {
    pattern: /\bALTER\s+TYPE\b[^;]*\bADD\s+VALUE\b/i,
    message: 'enum に足した値は、同じデプロイで流す後続のマイグレーションでは使えない（1 つのトランザクションで流すため）。使うのは次のデプロイにする',
  },
  {
    pattern: /\bADD\s+CONSTRAINT\b[^;]*\b(FOREIGN\s+KEY|CHECK)\b(?![^;]*\bNOT\s+VALID\b)/i,
    onExistingTableOnly: true,
    message: '既存の表に制約を足すと、全行を確かめる間ロックを持つ。NOT VALID で足し、VALIDATE CONSTRAINT を別のマイグレーションにする',
  },
  {
    pattern: /\bADD\s+CONSTRAINT\b[^;]*\b(UNIQUE|PRIMARY\s+KEY)\b/i,
    onExistingTableOnly: true,
    message: '既存の表に UNIQUE / PRIMARY KEY を足すと、索引を作り終わるまで書き込みが止まる。先に CONCURRENTLY で索引を作り USING INDEX で足す',
  },
  {
    pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\b(?!\s+IF\s+NOT\s+EXISTS)/i,
    onExistingTableOnly: true,
    message: '既存の表に索引を作ると、作り終わるまで書き込みが止まる。大きな表は事前の SQL で CONCURRENTLY で作り、ここは IF NOT EXISTS にする',
  },
]

/** -- のコメントを除き、文に分ける */
function statements(sql) {
  return sql
    .split('--> statement-breakpoint')
    .flatMap((part) => part.split(/;\s*(?:\n|$)/))
    .map((s) => s.replace(/--[^\n]*/g, '').trim())
    .filter(Boolean)
}

/** 文が対象にしている表の名前（ALTER TABLE / CREATE INDEX ... ON） */
function targetTable(stmt) {
  const m = /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?("?[\w.]+"?(?:\."?\w+"?)?)/i.exec(stmt) ?? /\bON\s+(?:ONLY\s+)?("?[\w.]+"?(?:\."?\w+"?)?)/i.exec(stmt)
  return m ? normalize(m[1]) : undefined
}

function normalize(name) {
  const plain = name.replaceAll('"', '')
  return plain.includes('.') ? plain : `public.${plain}`
}

/** ファイルの中で CREATE TABLE した表 */
function createdTables(sql) {
  return new Set([...sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?(?:\."?\w+"?)?)/gi)].map((m) => normalize(m[1])))
}

/**
 * @param {MigrationSet} current
 * @param {MigrationSet | null} base 基準のブランチの状態（取れないときは null）
 * @param {string[]} sqlFileNames drizzle/ にある .sql のファイル名
 * @returns {{ errors: Finding[], warnings: Finding[] }}
 */
export function checkMigrations(current, base, sqlFileNames) {
  /** @type {Finding[]} */ const errors = []
  /** @type {Finding[]} */ const warnings = []
  const entries = current.journal.entries

  entries.forEach((e, i) => {
    if (e.idx !== i) errors.push({ tag: e.tag, message: `idx が ${i} ではなく ${e.idx} になっている` })
    const prev = entries[i - 1]
    if (prev && e.when <= prev.when) {
      errors.push({
        tag: e.tag,
        message: `when（${e.when}）が前の ${prev.tag}（${prev.when}）より新しくない。本番では黙って飛ばされる。main を取り込んでから作り直す（docs/production.md#並行して作ったマイグレーション）`,
      })
    }
    if (!current.sql.has(e.tag)) errors.push({ tag: e.tag, message: `${e.tag}.sql がない` })
  })
  const tags = new Set(entries.map((e) => e.tag))
  for (const file of sqlFileNames) {
    const tag = file.replace(/\.sql$/, '')
    if (!tags.has(tag)) errors.push({ tag, message: `${file} が journal に載っていない（流されない）` })
  }

  if (base) {
    base.journal.entries.forEach((b, i) => {
      const now = entries[i]
      if (!now || now.tag !== b.tag || now.when !== b.when) {
        errors.push({ tag: b.tag, message: '基準のブランチにあるマイグレーションが消えた・順番が変わった。適用済みのものは変えない' })
      } else if (current.sql.get(b.tag) !== base.sql.get(b.tag)) {
        errors.push({ tag: b.tag, message: '基準のブランチにあるマイグレーションが書き換わっている。適用済みの環境には反映されないので、新しいマイグレーションを足す' })
      }
    })
  }

  for (const e of entries) {
    const sql = current.sql.get(e.tag) ?? ''
    if (/\bCONCURRENTLY\b/i.test(sql)) {
      errors.push({ tag: e.tag, message: `CONCURRENTLY はトランザクションの中では使えない（Drizzle はまとめて 1 つのトランザクションで流す）。事前の SQL に分ける（${GUIDE}）` })
    }
  }

  const known = new Set(base?.journal.entries.map((e) => e.tag) ?? [])
  for (const e of entries) {
    if (known.has(e.tag)) continue
    const sql = current.sql.get(e.tag) ?? ''
    const created = createdTables(sql)
    for (const stmt of statements(sql)) {
      for (const rule of RISKY) {
        if (!rule.pattern.test(stmt)) continue
        const table = targetTable(stmt)
        if (rule.onExistingTableOnly && table && created.has(table)) continue
        warnings.push({ tag: e.tag, message: `${rule.message}（${GUIDE}）\n    ${stmt.split('\n')[0].slice(0, 160)}` })
      }
    }
  }
  return { errors, warnings }
}

/** @returns {MigrationSet & { files: string[] }} */
function readWorkingTree(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'))
  /** @type {Journal} */ const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'))
  return { journal, sql: new Map(files.map((f) => [f.replace(/\.sql$/, ''), readFileSync(join(dir, f), 'utf8')])), files }
}

/** @returns {MigrationSet | null} */
function readRef(ref) {
  const show = (path) => execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { stdio: 'ignore' })
  } catch {
    return null
  }
  /** @type {Journal} */ let journal
  try {
    journal = JSON.parse(show('drizzle/meta/_journal.json'))
  } catch {
    return { journal: { entries: [] }, sql: new Map() } // 基準にまだ drizzle/ がない
  }
  return { journal, sql: new Map(journal.entries.map((e) => [e.tag, show(`drizzle/${e.tag}.sql`)])) }
}

function main() {
  const ref = process.argv[2] ?? process.env.MIGRATIONS_BASE_REF ?? 'origin/main'
  const current = readWorkingTree('drizzle')
  const base = readRef(ref)
  const inCi = Boolean(process.env.CI)
  const { errors, warnings } = checkMigrations(current, base, current.files)
  if (!base) {
    const message = `基準の ${ref} が見つからないので、適用済みのマイグレーションが書き換わっていないかは確かめていません（git fetch origin main）`
    if (inCi) errors.push({ tag: '-', message })
    else console.warn(`注意: ${message}`)
  }
  for (const w of warnings) {
    console.warn(`要確認 ${w.tag}: ${w.message}`)
    if (inCi) process.stdout.write(`::warning file=drizzle/${w.tag}.sql::${w.message.split('\n')[0]}\n`)
  }
  for (const e of errors) {
    console.error(`エラー ${e.tag}: ${e.message}`)
    if (inCi) process.stdout.write(`::error${e.tag === '-' ? '' : ` file=drizzle/${e.tag}.sql`}::${e.message}\n`)
  }
  if (errors.length > 0) process.exit(1)
  process.stdout.write(`マイグレーション ${current.journal.entries.length} 本を確かめました（基準: ${base ? ref : 'なし'}、要確認: ${warnings.length} 件）\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
