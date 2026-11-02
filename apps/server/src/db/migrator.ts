import type { Kysely } from 'kysely'
import { type Migration, Migrator } from 'kysely/migration'
import { migrations as productionMigrations } from './migrations/index.ts'

export function createMigrator<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration> = productionMigrations,
): Migrator {
  return new Migrator({ db, provider: { getMigrations: async () => migrations } })
}
