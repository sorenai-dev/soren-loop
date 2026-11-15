import { describe, expect, test } from 'vitest'
import * as schema from '../../src/index.ts'
import { growPinSet, verifyReceipt } from '../../src/receipt.ts'
import { VECTORS, runVectors } from '../../src/vectors/run.ts'
import type { VectorFile, VectorImpl } from '../../src/vectors/run.ts'
import { loadVectors } from '../helpers/vectors.ts'

const FILES: VectorFile[] = ['normalize.json', 'hash.json', 'challenge.json', 'receipt.json']

/** The package's own implementation, as a third party would wire theirs. */
const IMPL: VectorImpl = {
  nIntake: schema.nIntake, nHash: schema.nHash, frame: schema.frame, hashFields: schema.hashFields,
  byteSort: schema.byteSort, P: schema.P, jcs: schema.jcs, hReq: schema.hReq, hG1: schema.hG1, hSpec: schema.hSpec,
  hFb: schema.hFb, hRework: schema.hRework, hHoldClear: schema.hHoldClear, l2Fingerprint: schema.l2Fingerprint,
  hRollout: schema.hRollout, hEnableConfirm: schema.hEnableConfirm, hNotificationPolicy: schema.hNotificationPolicy,
  hSiteConfig: schema.hSiteConfig, hAuthenticator: schema.hAuthenticator, hBulkReject: schema.hBulkReject,
  deriveChallenge: schema.deriveChallenge, webauthnChallenge: schema.webauthnChallenge, verifyReceipt, growPinSet,
}

const idsOf = (file: VectorFile): string[] => loadVectors(file).map((v) => v.id)
const failedIds = (report: Awaited<ReturnType<typeof runVectors>>): string[] =>
  report.results.filter((r) => !r.ok).map((r) => r.id)
/** The package impl with some functions replaced. */
const mutant = (patch: Partial<VectorImpl>): VectorImpl => ({ ...IMPL, ...patch })

describe('runVectors (spec 016 batch A)', () => {
  test('[T016-1] the package passes every bundled vector, each reported exactly once', async () => {
    const report = await runVectors(IMPL)
    const expected = FILES.flatMap((f) => idsOf(f).map((id) => `${f} ${id}`))
    expect(report.results.map((r) => `${r.file} ${r.id}`)).toEqual(expected)
    expect(report.results.filter((r) => !r.ok)).toEqual([])
    expect(report.results.every((r) => r.checks > 0)).toBe(true)
    expect(report).toMatchObject({ passed: expected.length, failed: 0, skipped: 0 })
    expect(Object.keys(VECTORS)).toEqual(FILES)
  })

  test('[T016-2] an nHash that returns its input fails the NFC vectors and keeps hash vectors passing', async () => {
    const report = await runVectors(mutant({ nHash: ((x: string) => x) as VectorImpl['nHash'] }))
    expect(failedIds(report)).toContain('N-01')
    expect(report.results.find((r) => r.id === 'N-01')?.message).toMatch(/nHash/)
    expect(report.results.find((r) => r.id === 'H-13a')?.ok).toBe(true)
  })

  test('[T016-2] a verifyReceipt that always says ok fails every forged receipt', async () => {
    const report = await runVectors(mutant({ verifyReceipt: async () => ({ ok: true }) }))
    for (const id of ['R-02', 'R-03', 'R-04', 'R-05', 'R-07a', 'R-08', 'R-09']) expect(failedIds(report)).toContain(id)
    expect(failedIds(report)).not.toContain('R-01')
  })

  test('[T016-2] a deriveChallenge that skips the target sort fails C-02b and C-04', async () => {
    const unsorted = Object.assign(
      (c: schema.ChallengeInput) => schema.hashFields('sl:webauthn:v1', [
        c.action, schema.jcs(c.targets.map((t) => ({ id: t.id, type: t.type }))), c.contentHash, c.nonce,
      ]),
      { preimage: schema.deriveChallenge.preimage },
    ) as VectorImpl['deriveChallenge']
    const failed = failedIds(await runVectors(mutant({ deriveChallenge: unsorted })))
    expect(failed).toEqual(expect.arrayContaining(['C-02a', 'C-02b', 'C-04', 'C-06']))
    expect(failed).not.toContain('C-01')
  })

  test('[T016-2] an impl that throws TypeError for everything fails every expected_error vector', async () => {
    const thrower = (): never => {
      throw new TypeError('not implemented')
    }
    const all = Object.fromEntries(Object.keys(IMPL).map((k) => [k, thrower])) as unknown as VectorImpl
    const report = await runVectors(all)
    const errorIds = FILES.flatMap((f) => loadVectors(f).filter((v) => v.expected_error !== undefined).map((v) => v.id))
    expect(errorIds.length).toBeGreaterThan(0)
    for (const id of errorIds) expect(failedIds(report)).toContain(id)
    expect(report.failed).toBe(report.results.length)
  })

  test('[T016-2] an error with the wrong reason fails every expected_error vector', async () => {
    const wrong = (): never => {
      throw Object.assign(new Error('x'), { reason: 'not_the_reason' })
    }
    const all = Object.fromEntries(Object.keys(IMPL).map((k) => [k, wrong])) as unknown as VectorImpl
    const report = await runVectors(all)
    const errorIds = FILES.flatMap((f) => loadVectors(f).filter((v) => v.expected_error !== undefined).map((v) => v.id))
    for (const id of errorIds) expect(failedIds(report)).toContain(id)
  })

  test('[T016-2] a plain Error (not a SchemaError) with the right reason passes', async () => {
    const h05 = loadVectors('hash.json').filter((v) => v.id === 'H-05')
    const own = (): never => {
      throw Object.assign(new Error('x'), { reason: 'missing_key' })
    }
    const report = await runVectors(mutant({ hReq: Object.assign(own, { preimage: own }) as unknown as VectorImpl['hReq'] }), { 'hash.json': h05 })
    expect(report).toMatchObject({ passed: 1, failed: 0 })
  })

  test.each<[string, Partial<VectorImpl>, string]>([
    ['a .preimage with wrong bytes', { hFb: Object.assign((i: Parameters<typeof schema.hFb>[0]) => schema.hFb(i), { preimage: () => new Uint8Array([1]) }) as VectorImpl['hFb'] }, 'H-12c'],
    ['a frame with wrong bytes', { frame: (() => new Uint8Array([1])) as VectorImpl['frame'] }, 'H-13a'],
    ['a jcs with a different string', { jcs: (() => '{}') as VectorImpl['jcs'] }, 'JCS-01'],
    ['an nIntake that records nothing stripped', { nIntake: ((f: string, cap: number) => ({ ...schema.nIntake(f, cap), stripped: [] })) as VectorImpl['nIntake'] }, 'N-02'],
    ['a webauthnChallenge returning hex', { webauthnChallenge: ((h: string) => h) as VectorImpl['webauthnChallenge'] }, 'C-01'],
    ['a byteSort in UTF-16 order', { byteSort: ((xs: string[]) => [...xs].sort()) as VectorImpl['byteSort'] }, 'H-14'],
    ['a P that never throws', { P: ((p: string) => p.replace(/^\.\//, '').replace(/\/\//g, '/')) as VectorImpl['P'] }, 'H-15'],
    ['an hAuthenticator giving another add hash', { hAuthenticator: Object.assign(() => '0'.repeat(64), { preimage: () => new Uint8Array() }) as unknown as VectorImpl['hAuthenticator'] }, 'R-06a'],
  ])('[T016-2] %s fails its vector', async (_name, patch, id) => {
    expect(failedIds(await runVectors(mutant(patch)))).toContain(id)
  })

  test('[T016-2] webauthnChallenge runs on deriveChallenge output, not on the vector hash', async () => {
    const shifted = Object.assign((c: schema.ChallengeInput) => schema.deriveChallenge({ ...c, nonce: 'f'.repeat(32) }), {
      preimage: schema.deriveChallenge.preimage,
    }) as VectorImpl['deriveChallenge']
    const report = await runVectors(mutant({ deriveChallenge: shifted }), { 'challenge.json': loadVectors('challenge.json').slice(0, 1) })
    expect(report.results[0]?.message).toMatch(/webauthnChallenge/)
  })

  test('[T016-3] malformed records, rejected promises and unknown expectations are failures', async () => {
    const report = await runVectors(mutant({ verifyReceipt: () => Promise.reject(new Error('boom')) }), {
      'hash.json': [null, 42, { id: 'X-3' }, { id: 'X-4', fn: 'P', input: { path: 'a' }, expected_normalized: 'a', expected_bogus: 1 }],
      'receipt.json': loadVectors('receipt.json').slice(0, 1),
    })
    expect(report.results.map((r) => r.ok)).toEqual([false, false, false, false, false])
    expect(report.results[3]?.message).toMatch(/expected_bogus/)
  })

  test('[T016-3] results follow file order whatever the caller key order; bad lists are failures', async () => {
    const report = await runVectors(IMPL, {
      'receipt.json': loadVectors('receipt.json').slice(0, 1),
      'hash.json': loadVectors('hash.json').slice(0, 1),
    })
    expect(report.results.map((r) => r.file)).toEqual(['hash.json', 'receipt.json'])
    const bad = await runVectors(IMPL, { 'hash.json': 42, 'bogus.json': [] } as unknown as Parameters<typeof runVectors>[1])
    expect(bad.results).toEqual([
      expect.objectContaining({ file: 'hash.json', id: '*', ok: false }),
      expect.objectContaining({ file: 'bogus.json', id: '*', ok: false }),
    ])
    const none = await runVectors(IMPL, null as unknown as Parameters<typeof runVectors>[1])
    expect(none.failed).toBe(0)
    expect(none.results).toHaveLength(FILES.flatMap(idsOf).length)
  })

  test('[T016-3] a missing impl or a non-object vectors argument is a failure, never a rejection', async () => {
    const noImpl = await runVectors(null as unknown as VectorImpl)
    expect(noImpl).toMatchObject({ passed: 0, failed: 1 })
    expect(noImpl.results[0]).toMatchObject({ id: '*', ok: false })
    const notObject = await runVectors(IMPL, 42 as unknown as Parameters<typeof runVectors>[1])
    expect(notObject).toMatchObject({ passed: 0, failed: 1 })
  })

  test('[T016-3] a throwing function is named and the other functions still run', async () => {
    const boom = (): never => {
      throw new Error('boom')
    }
    const report = await runVectors(mutant({ nIntake: boom as VectorImpl['nIntake'] }), {
      'normalize.json': loadVectors('normalize.json').filter((v) => v.id === 'N-01'),
    })
    const r = report.results[0]
    expect(r?.ok).toBe(false)
    expect(r?.message).toMatch(/nIntake.*boom/)
    expect(r?.checks).toBeGreaterThan(0)
  })

  test('[T016-3] failed comparisons are labelled with their function', async () => {
    const stripped = await runVectors(
      mutant({ nIntake: ((f: string, cap: number) => ({ ...schema.nIntake(f, cap), stripped: [] })) as VectorImpl['nIntake'] }),
      { 'normalize.json': loadVectors('normalize.json').filter((v) => v.id === 'N-02') },
    )
    expect(stripped.results[0]?.message).toMatch(/nIntake/)
    const add = await runVectors(
      mutant({ hAuthenticator: Object.assign(() => '0'.repeat(64), { preimage: () => new Uint8Array() }) as unknown as VectorImpl['hAuthenticator'] }),
      { 'receipt.json': loadVectors('receipt.json').filter((v) => v.id === 'R-06a') },
    )
    expect(add.results[0]?.message).toMatch(/hAuthenticator/)
  })

  test('[T016-3] a known expectation that the named function never compares fails the vector', async () => {
    const h01 = { ...loadVectors('hash.json').find((v) => v.id === 'H-01'), expected_sorted: ['a'] }
    const report = await runVectors(IMPL, { 'hash.json': [h01] })
    expect(report.results[0]).toMatchObject({ ok: false, message: expect.stringMatching(/unused expectation expected_sorted/) })
  })

  test('[T016-3] unknown fn and no expectation are failures, never throws', async () => {
    const report = await runVectors(IMPL, {
      'hash.json': [
        { id: 'X-1', fn: 'nope', input: {}, expected_hash: 'a' },
        { id: 'X-2', fn: 'P', input: { path: 'a' } },
      ],
    })
    expect(report.results).toEqual([
      expect.objectContaining({ id: 'X-1', ok: false, message: expect.stringMatching(/unknown fn/) }),
      expect.objectContaining({ id: 'X-2', ok: false, message: expect.stringMatching(/no expectation/) }),
    ])
  })

  test('[T016-3] a content hash without .preimage counts its bytes checks as skipped', async () => {
    const bare = ((i: Parameters<typeof schema.hFb>[0]) => schema.hFb(i)) as VectorImpl['hFb']
    const h12c = loadVectors('hash.json').filter((v) => v.id === 'H-12c')
    const report = await runVectors(mutant({ hFb: bare }), { 'hash.json': h12c })
    expect(report).toMatchObject({ passed: 1, failed: 0, skipped: 1 })
  })

  test('[T016-3] a custom vector set runs only those vectors', async () => {
    const report = await runVectors(IMPL, { 'challenge.json': loadVectors('challenge.json').slice(0, 2) })
    expect(report.results.map((r) => r.id)).toEqual(idsOf('challenge.json').slice(0, 2))
  })
})
