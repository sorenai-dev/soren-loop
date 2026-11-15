import { expect, test } from 'vitest'
import { ID_ALPHABET, ID_PREFIXES, type IdPrefix, encodeId, isId, newId } from '../src/ids.ts'

// Expected encodings were computed outside the code under test (hand-written base62 over the
// integer values 2^128 - 1, 0 and 1), so a wrong alphabet, endianness or padding fails here.
const MAX = 'req_7n42DGM5Tflk9n8mt7Fhc7'
const TOO_BIG = 'req_7n42DGM5Tflk9n8mt7Fhc8' // 2^128, one past the largest 128-bit value

function decode(body: string): bigint {
  let n = 0n
  for (const ch of body) n = n * 62n + BigInt(ID_ALPHABET.indexOf(ch))
  return n
}

test('[T020-1] encodeId writes 16 bytes as 22 fixed-width base62 chars', () => {
  expect(encodeId('req', new Uint8Array(16).fill(0xff))).toBe(MAX)
  expect(encodeId('req', new Uint8Array(16))).toBe('req_0000000000000000000000')
  const one = new Uint8Array(16)
  one[15] = 1
  expect(encodeId('req', one)).toBe('req_0000000000000000000001')
  expect(() => encodeId('req', new Uint8Array(15))).toThrow(TypeError)
})

test('[T020-2] newId draws 128 random bits per ID (SR-12)', () => {
  const ids = Array.from({ length: 10_000 }, () => newId('req'))
  expect(new Set(ids).size).toBe(10_000)
  for (const id of ids) expect(id).toMatch(/^req_[0-9A-Za-z]{22}$/)
  // A uniform 128-bit source puts 15/16 of values at or above 2^124 (expected 9,375; the
  // threshold is about 15 sigma below). A 64-bit source filling the low bytes puts none there.
  const high = ids.filter((id) => decode(id.slice(4)) >= 2n ** 124n).length
  expect(high).toBeGreaterThanOrEqual(9_000)
  const seen = new Set(ids.flatMap((id) => [...id.slice(4)]))
  expect(seen.size).toBe(62)
})

test('[T020-3] isId accepts only a registered prefix and a 22-char body below 2^128', () => {
  const id = newId('req')
  expect(isId('req', id)).toBe(true)
  expect(isId('req', MAX)).toBe(true)
  expect(isId('rev', id)).toBe(false)
  expect(isId('req', 42)).toBe(false)
  expect(isId('req', null)).toBe(false)
  expect(isId('req', id.slice(0, -1))).toBe(false)
  expect(isId('req', `${id}0`)).toBe(false)
  expect(isId('req', `req_${'0'.repeat(21)}-`)).toBe(false)
  expect(isId('req', TOO_BIG)).toBe(false)
})

test('[T020-4] the prefix registry is the RFC 04 list plus rqr and fam, and is frozen', () => {
  expect(ID_PREFIXES).toEqual([
    'req', 'ref', 'rev', 'spec', 'apr', 'pck', 'clr', 'fb', 'q', 'sl', 'tok', 'run', 'dep', 'obx',
    'site', 'own', 'trc', 'rqr', 'fam',
  ])
  expect(Object.isFrozen(ID_PREFIXES)).toBe(true)
  expect(() => newId('nope' as IdPrefix)).toThrow(TypeError)
  expect(() => encodeId('nope' as IdPrefix, new Uint8Array(16))).toThrow(TypeError)
})
