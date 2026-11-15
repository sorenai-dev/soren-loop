import type { Kysely } from 'kysely'
import type { Database } from '../../src/db/schema.ts'
import { newId } from '../../src/ids.ts'

export const HEX = 'a'.repeat(64)

export const FIELDS = {
  title: 'Dark mode',
  problem: 'The page is too bright at night.',
  acceptance_criteria: ['A toggle switches themes'],
  area: null,
  owner_context: null,
}

export interface SeededSite {
  siteId: string
  ownerId: string
  requesterId: string
  requestId: string
  publicRef: string
  cliTokenId: string
  transitionSeq: string
}

/**
 * Raw inserts (tests may bypass the repository) of one site with an owner, a requester, a
 * `submitted` request with revision 1, a CLI token and one transition.
 */
export async function seedSite(db: Kysely<Database>, label: string): Promise<SeededSite> {
  const siteId = newId('site')
  const ownerId = newId('own')
  const requesterId = newId('rqr')
  const requestId = newId('req')
  const publicRef = newId('ref')
  const cliTokenId = newId('tok')
  await db.insertInto('sites').values({ id: siteId, name: `site ${label}` }).execute()
  await db.insertInto('owners').values({ id: ownerId, email: `${label}-${ownerId}@example.test` }).execute()
  await db.insertInto('site_owners').values({ site_id: siteId, owner_id: ownerId }).execute()
  await db.insertInto('requesters').values({ id: requesterId, site_id: siteId, sub: `sub-${label}` }).execute()
  await db
    .insertInto('requests')
    .values({
      id: requestId, public_ref: publicRef, site_id: siteId, requester_id: requesterId, state: 'submitted',
      state_ctx: JSON.stringify({ rev: 1, h_req: HEX }), current_rev: 1, h_req_current: HEX,
    })
    .execute()
  await db
    .insertInto('request_revisions')
    .values({
      id: newId('rev'), site_id: siteId, request_id: requestId, rev: 1, kind: 'requester',
      fields: JSON.stringify(FIELDS), h_req: HEX,
    })
    .execute()
  await db
    .insertInto('cli_tokens')
    .values({
      id: cliTokenId, owner_id: ownerId, site_id: siteId, family_id: newId('fam'),
      access_hmac: Buffer.from(newId('tok')), refresh_hmac: Buffer.from(newId('tok')),
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .execute()
  const { seq } = await db
    .insertInto('request_transitions')
    .values({ site_id: siteId, request_id: requestId, to_state: 'submitted', event: 'submit', actor_type: 'requester' })
    .returning('seq')
    .executeTakeFirstOrThrow()
  return { siteId, ownerId, requesterId, requestId, publicRef, cliTokenId, transitionSeq: String(seq) }
}

/** Resolves to the SQLSTATE of the error `run` rejects with; fails if it resolves. */
export async function sqlState(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') return code
    throw error
  }
  throw new Error('expected the statement to fail')
}
