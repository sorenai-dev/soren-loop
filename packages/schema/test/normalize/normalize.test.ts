import { describe, expect, test } from 'vitest'
import { nHash, nIntake } from '../../src/index.ts'
import type { StrippedRecord } from '../../src/index.ts'
import { reasonOf, vector } from '../helpers/vectors.ts'

interface NormInput {
  text?: string
  text_hex?: string
  cap?: number
  fn: 'intake' | 'hash' | 'both'
}

const INTAKE_CAP = 10_000

function field(input: NormInput): string | Uint8Array {
  return input.text_hex === undefined ? (input.text as string) : Buffer.from(input.text_hex, 'hex')
}

/** Runs a normalize.json vector through every function its `fn` names. */
function check(id: string): void {
  const v = vector<NormInput>('normalize.json', id)
  const fns = v.input.fn === 'both' ? (['intake', 'hash'] as const) : [v.input.fn]
  for (const fn of fns) {
    const run = (): string =>
      fn === 'intake' ? nIntake(field(v.input), v.input.cap ?? INTAKE_CAP).value : nHash(field(v.input), v.input.cap)
    if (v.expected_error !== undefined) {
      expect(reasonOf(run), `${id} ${fn}`).toBe(v.expected_error)
    } else {
      expect(run(), `${id} ${fn}`).toBe(v.expected_normalized)
    }
  }
  if (v.expected_stripped !== undefined) {
    expect(nIntake(field(v.input), v.input.cap ?? INTAKE_CAP).stripped, `${id} stripped`).toEqual(v.expected_stripped)
  }
}

describe('nHash (steps 1, 3-6)', () => {
  test('[T012-1] N-01 NFC composition', () => check('N-01'))
  test('[T012-4] N-04 CRLF/CR become LF, trailing whitespace per line is stripped, the field is trimmed', () => {
    check('N-04a')
    check('N-04b')
  })
  test('[T012-5] N-05 internal whitespace is preserved', () => check('N-05'))
  test('[T012-4] N-16 whitespace is Unicode White_Space and lines split on LF only', () => check('N-16'))
  test('[T012-6] N-06 nHash enforces a cap only when one is passed', () => {
    check('N-06b')
    expect(nHash('abcd')).toBe('abcd')
  })
  test('[T012-7] N-07 invalid UTF-8 is rejected: bad bytes and a lone surrogate', () => {
    check('N-07')
    expect(reasonOf(() => nHash('a\ud800'))).toBe('invalid_utf8')
    expect(reasonOf(() => nIntake('a\ud800', INTAKE_CAP))).toBe('invalid_utf8')
  })
  test('[T012-9] N-09 a Cyrillic confusable survives unchanged', () => check('N-09'))
  test('[T012-10] N-10 a code point assigned after 15.1 passes nHash unchanged', () => check('N-10h'))
  test('[T012-14] N-11 NFC runs again after stripping a character that blocked composition', () => check('N-11'))
  test('[T012-2] N-02 nHash strips Tag, zero-width and BOM characters', () => check('N-02h'))
})

describe('nIntake (steps 1-6)', () => {
  test('[T012-2] N-02 Tag, zero-width and BOM characters are stripped and recorded at raw-input offsets', () => check('N-02'))
  test('[T012-3] N-03 bidi controls are stripped and recorded', () => check('N-03'))
  test('[T012-3a] N-12 the stripped index is a raw-input offset, not a post-NFC one', () => check('N-12'))
  test('[T012-6] N-06 the cap is code points after normalization: exactly N passes, N+1 fails', () => {
    for (const id of ['N-06a', 'N-06b', 'N-06c', 'N-06d']) check(id)
  })
  test('[T012-6] N-17 cap 0: an empty value passes and one code point fails', () => {
    check('N-17a')
    check('N-17b')
  })
  test('[T012-16] a cap that is not a non-negative safe integer is a TypeError, not a SchemaError', () => {
    for (const cap of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => nIntake('a', cap)).toThrow(TypeError)
      expect(() => nHash('a', cap)).toThrow(TypeError)
    }
  })
  test('[T012-8] N-08 an unassigned code point is rejected', () => check('N-08'))
  test('[T012-10] N-10 a code point assigned after 15.1 is rejected by nIntake', () => check('N-10i'))
  test('[T012-11] N-13 a leading BOM in byte input is recorded at index 0 and stripped (both functions)', () => check('N-13'))
  test('[T012-2] N-14 every strip-set member is removed and recorded; assigned neighbours survive', () => check('N-14'))
  test('[T012-8] N-15 U+E0000 is stripped by nHash but rejected by nIntake (step 2 runs before step 4)', () => {
    check('N-15h')
    check('N-15i')
  })
  test('[T012-15] idempotence: nHash(nHash(x)) === nHash(x) and nHash(nIntake(x).value) === nIntake(x).value', () => {
    const marks = ['́', '̈', '̧']
    const stripped = ['​', '‍', '⁠', '﻿', '‮', '⁦', '‎', '\u{e0041}']
    const spacing = [' ', '\t', '\r\n', '\r', '\n', ' ', '　', ' ']
    const bases = ['e', 'a', 'c', 'x', 'A']
    const corpus: string[] = []
    // Deterministic corpus: every strip-set character placed between a base and each mark, with
    // spacing around it.
    for (const b of bases) {
      for (const s of stripped) {
        for (const m of marks) {
          for (const w of spacing) corpus.push(`${w}${b}${s}${m}${w}${b}${m}${s}${w}`)
        }
      }
    }
    expect(corpus.length).toBe(960)
    for (const x of corpus) {
      const once = nHash(x)
      expect(nHash(once), JSON.stringify(x)).toBe(once)
      const intake = nIntake(x, INTAKE_CAP).value
      expect(nHash(intake), JSON.stringify(x)).toBe(intake)
      expect(intake).toBe(once)
    }
  })
})

// The record type is part of the public API (Task 072 stores it).
const _typed: StrippedRecord = { codePoint: 0x200b, index: 0 }
void _typed
