import { SchemaError, type StrippedRecord, hReq } from '@sorenai/loop-schema'
import type { Kysely, Selectable, Transaction } from 'kysely'
import type { Database } from '../db/schema.ts'
import type { RequestRevisionsTable, RequestsTable } from '../db/tables/aggregate.ts'
import type { RequestersTable } from '../db/tables/identity.ts'
import { isId, newId } from '../ids.ts'
import { StateCtxError, parseStateCtx } from '../machine/states.ts'
import { RepoError, mapDbError } from './errors.ts'

export type Executor = Kysely<Database> | Transaction<Database>
export type RequesterRow = Selectable<RequestersTable>
export type RequestRow = Selectable<RequestsTable>
export type RevisionRow = Selectable<RequestRevisionsTable>

export interface InsertRequestInput {
  requesterId: string
  /** An `sl.request.v1` object; parsed and hashed here, so it must already be normalized. */
  fields: unknown
  stripped: readonly StrippedRecord[]
  /** Row 1 shadow-accept for a paused requester. */
  throttled?: boolean
  /** Builds the `security_hold` ctx once the request ID and `h_req` exist (row 1, PC-S). */
  hold?: (ids: { requestId: string; hReq: string }) => unknown
}

export interface SiteRepo {
  readonly siteId: string
  upsertRequester(input: { sub: string; displayName?: string | null }): Promise<RequesterRow>
  getRequester(id: string): Promise<RequesterRow | undefined>
  insertRequest(input: InsertRequestInput): Promise<RequestRow>
  getRequest(id: string): Promise<RequestRow | undefined>
  getRequestByPublicRef(ref: string): Promise<RequestRow | undefined>
  listRevisions(requestId: string): Promise<RevisionRow[]>
}

/**
 * The only way to query the configuration and request tables: every method is scoped to one
 * site (RFC 04 §2, T4.4). Another site's row is indistinguishable from a missing one.
 */
export function siteRepo(db: Executor, siteId: string): SiteRepo {
  if (!isId('site', siteId)) throw new TypeError('siteRepo needs a site_ ID')

  return {
    siteId,

    async upsertRequester({ sub, displayName = null }) {
      return db
        .insertInto('requesters')
        .values({ id: newId('rqr'), site_id: siteId, sub, display_name: displayName })
        .onConflict((oc) => oc.columns(['site_id', 'sub']).doUpdateSet((eb) => ({ display_name: eb.ref('excluded.display_name') })))
        .returningAll()
        .executeTakeFirstOrThrow()
    },

    async getRequester(id) {
      return db.selectFrom('requesters').selectAll().where('site_id', '=', siteId).where('id', '=', id).executeTakeFirst()
    },

    async insertRequest(input) {
      const row = prepareRequest(siteId, input)
      const write = async (tx: Executor): Promise<RequestRow> => {
        const request = await tx.insertInto('requests').values(row.request).returningAll().executeTakeFirstOrThrow()
        await tx.insertInto('request_revisions').values(row.revision).execute()
        return request
      }
      try {
        return db.isTransaction ? await write(db) : await db.transaction().execute(write)
      } catch (error) {
        throw mapDbError(error)
      }
    },

    async getRequest(id) {
      return db.selectFrom('requests').selectAll().where('site_id', '=', siteId).where('id', '=', id).executeTakeFirst()
    },

    async getRequestByPublicRef(ref) {
      return db.selectFrom('requests').selectAll().where('site_id', '=', siteId).where('public_ref', '=', ref).executeTakeFirst()
    },

    async listRevisions(requestId) {
      return db
        .selectFrom('request_revisions')
        .selectAll()
        .where('site_id', '=', siteId)
        .where('request_id', '=', requestId)
        .orderBy('rev', 'asc')
        .execute()
    },
  }
}

/** Validates and hashes before any write, so a bad input leaves the database untouched. */
function prepareRequest(siteId: string, input: InsertRequestInput) {
  const requestId = newId('req')
  let h: string
  try {
    h = hReq({ siteId, requestId, rev: 1, kind: 'requester', parentHReq: null, fields: input.fields })
  } catch (error) {
    if (error instanceof SchemaError) throw new RepoError('invalid_request', error.message, { cause: error })
    throw error
  }
  let state: 'submitted' | 'security_hold' = 'submitted'
  let ctx: Record<string, unknown> = { rev: 1, h_req: h }
  if (input.hold) {
    try {
      state = 'security_hold'
      ctx = parseStateCtx('security_hold', input.hold({ requestId, hReq: h }))
    } catch (error) {
      if (error instanceof StateCtxError) throw new RepoError('invalid_state_ctx', error.message, { cause: error })
      throw error
    }
  }
  return {
    request: {
      id: requestId,
      public_ref: newId('ref'),
      site_id: siteId,
      requester_id: input.requesterId,
      state,
      state_ctx: JSON.stringify(ctx),
      current_rev: 1,
      h_req_current: h,
      throttled: input.throttled ?? false,
    },
    revision: {
      id: newId('rev'),
      site_id: siteId,
      request_id: requestId,
      rev: 1,
      kind: 'requester' as const,
      fields: JSON.stringify(input.fields),
      stripped: JSON.stringify(input.stripped),
      h_req: h,
      parent_h_req: null,
    },
  }
}
