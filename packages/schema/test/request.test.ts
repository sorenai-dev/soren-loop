import { describe, expect, test } from 'vitest'
import { RequestV1Schema, parseRequestV1 } from '../src/index.ts'
import { reasonOf } from './helpers/vectors.ts'

const valid = {
  title: 'Export CSV',
  problem: 'I need my data.',
  acceptance_criteria: ['A button exports CSV'],
  area: null,
  owner_context: null,
}

describe('sl.request.v1 (closed schema)', () => {
  test('[T013-4] a complete object parses, with null kept rather than omitted', () => {
    expect(parseRequestV1(valid)).toEqual(valid)
    expect(parseRequestV1({ ...valid, area: 'billing', acceptance_criteria: [] })).toEqual({
      ...valid,
      area: 'billing',
      acceptance_criteria: [],
    })
  })

  test('[T013-4] H-05 every key is required: a missing key is missing_key', () => {
    for (const key of Object.keys(valid)) {
      const rest: Record<string, unknown> = { ...valid }
      delete rest[key]
      expect(reasonOf(() => parseRequestV1(rest)), key).toBe('missing_key')
    }
  })

  test('[T013-4] an extra key is unknown_key, including eligibility_class', () => {
    expect(reasonOf(() => parseRequestV1({ ...valid, eligibility_class: 'small' }))).toBe('unknown_key')
  })

  test('[T013-4] a wrong type is invalid_type', () => {
    const bad = [
      { ...valid, title: 1 },
      { ...valid, area: undefined },
      { ...valid, acceptance_criteria: 'one' },
      { ...valid, acceptance_criteria: [1] },
      { ...valid, owner_context: false },
    ]
    for (const b of bad) expect(reasonOf(() => parseRequestV1(b)), JSON.stringify(b)).toBe('invalid_type')
    for (const notObject of [null, [], 'x', 1]) expect(reasonOf(() => parseRequestV1(notObject))).toBe('invalid_type')
  })

  test('[T013-4] RequestV1Schema is strict and carries no length cap (caps are code points, in nIntake)', () => {
    expect(RequestV1Schema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
    expect(RequestV1Schema.safeParse({ ...valid, title: 'x'.repeat(100_000) }).success).toBe(true)
  })
})
