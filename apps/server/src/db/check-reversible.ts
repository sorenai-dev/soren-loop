import type { Kysely } from 'kysely'
import { type Migration, NO_MIGRATIONS } from 'kysely/migration'
import { createMigrator } from './migrator.ts'

export interface ReversibleResult {
  reversible: boolean
  before: string
  after: string
}

/** Drops the random `\restrict` token newer pg_dump versions write on every run. */
export function normalizeDump(dump: string): string {
  return dump
    .split('\n')
    .filter((line) => !/^\\(un)?restrict\b/.test(line))
    .join('\n')
}

/** Migrates up, all the way down, and up again; the two schema dumps must match. */
export async function checkReversible<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
  dump: () => Promise<string>,
): Promise<ReversibleResult> {
  const migrator = createMigrator(db, migrations)
  await expectSuccess(migrator.migrateToLatest())
  const before = normalizeDump(await dump())
  await expectSuccess(migrator.migrateTo(NO_MIGRATIONS))
  await expectSuccess(migrator.migrateToLatest())
  const after = normalizeDump(await dump())
  return { reversible: before === after, before, after }
}

async function expectSuccess(run: Promise<{ error?: unknown }>): Promise<void> {
  const { error } = await run
  if (error) throw error
}
