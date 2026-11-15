import { describe, expect, test } from 'vitest'
import {
  hEnableConfirm, hFb, hG1, hHoldClear, hNotificationPolicy, hReq, hRework, hRollout, hSiteConfig,
  hSpec, l2Fingerprint,
} from '../../src/index.ts'
import { hex, reasonOf, vector } from '../helpers/vectors.ts'

interface HashFn<I> {
  (input: I): string
  preimage(input: I): Uint8Array
}

/** Asserts the function's own preimage, then its hash, against a hash.json vector. */
function check<I>(fn: HashFn<I>, id: string, override?: Partial<I>): string {
  const v = vector<I>('hash.json', id)
  const input = { ...v.input, ...override } as I
  expect(hex(fn.preimage(input)), `${id} preimage`).toBe(v.expected_bytes_hex)
  const h = fn(input)
  expect(h, `${id} hash`).toBe(v.expected_hash)
  return h
}

const input = <I>(id: string): I => vector<I>('hash.json', id).input
type ReqInput = Parameters<typeof hReq>[0]
const H01 = (): ReqInput => input<ReqInput>('H-01')
const HEX63 = 'a'.repeat(63)
const UPPER = 'A'.repeat(64)

describe('hReq (sl:req:v1)', () => {
  test('[T013-1] H-01/H-02 rev 1 with area null and with area set hash to their vectors and differ', () => {
    expect(check(hReq, 'H-01')).not.toBe(check(hReq, 'H-02'))
  })

  test('[T013-2] H-03 input key order does not change H_req', () => {
    expect(check(hReq, 'H-03')).toBe(vector('hash.json', 'H-01').expected_hash)
  })

  test('[T013-3] H-04 rev 2 owner_context revision with parent_h_req', () => check(hReq, 'H-04'))

  test('[T013-4] H-05 a malformed or unnormalized fields object is rejected, never hashed', () => {
    expect(reasonOf(() => hReq(input<ReqInput>('H-05')))).toBe(vector('hash.json', 'H-05').expected_error)
    const f = H01().fields as Record<string, unknown>
    expect(reasonOf(() => hReq({ ...H01(), fields: { ...f, extra: 1 } }))).toBe('unknown_key')
    expect(reasonOf(() => hReq({ ...H01(), fields: { ...f, area: undefined } }))).toBe('invalid_type')
    // One unnormalized value in each string slot Design Decision 3 lists.
    const slots: Record<string, unknown>[] = [
      { title: 'Export\u202eCSV' },
      { problem: 'I need my data. ' },
      { acceptance_criteria: ['ok', 'x\r\ny'] },
      { area: 'e\u0301' },
      { owner_context: '\u200bnote' },
    ]
    for (const slot of slots) {
      expect(reasonOf(() => hReq({ ...H01(), fields: { ...f, ...slot } })), JSON.stringify(slot)).toBe('not_normalized')
    }
  })

  test('[T013-5] hReq rejects inconsistent rev, kind and parent combinations', () => {
    const parent = vector('hash.json', 'H-01').expected_hash as string
    const bad: Partial<ReqInput>[] = [
      { rev: 1, parentHReq: parent },
      { rev: 2, kind: 'owner_context', parentHReq: null },
      { rev: 1, kind: 'owner_context' },
      { rev: 0 },
      { rev: 1.5 },
      { rev: 2, kind: 'owner_context', parentHReq: UPPER },
      { rev: 2, kind: 'owner_context', parentHReq: HEX63 },
      { siteId: '' },
      { requestId: '' },
    ]
    for (const b of bad) expect(reasonOf(() => hReq({ ...H01(), ...b })), JSON.stringify(b)).toBe('invalid_value')
  })
})

describe('hG1 (sl:g1:v1)', () => {
  test('[T013-6] H-06 the class changes the G1 hash, not H_req', () => {
    const g1 = (id: string): string => {
      const v = vector<{ hReq: string; eligibilityClass: string }>('hash.json', id)
      expect(hex(hG1.preimage(v.input.hReq, v.input.eligibilityClass)), id).toBe(v.expected_bytes_hex)
      return hG1(v.input.hReq, v.input.eligibilityClass)
    }
    const small = g1('H-06a')
    const standard = g1('H-06b')
    expect(small).toBe(vector('hash.json', 'H-06a').expected_hash)
    expect(standard).toBe(vector('hash.json', 'H-06b').expected_hash)
    expect(small).not.toBe(standard)
    expect(hReq(H01())).toBe(vector('hash.json', 'H-01').expected_hash)
  })
})

describe('hSpec, hFb, hRework', () => {
  test('[T013-7] H-07 unsorted and duplicated paths give the sorted-unique H_spec', () => {
    const h = check(hSpec, 'H-07')
    const v = vector<Parameters<typeof hSpec>[0]>('hash.json', 'H-07')
    expect(hSpec({ ...v.input, paths: v.equivalent_paths as string[] })).toBe(h)
  })

  test('[T013-7] H-07n a body that is not normalized hashes as its nHash form', () => {
    expect(check(hSpec, 'H-07n')).toBe(vector('hash.json', 'H-07').expected_hash)
  })

  test('[T013-7] H-07a spec paths sort by UTF-8 bytes', () => check(hSpec, 'H-07a'))

  test('[T013-8] H-08 the same spec with h_fb set hashes differently', () => {
    expect(check(hSpec, 'H-08')).not.toBe(vector('hash.json', 'H-07').expected_hash)
  })

  test('[T013-9] H-09 rework binds h_spec and h_fb', () => check(hRework, 'H-09'))

  test('[T013-12] H-12c plan feedback hash', () => check(hFb, 'H-12c'))

  test('[T013-12] H-12cn a feedback body that is not normalized hashes as its nHash form', () => {
    expect(check(hFb, 'H-12cn')).toBe(vector('hash.json', 'H-12c').expected_hash)
  })
})

describe('hHoldClear, l2Fingerprint', () => {
  test('[T013-10] H-10 hold clear without and with L2; the L2 fingerprint sorts entries by P(path)', () => {
    const l2 = check(l2Fingerprint, 'H-10d')
    check(l2Fingerprint, 'H-10c')
    check(l2Fingerprint, 'H-10e')
    check(hHoldClear, 'H-10a')
    expect(check(hHoldClear, 'H-10b')).not.toBe(vector('hash.json', 'H-10a').expected_hash)
    // Fixture cross-check: the H-10b vector embeds the H-10d fingerprint.
    expect(input<{ l2Fingerprint: string }>('H-10b').l2Fingerprint).toBe(l2)
  })
})

describe('hRollout (sl:rollout:v1)', () => {
  test('[T013-11] H-11 rollout targets, bp, all and doc_version', () => {
    const t = check(hRollout, 'H-11a')
    const v = vector<Parameters<typeof hRollout>[0]>('hash.json', 'H-11a')
    expect(hRollout({ ...v.input, targets: v.equivalent_targets as string[] } as Parameters<typeof hRollout>[0])).toBe(t)
    check(hRollout, 'H-11b')
    expect(check(hRollout, 'H-11c')).not.toBe(check(hRollout, 'H-11d'))
    check(hRollout, 'H-14b')
  })

  test('[T013-11] rollout rejects out-of-range bp, bad targets and a negative doc_version', () => {
    const base = { requestId: 'req_1', docVersion: 7 }
    const bad = [
      { ...base, mode: 'bp', bp: 10001 },
      { ...base, mode: 'bp', bp: -1 },
      { ...base, mode: 'bp', bp: 1.5 },
      { ...base, mode: 'targets', targets: [] },
      { ...base, mode: 'targets', targets: Array.from({ length: 501 }, (_, i) => `u${i}`) },
      { ...base, mode: 'targets', targets: [''] }, // spec 013 DD5: targets are non-empty ids
      { ...base, mode: 'all', docVersion: -1 },
      { ...base, mode: 'all', docVersion: 1.5 },
    ]
    for (const b of bad) {
      expect(reasonOf(() => hRollout(b as Parameters<typeof hRollout>[0])), JSON.stringify(b).slice(0, 80)).toBe('invalid_value')
    }
    for (const ok of [{ ...base, mode: 'bp', bp: 0 }, { ...base, mode: 'bp', bp: 10_000 }, { ...base, mode: 'all', docVersion: 0 }]) {
      expect(hRollout(ok as Parameters<typeof hRollout>[0])).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(hNotificationPolicy({ siteId: 's', baseVersion: 0, override: {} })).toMatch(/^[0-9a-f]{64}$/)
    expect(hSiteConfig({ siteId: 's', setting: 'x', baseVersion: 0, value: null })).toMatch(/^[0-9a-f]{64}$/)
    const many = Array.from({ length: 500 }, (_, i) => `u${i}`)
    expect(hRollout({ ...base, mode: 'targets', targets: [...many, 'u0'] })).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('hNotificationPolicy, hSiteConfig, hEnableConfirm', () => {
  test('[T013-12] H-12 notification policy with base_version; site config; enable confirm', () => {
    expect(check(hNotificationPolicy, 'H-12a')).not.toBe(check(hNotificationPolicy, 'H-12e'))
    check(hSiteConfig, 'H-12b')
    check(hEnableConfirm, 'H-12d')
  })
})

describe('invalid_value per function', () => {
  test('[T013-14] hash inputs must be 64 lowercase hex; identifiers must be non-empty; L2 paths unique', () => {
    const h = vector('hash.json', 'H-01').expected_hash as string
    for (const bad of [UPPER, HEX63]) {
      expect(reasonOf(() => hG1(bad, 'small'))).toBe('invalid_value')
      expect(reasonOf(() => hSpec({ hReq: bad, hFb: null, bodyMd: 'x', paths: [] }))).toBe('invalid_value')
      expect(reasonOf(() => hSpec({ hReq: h, hFb: bad, bodyMd: 'x', paths: [] }))).toBe('invalid_value')
      expect(reasonOf(() => hRework({ hSpec: bad, hFb: h }))).toBe('invalid_value')
      expect(reasonOf(() => hRework({ hSpec: h, hFb: bad }))).toBe('invalid_value')
      expect(reasonOf(() => hHoldClear({ requestId: 'r', verdictId: 'v', contentHash: bad, l2Fingerprint: null }))).toBe('invalid_value')
      expect(reasonOf(() => hHoldClear({ requestId: 'r', verdictId: 'v', contentHash: h, l2Fingerprint: bad }))).toBe('invalid_value')
    }
    expect(reasonOf(() => hG1(h, ''))).toBe('invalid_value')
    expect(reasonOf(() => hFb({ requestId: '', kind: 'plan', body: 'x' }))).toBe('invalid_value')
    const hold = { requestId: 'r', verdictId: 'v', contentHash: h, l2Fingerprint: null }
    const enable = { requestId: 'r', deploymentId: 'd', flagKey: 'f' }
    for (const k of ['requestId', 'verdictId'] as const) {
      expect(reasonOf(() => hHoldClear({ ...hold, [k]: '' })), k).toBe('invalid_value')
    }
    for (const k of ['requestId', 'deploymentId', 'flagKey'] as const) {
      expect(reasonOf(() => hEnableConfirm({ ...enable, [k]: '' })), k).toBe('invalid_value')
    }
    expect(reasonOf(() => hSiteConfig({ siteId: 's', setting: '', baseVersion: 1, value: 1 }))).toBe('invalid_value')
    expect(reasonOf(() => hSiteConfig({ siteId: 's', setting: 'x', baseVersion: -1, value: 1 }))).toBe('invalid_value')
    expect(reasonOf(() => hNotificationPolicy({ siteId: '', baseVersion: 1, override: {} }))).toBe('invalid_value')
    const entry = { status: 'added', blobSha: 'b' }
    expect(reasonOf(() => l2Fingerprint({ trustedSha: 't', baseSha: 'b', entries: [{ ...entry, path: 'a.ts' }, { ...entry, path: './a.ts' }] }))).toBe('invalid_value')
    const l2 = { trustedSha: 't', baseSha: 'b', entries: [{ ...entry, path: 'a.ts' }] }
    expect(reasonOf(() => l2Fingerprint({ ...l2, trustedSha: '' }))).toBe('invalid_value')
    expect(reasonOf(() => l2Fingerprint({ ...l2, baseSha: '' }))).toBe('invalid_value')
    expect(reasonOf(() => l2Fingerprint({ ...l2, entries: [{ ...entry, path: 'a.ts', status: '' }] }))).toBe('invalid_value')
    expect(reasonOf(() => l2Fingerprint({ ...l2, entries: [{ ...entry, path: 'a.ts', blobSha: '' }] }))).toBe('invalid_value')
    expect(reasonOf(() => l2Fingerprint({ ...l2, entries: [{ ...entry, path: '/etc/x' }] }))).toBe('path_absolute')
    expect(reasonOf(() => hSpec({ hReq: h, hFb: null, bodyMd: 'x', paths: ['../x'] }))).toBe('path_traversal')
    expect(reasonOf(() => hFb({ requestId: 'r', kind: 'plan', body: 'a\ud800' }))).toBe('invalid_utf8')
    // Closed enums still hold for JavaScript callers that bypass the types.
    expect(reasonOf(() => hFb({ requestId: 'r', kind: 'x' as never, body: 'b' }))).toBe('invalid_value')
    const parentH01 = vector('hash.json', 'H-01').expected_hash as string
    expect(reasonOf(() => hReq({ ...H01(), rev: 2, parentHReq: parentH01, kind: 'x' as never }))).toBe('invalid_value')
    expect(reasonOf(() => hRollout({ requestId: 'r', docVersion: 1, mode: 'x' } as never))).toBe('invalid_value')
    expect(reasonOf(() => hReq({ ...H01(), fields: { ...(H01().fields as object), title: 'a\ud800' } }))).toBe('invalid_utf8')
  })
})
