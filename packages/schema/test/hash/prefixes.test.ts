import { describe, expect, test } from 'vitest'
import { PREFIXES } from '../../src/index.ts'
import type { RegisteredPrefix } from '../../src/index.ts'
import { frameRecord, hashRecord } from '../../src/hash/content.ts'
import { hex, vector } from '../helpers/vectors.ts'

// The frozen contract (spec 013, RFC 04 §3.4). Changing any list requires a new prefix version,
// so this literal is never edited to make a test pass.
const FROZEN: Record<string, string[]> = {
  'sl:req:v1': ['site_id', 'request_id', 'rev', 'kind', 'parent_h_req', 'fields'],
  'sl:g1:v1': ['h_req', 'eligibility_class'],
  'sl:spec:v1': ['h_req', 'h_fb', 'envelope'],
  'sl:fb:v1': ['request_id', 'kind', 'body'],
  'sl:rework:v1': ['h_spec', 'h_fb'],
  'sl:hold_clear:v1': ['request_id', 'verdict_id', 'content_hash', 'l2_fingerprint'],
  'sl:l2:v1': ['trusted_sha', 'base_sha', 'entries'],
  'sl:rollout:v1': ['request_id', 'mode', 'value', 'doc_version'],
  'sl:enable_confirm:v1': ['request_id', 'deployment_id', 'flag_key'],
  'sl:notification_policy:v1': ['site_id', 'base_version', 'override'],
  'sl:site_config:v1': ['site_id', 'setting', 'base_version', 'value'],
  'sl:webauthn:v1': ['action', 'targets', 'content_hash', 'nonce'],
  // Added by spec 014 (new prefixes; the entries above are unchanged).
  'sl:authenticator:v1': ['owner_id', 'op', 'credential_id', 'public_key_cose'],
  'sl:bulk_reject:v1': ['site_id', 'request_ids'],
}

describe('PREFIXES registry', () => {
  test('[T013-13] every prefix and field list matches the frozen contract, in order', () => {
    expect(PREFIXES).toEqual(FROZEN)
    expect(Object.keys(PREFIXES)).toEqual(Object.keys(FROZEN))
  })

  test('[T013-13] the registry and every field list are frozen', () => {
    expect(Object.isFrozen(PREFIXES)).toBe(true)
    for (const fields of Object.values(PREFIXES)) expect(Object.isFrozen(fields)).toBe(true)
    expect(() => {
      ;(PREFIXES['sl:g1:v1'] as string[]).push('extra')
    }).toThrow(TypeError)
  })
})

describe('hashRecord and frameRecord', () => {
  test('[T013-15] frame the record in registry order regardless of the record key order', () => {
    const a = frameRecord('sl:g1:v1', { eligibility_class: 'small', h_req: 'x' })
    const b = frameRecord('sl:g1:v1', { h_req: 'x', eligibility_class: 'small' })
    expect(a).toEqual(b)
    expect(hashRecord('sl:g1:v1', { h_req: 'x', eligibility_class: 'small' })).toMatch(/^[0-9a-f]{64}$/)
  })

  test('[T013-15] frameRecord frames in registry order, matching the H-06a preimage', () => {
    const v = vector<{ hReq: string; eligibilityClass: string }>('hash.json', 'H-06a')
    const bytes = frameRecord('sl:g1:v1', { eligibility_class: v.input.eligibilityClass, h_req: v.input.hReq })
    expect(hex(bytes)).toBe(v.expected_bytes_hex)
  })

  test('[T013-15] an unregistered prefix, or a missing or extra key, is a TypeError', () => {
    expect(() => hashRecord('sl:test:v1' as RegisteredPrefix, {})).toThrow(TypeError)
    expect(() => hashRecord('sl:g1:v1', { h_req: 'x' })).toThrow(TypeError)
    expect(() => hashRecord('sl:g1:v1', { h_req: 'x', eligibility_class: 'y', extra: 'z' })).toThrow(TypeError)
    expect(() => hashRecord('toString' as RegisteredPrefix, {})).toThrow(TypeError)
  })
})
