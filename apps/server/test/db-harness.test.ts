import { type Kysely, sql } from 'kysely'
import { describe, expect, test } from 'vitest'
import { migrations } from '../src/db/migrations/index.ts'
import { createMigrator } from '../src/db/migrator.ts'
import { fixtureMigrations } from './fixtures/migrations.ts'
import { openTestDb, resolveTestDbTarget, testPg, withDb } from './helpers/db.ts'

async function tableExists<DB>(db: Kysely<DB>, name: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select to_regclass(${name}) is not null as found`.execute(db)
  return rows[0]?.found ?? false
}

describe('resolveTestDbTarget', () => {
  test('[T003-1] uses Postgres when DATABASE_URL is set', () => {
    expect(resolveTestDbTarget({ DATABASE_URL: 'postgres://x/y' })).toEqual({ kind: 'postgres', url: 'postgres://x/y' })
  })

  test('[T003-2] falls back to in-process PGlite when DATABASE_URL is unset or empty', () => {
    expect(resolveTestDbTarget({})).toEqual({ kind: 'pglite' })
    expect(resolveTestDbTarget({ DATABASE_URL: '' })).toEqual({ kind: 'pglite' })
  })

  test('[T003-3] refuses the fallback when SL_REQUIRE_PG=1, so test:db can never pass on PGlite', () => {
    expect(() => resolveTestDbTarget({ SL_REQUIRE_PG: '1' })).toThrow(/DATABASE_URL/)
  })
})

describe('withDb', () => {
  test('[T003-4] hands the callback a working connection and returns its result', async () => {
    const value = await withDb(async (db) => {
      const { rows } = await sql<{ n: number }>`select 1 + 1 as n`.execute(db)
      return rows[0]?.n
    })
    expect(value).toBe(2)
  })

  test('[T003-5] isolates calls: a table created in one call is absent in the next', async () => {
    await withDb(async (db) => {
      await sql`create table leak_probe (id int)`.execute(db)
    })
    expect(await withDb((db) => tableExists(db, 'leak_probe'))).toBe(false)
  })
})

describe('createMigrator', () => {
  test('[T003-6] applies migrations in name order and rolls back one step at a time', async () => {
    const handle = await openTestDb()
    try {
      const migrator = createMigrator(handle.db, fixtureMigrations)
      const up = await migrator.migrateToLatest()
      expect(up.error).toBeUndefined()
      expect(up.results?.map((r) => r.migrationName)).toEqual(['0001_widgets', '0002_gadgets'])

      const down = await migrator.migrateDown()
      expect(down.results?.map((r) => [r.migrationName, r.direction])).toEqual([['0002_gadgets', 'Down']])
      expect(await tableExists(handle.db, 'gadgets')).toBe(false)
      expect(await tableExists(handle.db, 'widgets')).toBe(true)
    } finally {
      await handle.close()
    }
  })

  test('[T003-7] every production migration ships a down', () => {
    for (const [name, migration] of Object.entries(migrations)) {
      expect(typeof migration.down, `${name} has no down`).toBe('function')
    }
  })
})

testPg('[T003-8] FOR UPDATE SKIP LOCKED skips a row another transaction holds', async (db) => {
  await sql`create table jobs (id int primary key)`.execute(db)
  await sql`insert into jobs values (1), (2)`.execute(db)
  await db.transaction().execute(async (first) => {
    const held = await sql<{ id: number }>`select id from jobs order by id limit 1 for update skip locked`.execute(first)
    const other = await db.transaction().execute((second) =>
      sql<{ id: number }>`select id from jobs order by id limit 1 for update skip locked`.execute(second),
    )
    expect(held.rows.map((r) => r.id)).toEqual([1])
    expect(other.rows.map((r) => r.id)).toEqual([2])
  })
})
