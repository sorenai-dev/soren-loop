// Usage: node src/db/cli.ts <migrate|rollback|check-reversible>   (needs DATABASE_URL)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { MigrationResultSet } from 'kysely/migration'
import { checkReversible } from './check-reversible.ts'
import { createDb } from './connect.ts'
import { migrations } from './migrations/index.ts'
import { createMigrator } from './migrator.ts'

const run = promisify(execFile)

function report({ error, results }: MigrationResultSet): void {
  for (const r of results ?? []) console.log(`${r.status.padEnd(9)} ${r.direction.padEnd(4)} ${r.migrationName}`)
  if (results?.length === 0) console.log('nothing to do')
  if (error) throw error
}

// PG_DUMP overrides the dump command (CI runs pg_dump inside the service container).
async function pgDump(url: string): Promise<string> {
  const [command = 'pg_dump', ...args] = process.env.PG_DUMP?.split(' ') ?? ['pg_dump', url]
  const { stdout } = await run(command, [...args, '--schema-only', '--no-owner'], { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

async function main(command: string | undefined): Promise<number> {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  const db = createDb(url)
  try {
    switch (command) {
      case 'migrate':
        report(await createMigrator(db).migrateToLatest())
        return 0
      case 'rollback':
        report(await createMigrator(db).migrateDown())
        return 0
      case 'check-reversible': {
        const result = await checkReversible(db, migrations, () => pgDump(url))
        console.log(result.reversible ? 'migrations are reversible' : 'schema differs after up → down → up')
        return result.reversible ? 0 : 1
      }
      default:
        console.error('usage: cli.ts <migrate|rollback|check-reversible>')
        return 2
    }
  } finally {
    await db.destroy()
  }
}

process.exitCode = await main(process.argv[2])
