import { describe, expect, test } from 'vitest'
import { P, byteSort, frame, hashFields, jcs, lp, sortedUnique } from '../../src/index.ts'
import type { Prefix } from '../../src/index.ts'
import { hex, reasonOf, utf8Hex, vector } from '../helpers/vectors.ts'

// Lone surrogates can't travel in shared JSON vectors (other decoders replace them), so these
// cases live only in TS tests.
const LONE_SURROGATE = 'a\ud800'

type FieldsInput = { prefix: Prefix; fields: string[] }

describe('lp, frame and hashFields', () => {
  test('[T011-1] lp is a uint32 big-endian byte length followed by the UTF-8 bytes', () => {
    expect(hex(lp(''))).toBe('00000000')
    expect(hex(lp('\u00e9'))).toBe('00000002c3a9')
    expect(hex(lp('\u{1F600}'))).toBe('00000004f09f9880')
  })

  test('[T011-2] H-13 LP framing: ("ab","c") and ("a","bc") frame and hash to their vectors and differ', () => {
    const a = vector<FieldsInput>('hash.json', 'H-13a')
    const b = vector<FieldsInput>('hash.json', 'H-13b')
    expect(hex(frame(a.input.prefix, a.input.fields))).toBe(a.expected_bytes_hex)
    expect(hex(frame(b.input.prefix, b.input.fields))).toBe(b.expected_bytes_hex)
    expect(hashFields(a.input.prefix, a.input.fields)).toBe(a.expected_hash)
    expect(hashFields(b.input.prefix, b.input.fields)).toBe(b.expected_hash)
    expect(hashFields(a.input.prefix, a.input.fields)).not.toBe(hashFields(b.input.prefix, b.input.fields))
  })

  test('[T011-3] hashFields is 64 lowercase hex, and zero fields frame LP(prefix) alone', () => {
    const v = vector<FieldsInput>('hash.json', 'H-13c')
    expect(hex(frame(v.input.prefix, v.input.fields))).toBe(v.expected_bytes_hex)
    const h = hashFields(v.input.prefix, v.input.fields)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe(v.expected_hash)
  })

  test('[T011-4] hashFields rejects a malformed prefix with invalid_prefix', () => {
    for (const bad of ['sl:Test:v1', 'sl:test:v0', 'sl:test', 'xx:test:v1', 'sl:test:v01', 'sl::v1', 'sl:1x:v1']) {
      expect(reasonOf(() => hashFields(bad as Prefix, []))).toBe('invalid_prefix')
    }
    for (const good of ['sl:a_1:v12', 'sl:hold_clear:v1', 'sl:l2:v1'] as const) {
      expect(hashFields(good, ['x']), good).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('byteSort and sortedUnique', () => {
  test('[T011-5] H-14 an astral string among BMP strings sorts by UTF-8 bytes, then frames and hashes to the vector', () => {
    const v = vector<{ prefix: Prefix; unsorted: string[] }>('hash.json', 'H-14')
    const sorted = byteSort(v.input.unsorted)
    expect(sorted).toEqual(v.expected_sorted)
    expect(hex(frame(v.input.prefix, sorted))).toBe(v.expected_bytes_hex)
    expect(hashFields(v.input.prefix, sorted)).toBe(v.expected_hash)
  })

  test('[T011-6] sortedUnique sorts, removes duplicates, and neither function mutates its input', () => {
    const input = ['b', 'a', 'b', '\u{1F600}', 'a']
    const copy = [...input]
    expect(sortedUnique(input)).toEqual(['a', 'b', '\u{1F600}'])
    expect(byteSort(input)).toEqual(['a', 'a', 'b', 'b', '\u{1F600}'])
    expect(input).toEqual(copy)
  })

  test('[T011-7] byteSort, lp and hashFields reject a lone surrogate with invalid_utf8', () => {
    expect(reasonOf(() => byteSort(['a', LONE_SURROGATE]))).toBe('invalid_utf8')
    expect(reasonOf(() => sortedUnique([LONE_SURROGATE]))).toBe('invalid_utf8')
    expect(reasonOf(() => lp(LONE_SURROGATE))).toBe('invalid_utf8')
    expect(reasonOf(() => hashFields('sl:test:v1', [LONE_SURROGATE]))).toBe('invalid_utf8')
  })
})

describe('P(path)', () => {
  test('[T011-8] H-15 ./src/a.ts, src/a.ts and src//a.ts give one P result; ../x is rejected', () => {
    const v = vector<{ same: string[]; rejected: string }>('hash.json', 'H-15')
    for (const p of v.input.same) expect(P(p)).toBe(v.expected_normalized)
    expect(reasonOf(() => P(v.input.rejected))).toBe(v.expected_error)
  })

  test('[T011-9] P rejects traversal, backslash, NUL, absolute and empty paths; P-01..P-03; P is idempotent', () => {
    expect(reasonOf(() => P('src/../x'))).toBe('path_traversal')
    expect(reasonOf(() => P('src/..'))).toBe('path_traversal')
    expect(reasonOf(() => P('src\\a.ts'))).toBe('path_invalid')
    expect(reasonOf(() => P('..\\x'))).toBe('path_invalid')
    expect(reasonOf(() => P('a\u0000b'))).toBe('path_invalid')
    expect(reasonOf(() => P('/etc/x'))).toBe('path_absolute')
    expect(reasonOf(() => P('/'))).toBe('path_absolute')
    expect(reasonOf(() => P('//'))).toBe('path_absolute')
    expect(reasonOf(() => P(''))).toBe('path_empty')
    expect(reasonOf(() => P('./'))).toBe('path_empty')
    expect(reasonOf(() => P('.'))).toBe('path_empty')
    expect(reasonOf(() => P(LONE_SURROGATE))).toBe('invalid_utf8')
    for (const id of ['P-01', 'P-02', 'P-03']) {
      const v = vector<{ path: string }>('hash.json', id)
      expect(P(v.input.path), id).toBe(v.expected_normalized)
    }
    for (const x of ['./src/a.ts', 'src//a.ts', 'src/./a.ts', 'src/', 'a:b.md', 'Src/A.ts', 'cafe\u0301/x.ts']) {
      expect(P(P(x)), x).toBe(P(x))
    }
  })

  test('[T011-10] P preserves case and applies NFC', () => {
    expect(P('Src/A.ts')).toBe('Src/A.ts')
    expect(P('cafe\u0301/x.ts')).toBe('caf\u00e9/x.ts')
  })
})

describe('jcs (RFC 8785)', () => {
  test('[T011-11] input key order does not change the output bytes', () => {
    const expected = '{"a":[true,null,"x"],"b":1}'
    expect(jcs({ b: 1, a: [true, null, 'x'] })).toBe(expected)
    expect(jcs({ a: [true, null, 'x'], b: 1 })).toBe(expected)
  })

  test('[T011-12] object keys sort by UTF-16 code units, matching the JCS-01 vector bytes', () => {
    const v = vector<{ value: unknown }>('hash.json', 'JCS-01')
    expect(utf8Hex(jcs(v.input.value))).toBe(v.expected_bytes_hex)
  })

  test('[T011-13] numbers follow RFC 8785 Appendix B; strings use RFC 8785 escapes', () => {
    // RFC 8785 Appendix B: IEEE-754 bit pattern -> serialized number.
    const appendixB: [string, string][] = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ]
    for (const [bits, expected] of appendixB) {
      const view = new DataView(new ArrayBuffer(8))
      view.setBigUint64(0, BigInt(`0x${bits}`))
      expect(jcs(view.getFloat64(0)), bits).toBe(expected)
    }
    expect(jcs([1e-7, 2 ** 53, 1.5])).toBe('[1e-7,9007199254740992,1.5]')
    expect(jcs('\b\t\f\r\u001f\u007f/')).toBe('"\\b\\t\\f\\r\\u001f\u007f/"')
    expect(jcs(['\n', '\u0001', '"', '\\', '\u00e9', '\u2028'])).toBe('["\\n","\\u0001","\\"","\\\\","\u00e9","\u2028"]')
  })

  test('[T011-14] jcs rejects values JSON cannot represent exactly, and accepts JSON.parse output', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const accessor = Object.defineProperty({}, 'a', { get: () => 1, enumerable: true })
    // eslint-disable-next-line no-sparse-arrays
    const holey = [, 1]
    const notJson: unknown[] = [
      undefined, NaN, Infinity, -Infinity, () => 1, 1n, Symbol('s'), new Date(0), new Map(),
      { a: undefined }, [undefined], cyclic, { [Symbol('k')]: 1 }, accessor, holey,
      { toJSON: () => 'x' }, new (class X { a = 1 })(), Object.assign([1], { x: 2 }),
      JSON.parse('['.repeat(65) + ']'.repeat(65)),
    ]
    for (const value of notJson) expect(reasonOf(() => jcs(value)), String(value)).toBe('not_json')
    expect(reasonOf(() => jcs({ k: LONE_SURROGATE }))).toBe('invalid_utf8')
    expect(reasonOf(() => jcs({ [LONE_SURROGATE]: 1 }))).toBe('invalid_utf8')
    expect(jcs(JSON.parse('{"__proto__":1}'))).toBe('{"__proto__":1}')
    expect(jcs(JSON.parse('['.repeat(64) + ']'.repeat(64)))).toBe('['.repeat(64) + ']'.repeat(64))
    expect(reasonOf(() => jcs(JSON.parse('['.repeat(20000) + ']'.repeat(20000))))).toBe('not_json')
    const shared = {}
    expect(jcs({ a: shared, b: shared })).toBe('{"a":{},"b":{}}')
    const bare = Object.create(null) as Record<string, unknown>
    bare.z = 1
    bare.a = 'b'
    expect(jcs(bare)).toBe('{"a":"b","z":1}')
  })
})
