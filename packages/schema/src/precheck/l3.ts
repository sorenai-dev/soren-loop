// L3: the deterministic, model-free pre-check layer (spec 017, RFC 06 §4, SR-26c). Block-only:
// a hit can hold a request, never approve or soften anything. Shared by PC-S and PC-A/B.
import { SchemaError } from '../errors.ts'
import { compareUtf8 } from '../hash/framing.ts'
import { nHash } from '../normalize/normalize.ts'
import { assertWellFormed } from '../utf8.ts'
import type { StrippedRecord } from '../normalize/normalize.ts'

export type L3Category = 'invisible' | 'bidi' | 'confusable_mixed_script' | 'encoded_blob' | 'url_or_host' | 'shell_like'
export interface L3Span { field: string; start: number; end: number; category: L3Category }
export interface L3StrippedHit { field: string; codePoint: number; category: 'invisible' | 'bidi' }
export interface L3Input {
  fields: Readonly<Record<string, string>>
  stripped: Readonly<Record<string, readonly StrippedRecord[]>>
  requesterFields: readonly string[]
}
export interface L3Result {
  flagged: boolean
  categories: L3Category[]
  spans: L3Span[]
  stripped: L3StrippedHit[]
  truncated: boolean
  requesterAttributable: boolean
}

type Ranges = readonly (readonly [number, number])[]
const ranges = (...rs: [number, number][]): Ranges => Object.freeze(rs.map((r) => Object.freeze(r)))

export const L3_CATEGORIES: readonly L3Category[] = Object.freeze([
  'invisible', 'bidi', 'confusable_mixed_script', 'encoded_blob', 'url_or_host', 'shell_like',
])
// Thresholds and lists are tuned in Phase 1 against real traffic; they are never dropped.
export const BASE64_MIN_LENGTH = 40
export const HEX_MIN_LENGTH = 32
export const MAX_SPANS = 200
export const HOST_TLDS: readonly string[] = Object.freeze([
  'com', 'net', 'org', 'edu', 'gov', 'io', 'dev', 'co', 'xyz', 'info', 'biz', 'me', 'ru', 'cn', 'top', 'site',
  'online', 'link', 'click', 'live', 'tk', 'ga', 'cf', 'gq',
])
export const SHELL_PATTERNS: readonly string[] = Object.freeze(['$(', '`', '| sh', 'curl ', '&&'])
export const INVISIBLE_RANGES: Ranges = ranges(
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200d],
  [0x2060, 0x2064], [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xe0000, 0xe007f],
)
export const BIDI_RANGES: Ranges = ranges([0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069])

const inRanges = (cp: number, rs: Ranges): boolean => rs.some(([lo, hi]) => cp >= lo && cp <= hi)

/** A match in UTF-16 units; converted to code points once per field. */
interface Hit { start: number; end: number; category: L3Category }

function characterHits(text: string): Hit[] {
  const hits: Hit[] = []
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i) as number
    const width = cp > 0xffff ? 2 : 1
    const category = inRanges(cp, BIDI_RANGES) ? 'bidi' : inRanges(cp, INVISIBLE_RANGES) ? 'invisible' : null
    if (category) hits.push({ start: i, end: i + width, category })
    i += width
  }
  return hits
}

const TOKEN = /[\p{L}\p{M}\p{N}]+/gu
const SCRIPTS = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u]

function confusableHits(text: string): Hit[] {
  const hits: Hit[] = []
  for (const m of text.matchAll(TOKEN)) {
    const letters = m[0].match(/\p{L}/gu)?.join('') ?? ''
    if (SCRIPTS.filter((s) => s.test(letters)).length >= 2) {
      hits.push({ start: m.index, end: m.index + m[0].length, category: 'confusable_mixed_script' })
    }
  }
  return hits
}

const BASE64_RUN = /[A-Za-z0-9+/_-]+={0,2}/g
const HEX_RUN = /[0-9A-Fa-f]+/g
const WORD = /[A-Za-z0-9_]/

function encodedHits(text: string): Hit[] {
  const hits: Hit[] = []
  for (const m of text.matchAll(BASE64_RUN)) {
    const body = m[0].replace(/=+$/, '')
    if (body.length >= BASE64_MIN_LENGTH && /[A-Z]/.test(body) && /[a-z]/.test(body) && /[0-9]/.test(body)) {
      hits.push({ start: m.index, end: m.index + m[0].length, category: 'encoded_blob' })
    }
  }
  for (const m of text.matchAll(HEX_RUN)) {
    if (m[0].length < HEX_MIN_LENGTH) continue
    const end = m.index + m[0].length
    // A 0x prefix is part of the span; the run itself starts after the x.
    const prefixed = m.index >= 2 && /[xX]/.test(text[m.index - 1] as string) && text[m.index - 2] === '0'
    const start = prefixed ? m.index - 2 : m.index
    const before = text[start - 1]
    const after = text[end]
    if ((before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after))) {
      hits.push({ start, end, category: 'encoded_blob' })
    }
  }
  return hits
}

// Lookbehinds anchor each regex at the start of a run, so none rescans a run from every
// position (linear time on untrusted input, spec 017 T017-16).
const WWW_RE = /(?<![A-Za-z0-9.-])www\.[A-Za-z0-9.-]+/gi
const IPV4_RE = /(?<![0-9.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9]|\.[0-9])/g
// The TLD is inside the pattern, so when the greedy chain fails the neighbour rules,
// backtracking settles on the longest chain that passes (evil.com.-x flags evil.com). Each TLD
// letter is an ASCII [xX] pair rather than the `i` flag, whose Unicode folding maps U+017F to s.
const asciiCaseless = (word: string): string => [...word].map((c) => `[${c}${c.toUpperCase()}]`).join('')
const HOST_RE = new RegExp(
  `(?<![\\p{L}\\p{N}.-])(?:[\\p{L}\\p{N}-]+\\.)+(?:${HOST_TLDS.map(asciiCaseless).join('|')})` +
    '(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])',
  'gu',
)
const SCHEME_CHAR = /[A-Za-z0-9+.-]/
const ALNUM = /[A-Za-z0-9]/
// Unicode White_Space (the N_intake set, including U+0085) and the delimiters that end a URL.
const URL_STOP = /[\s\x85<>"'`]/
const URL_TRAILING = /[.,;:!?)\]}]+$/

/**
 * Scheme URLs, found from each `://` and walked back over the scheme run. A regex starting at
 * the scheme would rescan a long `.a.a...` run from every letter (quadratic); this is linear
 * because each walk-back stops at the previous `:` or `/`.
 */
function schemeUrlHits(text: string): Hit[] {
  const hits: Hit[] = []
  for (let at = text.indexOf('://'); at !== -1;) {
    let runStart = at
    while (runStart > 0 && SCHEME_CHAR.test(text[runStart - 1] as string)) runStart--
    let start = -1
    for (let k = runStart; k < at && start === -1; k++) {
      if (/[A-Za-z]/.test(text[k] as string) && (k === 0 || !ALNUM.test(text[k - 1] as string))) start = k
    }
    if (start === -1) {
      // No scheme here: look at the next `://`, which may start a real URL (0://https://...).
      at = text.indexOf('://', at + 1)
      continue
    }
    let end = at + 3
    while (end < text.length && !URL_STOP.test(text[end] as string)) end++
    const match = text.slice(start, end).replace(URL_TRAILING, '')
    hits.push({ start, end: start + match.length, category: 'url_or_host' })
    at = text.indexOf('://', end)
  }
  return hits
}

function urlHits(text: string): Hit[] {
  const hits = schemeUrlHits(text)
  const push = (start: number, length: number): void => {
    hits.push({ start, end: start + length, category: 'url_or_host' })
  }
  for (const m of text.matchAll(WWW_RE)) {
    const host = m[0].slice(4).replace(/\.+$/, '')
    if (host.length > 0) push(m.index, 4 + host.length)
  }
  for (const m of text.matchAll(IPV4_RE)) {
    if (m.slice(1).every((octet) => Number(octet) <= 255)) push(m.index, m[0].length)
  }
  for (const m of text.matchAll(HOST_RE)) push(m.index, m[0].length)
  return hits
}

function shellHits(text: string): Hit[] {
  const hits: Hit[] = []
  for (const m of text.matchAll(/`+/g)) hits.push({ start: m.index, end: m.index + m[0].length, category: 'shell_like' })
  for (const pattern of SHELL_PATTERNS.filter((p) => p !== '`')) {
    for (let i = text.indexOf(pattern); i !== -1; i = text.indexOf(pattern, i + 1)) {
      hits.push({ start: i, end: i + pattern.length, category: 'shell_like' })
    }
  }
  return hits
}

/** Code-point offset of every UTF-16 index (spans are code points, spec 017 DD4). */
function codePointIndex(text: string): Int32Array {
  const index = new Int32Array(text.length + 1)
  let cp = 0
  for (let i = 0; i < text.length; i++) {
    index[i] = cp
    const unit = text.charCodeAt(i)
    if (unit < 0xd800 || unit > 0xdbff) cp++
  }
  index[text.length] = cp
  return index
}

const categoryRank = (c: L3Category): number => L3_CATEGORIES.indexOf(c)
const bySpan = (a: L3Span, b: L3Span): number =>
  compareUtf8(a.field, b.field) || a.start - b.start || a.end - b.end || categoryRank(a.category) - categoryRank(b.category)

/** Merges overlapping or adjacent spans of one category in one field. */
function merge(spans: L3Span[]): L3Span[] {
  const out: L3Span[] = []
  for (const s of [...spans].sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && last.category === s.category && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

function fieldSpans(field: string, text: string): L3Span[] {
  assertWellFormed(text) // first, so a lone surrogate reports invalid_utf8 whatever else is wrong
  if (nHash(text) !== text) throw new SchemaError('not_normalized', `field ${field} is not normalized`)
  const hits = [...characterHits(text), ...confusableHits(text), ...encodedHits(text), ...urlHits(text), ...shellHits(text)]
  const index = codePointIndex(text)
  return merge(hits.map((h) => ({ field, start: index[h.start] as number, end: index[h.end] as number, category: h.category })))
}

export function runL3(input: L3Input): L3Result {
  const requester = new Set(input.requesterFields)
  const spans = Object.entries(input.fields).flatMap(([field, text]) => fieldSpans(field, text)).sort(bySpan)
  const stripped: L3StrippedHit[] = Object.keys(input.stripped).sort(compareUtf8).flatMap((field) =>
    (input.stripped[field] ?? []).map((r) => ({
      field, codePoint: r.codePoint, category: inRanges(r.codePoint, BIDI_RANGES) ? 'bidi' as const : 'invisible' as const,
    })))
  // Everything derived is computed before truncation, so a stored row never under-reports.
  const present = new Set<L3Category>([...spans, ...stripped].map((s) => s.category))
  const requesterAttributable = spans.some((s) => requester.has(s.field))
  const truncated = spans.length > MAX_SPANS || stripped.length > MAX_SPANS
  const kept = spans.length > MAX_SPANS
    ? [...spans.filter((s) => requester.has(s.field)), ...spans.filter((s) => !requester.has(s.field))].slice(0, MAX_SPANS).sort(bySpan)
    : spans
  return {
    flagged: spans.length > 0 || stripped.length > 0,
    categories: L3_CATEGORIES.filter((c) => present.has(c)),
    spans: kept,
    stripped: stripped.slice(0, MAX_SPANS),
    truncated,
    requesterAttributable,
  }
}
