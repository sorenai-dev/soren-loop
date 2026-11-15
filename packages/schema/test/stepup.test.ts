import { describe, expect, test } from 'vitest'
import {
  PREFIXES, STEPUP_ACTIONS, TARGET_TYPES, contentHashPrefixFor, deriveChallenge, hAuthenticator,
  hBulkReject, targetShapeFor, webauthnChallenge,
} from '../src/index.ts'
import type { ChallengeInput, StepupAction, Target } from '../src/index.ts'
import { hex, reasonOf, vector } from './helpers/vectors.ts'

// Code points built at runtime so the source stays ASCII (hygiene test T012-17).
const FI = String.fromCodePoint(0xfb01)
const EMOJI = String.fromCodePoint(0x1f600)
const LONE = String.fromCharCode(0xd800)

interface HashFn<I> {
  (input: I): string
  preimage(input: I): Uint8Array
}

/** Asserts a vector's preimage and hash for the function under test, returning the hash. */
function check<I>(fn: HashFn<I>, file: 'hash.json' | 'challenge.json', id: string): string {
  const v = vector<I>(file, id)
  expect(hex(fn.preimage(v.input)), `${id} preimage`).toBe(v.expected_bytes_hex)
  const h = fn(v.input)
  expect(h, `${id} hash`).toBe(v.expected_hash)
  return h
}

const C01 = (): ChallengeInput => vector<ChallengeInput>('challenge.json', 'C-01').input
const req = (id: string): Target => ({ type: 'request', id })

// The action table from spec 014 DD1, written out by hand.
const TABLE: Record<StepupAction, [string, unknown]> = {
  'request.approve': ['sl:g1:v1', { kind: 'exact', types: ['request'] }],
  'spec.approve': ['sl:spec:v1', { kind: 'exact', types: ['request'] }],
  'hold.clear': ['sl:hold_clear:v1', { kind: 'exact', types: ['request', 'verdict'] }],
  'rework.approve': ['sl:rework:v1', { kind: 'exact', types: ['request'] }],
  'rollout.widen': ['sl:rollout:v1', { kind: 'exact', types: ['request'] }],
  'enablement.confirm': ['sl:enable_confirm:v1', { kind: 'exact', types: ['request'] }],
  'notification_policy.update': ['sl:notification_policy:v1', { kind: 'exact', types: ['site'] }],
  'site_config.update': ['sl:site_config:v1', { kind: 'exact', types: ['site'] }],
  'authenticator.add': ['sl:authenticator:v1', { kind: 'exact', types: ['owner'] }],
  'authenticator.remove': ['sl:authenticator:v1', { kind: 'exact', types: ['owner'] }],
  'requests.bulk_reject': ['sl:bulk_reject:v1', { kind: 'many', type: 'request', max: 500 }],
}

/** A valid target list for each action, used to vary one thing at a time. */
function validTargets(action: StepupAction): Target[] {
  const shape = TABLE[action][1] as { kind: string; types?: string[]; type?: string }
  const types = shape.kind === 'exact' ? (shape.types as Target['type'][]) : [shape.type as Target['type']]
  return types.map((type, i) => ({ type, id: `id_${i}` }))
}

describe('step-up content hashes (spec 014 batch A)', () => {
  test('[T014-1] H-16a/H-16b authenticator add and remove match their vectors and differ', () => {
    expect(check(hAuthenticator, 'hash.json', 'H-16a')).not.toBe(check(hAuthenticator, 'hash.json', 'H-16b'))
  })

  test('[T014-1] H-16c a credential id using - and _ is canonical and matches its vector', () => {
    check(hAuthenticator, 'hash.json', 'H-16c')
  })

  test('[T014-2] H-17a/H-17b bulk reject ids hash independently of input order', () => {
    expect(check(hBulkReject, 'hash.json', 'H-17a')).toBe(check(hBulkReject, 'hash.json', 'H-17b'))
  })

  test('[T014-2] H-17c bulk reject ids sort by UTF-8 bytes, not UTF-16 order', () => {
    const v = vector<{ requestIds: string[] }>('hash.json', 'H-17c')
    expect(v.input.requestIds).toEqual([`req_${EMOJI}`, `req_${FI}`])
    check(hBulkReject, 'hash.json', 'H-17c')
  })

  type AuthIn = Parameters<typeof hAuthenticator>[0]
  const auth = (): AuthIn => vector<AuthIn>('hash.json', 'H-16a').input
  test.each<[string, () => unknown]>([
    ['op not add/remove', () => hAuthenticator({ ...auth(), op: 'replace' as 'add' })],
    ['empty ownerId', () => hAuthenticator({ ...auth(), ownerId: '' })],
    ['padded credentialId', () => hAuthenticator({ ...auth(), credentialId: 'AQ==' })],
    ['non-zero trailing bits', () => hAuthenticator({ ...auth(), credentialId: 'AR' })],
    ['non-alphabet publicKeyCose', () => hAuthenticator({ ...auth(), publicKeyCose: 'a+b' })],
    ['empty publicKeyCose', () => hAuthenticator({ ...auth(), publicKeyCose: '' })],
    ['empty credentialId', () => hAuthenticator({ ...auth(), credentialId: '' })],
    ['length 1 mod 4 (A)', () => hAuthenticator({ ...auth(), credentialId: 'A' })],
    ['length 1 mod 4 (AAAAA)', () => hAuthenticator({ ...auth(), credentialId: 'AAAAA' })],
    ['0 bulk ids', () => hBulkReject({ siteId: 'site_1', requestIds: [] })],
    ['501 bulk ids', () => hBulkReject({ siteId: 'site_1', requestIds: Array.from({ length: 501 }, (_, i) => `r${i}`) })],
    ['empty bulk id', () => hBulkReject({ siteId: 'site_1', requestIds: ['req_1', ''] })],
    ['duplicate bulk id', () => hBulkReject({ siteId: 'site_1', requestIds: ['req_1', 'req_1'] })],
    ['empty siteId', () => hBulkReject({ siteId: '', requestIds: ['req_1'] })],
    ['requestIds not an array', () => hBulkReject({ siteId: 'site_1', requestIds: 'req_1' as unknown as string[] })],
  ])('[T014-3] %s is invalid_value', (_name, fn) => {
    expect(reasonOf(fn)).toBe('invalid_value')
  })

  test('[T014-3] canonical base64url "AQ" is accepted and 500 bulk ids are accepted', () => {
    expect(hAuthenticator({ ...auth(), credentialId: 'AQ' })).toMatch(/^[0-9a-f]{64}$/)
    const ids = Array.from({ length: 500 }, (_, i) => `r${i}`)
    expect(hBulkReject({ siteId: 'site_1', requestIds: ids })).toMatch(/^[0-9a-f]{64}$/)
  })

  test('[T014-4] the registry gains sl:authenticator:v1 and sl:bulk_reject:v1', () => {
    expect(PREFIXES['sl:authenticator:v1']).toEqual(['owner_id', 'op', 'credential_id', 'public_key_cose'])
    expect(PREFIXES['sl:bulk_reject:v1']).toEqual(['site_id', 'request_ids'])
  })
})

describe('deriveChallenge vectors (spec 014 batch B)', () => {
  test('[T014-5] C-01 request.approve over one request target', () => {
    check(deriveChallenge, 'challenge.json', 'C-01')
  })

  test('[T014-6] C-02 bulk reject is target-order independent; one id fewer differs (ST-50)', () => {
    const a = check(deriveChallenge, 'challenge.json', 'C-02a')
    expect(check(deriveChallenge, 'challenge.json', 'C-02b')).toBe(a)
    expect(check(deriveChallenge, 'challenge.json', 'C-02c')).not.toBe(a)
  })

  test('[T014-7] C-03 site_config.update over one site target', () => {
    check(deriveChallenge, 'challenge.json', 'C-03')
  })

  test('[T014-8] C-04 ids sort by UTF-8 bytes; C-06 targets sort by type before id', () => {
    const c04 = vector<ChallengeInput>('challenge.json', 'C-04').input
    expect(c04.targets.map((t) => t.id)).toEqual([EMOJI, FI])
    check(deriveChallenge, 'challenge.json', 'C-04')
    const c06 = vector<ChallengeInput>('challenge.json', 'C-06').input
    expect(c06.targets.map((t) => t.type)).toEqual(['verdict', 'request'])
    check(deriveChallenge, 'challenge.json', 'C-06')
  })

  test('[T014-9] C-05 changing only the action, nonce or content hash changes the challenge', () => {
    const base = deriveChallenge(C01())
    for (const id of ['C-05a', 'C-05b', 'C-05c']) {
      expect(check(deriveChallenge, 'challenge.json', id)).not.toBe(base)
    }
  })

  test('[T014-10] webauthnChallenge is the unpadded base64url of the 32 digest bytes', () => {
    const v = vector('challenge.json', 'C-01')
    expect(webauthnChallenge(v.expected_hash as string)).toBe(v.expected_webauthn_challenge)
  })
})

describe('the action table and input validation (spec 014 batch C)', () => {
  test('[T014-11] each action maps to the DD1 prefix and target shape; the lists are frozen', () => {
    expect(STEPUP_ACTIONS).toEqual(Object.keys(TABLE))
    expect(TARGET_TYPES).toEqual(['request', 'site', 'verdict', 'owner', 'outbox'])
    expect(Object.isFrozen(STEPUP_ACTIONS)).toBe(true)
    expect(Object.isFrozen(TARGET_TYPES)).toBe(true)
    for (const action of STEPUP_ACTIONS) {
      const [prefix, shape] = TABLE[action]
      expect(contentHashPrefixFor(action), action).toBe(prefix)
      expect(targetShapeFor(action), action).toEqual(shape)
      expect(Object.hasOwn(PREFIXES, prefix), prefix).toBe(true)
    }
  })

  test.each(['flag.restore', 'toString', '__proto__', ''])('[T014-12] unknown action %j is invalid_value', (a) => {
    const action = a as StepupAction
    expect(reasonOf(() => contentHashPrefixFor(action))).toBe('invalid_value')
    expect(reasonOf(() => targetShapeFor(action))).toBe('invalid_value')
    expect(reasonOf(() => deriveChallenge({ ...C01(), action }))).toBe('invalid_value')
  })

  test.each([...Object.keys(TABLE)] as StepupAction[])('[T014-13] %s accepts its shape and rejects others', (action) => {
    const good = validTargets(action)
    expect(deriveChallenge({ ...C01(), action, targets: good })).toMatch(/^[0-9a-f]{64}$/)
    const wrongType: Target = { type: good[0]?.type === 'outbox' ? 'site' : 'outbox', id: 'x' }
    expect(reasonOf(() => deriveChallenge({ ...C01(), action, targets: [wrongType] }))).toBe('invalid_value')
    if (action !== 'requests.bulk_reject') {
      const extra = [...good, { type: good[0]?.type ?? 'request', id: 'extra' } as Target]
      expect(reasonOf(() => deriveChallenge({ ...C01(), action, targets: extra }))).toBe('invalid_value')
    }
  })

  test.each<[string, StepupAction, Target[]]>([
    ['hold.clear with two requests', 'hold.clear', [req('a'), req('b')]],
    ['hold.clear with two verdicts', 'hold.clear', [{ type: 'verdict', id: 'a' }, { type: 'verdict', id: 'b' }]],
    ['bulk reject with a site among requests', 'requests.bulk_reject', [req('a'), { type: 'site', id: 'b' }]],
  ])('[T014-13] %s is invalid_value', (_name, action, targets) => {
    expect(reasonOf(() => deriveChallenge({ ...C01(), action, targets }))).toBe('invalid_value')
  })

  test('[T014-13] hold.clear accepts a request and a verdict that share an id (duplicates are by type and id)', () => {
    const targets: Target[] = [req('x'), { type: 'verdict', id: 'x' }]
    expect(deriveChallenge({ ...C01(), action: 'hold.clear', targets })).toMatch(/^[0-9a-f]{64}$/)
  })

  test('[T014-13] hold.clear needs both targets; bulk reject takes 1..500 request targets', () => {
    expect(reasonOf(() => deriveChallenge({ ...C01(), action: 'hold.clear', targets: [req('r')] }))).toBe('invalid_value')
    const bulk = (n: number): ChallengeInput => ({
      ...C01(), action: 'requests.bulk_reject', targets: Array.from({ length: n }, (_, i) => req(`r${i}`)),
    })
    expect(reasonOf(() => deriveChallenge(bulk(0)))).toBe('invalid_value')
    expect(reasonOf(() => deriveChallenge(bulk(501)))).toBe('invalid_value')
    expect(deriveChallenge(bulk(500))).toMatch(/^[0-9a-f]{64}$/)
    expect(deriveChallenge(bulk(1))).toMatch(/^[0-9a-f]{64}$/)
  })

  test.each<[string, Partial<ChallengeInput>]>([
    ['31-char nonce', { nonce: 'a'.repeat(31) }],
    ['33-char nonce', { nonce: 'a'.repeat(33) }],
    ['uppercase nonce', { nonce: 'A'.repeat(32) }],
    ['non-hex nonce', { nonce: 'g'.repeat(32) }],
    ['63-char content hash', { contentHash: 'a'.repeat(63) }],
    ['uppercase content hash', { contentHash: 'A'.repeat(64) }],
    ['65-char content hash', { contentHash: 'a'.repeat(65) }],
    ['non-hex content hash', { contentHash: 'g'.repeat(64) }],
    ['non-string target id', { targets: [{ type: 'request', id: 1 as unknown as string }] }],
    ['null target', { targets: [null as unknown as Target] }],
    ['unknown target type', { targets: [{ type: 'user' as Target['type'], id: 'u' }] }],
    ['empty target id', { targets: [req('')] }],
    ['targets not an array', { targets: 'req_1' as unknown as Target[] }],
    ['duplicate target pair', { action: 'requests.bulk_reject', targets: [req('a'), req('a')] }],
  ])('[T014-14] %s is invalid_value', (_name, override) => {
    expect(reasonOf(() => deriveChallenge({ ...C01(), ...override }))).toBe('invalid_value')
  })

  test('[T014-14] a lone surrogate id is invalid_utf8; extra target keys do not change the hash', () => {
    expect(reasonOf(() => deriveChallenge({ ...C01(), targets: [req(`a${LONE}`)] }))).toBe('invalid_utf8')
    const extra = { ...req('req_1'), label: 'shown in the dashboard' } as Target
    expect(deriveChallenge({ ...C01(), targets: [extra] })).toBe(vector('challenge.json', 'C-01').expected_hash)
  })

  test.each(['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ''])('[T014-14] webauthnChallenge(%j) is invalid_value', (h) => {
    expect(reasonOf(() => webauthnChallenge(h))).toBe('invalid_value')
  })
})
