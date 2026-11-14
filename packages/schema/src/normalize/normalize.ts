// N_intake and N_hash (RFC 04 §3.1, Postel D-M2). N_intake runs on the server at submission;
// N_hash runs wherever a hash is recomputed and never checks assignment, so an older verifier
// never rejects text a newer server accepted.
import { SchemaError } from '../errors.ts'
import { assertWellFormed } from '../utf8.ts'
import { ASSIGNED_RANGES } from './unicode-15.1-assigned.ts'

export const UNICODE_VERSION = '15.1'

export interface StrippedRecord {
  codePoint: number
  /** Code-point offset in the decoded input, as received (before NFC). */
  index: number
}

export interface IntakeResult {
  value: string
  stripped: StrippedRecord[]
}

// Step 4's strip set, exactly as listed in the RFC.
const STRIP_RANGES: readonly (readonly [number, number])[] = [
  [0xe0000, 0xe007f], [0x200b, 0x200d], [0x2060, 0x2060], [0xfeff, 0xfeff],
  [0x202a, 0x202e], [0x2066, 0x2069], [0x200e, 0x200f],
]

// Unicode White_Space, as an explicit list so the runtime's `\s` never decides.
const WHITE_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
])

// ignoreBOM keeps a leading BOM so step 4 records and strips it like any other U+FEFF.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function isAssigned(cp: number): boolean {
  if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) return false
  let lo = 0
  let hi = ASSIGNED_RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [start, end] = ASSIGNED_RANGES[mid] as readonly [number, number]
    if (cp < start) hi = mid - 1
    else if (cp > end) lo = mid + 1
    else return true
  }
  return false
}

export function nIntake(field: string | Uint8Array, cap: number): IntakeResult {
  assertCap(cap)
  const text = decode(field)
  const stripped: StrippedRecord[] = []
  let index = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number
    if (!isAssigned(cp)) {
      throw new SchemaError('unassigned_code_point', `U+${cp.toString(16).toUpperCase()} is unassigned in Unicode 15.1`)
    }
    // No strip-set character decomposes or composes, so the raw input holds exactly the
    // characters step 4 removes after NFC.
    if (isStripped(cp)) stripped.push({ codePoint: cp, index })
    index++
  }
  return { value: enforceCap(normalize(text), cap), stripped }
}

export function nHash(field: string | Uint8Array, cap?: number): string {
  if (cap !== undefined) assertCap(cap)
  const value = normalize(decode(field))
  return cap === undefined ? value : enforceCap(value, cap)
}

function decode(field: string | Uint8Array): string {
  if (typeof field === 'string') {
    assertWellFormed(field)
    return field
  }
  try {
    return decoder.decode(field)
  } catch {
    throw new SchemaError('invalid_utf8', 'field is not valid UTF-8')
  }
}

/** Steps 3, 4, 4b and 5. */
function normalize(text: string): string {
  let kept = ''
  for (const ch of text.normalize('NFC')) {
    if (!isStripped(ch.codePointAt(0) as number)) kept += ch
  }
  // Step 4b (not in the RFC): a stripped character can block composition, so NFC runs again
  // to keep nHash(nIntake(x).value) === nIntake(x).value.
  const lines = kept.normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
  return trim(lines.map(trimEnd).join('\n'))
}

function isStripped(cp: number): boolean {
  return STRIP_RANGES.some(([start, end]) => cp >= start && cp <= end)
}

// Every White_Space character is in the BMP, so UTF-16 indexing is safe here.
function trimEnd(s: string): string {
  let end = s.length
  while (end > 0 && WHITE_SPACE.has(s.charCodeAt(end - 1))) end--
  return s.slice(0, end)
}

function trim(s: string): string {
  let start = 0
  while (start < s.length && WHITE_SPACE.has(s.charCodeAt(start))) start++
  return trimEnd(s.slice(start))
}

function assertCap(cap: number): void {
  if (!Number.isSafeInteger(cap) || cap < 0) throw new TypeError(`cap must be a non-negative safe integer, got ${cap}`)
}

/** Step 6: the cap counts code points of the normalized value. */
function enforceCap(value: string, cap: number): string {
  if ([...value].length > cap) throw new SchemaError('too_long', `field exceeds ${cap} code points`)
  return value
}
