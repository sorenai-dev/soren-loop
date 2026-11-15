// The vector conformance runner (spec 016, RFC 04 §3.5). Any implementation of the package's
// contract (the server, the dashboard, the CLI, a third party) passes its functions here and gets
// one result per vector. The runner never throws: every failure is a result.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import challengeJson from '../../test-vectors/challenge.json' with { type: 'json' }
import hashJson from '../../test-vectors/hash.json' with { type: 'json' }
import normalizeJson from '../../test-vectors/normalize.json' with { type: 'json' }
import receiptJson from '../../test-vectors/receipt.json' with { type: 'json' }
import type {
  P, byteSort, deriveChallenge, frame, hAuthenticator, hBulkReject, hEnableConfirm, hFb, hG1, hHoldClear,
  hNotificationPolicy, hReq, hRework, hRollout, hSiteConfig, hSpec, hashFields, jcs, l2Fingerprint, nHash, nIntake,
  webauthnChallenge,
} from '../index.ts'
// Through the package's own subpath: only the verifier module may import its own file (T015-15).
import type { growPinSet, verifyReceipt } from '@sorenai/loop-schema/receipt'

export type VectorFile = 'normalize.json' | 'hash.json' | 'challenge.json' | 'receipt.json'
export interface VectorResult { file: VectorFile; id: string; ok: boolean; checks: number; message?: string }
export interface Report { results: VectorResult[]; passed: number; failed: number; skipped: number }
export interface VectorImpl {
  nIntake: typeof nIntake; nHash: typeof nHash; frame: typeof frame; hashFields: typeof hashFields
  byteSort: typeof byteSort; P: typeof P; jcs: typeof jcs
  hReq: typeof hReq; hG1: typeof hG1; hSpec: typeof hSpec; hFb: typeof hFb; hRework: typeof hRework
  hHoldClear: typeof hHoldClear; l2Fingerprint: typeof l2Fingerprint; hRollout: typeof hRollout
  hEnableConfirm: typeof hEnableConfirm; hNotificationPolicy: typeof hNotificationPolicy
  hSiteConfig: typeof hSiteConfig; hAuthenticator: typeof hAuthenticator; hBulkReject: typeof hBulkReject
  deriveChallenge: typeof deriveChallenge; webauthnChallenge: typeof webauthnChallenge
  verifyReceipt: typeof verifyReceipt; growPinSet: typeof growPinSet
}

export const VECTORS: Readonly<Record<VectorFile, readonly unknown[]>> = Object.freeze({
  'normalize.json': normalizeJson, 'hash.json': hashJson, 'challenge.json': challengeJson, 'receipt.json': receiptJson,
})

/* eslint-disable @typescript-eslint/no-explicit-any -- vectors are untyped JSON by design */
type Json = any
type Fn = (...args: Json[]) => Json

/** Content hashes whose vector input is not a single object argument. */
const ARGS: Partial<Record<keyof VectorImpl, (input: Json) => Json[]>> = {
  hG1: (i) => [i.hReq, i.eligibilityClass],
}
const CONTENT = new Set<keyof VectorImpl>([
  'hReq', 'hG1', 'hSpec', 'hFb', 'hRework', 'hHoldClear', 'l2Fingerprint', 'hRollout', 'hEnableConfirm',
  'hNotificationPolicy', 'hSiteConfig', 'hAuthenticator', 'hBulkReject', 'deriveChallenge',
])
const EXPECTATIONS = [
  'expected_error', 'expected_normalized', 'expected_stripped', 'expected_sorted', 'expected_hash',
  'expected_bytes_hex', 'expected_webauthn_challenge', 'expected_result', 'expected_add_hash',
]

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as Json)[k], (b as Json)[k]))
}

const utf8 = new TextEncoder()
const show = (x: unknown): string => {
  try {
    return JSON.stringify(x) ?? String(x)
  } catch {
    return String(x)
  }
}

/** Collects the outcome of each comparison for one vector, and which expectations it used. */
class Checker {
  checks = 0
  skipped = 0
  failures: string[] = []
  used = new Set<string>()
  equal(what: string, actual: unknown, expected: unknown, key: string): void {
    this.used.add(key)
    this.checks++
    if (!deepEqual(actual, expected)) this.failures.push(`${what}: got ${show(actual)}, want ${show(expected)}`)
  }
  skip(key: string): void {
    this.used.add(key)
    this.skipped++
  }
  async throws(what: string, run: () => unknown, reason: string): Promise<void> {
    this.used.add('expected_error')
    this.checks++
    try {
      await run()
      this.failures.push(`${what}: did not throw, want ${reason}`)
    } catch (error) {
      // Only the reason is compared, never instanceof: another build of the package can pass.
      const got = (error as { reason?: unknown } | null)?.reason
      if (got !== reason) this.failures.push(`${what}: threw ${show(got ?? String(error))}, want ${reason}`)
    }
  }
}

async function checkFn(impl: VectorImpl, name: keyof VectorImpl, v: Json, c: Checker): Promise<void> {
  const fn = impl[name] as unknown as Fn & { preimage?: Fn }
  if (typeof fn !== 'function') throw new Error('the impl has no such function')
  const i = v.input
  switch (name) {
    case 'nIntake':
    case 'nHash': {
      const field = i.text_hex === undefined ? i.text : hexToBytes(i.text_hex)
      const run = (): Json => fn(field, i.cap)
      if (v.expected_error !== undefined) return c.throws(name, run, v.expected_error)
      const out = run()
      c.equal(name, name === 'nIntake' ? out.value : out, v.expected_normalized, 'expected_normalized')
      if (name === 'nIntake' && v.expected_stripped !== undefined) {
        c.equal('nIntake stripped', out.stripped, v.expected_stripped, 'expected_stripped')
      }
      return
    }
    case 'byteSort':
      return c.equal(name, fn(i.unsorted), v.expected_sorted, 'expected_sorted')
    case 'frame':
    case 'hashFields': {
      const out = fn(i.prefix, i.fields ?? impl.byteSort(i.unsorted))
      if (name === 'frame') c.equal(name, bytesToHex(out), v.expected_bytes_hex, 'expected_bytes_hex')
      else c.equal(name, out, v.expected_hash, 'expected_hash')
      return
    }
    case 'P':
      for (const p of [...(i.path === undefined ? [] : [i.path]), ...(i.same ?? [])]) {
        c.equal(`P(${p})`, fn(p), v.expected_normalized, 'expected_normalized')
      }
      if (i.rejected !== undefined) await c.throws(`P(${i.rejected})`, () => fn(i.rejected), v.expected_error)
      return
    case 'jcs':
      return c.equal(name, bytesToHex(utf8.encode(fn(i.value))), v.expected_bytes_hex, 'expected_bytes_hex')
    case 'webauthnChallenge':
      return c.equal(name, fn(impl.deriveChallenge(i)), v.expected_webauthn_challenge, 'expected_webauthn_challenge')
    case 'verifyReceipt':
      return c.equal(name, await fn(i), v.expected_result, 'expected_result')
    case 'growPinSet':
      c.equal(name, await fn(i.pin, i.add), v.expected_result, 'expected_result')
      if (v.expected_add_hash !== undefined) {
        const addHash = impl.hAuthenticator({ ownerId: i.pin.ownerId, op: 'add', ...i.add.key })
        c.equal('hAuthenticator add hash', addHash, v.expected_add_hash, 'expected_add_hash')
      }
      return
    default: {
      if (!CONTENT.has(name)) throw new Error('no runner for this function')
      const args = ARGS[name]?.(i) ?? [i]
      if (v.expected_error !== undefined) return c.throws(name, () => fn(...args), v.expected_error)
      c.equal(name, fn(...args), v.expected_hash, 'expected_hash')
      if (v.expected_bytes_hex === undefined) return
      if (typeof fn.preimage === 'function') {
        c.equal(`${name}.preimage`, bytesToHex(fn.preimage(...args)), v.expected_bytes_hex, 'expected_bytes_hex')
      } else {
        c.skip('expected_bytes_hex')
      }
    }
  }
}

type Outcome = VectorResult & { skipped: number }

const outcome = (file: string, id: string, c: Checker): Outcome => {
  const ok = c.failures.length === 0 && c.checks > 0
  const message = c.failures.length > 0 ? c.failures.join('; ') : c.checks === 0 ? 'no checks ran' : undefined
  return { file: file as VectorFile, id, ok, checks: c.checks, skipped: c.skipped, ...(message === undefined ? {} : { message }) }
}

async function runOne(impl: VectorImpl, file: VectorFile, v: Json): Promise<Outcome> {
  const c = new Checker()
  const id = String(v?.id)
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    c.failures.push('not a vector record')
    return outcome(file, id, c)
  }
  const unknown = Object.keys(v).filter((k) => k.startsWith('expected_') && !EXPECTATIONS.includes(k))
  if (unknown.length > 0) c.failures.push(`unknown expectation ${unknown.join(', ')}`)
  if (!EXPECTATIONS.some((k) => v[k] !== undefined)) c.failures.push('no expectation')
  const names: unknown[] = Array.isArray(v.fn) ? v.fn : [v.fn]
  for (const name of names) {
    if (typeof name !== 'string' || !Object.hasOwn(impl, name)) {
      c.failures.push(`unknown fn ${show(name)}`)
      continue
    }
    // Each function runs on its own: one that throws is named and the rest still run.
    try {
      await checkFn(impl, name as keyof VectorImpl, v, c)
    } catch (error) {
      c.failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (c.failures.length === 0) {
    const unused = EXPECTATIONS.filter((k) => v[k] !== undefined && !c.used.has(k))
    if (unused.length > 0) c.failures.push(`unused expectation ${unused.join(', ')}`)
  }
  return outcome(file, id, c)
}

const FILES = Object.keys(VECTORS) as VectorFile[]

export async function runVectors(
  impl: VectorImpl,
  vectors?: Partial<Record<VectorFile, readonly unknown[]>> | null,
): Promise<Report> {
  const outcomes: Outcome[] = []
  const bad = (file: string, why: string): void => {
    const c = new Checker()
    c.failures.push(why)
    outcomes.push(outcome(file, '*', c))
  }
  const sets: Record<string, unknown> = vectors ?? VECTORS
  if (typeof impl !== 'object' || impl === null) bad('*', 'impl is not an object')
  else if (typeof sets !== 'object' || Array.isArray(sets)) bad('*', 'vectors is not an object of vector files')
  else {
    // Fixed file order, whatever the caller's key order.
    for (const file of FILES) {
      const list = sets[file]
      if (list === undefined) continue
      if (!Array.isArray(list)) {
        bad(file, 'not an array of vectors')
        continue
      }
      for (const v of list) outcomes.push(await runOne(impl, file, v))
    }
    for (const file of Object.keys(sets).filter((k) => !FILES.includes(k as VectorFile))) bad(file, 'not a vector file')
  }
  const results: VectorResult[] = outcomes.map((o) => {
    const { skipped, ...r } = o
    void skipped
    return r
  })
  const passed = results.filter((r) => r.ok).length
  return { results, passed, failed: results.length - passed, skipped: outcomes.reduce((n, o) => n + o.skipped, 0) }
}
