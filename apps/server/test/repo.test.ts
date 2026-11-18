import { hReq } from '@sorenai/loop-schema'
import { sql } from 'kysely'
import { expect, test } from 'vitest'
import { encodeId, isId, newId } from '../src/ids.ts'
import { RepoError, siteRepo } from '../src/repo/index.ts'
import { FIELDS, HEX, seedSite, sqlState } from './helpers/core-fixtures.ts'
import { withDb } from './helpers/db.ts'

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

test('[T020-5] siteRepo refuses an ID that is not a site_ ID', async () => {
  await withDb(async (db) => {
    expect(() => siteRepo(db, 'not-an-id')).toThrow(TypeError)
    expect(() => siteRepo(db, encodeId('req', new Uint8Array(16)))).toThrow(TypeError)
  })
})

test('[T020-10] upsertRequester is keyed by (site, sub)', async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    const b = await seedSite(db, 'b')
    const repoA = siteRepo(db, a.siteId)
    const first = await repoA.upsertRequester({ sub: 's1', displayName: 'Ann' })
    const second = await repoA.upsertRequester({ sub: 's1', displayName: 'Bea' })
    expect(isId('rqr', first.id)).toBe(true)
    expect(second.id).toBe(first.id)
    expect((await repoA.getRequester(first.id))?.display_name).toBe('Bea')
    await repoA.upsertRequester({ sub: 's1' })
    expect((await repoA.getRequester(first.id))?.display_name).toBeNull()
    const onB = await siteRepo(db, b.siteId).upsertRequester({ sub: 's1' })
    expect(onB.id).not.toBe(first.id)
    const duplicate = () => db.insertInto('requesters').values({ id: newId('rqr'), site_id: a.siteId, sub: 's1' }).execute()
    expect(await sqlState(duplicate)).toBe('23505')
  })
})

test('[T020-15] insertRequest stores a submitted request and revision 1 with its own h_req', async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    const repo = siteRepo(db, a.siteId)
    const stripped = [{ codePoint: 0x200b, index: 3 }]
    const req = await repo.insertRequest({ requesterId: a.requesterId, fields: FIELDS, stripped })
    const expected = hReq({ siteId: a.siteId, requestId: req.id, rev: 1, kind: 'requester', parentHReq: null, fields: FIELDS })
    expect(isId('req', req.id)).toBe(true)
    expect(isId('ref', req.public_ref)).toBe(true)
    expect(req).toMatchObject({
      state: 'submitted', version: 0, current_rev: 1, throttled: false, eligibility_class: null, h_req_current: expected,
    })
    expect(req.state_ctx).toEqual({ rev: 1, h_req: expected })
    const revisions = await repo.listRevisions(req.id)
    expect(revisions).toHaveLength(1)
    expect(isId('rev', revisions[0]?.id)).toBe(true)
    expect(revisions[0]).toMatchObject({ rev: 1, kind: 'requester', parent_h_req: null, h_req: expected })
    expect(revisions[0]?.fields).toEqual(FIELDS)
    expect(revisions[0]?.stripped).toEqual(stripped)
  })
})

test('[T020-16] insertRequest records throttling and can start in a PC-S hold', async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    const repo = siteRepo(db, a.siteId)
    const throttled = await repo.insertRequest({ requesterId: a.requesterId, fields: FIELDS, stripped: [], throttled: true })
    expect(throttled.throttled).toBe(true)

    const calls: { requestId: string; hReq: string }[] = []
    const verdictId = newId('pck')
    const held = await repo.insertRequest({
      requesterId: a.requesterId, fields: FIELDS, stripped: [],
      hold: (ids) => {
        calls.push(ids)
        return {
          checkpoint: 'PC-S', reason: 'flagged', verdict_id: verdictId, content_hash: ids.hReq,
          l2_fingerprint: null, return_to: 'submitted',
        }
      },
    })
    const [revision] = await repo.listRevisions(held.id)
    expect(calls).toEqual([{ requestId: held.id, hReq: revision?.h_req }])
    expect(held.state).toBe('security_hold')
    expect(held.state_ctx).toEqual({
      checkpoint: 'PC-S', reason: 'flagged', verdict_id: verdictId, content_hash: revision?.h_req,
      l2_fingerprint: null, return_to: 'submitted',
    })
  })
})

test('[T020-17] insertRequest rejects bad input with a typed error and writes nothing', async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    const b = await seedSite(db, 'b')
    const repo = siteRepo(db, a.siteId)
    const noTitle: Partial<typeof FIELDS> = { ...FIELDS }
    delete noTitle.title
    const cases: [string, Parameters<typeof repo.insertRequest>[0]][] = [
      ['invalid_reference', { requesterId: b.requesterId, fields: FIELDS, stripped: [] }],
      ['invalid_request', { requesterId: a.requesterId, fields: noTitle, stripped: [] }],
      // "e" + U+0301 is not NFC; h_req is defined over normalized text only.
      ['invalid_request', { requesterId: a.requesterId, fields: { ...FIELDS, title: 'Café' }, stripped: [] }],
      ['invalid_state_ctx', {
        requesterId: a.requesterId, fields: FIELDS, stripped: [],
        hold: (ids) => ({ checkpoint: 'PC-S', reason: 'flagged', content_hash: ids.hReq, l2_fingerprint: null, return_to: 'submitted' }),
      }],
    ]
    for (const [code, input] of cases) {
      const error = await rejection(() => repo.insertRequest(input))
      expect(error, code).toBeInstanceOf(RepoError)
      expect((error as RepoError).code).toBe(code)
      expect((error as RepoError).cause, code).toBeDefined()
    }
    const count = await db.selectFrom('requests').select(db.fn.countAll<number>().as('n')).where('site_id', '=', a.siteId).executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(1) // only the seeded request
  })
})

test('[T020-18] a failed revision insert rolls back the request row', async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    await sql`create function test_fail_revision() returns trigger language plpgsql as $$
      begin raise exception 'revision insert failed'; end $$`.execute(db)
    await sql`create trigger test_fail_revision before insert on request_revisions
      for each row execute function test_fail_revision()`.execute(db)
    const error = await rejection(() => siteRepo(db, a.siteId).insertRequest({ requesterId: a.requesterId, fields: FIELDS, stripped: [] }))
    expect(error).not.toBeInstanceOf(RepoError)
    expect((error as { code?: string }).code).toBe('P0001')
    const rows = await db.selectFrom('requests').select('id').where('site_id', '=', a.siteId).execute()
    expect(rows.map((r) => r.id)).toEqual([a.requestId])
  })
})

test("[T020-19] insertRequest uses the caller's transaction", async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    let id = ''
    await expect(
      db.transaction().execute(async (tx) => {
        const req = await siteRepo(tx, a.siteId).insertRequest({ requesterId: a.requesterId, fields: FIELDS, stripped: [] })
        id = req.id
        expect(await siteRepo(tx, a.siteId).getRequest(id)).toBeDefined()
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    expect(id).not.toBe('')
    expect(await siteRepo(db, a.siteId).getRequest(id)).toBeUndefined()
  })
})

test("[T020-20] a site's repository never sees another site's rows", async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    const b = await seedSite(db, 'b')
    const repoA = siteRepo(db, a.siteId)
    const repoB = siteRepo(db, b.siteId)
    expect(await repoA.getRequest(b.requestId)).toBeUndefined()
    expect(await repoA.getRequestByPublicRef(b.publicRef)).toBeUndefined()
    expect(await repoA.getRequester(b.requesterId)).toBeUndefined()
    expect(await repoA.listRevisions(b.requestId)).toEqual([])
    expect((await repoB.getRequest(b.requestId))?.id).toBe(b.requestId)
    expect((await repoB.getRequestByPublicRef(b.publicRef))?.id).toBe(b.requestId)
    expect((await repoB.getRequester(b.requesterId))?.id).toBe(b.requesterId)
    expect(await repoB.listRevisions(b.requestId)).toHaveLength(1)
  })
})

test('[T020-21] listRevisions returns revisions in rev order', async () => {
  await withDb(async (db) => {
    const a = await seedSite(db, 'a')
    const requestId = newId('req')
    await db.insertInto('requests').values({
      id: requestId, public_ref: newId('ref'), site_id: a.siteId, requester_id: a.requesterId, state: 'submitted',
      state_ctx: JSON.stringify({ rev: 2, h_req: HEX }), current_rev: 2, h_req_current: HEX,
    }).execute()
    for (const [rev, kind] of [[2, 'owner_context'], [1, 'requester']] as const) {
      await db.insertInto('request_revisions').values({
        id: newId('rev'), site_id: a.siteId, request_id: requestId, rev, kind, fields: JSON.stringify(FIELDS), h_req: HEX,
      }).execute()
    }
    const revs = await siteRepo(db, a.siteId).listRevisions(requestId)
    expect(revs.map((r) => r.rev)).toEqual([1, 2])
  })
})
