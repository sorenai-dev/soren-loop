import { randomBytes } from 'node:crypto'

// RFC 04 intro, plus `rqr` (requesters) and `fam` (CLI token families), which the RFC uses
// without naming a prefix. IDs carry 128 random bits and are never sequential (SR-12, AB6).
export const ID_PREFIXES = Object.freeze([
  'req', 'ref', 'rev', 'spec', 'apr', 'pck', 'clr', 'fb', 'q', 'sl', 'tok', 'run', 'dep', 'obx',
  'site', 'own', 'trc', 'rqr', 'fam',
] as const)

export type IdPrefix = (typeof ID_PREFIXES)[number]

export const ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

const ID_BYTES = 16
const BODY_LENGTH = 22 // 62^22 > 2^128, so every 128-bit value fits in a fixed width
const MAX = 2n ** 128n
const PREFIX_SET: ReadonlySet<string> = new Set(ID_PREFIXES)
const BODY = /^[0-9A-Za-z]{22}$/

function assertPrefix(prefix: string): void {
  if (!PREFIX_SET.has(prefix)) throw new TypeError(`unregistered ID prefix: ${prefix}`)
}

export function encodeId(prefix: IdPrefix, bytes: Uint8Array): string {
  assertPrefix(prefix)
  if (bytes.length !== ID_BYTES) throw new TypeError(`an ID needs ${ID_BYTES} bytes, got ${bytes.length}`)
  let n = 0n
  for (const byte of bytes) n = (n << 8n) | BigInt(byte)
  let body = ''
  while (n > 0n) {
    body = ID_ALPHABET[Number(n % 62n)] + body
    n /= 62n
  }
  return `${prefix}_${body.padStart(BODY_LENGTH, '0')}`
}

export function newId(prefix: IdPrefix): string {
  return encodeId(prefix, randomBytes(ID_BYTES))
}

export function isId(prefix: IdPrefix, value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(`${prefix}_`)) return false
  const body = value.slice(prefix.length + 1)
  if (!BODY.test(body)) return false
  let n = 0n
  for (const ch of body) n = n * 62n + BigInt(ID_ALPHABET.indexOf(ch))
  return n < MAX
}
