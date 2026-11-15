// Byte framing under every sl:*:v1 content hash (RFC 04 §3.2). Pure functions; no Node
// builtins, because the dashboard runs this same code in the browser.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { SchemaError } from '../errors.ts'
import { assertWellFormed } from '../utf8.ts'

export type Prefix = `sl:${string}:v${number}`

const PREFIX_SHAPE = /^sl:[a-z][a-z0-9_]*:v[1-9][0-9]*$/
const encoder = new TextEncoder()

/** LP(x) = uint32_be(len(utf8(x))) || utf8(x) */
export function lp(x: string): Uint8Array {
  assertWellFormed(x)
  const bytes = encoder.encode(x)
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length)
  out.set(bytes, 4)
  return out
}

/** LP(prefix) || LP(f1) || ... || LP(fn): the SHA-256 preimage. */
export function frame(prefix: Prefix, fields: readonly string[]): Uint8Array {
  if (!PREFIX_SHAPE.test(prefix)) throw new SchemaError('invalid_prefix', `malformed prefix ${JSON.stringify(prefix)}`)
  return concatBytes(lp(prefix), ...fields.map(lp))
}

/** H(p; f1..fn) as 64 lowercase hex characters. */
export function hashFields(prefix: Prefix, fields: readonly string[]): string {
  return bytesToHex(sha256(frame(prefix, fields)))
}

/**
 * UTF-8 byte order (Postel D-M1). UTF-8 preserves code point order, so this compares code
 * points; it never uses `<` on JS strings (UTF-16 order) or localeCompare.
 */
export function compareUtf8(a: string, b: string): number {
  let i = 0
  while (i < a.length && i < b.length) {
    const ca = a.codePointAt(i) as number
    const cb = b.codePointAt(i) as number
    if (ca !== cb) return ca < cb ? -1 : 1
    i += ca > 0xffff ? 2 : 1
  }
  return Math.sign(a.length - b.length)
}

export function byteSort(xs: readonly string[]): string[] {
  for (const x of xs) assertWellFormed(x)
  return [...xs].sort(compareUtf8)
}

export function sortedUnique(xs: readonly string[]): string[] {
  return byteSort(xs).filter((x, i, sorted) => i === 0 || x !== sorted[i - 1])
}

/** P(path) (RFC 04 §3.2): repo-relative POSIX path, NFC, no `.`/empty segments, case kept. */
export function P(path: string): string {
  assertWellFormed(path)
  // `\` is a legal POSIX filename byte; converting it would make two real paths collide.
  // The CLI converts native separators before calling P.
  if (path.includes('\\') || path.includes('\u0000')) {
    throw new SchemaError('path_invalid', 'path contains a backslash or NUL')
  }
  const nfc = path.normalize('NFC')
  if (nfc.startsWith('/')) throw new SchemaError('path_absolute', 'path is absolute')
  const segments = nfc.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) throw new SchemaError('path_traversal', 'path has a ".." segment')
  if (segments.length === 0) throw new SchemaError('path_empty', 'path is empty')
  return segments.join('/')
}
