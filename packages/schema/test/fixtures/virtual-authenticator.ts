// A fixed virtual authenticator for receipt tests (spec 015). TEST-ONLY: these private scalars
// are public fixtures, never secrets, and never pinned by a real deployment. The values are the
// ones test-vectors/tools/challenge_oracle.py prints, so receipts signed here verify against the
// same pin set as test-vectors/receipt.json.
import { createHash, createPrivateKey, sign } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { PinSet, PinnedKey, Receipt } from '../../src/receipt.ts'

export const ORIGIN = 'https://loop.example.test'
export const RP_ID = 'loop.example.test'
export const OWNER_ID = 'owner_1'

export interface VirtualKey {
  d: string
  x: string
  y: string
  pinned: PinnedKey
}

export const KEY_A: VirtualKey = {
  d: '67b4a2aadd19e909361351e19c6d60767e8a9fbe9ba4712e1a383a514d98349c',
  x: '79737b664b9bdfce19b991165360aa1da60e7d51bb0be86062872e925d586dc0',
  y: '4cca84186e2a07b0328bfbd61c3c08b6b9c9394d52e8d6b408b0687db6547288',
  pinned: {
    credentialId: 'YNFMKYaO--85UG9rE2jT0A',
    publicKeyCose: 'pQECAyYgASFYIHlze2ZLm9_OGbmRFlNgqh2mDn1RuwvoYGKHLpJdWG3AIlggTMqEGG4qB7Ayi_vWHDwItrnJOU1S6Na0CLBofbZUcog',
  },
}

export const KEY_B: VirtualKey = {
  d: 'c81501d9b76717fa051c801d9ab14a554353665e2e1880977eeaf9c759a8a450',
  x: 'd8a2d54fa4d682c5b83d5497d5833921064b614aea0a60c0f7a9eef458b121a1',
  y: '709aca278aa4a28da962e7f556912cab9f8188cb896d922af879e63cd171e1e1',
  pinned: {
    credentialId: 'd4gmPTjSXQ5JWT0XUKGW-A',
    publicKeyCose: 'pQECAyYgASFYINii1U-k1oLFuD1Ul9WDOSEGS2FK6gpgwPep7vRYsSGhIlggcJrKJ4qkoo2pYuf1VpEsq5-BiMuJbZIq-HnmPNFx4eE',
  },
}

/** The pin set a CLI holds after `login` with key A. */
export const PIN: PinSet = Object.freeze({ ownerId: OWNER_ID, keys: Object.freeze([KEY_A.pinned]), origin: ORIGIN, rpId: RP_ID })

const b64u = (hex: string): string => Buffer.from(hex, 'hex').toString('base64url')

function privateKey(key: VirtualKey): KeyObject {
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(key.d), x: b64u(key.x), y: b64u(key.y) },
    format: 'jwk',
  })
}

export interface AssertionOptions {
  key: VirtualKey
  challengeHex: string
  nonce: string
  origin?: string
  rpId?: string
  /** authenticatorData flags byte; 0x05 = UP | UV. */
  flags?: number
  type?: string
}

/** Signs a WebAuthn get assertion the way a browser and authenticator would. */
export function signAssertion(o: AssertionOptions): Receipt {
  const challenge = Buffer.from(o.challengeHex, 'hex').toString('base64url')
  const clientData = Buffer.from(JSON.stringify({
    type: o.type ?? 'webauthn.get', challenge, origin: o.origin ?? ORIGIN, crossOrigin: false,
  }), 'utf8')
  const rpIdHash = createHash('sha256').update(o.rpId ?? RP_ID, 'utf8').digest()
  const authData = Buffer.concat([rpIdHash, Buffer.from([o.flags ?? 0x05, 0, 0, 0, 1])])
  const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()])
  const signature = sign('sha256', signed, { key: privateKey(o.key), dsaEncoding: 'der' })
  return {
    credentialId: o.key.pinned.credentialId,
    nonce: o.nonce,
    authenticatorData: authData.toString('base64url'),
    clientDataJSON: clientData.toString('base64url'),
    signature: signature.toString('base64url'),
  }
}
