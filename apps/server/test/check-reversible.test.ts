import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'
import { expect, test } from 'vitest'
import { checkReversible, normalizeDump } from '../src/db/check-reversible.ts'
import { fixtureMigrations } from './fixtures/migrations.ts'
import { openTestDb } from './helpers/db.ts'

// Stands in for `pg_dump --schema-only`: lists every user table and column.
async function catalogDump<DB>(db: Kysely<DB>): Promise<string> {
  const { rows } = await sql<{ line: string }>`
    select table_name || '.' || column_name || ' ' || data_type as line
    from information_schema.columns
    where table_schema = current_schema() and table_name <> 'kysely_migration' and table_name <> 'kysely_migration_lock'
    order by 1`.execute(db)
  return rows.map((r) => r.line).join('\n')
}

async function runCheck(migrations: Record<string, Migration>) {
  const handle = await openTestDb()
  try {
    return await checkReversible(handle.db, migrations, () => catalogDump(handle.db))
  } finally {
    await handle.close()
  }
}

test('[T003-9] reports reversible when up, down, up yields the same schema', async () => {
  const result = await runCheck(fixtureMigrations)
  expect(result.reversible).toBe(true)
  expect(result.before).toContain('widgets.id integer')
})

test('[T003-10] reports not reversible when a down leaves residue behind', async () => {
  const leaky: Record<string, Migration> = {
    '0001_leaky': {
      up: async (db) => {
        await sql`create table leaky (id int)`.execute(db)
      },
      down: async (db) => {
        await sql`drop table leaky`.execute(db)
        await sql`create table if not exists residue (id int)`.execute(db)
      },
    },
  }
  const result = await runCheck(leaky)
  expect(result.reversible).toBe(false)
  expect(result.after).toContain('residue.id integer')
})

test('[T003-11] ignores the per-run \\restrict token pg_dump writes', () => {
  const a = '\\restrict abc123\nCREATE TABLE t ();\n\\unrestrict abc123\n'
  const b = '\\restrict zzz999\nCREATE TABLE t ();\n\\unrestrict zzz999\n'
  expect(normalizeDump(a)).toBe(normalizeDump(b))
})
