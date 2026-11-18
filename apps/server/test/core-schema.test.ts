import { type Kysely, sql } from 'kysely'
import { NO_MIGRATIONS } from 'kysely/migration'
import { expect, test } from 'vitest'
import { createMigrator } from '../src/db/migrator.ts'
import type { Database } from '../src/db/schema.ts'
import { newId } from '../src/ids.ts'
import { CORE_COLUMNS, CORE_CONSTRAINTS, CORE_TABLES } from './fixtures/core-catalog.ts'
import { FIELDS, HEX, seedSite, sqlState } from './helpers/core-fixtures.ts'
import { withDb } from './helpers/db.ts'

async function columns(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ line: string }>`
    select table_name || '.' || column_name || ' ' || data_type
      || case when is_nullable = 'NO' then ' not null' else '' end
      || coalesce(' default ' || column_default, '')
      || case when is_identity = 'YES' then ' identity ' || identity_generation else '' end as line
    from information_schema.columns
    where table_schema = current_schema() and table_name in (${sql.join([...CORE_TABLES])})`.execute(db)
  return rows.map((r) => r.line).sort()
}

async function constraints(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{ line: string }>`
    select rel.relname || ' ' || con.contype::text || ' ' || pg_get_constraintdef(con.oid) as line
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = current_schema() and rel.relname in (${sql.join([...CORE_TABLES])})
      and con.contype in ('p', 'u', 'f', 'c')`.execute(db)
  return rows.map((r) => r.line).sort()
}

test('[T020-6] the migrated catalog matches spec 020 Appendix A', async () => {
  await withDb(async (db) => {
    expect(await columns(db)).toEqual([...CORE_COLUMNS].sort())
    expect(await constraints(db)).toEqual([...CORE_CONSTRAINTS].sort())
  })
})

test('[T020-7] the migration reverses cleanly and re-applies', async () => {
  await withDb(async (db) => {
    const migrator = createMigrator(db)
    const { rows: named } = await sql<{ proname: string }>`
      select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = current_schema() and p.proname like 'sl\\_%' order by 1`.execute(db)
    expect(named.map((r) => r.proname)).toEqual(['sl_reject_update_request_revisions', 'sl_reject_update_specs'])
    const down = await migrator.migrateTo(NO_MIGRATIONS)
    expect(down.error).toBeUndefined()
    const { rows: tables } = await sql<{ n: number }>`
      select count(*)::int as n from information_schema.tables
      where table_schema = current_schema() and table_name in (${sql.join([...CORE_TABLES])})`.execute(db)
    expect(tables[0]?.n).toBe(0)
    const { rows: fns } = await sql<{ n: number }>`
      select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = current_schema() and p.proname like 'sl\\_%'`.execute(db)
    expect(fns[0]?.n).toBe(0)
    expect((await migrator.migrateToLatest()).error).toBeUndefined()
  })
})

test('[T020-8] request_revisions and specs reject UPDATE', async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    const specId = newId('spec')
    await db
      .insertInto('specs')
      .values({
        id: specId, site_id: a.siteId, request_id: a.requestId, version: 1,
        envelope: JSON.stringify({ body_md: 'plan', paths: ['src/a.ts'] }), h_spec: HEX, parent_h_req: HEX,
        base_sha: 'b'.repeat(40), uploaded_by_run: newId('run'),
      })
      .execute()
    const updateRevision = () => db.updateTable('request_revisions').set({ h_req: 'f'.repeat(64) }).execute()
    const updateSpec = () => db.updateTable('specs').set({ h_spec: 'f'.repeat(64) }).execute()
    await expect(updateRevision()).rejects.toThrow('request_revisions is immutable')
    await expect(updateSpec()).rejects.toThrow('specs is immutable')
    expect(await sqlState(updateRevision)).toBe('P0001')
    expect(await sqlState(updateSpec)).toBe('P0001')
    const rev = await db.selectFrom('request_revisions').select('h_req').executeTakeFirstOrThrow()
    const spec = await db.selectFrom('specs').select('h_spec').executeTakeFirstOrThrow()
    expect(rev.h_req).toBe(HEX)
    expect(spec.h_spec).toBe(HEX)
  })
})

test('[T020-9] composite foreign keys stop a row from crossing sites', async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    const b = await seedSite(db, 'b')
    const onA = { site_id: a.siteId, request_id: b.requestId }
    const inserts: [string, () => Promise<unknown>][] = [
      ['request_revisions', () => db.insertInto('request_revisions').values({ ...onA, id: newId('rev'), rev: 2, kind: 'requester', fields: JSON.stringify(FIELDS), h_req: HEX }).execute()],
      ['specs', () => db.insertInto('specs').values({ ...onA, id: newId('spec'), version: 1, envelope: '{}', h_spec: HEX, parent_h_req: HEX, base_sha: 'b'.repeat(40), uploaded_by_run: newId('run') }).execute()],
      ['feedback', () => db.insertInto('feedback').values({ ...onA, id: newId('fb'), kind: 'plan', body: 'x', h_fb: HEX, author: 'owner' }).execute()],
      ['questions', () => db.insertInto('questions').values({ ...onA, id: newId('q'), body: 'x', asked_by: a.ownerId }).execute()],
      ['request_transitions', () => db.insertInto('request_transitions').values({ ...onA, event: 'submit', actor_type: 'requester' }).execute()],
      ['requester_events', () => db.insertInto('requester_events').values({ ...onA, stage: 'received', stage_since: new Date(), transition_seq: b.transitionSeq }).execute()],
      ['requests', () => db.insertInto('requests').values({ id: newId('req'), public_ref: newId('ref'), site_id: a.siteId, requester_id: b.requesterId, state: 'submitted', state_ctx: '{}', current_rev: 1, h_req_current: HEX }).execute()],
      ['transition cli token', () => db.insertInto('request_transitions').values({ site_id: a.siteId, request_id: a.requestId, event: 'plan_uploaded', actor_type: 'cli_for_owner', cli_token_id: b.cliTokenId }).execute()],
      ['question asked by a non-owner', () => db.insertInto('questions').values({ site_id: a.siteId, request_id: a.requestId, id: newId('q'), body: 'x', asked_by: b.ownerId }).execute()],
    ]
    for (const [name, run] of inserts) expect(await sqlState(run), name).toBe('23503')

    // Same site, but the transition belongs to a different request.
    const other = newId('req')
    await db.insertInto('requests').values({ id: other, public_ref: newId('ref'), site_id: a.siteId, requester_id: a.requesterId, state: 'submitted', state_ctx: '{}', current_rev: 1, h_req_current: HEX }).execute()
    const event = () => db.insertInto('requester_events').values({ site_id: a.siteId, request_id: other, stage: 'received', stage_since: new Date(), transition_seq: a.transitionSeq }).execute()
    expect(await sqlState(event)).toBe('23503')
  })
})

test('[T020-11] repo_bindings: same_repo_mode is exactly "no push App and no fork"', async () => {
  await withDb(async (db) => {
    const base = { pr_app_id: '1', pr_app_installation_id: '2', upstream_full_name: 'o/r', default_branch: 'main', owner_github_login: 'o' }
    const forkCols = { push_app_id: '3', push_app_installation_id: '4', bot_owner_login: 'bot', fork_full_name: 'bot/r' }
    const site = async () => (await seedSite(db, newId('trc'))).siteId
    const bind = async (values: Record<string, unknown>) =>
      db.insertInto('repo_bindings').values({ ...base, ...values } as never).execute()

    expect(await sqlState(async () => bind({ site_id: await site(), same_repo_mode: true, fork_full_name: 'bot/r' }))).toBe('23514')
    expect(await sqlState(async () => bind({ site_id: await site(), same_repo_mode: false }))).toBe('23514')
    await expect(bind({ site_id: await site(), same_repo_mode: true })).resolves.toBeDefined()
    await expect(bind({ site_id: await site(), same_repo_mode: false, ...forkCols })).resolves.toBeDefined()
  })
})
