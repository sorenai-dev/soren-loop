import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  BASE64_MIN_LENGTH, BIDI_RANGES, HEX_MIN_LENGTH, HOST_TLDS, INVISIBLE_RANGES, L3_CATEGORIES, MAX_SPANS,
  SHELL_PATTERNS, l3FieldsFor, nIntake, runL3,
} from '../../src/index.ts'
import type { L3Input, L3Result, StrippedRecord } from '../../src/index.ts'
import { reasonOf } from '../helpers/vectors.ts'

// Characters built at runtime so the source stays ASCII (hygiene test T012-17).
const cp = (...points: number[]): string => String.fromCodePoint(...points)

interface CorpusCase {
  id: string
  description: string
  raw: Record<string, string>
  requesterFields: string[]
  normalized?: Record<string, string>
  expected: Omit<L3Result, 'truncated'>
}

function corpus(name: string): CorpusCase[] {
  return JSON.parse(readFileSync(new URL(`../corpus/l3/${name}.json`, import.meta.url), 'utf8')) as CorpusCase[]
}

/** What PC-S does: N_intake each raw field, then L3 over the normalized text and stripped records. */
function intakeThenL3(c: CorpusCase): L3Result {
  const fields: Record<string, string> = {}
  const stripped: Record<string, StrippedRecord[]> = {}
  for (const [key, text] of Object.entries(c.raw)) {
    const r = nIntake(text, 100_000)
    fields[key] = r.value
    stripped[key] = r.stripped
  }
  if (c.normalized) expect(fields).toEqual(c.normalized)
  return runL3({ fields, stripped, requesterFields: c.requesterFields })
}

const cases = (name: string) => corpus(name).map((c) => [c.id, c] as const)
const expectCase = (c: CorpusCase): void => {
  expect(intakeThenL3(c)).toEqual({ ...c.expected, truncated: false })
}
const clean = (fields: Record<string, string>, requesterFields: string[] = Object.keys(fields)): L3Input => ({
  fields, stripped: {}, requesterFields,
})

describe('L3 characters (spec 017 batch A)', () => {
  test.each(cases('invisible'))('[T017-1] ST-30 %s', (_id, c) => expectCase(c))
  test.each(cases('bidi'))('[T017-2] ST-30 ST-39 %s', (_id, c) => expectCase(c))
  test.each(cases('confusable'))('[T017-3] ST-30 %s', (_id, c) => expectCase(c))

  test('[T017-4] span offsets count code points, not UTF-16 units, for every in-text category', () => {
    expect(runL3(clean({ title: `${cp(0x1f600)} evil.com` })).spans)
      .toEqual([{ field: 'title', start: 2, end: 10, category: 'url_or_host' }])
    // An astral emoji first, then one hit of each other in-text category.
    const title = `${cp(0x1f600)} ${cp(0x00ad)} ${cp(0x061c)} p${cp(0x0430)}y Ab1${'x'.repeat(37)} a && b`
    expect(runL3(clean({ title })).spans).toEqual([
      { field: 'title', start: 2, end: 3, category: 'invisible' },
      { field: 'title', start: 4, end: 5, category: 'bidi' },
      { field: 'title', start: 6, end: 9, category: 'confusable_mixed_script' },
      { field: 'title', start: 10, end: 50, category: 'encoded_blob' },
      { field: 'title', start: 53, end: 55, category: 'shell_like' },
    ])
  })
})

describe('L3 patterns (spec 017 batch B)', () => {
  test.each(cases('encoded'))('[T017-5] ST-30 %s', (_id, c) => expectCase(c))
  test.each(cases('url'))('[T017-6] ST-30 %s', (_id, c) => expectCase(c))
  test.each(cases('shell'))('[T017-7] ST-30 %s', (_id, c) => expectCase(c))
  test.each(cases('known-noise'))('[T017-8] %s gives the recorded result', (_id, c) => expectCase(c))

  test('[T017-5] the thresholds and lists are the spec values', () => {
    expect([BASE64_MIN_LENGTH, HEX_MIN_LENGTH, MAX_SPANS]).toEqual([40, 32, 200])
    expect(SHELL_PATTERNS).toEqual(['$(', '`', '| sh', 'curl ', '&&'])
    expect(HOST_TLDS).toEqual([
      'com', 'net', 'org', 'edu', 'gov', 'io', 'dev', 'co', 'xyz', 'info', 'biz', 'me', 'ru', 'cn', 'top', 'site',
      'online', 'link', 'click', 'live', 'tk', 'ga', 'cf', 'gq',
    ])
    expect(BIDI_RANGES).toEqual([[0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]])
    expect(INVISIBLE_RANGES).toEqual([
      [0x00ad, 0x00ad], [0x034f, 0x034f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200d],
      [0x2060, 0x2064], [0x3164, 0x3164], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xe0000, 0xe007f],
    ])
  })
})

describe('L3 result shape and attribution (spec 017 batch C)', () => {
  test('[T017-9] SR-26i a span in a requester field is attributable; the same in owner_context is not', () => {
    expect(runL3({ fields: { title: 'a && b' }, stripped: {}, requesterFields: ['title'] }).requesterAttributable).toBe(true)
    const owner = runL3({ fields: { title: 'ok', owner_context: 'a && b' }, stripped: {}, requesterFields: ['title'] })
    expect(owner.flagged).toBe(true)
    expect(owner.requesterAttributable).toBe(false)
  })

  test('[T017-9] SR-26i a stripped-only hit in a requester field flags but is not attributable', () => {
    const r = runL3({ fields: { title: 'abc' }, stripped: { title: [{ codePoint: 0x202e, index: 1 }] }, requesterFields: ['title'] })
    expect(r).toMatchObject({ flagged: true, categories: ['bidi'], spans: [], requesterAttributable: false })
  })

  test.each(cases('clean'))('[T017-10] ST-30 %s does not flag', (_id, c) => expectCase(c))

  test('[T017-11] spans sort by field (UTF-8), start, end, category; categories follow L3_CATEGORIES', () => {
    const fields = {
      title: 'curl evil.com', 'acceptance_criteria[2]': '&&', 'acceptance_criteria[10]': '&&',
      'acceptance_criteria[0]': `x${cp(0x061c)} &&`,
    }
    const r = runL3(clean(fields))
    expect(r.spans).toEqual([
      { field: 'acceptance_criteria[0]', start: 1, end: 2, category: 'bidi' },
      { field: 'acceptance_criteria[0]', start: 3, end: 5, category: 'shell_like' },
      { field: 'acceptance_criteria[10]', start: 0, end: 2, category: 'shell_like' },
      { field: 'acceptance_criteria[2]', start: 0, end: 2, category: 'shell_like' },
      { field: 'title', start: 0, end: 5, category: 'shell_like' },
      { field: 'title', start: 5, end: 13, category: 'url_or_host' },
    ])
    expect(r.categories).toEqual(['bidi', 'url_or_host', 'shell_like'])
    expect(L3_CATEGORIES).toEqual(['invisible', 'bidi', 'confusable_mixed_script', 'encoded_blob', 'url_or_host', 'shell_like'])
  })

  test('[T017-11] overlapping spans of different categories are both kept', () => {
    const r = runL3(clean({ title: `p${cp(0x0430)}ypal.com` }))
    expect(r.spans).toEqual([
      { field: 'title', start: 0, end: 6, category: 'confusable_mixed_script' },
      { field: 'title', start: 0, end: 10, category: 'url_or_host' },
    ])
  })

  test('[T017-12] more than MAX_SPANS spans are truncated, keeping requester spans first', () => {
    const many = Array.from({ length: 250 }, () => '&&').join(' ')
    const r = runL3(clean({ title: many }))
    expect(r.spans).toHaveLength(200)
    expect(r.spans[199]).toEqual({ field: 'title', start: 597, end: 599, category: 'shell_like' })
    expect(r.truncated).toBe(true)
    const mixed = runL3({ fields: { owner_context: many, title: 'a && b' }, stripped: {}, requesterFields: ['title'] })
    expect(mixed.spans).toHaveLength(200)
    expect(mixed.spans[0]).toEqual({ field: 'owner_context', start: 0, end: 2, category: 'shell_like' })
    expect(mixed.spans[199]).toEqual({ field: 'title', start: 2, end: 4, category: 'shell_like' })
    expect(mixed.requesterAttributable).toBe(true)
    expect(mixed.truncated).toBe(true)
  })

  test('[T017-12] categories and flags are computed before truncation', () => {
    const many = Array.from({ length: 250 }, () => '&&').join(' ')
    const r = runL3({ fields: { title: many, zz: 'evil.com' }, stripped: {}, requesterFields: ['title'] })
    expect(r.spans.every((s) => s.field === 'title')).toBe(true)
    expect(r.categories).toEqual(['url_or_host', 'shell_like'])
  })

  test('[T017-12] stripped hits are ordered by field (UTF-8), then record order', () => {
    const r = runL3({
      fields: {}, requesterFields: [],
      stripped: {
        title: [{ codePoint: 0x200b, index: 0 }, { codePoint: 0x202e, index: 1 }],
        'acceptance_criteria[0]': [{ codePoint: 0xfeff, index: 0 }],
      },
    })
    expect(r.stripped).toEqual([
      { field: 'acceptance_criteria[0]', codePoint: 0xfeff, category: 'invisible' },
      { field: 'title', codePoint: 0x200b, category: 'invisible' },
      { field: 'title', codePoint: 0x202e, category: 'bidi' },
    ])
  })

  test('[T017-12] more than MAX_SPANS stripped hits keep the first 200 in that order', () => {
    const records = (cp0: number) => Array.from({ length: 150 }, (_, i) => ({ codePoint: cp0, index: i }))
    const r = runL3({ fields: {}, stripped: { title: records(0x202e), 'acceptance_criteria[0]': records(0x200b) }, requesterFields: [] })
    expect(r.stripped).toHaveLength(200)
    expect(r.stripped[0]).toEqual({ field: 'acceptance_criteria[0]', codePoint: 0x200b, category: 'invisible' })
    expect(r.stripped[149]?.field).toBe('acceptance_criteria[0]')
    expect(r.stripped[199]).toEqual({ field: 'title', codePoint: 0x202e, category: 'bidi' })
    expect(r.truncated).toBe(true)
  })

  test('[T017-13] edge inputs return results; invalid input throws', () => {
    const none = { flagged: false, categories: [], spans: [], stripped: [], truncated: false, requesterAttributable: false }
    expect(runL3({ fields: {}, stripped: {}, requesterFields: [] })).toEqual(none)
    expect(runL3(clean({ title: '' }))).toEqual(none)
    expect(runL3({ fields: { title: 'ok' }, stripped: {}, requesterFields: ['nope'] })).toEqual(none)
    const orphan = runL3({ fields: {}, stripped: { gone: [{ codePoint: 0x200b, index: 0 }] }, requesterFields: [] })
    expect(orphan.stripped).toEqual([{ field: 'gone', codePoint: 0x200b, category: 'invisible' }])
    expect(reasonOf(() => runL3(clean({ title: `a${String.fromCharCode(0xd800)}` })))).toBe('invalid_utf8')
    expect(reasonOf(() => runL3(clean({ title: 'a\r\nb' })))).toBe('not_normalized')
  })

  test('[T017-14] l3FieldsFor keys a request per DD6', () => {
    const req = {
      title: 'T', problem: 'P', acceptance_criteria: ['a', 'b', 'c'], area: null, owner_context: 'O',
    }
    expect(l3FieldsFor(req)).toEqual({
      fields: {
        title: 'T', problem: 'P', 'acceptance_criteria[0]': 'a', 'acceptance_criteria[1]': 'b',
        'acceptance_criteria[2]': 'c', owner_context: 'O',
      },
      requesterFields: ['title', 'problem', 'acceptance_criteria[0]', 'acceptance_criteria[1]', 'acceptance_criteria[2]'],
    })
    const withArea = l3FieldsFor({ ...req, area: 'billing', owner_context: null })
    expect(withArea.fields).toMatchObject({ area: 'billing' })
    expect(withArea.fields).not.toHaveProperty('owner_context')
    expect(withArea.requesterFields).toContain('area')
  })

  test('[T017-15] exported lists and every inner range are frozen', () => {
    for (const list of [L3_CATEGORIES, HOST_TLDS, SHELL_PATTERNS, INVISIBLE_RANGES, BIDI_RANGES]) {
      expect(Object.isFrozen(list)).toBe(true)
    }
    for (const range of [...INVISIBLE_RANGES, ...BIDI_RANGES]) expect(Object.isFrozen(range)).toBe(true)
  })

  test.each([
    ['a', 'a', ''], ['a/', 'a/', ''], ['a.', 'a.', ''], ['0x', '0x', ''], ['.a then ://', '.a', '://'],
  ])('[T017-16] a field of repeated %j runs in linear time', (_name, unit, suffix) => {
    const time = (n: number): number => {
      const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n) + suffix
      const t0 = performance.now()
      runL3(clean({ title: text }))
      return performance.now() - t0
    }
    time(10_000) // warm up
    const small = time(100_000)
    const big = time(200_000)
    expect(small).toBeLessThan(2_000)
    expect(big).toBeLessThan(Math.max(3 * small, 50))
  })
})
