import { type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// Two throwaway migrations that exercise the runner without touching the real schema.
export const fixtureMigrations: Record<string, Migration> = {
  '0002_gadgets': {
    up: async (db: Kysely<unknown>) => {
      await sql`create table gadgets (id int primary key)`.execute(db)
    },
    down: async (db: Kysely<unknown>) => {
      await sql`drop table gadgets`.execute(db)
    },
  },
  '0001_widgets': {
    up: async (db: Kysely<unknown>) => {
      await sql`create table widgets (id int primary key)`.execute(db)
    },
    down: async (db: Kysely<unknown>) => {
      await sql`drop table widgets`.execute(db)
    },
  },
}
