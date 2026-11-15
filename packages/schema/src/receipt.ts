// Offline approval-receipt verification (spec 015, RFC 17 §1, SR-19). The CLI runs this before
// plan, build, rework and hold-laundering checks. Everything that says *what* was approved comes
// from the caller's local recomputation; the server supplies only the nonce and signed bytes.
// Exported from the `./receipt` subpath only: the WebAuthn helpers are CLI-side weight.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { parseAuthenticatorData, verifySignature } from '@simplewebauthn/server/helpers'
import { decodeBase64url, isCanonicalBase64url } from './base64url.ts'
import { hAuthenticator } from './hash/content.ts'
import { deriveChallenge, webauthnChallenge } from './stepup.ts'
import type { StepupAction, Target } from './stepup.ts'

export interface PinnedKey { credentialId: string; publicKeyCose: string }
export interface PinSet { ownerId: string; keys: readonly PinnedKey[]; origin: string; rpId: string }
export interface Receipt {
  credentialId: string
  nonce: string
  authenticatorData: string
  clientDataJSON: string
  signature: string
}
export type ReceiptFailure =
  | 'malformed' | 'challenge_mismatch' | 'wrong_type' | 'wrong_origin' | 'wrong_rp_id_hash'
  | 'uv_not_set' | 'unpinned_key' | 'bad_signature' | 'key_added_without_receipt' | 'key_conflict'
export type ReceiptResult = { ok: true } | { ok: false; reason: ReceiptFailure }
export type GrowResult =
  | { ok: true; pin: PinSet }
  | { ok: false; reason: 'key_added_without_receipt' | 'key_conflict'; cause?: ReceiptFailure }
export interface VerifyOptions {
  receipt: Receipt
  expectedContentHash: string
  action: StepupAction
  targets: readonly Target[]
  pin: PinSet
}

const NONCE = /^[0-9a-f]{32}$/
const UNUSED_NONCE = '0'.repeat(32)
const utf8 = new TextDecoder('utf-8', { fatal: true })
const fail = (reason: ReceiptFailure): ReceiptResult => ({ ok: false, reason })

interface Decoded {
  authData: Uint8Array<ArrayBuffer>
  clientBytes: Uint8Array<ArrayBuffer>
  signature: Uint8Array<ArrayBuffer>
  client: { type: string; challenge: string; origin: string; crossOrigin?: unknown }
  rpIdHash: Uint8Array
  uv: boolean
}

const isKey = (s: unknown): s is string => isCanonicalBase64url(s) && s !== ''

/** Step (a): strict decoding of server-supplied data; null means malformed. */
function decode(r: Receipt): Decoded | null {
  try {
    if (typeof r.nonce !== 'string' || !NONCE.test(r.nonce) || !isKey(r.credentialId)) return null
    const authData = decodeBase64url(r.authenticatorData)
    const clientBytes = decodeBase64url(r.clientDataJSON)
    const signature = decodeBase64url(r.signature)
    if (authData.length < 37) return null
    const client: unknown = JSON.parse(utf8.decode(clientBytes))
    if (typeof client !== 'object' || client === null || Array.isArray(client)) return null
    const c = client as Record<string, unknown>
    if (typeof c.type !== 'string' || typeof c.challenge !== 'string' || typeof c.origin !== 'string') return null
    const parsed = parseAuthenticatorData(authData)
    return {
      authData, clientBytes, signature, rpIdHash: parsed.rpIdHash, uv: parsed.flags.uv,
      client: { type: c.type, challenge: c.challenge, origin: c.origin, crossOrigin: c.crossOrigin },
    }
  } catch {
    return null
  }
}

/** Verifies one receipt in RFC 17 §1 order; the first failing step is the reason (DD1). */
export async function verifyReceipt(opts: VerifyOptions): Promise<ReceiptResult> {
  const { receipt, pin } = opts
  const local = { action: opts.action, targets: opts.targets, contentHash: opts.expectedContentHash }
  // (0) Local inputs first: a caller bug throws instead of hiding behind `malformed`.
  deriveChallenge({ ...local, nonce: UNUSED_NONCE })
  const d = decode(receipt)
  if (d === null) return fail('malformed')
  if (d.client.challenge !== webauthnChallenge(deriveChallenge({ ...local, nonce: receipt.nonce }))) {
    return fail('challenge_mismatch')
  }
  if (d.client.type !== 'webauthn.get') return fail('wrong_type')
  if (d.client.origin !== pin.origin || d.client.crossOrigin === true) return fail('wrong_origin')
  if (bytesToHex(d.rpIdHash) !== bytesToHex(sha256(utf8ToBytes(pin.rpId)))) return fail('wrong_rp_id_hash')
  if (!d.uv) return fail('uv_not_set')
  const key = pin.keys.find((k) => k.credentialId === receipt.credentialId)
  if (key === undefined) return fail('unpinned_key')
  try {
    const ok = await verifySignature({
      signature: d.signature,
      // The helper's types want an ArrayBuffer-backed array; concatBytes is typed more loosely.
      data: new Uint8Array(concatBytes(d.authData, sha256(d.clientBytes))),
      credentialPublicKey: decodeBase64url(key.publicKeyCose),
    })
    return ok ? { ok: true } : fail('bad_signature')
  } catch {
    return fail('bad_signature')
  }
}

/** Adds a key only on an authenticator.add receipt signed by an already-pinned key (DD4). */
export async function growPinSet(pin: PinSet, add: { key: PinnedKey; receipt?: Receipt }): Promise<GrowResult> {
  const { key } = add
  if (!isKey(key?.credentialId) || !isKey(key.publicKeyCose)) {
    return { ok: false, reason: 'key_added_without_receipt', cause: 'malformed' }
  }
  const pinned = pin.keys.find((k) => k.credentialId === key.credentialId)
  if (pinned !== undefined) {
    return pinned.publicKeyCose === key.publicKeyCose ? { ok: true, pin } : { ok: false, reason: 'key_conflict' }
  }
  if (add.receipt === undefined) return { ok: false, reason: 'key_added_without_receipt' }
  const fresh = { credentialId: key.credentialId, publicKeyCose: key.publicKeyCose }
  const result = await verifyReceipt({
    receipt: add.receipt,
    expectedContentHash: hAuthenticator({ ownerId: pin.ownerId, op: 'add', ...fresh }),
    action: 'authenticator.add',
    targets: [{ type: 'owner', id: pin.ownerId }],
    pin,
  })
  if (!result.ok) return { ok: false, reason: 'key_added_without_receipt', cause: result.reason }
  return { ok: true, pin: Object.freeze({ ...pin, keys: Object.freeze([...pin.keys, Object.freeze(fresh)]) }) }
}
