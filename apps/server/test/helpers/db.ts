import { randomBytes } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { Kysely, sql } from 'kysely'
import { PGliteDialect } from 'kysely-pglite-dialect'
import { test } from 'vitest'
import { createDb } from '../../src/db/connect.ts'
import { createMigrator } from '../../src/db/migrator.ts'
import type { Database } from '../../src/db/schema.ts'

export type TestDbTarget = { kind: 'postgres'; url: string } | { kind: 'pglite' }

export interface TestDbHandle {
  db: Kysely<Database>
  close: () => Promise<void>
}

const PG_ONLY_REASON =
  'needs Postgres 16 (set DATABASE_URL): PGlite parity for advisory locks and SKIP LOCKED is unverified'

export function resolveTestDbTarget(env: Record<string, string | undefined> = process.env): TestDbTarget {
  const url = env.DATABASE_URL
  if (url) return { kind: 'postgres', url }
  if (env.SL_REQUIRE_PG === '1') {
    throw new Error('SL_REQUIRE_PG=1 but DATABASE_URL is unset; test:db must run against Postgres 16')
  }
  return { kind: 'pglite' }
}

/**
 * Opens an empty, isolated database: a fresh database on the Postgres server (a schema is not
 * enough, because Kysely's introspection scans every schema and races parallel teardown), or a
 * fresh in-process PGlite instance.
 */
export async function openTestDb(target: TestDbTarget = resolveTestDbTarget()): Promise<TestDbHandle> {
  if (target.kind === 'pglite') {
    const db = new Kysely<Database>({ dialect: new PGliteDialect(new PGlite()) })
    return { db, close: () => db.destroy() }
  }
  const name = `sl_test_${randomBytes(6).toString('hex')}`
  const admin = createDb(target.url)
  try {
    await sql`create database ${sql.id(name)} template template0`.execute(admin)
  } catch (error) {
    await admin.destroy()
    throw error
  }
  const url = new URL(target.url)
  url.pathname = `/${name}`
  const db = createDb(url.toString())
  return {
    db,
    close: async () => {
      try {
        await db.destroy()
        await sql`drop database ${sql.id(name)} with (force)`.execute(admin)
      } finally {
        await admin.destroy()
      }
    },
  }
}

/** Runs `fn` against a freshly migrated, isolated database, then tears it down. */
export async function withDb<T>(fn: (db: Kysely<Database>) => Promise<T>): Promise<T> {
  const handle = await openTestDb()
  try {
    const { error } = await createMigrator(handle.db).migrateToLatest()
    if (error) throw error
    return await fn(handle.db)
  } finally {
    await handle.close()
  }
}

/** A test that needs real Postgres concurrency: titled `@pg`, skipped with a reason on PGlite. */
export function testPg(name: string, fn: (db: Kysely<Database>) => Promise<void>): void {
  test(`${name} @pg`, async (context) => {
    context.skip(resolveTestDbTarget().kind === 'pglite', PG_ONLY_REASON)
    await withDb(fn)
  })
}
