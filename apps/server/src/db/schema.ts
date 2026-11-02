import type { Kysely } from 'kysely'

// Tables are added by the data-model tasks (RFC 04); each one extends this map.
export type Database = Record<never, never>

export type Db = Kysely<Database>
