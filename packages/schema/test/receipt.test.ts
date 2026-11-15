import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import * as root from '../src/index.ts'
import { SchemaError, deriveChallenge, hAuthenticator } from '../src/index.ts'
import type { StepupAction, Target } from '../src/index.ts'
import { growPinSet, verifyReceipt } from '../src/receipt.ts'
import type { PinSet, PinnedKey, Receipt } from '../src/receipt.ts'
import { KEY_A, KEY_B, PIN, signAssertion } from './fixtures/virtual-authenticator.ts'
import { loadVectors, vector } from './helpers/vectors.ts'

interface VerifyInput {
  receipt: Receipt
  expectedContentHash: string
  action: StepupAction
  targets: Target[]
  pin: PinSet
}
interface GrowInput { pin: PinSet; add: { key: PinnedKey; receipt?: Receipt } }

const verifyVector = (id: string) => vector<VerifyInput>('receipt.json', id)
const growVector = (id: string) => vector<GrowInput>('receipt.json', id)

/** Runs verifyReceipt on a vector and returns the result for comparison with expected_result. */
async function runVerify(id: string, override: Partial<VerifyInput> = {}) {
  const v = verifyVector(id)
  return verifyReceipt({ ...v.input, ...override })
}

const R01 = (): VerifyInput => verifyVector('R-01').input
const b64uToBytes = (s: string): Buffer => Buffer.from(s, 'base64url')
const bytesToB64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url')

describe('every receipt.json vector (spec 015 DD8)', () => {
  test.each(loadVectors('receipt.json').map((v) => [v.id, v] as const))('[T015-16] %s gives expected_result', async (_id, v) => {
    const input: unknown = v.input
    const result = v.fn === 'growPinSet'
      ? await growPinSet((input as GrowInput).pin, (input as GrowInput).add)
      : await verifyReceipt(input as VerifyInput)
    expect(result).toEqual(v.expected_result)
  })
})

describe('valid receipts (spec 015 batch A)', () => {
  test('[T015-1] R-01 verifies offline; R-01h with the other s also verifies', async () => {
    expect(await runVerify('R-01')).toEqual({ ok: true })
    expect(verifyVector('R-01h').input.receipt.signature).not.toBe(R01().receipt.signature)
    expect(await runVerify('R-01h')).toEqual({ ok: true })
  })

  test('[T015-2] a fixture-signed receipt round-trips; a stored challenge field is ignored', async () => {
    const input = R01()
    const challengeHex = deriveChallenge({
      action: input.action, targets: input.targets, contentHash: input.expectedContentHash, nonce: input.receipt.nonce,
    })
    const receipt = signAssertion({ key: KEY_A, challengeHex, nonce: input.receipt.nonce })
    expect(await verifyReceipt({ ...input, receipt })).toEqual({ ok: true })
    const lying = {
      ...receipt, challenge: 'f'.repeat(64), action: 'spec.approve', contentHash: '0'.repeat(64), content_hash: '0'.repeat(64),
    } as Receipt
    expect(await verifyReceipt({ ...input, receipt: lying })).toEqual({ ok: true })
  })
})

describe('clientData checks (spec 015 batch B)', () => {
  test.each(['R-02', 'R-02x', 'R-02p'])('[T015-3] ST-63 %s wrong, cross or prefix-only origin is wrong_origin', async (id) => {
    expect(await runVerify(id)).toEqual(verifyVector(id).expected_result)
    expect(verifyVector(id).expected_result).toEqual({ ok: false, reason: 'wrong_origin' })
  })

  test.each(['R-07a', 'R-07b', 'R-07c'])('[T015-4] ST-63 ST-50 %s is challenge_mismatch', async (id) => {
    expect(await runVerify(id)).toEqual({ ok: false, reason: 'challenge_mismatch' })
  })

  test('[T015-5] ST-63 R-09 webauthn.create is wrong_type', async () => {
    expect(await runVerify('R-09')).toEqual({ ok: false, reason: 'wrong_type' })
  })

  test('[T015-16] R-10 with two defects reports the first failing step (origin before UV)', async () => {
    expect(await runVerify('R-10')).toEqual({ ok: false, reason: 'wrong_origin' })
  })
})

describe('authenticatorData, key and signature (spec 015 batch C)', () => {
  test('[T015-6] ST-63 R-03 another RP ID hash is wrong_rp_id_hash', async () => {
    expect(await runVerify('R-03')).toEqual({ ok: false, reason: 'wrong_rp_id_hash' })
  })

  test('[T015-7] ST-63 R-04 UV clear is uv_not_set', async () => {
    expect(await runVerify('R-04')).toEqual({ ok: false, reason: 'uv_not_set' })
  })

  test('[T015-8] ST-63 R-05 a receipt signed by unpinned key B is unpinned_key', async () => {
    expect(await runVerify('R-05')).toEqual({ ok: false, reason: 'unpinned_key' })
  })

  test('[T015-9] ST-63 R-08 a flipped signature byte is bad_signature', async () => {
    expect(await runVerify('R-08')).toEqual({ ok: false, reason: 'bad_signature' })
  })

  test('[T015-9] a pinned key the helper cannot use resolves to bad_signature, never rejects', async () => {
    const input = R01()
    const pin = { ...input.pin, keys: [{ ...KEY_A.pinned, publicKeyCose: bytesToB64u(new Uint8Array([0xa0])) }] }
    await expect(verifyReceipt({ ...input, pin })).resolves.toEqual({ ok: false, reason: 'bad_signature' })
  })
})

describe('pin-set growth (spec 015 batch D)', () => {
  test('[T015-10] ST-63 R-06a add receipt signed by B, and R-06b no receipt, are key_added_without_receipt', async () => {
    const a = growVector('R-06a')
    expect(await growPinSet(a.input.pin, a.input.add)).toEqual({ ok: false, reason: 'key_added_without_receipt', cause: 'unpinned_key' })
    const b = growVector('R-06b')
    expect(await growPinSet(b.input.pin, b.input.add)).toEqual({ ok: false, reason: 'key_added_without_receipt' })
  })

  test('[T015-11] ST-63 R-06c a receipt from pinned A grows the set; R-06d B then verifies', async () => {
    const c = growVector('R-06c')
    const before = structuredClone(c.input.pin)
    const grown = await growPinSet(c.input.pin, c.input.add)
    expect(grown).toEqual(c.expected_result)
    expect(c.input.pin).toEqual(before)
    const pin = (grown as { pin: PinSet }).pin
    expect(pin).not.toBe(c.input.pin)
    expect(Object.isFrozen(pin)).toBe(true)
    expect(Object.isFrozen(pin.keys)).toBe(true)
    expect(c.expected_add_hash).toBe(hAuthenticator({ ownerId: PIN.ownerId, op: 'add', ...KEY_B.pinned }))
    expect(await runVerify('R-06d')).toEqual({ ok: true })
  })

  test('[T015-12] re-adding A returns the same pin set; a conflicting key is key_conflict', async () => {
    expect(await growPinSet(PIN, { key: KEY_A.pinned })).toEqual({ ok: true, pin: PIN })
    expect((await growPinSet(PIN, { key: KEY_A.pinned }) as { pin: PinSet }).pin).toBe(PIN)
    const conflict = { credentialId: KEY_A.pinned.credentialId, publicKeyCose: KEY_B.pinned.publicKeyCose }
    expect(await growPinSet(PIN, { key: conflict })).toEqual({ ok: false, reason: 'key_conflict' })
  })

  test.each<[string, PinnedKey]>([
    ['padded credentialId', { ...KEY_B.pinned, credentialId: `${KEY_B.pinned.credentialId}==` }],
    ['padded publicKeyCose', { ...KEY_B.pinned, publicKeyCose: `${KEY_B.pinned.publicKeyCose}=` }],
    ['empty credentialId', { ...KEY_B.pinned, credentialId: '' }],
    ['empty publicKeyCose', { ...KEY_B.pinned, publicKeyCose: '' }],
  ])('[T015-12] a server-supplied key with %s is key_added_without_receipt, cause malformed', async (_name, key) => {
    expect(await growPinSet(PIN, { key })).toEqual({ ok: false, reason: 'key_added_without_receipt', cause: 'malformed' })
  })

  test('[T015-11] growPinSet binds the pinned ownerId, never one carried by the receipt', async () => {
    const pin: PinSet = { ...PIN, ownerId: 'owner_2' }
    const key = KEY_B.pinned
    const nonce = '1'.repeat(32)
    const challengeHex = deriveChallenge({
      action: 'authenticator.add', targets: [{ type: 'owner', id: 'owner_2' }],
      contentHash: hAuthenticator({ ownerId: 'owner_2', op: 'add', ...key }), nonce,
    })
    const receipt = { ...signAssertion({ key: KEY_A, challengeHex, nonce }), ownerId: 'owner_1' } as Receipt
    expect((await growPinSet(pin, { key, receipt })).ok).toBe(true)
    expect(await growPinSet(PIN, { key, receipt })).toEqual({ ok: false, reason: 'key_added_without_receipt', cause: 'challenge_mismatch' })
  })
})

describe('robustness (spec 015 batch E)', () => {
  const clientWith = (json: string): string => Buffer.from(json, 'utf8').toString('base64url')
  test.each<[string, (r: Receipt) => Receipt]>([
    ['padded signature', (r) => ({ ...r, signature: `${r.signature}=` })],
    ['non-alphabet authenticatorData', (r) => ({ ...r, authenticatorData: `${r.authenticatorData.slice(1)}+` })],
    ['authenticatorData under 37 bytes', (r) => ({ ...r, authenticatorData: bytesToB64u(b64uToBytes(r.authenticatorData).subarray(0, 36)) })],
    ['non-JSON clientDataJSON', (r) => ({ ...r, clientDataJSON: clientWith('not json') })],
    ['clientDataJSON not an object', (r) => ({ ...r, clientDataJSON: clientWith('["webauthn.get"]') })],
    ['clientData challenge not a string', (r) => ({ ...r, clientDataJSON: clientWith('{"type":"webauthn.get","challenge":1,"origin":"https://loop.example.test"}') })],
    ['invalid UTF-8 inside a JSON string in clientDataJSON', (r) => {
      const json = b64uToBytes(r.clientDataJSON)
      const bad = Buffer.concat([json.subarray(0, json.length - 1), Buffer.from(',"x":"'), Buffer.from([0xff]), Buffer.from('"}')])
      return { ...r, clientDataJSON: bytesToB64u(bad) }
    }],
    ['31-hex nonce', (r) => ({ ...r, nonce: r.nonce.slice(1) })],
    ['uppercase nonce', (r) => ({ ...r, nonce: r.nonce.toUpperCase() })],
    ['clientData without type', (r) => ({ ...r, clientDataJSON: clientWith('{"challenge":"x","origin":"https://loop.example.test"}') })],
    ['clientData without origin', (r) => ({ ...r, clientDataJSON: clientWith('{"type":"webauthn.get","challenge":"x"}') })],
    ['non-canonical credentialId', (r) => ({ ...r, credentialId: `${r.credentialId}=` })],
  ])('[T015-13] %s resolves to malformed', async (_name, mutate) => {
    const input = R01()
    await expect(verifyReceipt({ ...input, receipt: mutate(input.receipt) })).resolves.toEqual({ ok: false, reason: 'malformed' })
  })

  // Non-canonical forms that a lenient decoder would map to the same bytes.
  const bumpTail = (s: string): string => s.slice(0, -1) + String.fromCharCode(s.charCodeAt(s.length - 1) + 1)
  type Blob = 'authenticatorData' | 'clientDataJSON' | 'signature'
  test.each<Blob>(['authenticatorData', 'clientDataJSON', 'signature'])('[T015-13] non-canonical %s is malformed', async (field) => {
    const input = R01()
    const value = input.receipt[field]
    const forms = [`${value}=`, ...(value.length % 4 === 0 ? [] : [bumpTail(value)])]
    for (const form of forms) {
      expect(b64uToBytes(form).equals(b64uToBytes(value)), form).toBe(true)
      expect(await verifyReceipt({ ...input, receipt: { ...input.receipt, [field]: form } })).toEqual({ ok: false, reason: 'malformed' })
    }
  })

  const malformed = (r: Receipt): Receipt => ({ ...r, signature: `${r.signature}=` })
  test.each<[string, Partial<VerifyInput>]>([
    ['unknown action', { action: 'flag.restore' as StepupAction }],
    ['a target of the wrong type', { targets: [{ type: 'site', id: 'site_1' }] }],
    ['a bad expectedContentHash', { expectedContentHash: 'A'.repeat(64) }],
  ])('[T015-14] %s rejects with invalid_value, with a valid or a malformed receipt', async (_name, override) => {
    for (const receipt of [R01().receipt, malformed(R01().receipt)]) {
      const err = await verifyReceipt({ ...R01(), receipt, ...override }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SchemaError)
      expect((err as SchemaError).reason).toBe('invalid_value')
    }
  })

  test('[T015-15] only receipt.ts imports the WebAuthn helpers, and nothing in src imports receipt.ts', () => {
    expect(Object.keys(root)).not.toContain('verifyReceipt')
    expect(Object.keys(root)).not.toContain('growPinSet')
    const dir = new URL('../src/', import.meta.url)
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'))
    for (const f of files.filter((name) => name !== 'receipt.ts')) {
      const source = readFileSync(new URL(f, dir), 'utf8')
      expect(source, f).not.toMatch(/@simplewebauthn|receipt\.ts/)
    }
  })

  test('[T015-15] package.json exports ./receipt and ./testing/virtual-authenticator', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> }
    expect(pkg.exports['./receipt']).toBe('./src/receipt.ts')
    expect(pkg.exports['./testing/virtual-authenticator']).toBe('./test/fixtures/virtual-authenticator.ts')
  })
})
