// Canonical unpadded base64url (RFC 4648 §5, spec 014 DD8). One byte string has exactly one
// encoding: no padding, length % 4 !== 1, and unused trailing bits are zero, so "AQ" decodes
// and "AQ==" and "AR" don't. Lenient decoders would let two strings name one key.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const VALUE = new Map([...ALPHABET].map((c, i) => [c, i]))
const SHAPE = /^[A-Za-z0-9_-]*$/

export function isCanonicalBase64url(s: unknown): s is string {
  if (typeof s !== 'string' || !SHAPE.test(s) || s.length % 4 === 1) return false
  const tail = s.length % 4
  if (tail === 0) return true
  const last = VALUE.get(s[s.length - 1] as string) as number
  return (last & (tail === 2 ? 0x0f : 0x03)) === 0
}

/** Decodes canonical base64url; throws TypeError on anything else. */
export function decodeBase64url(s: string): Uint8Array {
  if (!isCanonicalBase64url(s)) throw new TypeError('not canonical base64url')
  const out = new Uint8Array(Math.floor((s.length * 6) / 8))
  let bits = 0
  let acc = 0
  let n = 0
  for (const c of s) {
    acc = ((acc << 6) | (VALUE.get(c) as number)) & 0x3fff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[n++] = (acc >> bits) & 0xff
    }
  }
  return out
}

export function encodeBase64url(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let acc = 0
  for (const b of bytes) {
    acc = ((acc << 8) | b) & 0xffff
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += ALPHABET[(acc >> bits) & 0x3f]
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (6 - bits)) & 0x3f]
  return out
}
