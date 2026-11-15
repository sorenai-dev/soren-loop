import type { Migration } from 'kysely/migration'
import { migration0001Core } from './0001_core.ts'

// Migrations are registered here explicitly, keyed by name; the runner applies them in name
// order. Every migration must ship a `down` (RFC 10 §4), and CI checks up → down → up.
export const migrations: Record<string, Migration> = {
  '0001_core': migration0001Core,
}
