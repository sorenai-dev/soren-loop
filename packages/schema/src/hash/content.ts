// One content hash per approvable thing (RFC 04 §3.4). Each frames a record in its registry
// field order, so the code and the registry cannot drift, and each exposes .preimage() for
// vector tests.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { isCanonicalBase64url } from '../base64url.ts'
import { SchemaError } from '../errors.ts'
import { nHash } from '../normalize/normalize.ts'
import { parseRequestV1 } from '../request.ts'
import type { RequestV1 } from '../request.ts'
import { P, byteSort, compareUtf8, frame, sortedUnique } from './framing.ts'
import { jcs } from './jcs.ts'
import { PREFIXES } from './prefixes.ts'
import { hash, id, int, invalid, oneOf, optionalHash } from './validate.ts'
import type { RegisteredPrefix } from './prefixes.ts'

export type ContentHash<A extends unknown[]> = ((...args: A) => string) & {
  preimage: (...args: A) => Uint8Array
}

/** Frames a record in PREFIXES order. A missing or extra key is a programmer error. */
export function frameRecord(prefix: RegisteredPrefix, record: Readonly<Record<string, string>>): Uint8Array {
  if (!Object.hasOwn(PREFIXES, prefix)) throw new TypeError(`unregistered prefix ${prefix}`)
  const names = PREFIXES[prefix]
  const keys = Object.keys(record)
  if (keys.length !== names.length || !names.every((n) => Object.hasOwn(record, n))) {
    throw new TypeError(`${prefix} record keys [${keys.join(', ')}] do not match [${names.join(', ')}]`)
  }
  return frame(prefix, names.map((n) => record[n] as string))
}

export function hashRecord(prefix: RegisteredPrefix, record: Readonly<Record<string, string>>): string {
  return bytesToHex(sha256(frameRecord(prefix, record)))
}

export function contentHash<A extends unknown[]>(
  prefix: RegisteredPrefix,
  toRecord: (...args: A) => Record<string, string>,
): ContentHash<A> {
  const preimage = (...args: A): Uint8Array => frameRecord(prefix, toRecord(...args))
  return Object.assign((...args: A): string => bytesToHex(sha256(preimage(...args))), { preimage })
}

function assertNormalized(fields: RequestV1): void {
  const strings = [fields.title, fields.problem, ...fields.acceptance_criteria, fields.area, fields.owner_context]
  for (const s of strings) {
    if (s !== null && nHash(s) !== s) throw new SchemaError('not_normalized', 'request fields must be N_intake output')
  }
}

export interface ReqInput {
  siteId: string
  requestId: string
  rev: number
  kind: 'requester' | 'owner_context'
  parentHReq: string | null
  fields: unknown
}

export const hReq = contentHash('sl:req:v1', (r: ReqInput) => {
  const fields = parseRequestV1(r.fields)
  assertNormalized(fields)
  const rev = int('rev', r.rev, 1)
  oneOf('kind', r.kind, ['requester', 'owner_context'])
  if (r.rev === 1 && (r.parentHReq !== null || r.kind !== 'requester')) {
    throw invalid('rev 1 is a requester revision with no parent')
  }
  if (r.rev > 1 && r.parentHReq === null) throw invalid(`rev ${r.rev} needs parent_h_req`)
  return {
    site_id: id('siteId', r.siteId),
    request_id: id('requestId', r.requestId),
    rev,
    kind: r.kind,
    parent_h_req: optionalHash('parentHReq', r.parentHReq),
    fields: jcs(fields),
  }
})

export const hG1 = contentHash('sl:g1:v1', (hReqValue: string, eligibilityClass: string) => ({
  h_req: hash('hReq', hReqValue),
  eligibility_class: id('eligibilityClass', eligibilityClass),
}))

export const hSpec = contentHash(
  'sl:spec:v1',
  (s: { hReq: string; hFb: string | null; bodyMd: string; paths: readonly string[] }) => ({
    h_req: hash('hReq', s.hReq),
    h_fb: optionalHash('hFb', s.hFb),
    envelope: jcs({ body_md: nHash(s.bodyMd), paths: sortedUnique(s.paths.map(P)) }),
  }),
)

export const hFb = contentHash('sl:fb:v1', (f: { requestId: string; kind: 'plan' | 'rework'; body: string }) => ({
  request_id: id('requestId', f.requestId),
  kind: oneOf('kind', f.kind, ['plan', 'rework']),
  body: nHash(f.body),
}))

export const hRework = contentHash('sl:rework:v1', (r: { hSpec: string; hFb: string }) => ({
  h_spec: hash('hSpec', r.hSpec),
  h_fb: hash('hFb', r.hFb),
}))

export const hHoldClear = contentHash(
  'sl:hold_clear:v1',
  (c: { requestId: string; verdictId: string; contentHash: string; l2Fingerprint: string | null }) => ({
    request_id: id('requestId', c.requestId),
    verdict_id: id('verdictId', c.verdictId),
    content_hash: hash('contentHash', c.contentHash),
    l2_fingerprint: optionalHash('l2Fingerprint', c.l2Fingerprint),
  }),
)

export interface L2Entry {
  path: string
  status: string
  blobSha: string
}

export const l2Fingerprint = contentHash(
  'sl:l2:v1',
  (l: { trustedSha: string; baseSha: string; entries: readonly L2Entry[] }) => {
    const entries = l.entries
      .map((e) => ({ path: P(e.path), status: id('status', e.status), blob_sha: id('blobSha', e.blobSha) }))
      .sort((a, b) => compareUtf8(a.path, b.path))
    // Equal sort keys would leave the order ambiguous, so a duplicate path is rejected.
    if (entries.some((e, i) => i > 0 && e.path === entries[i - 1]?.path)) throw invalid('duplicate L2 path')
    return { trusted_sha: id('trustedSha', l.trustedSha), base_sha: id('baseSha', l.baseSha), entries: jcs(entries) }
  },
)

export type RolloutInput = { requestId: string; docVersion: number } & (
  | { mode: 'targets'; targets: readonly string[] }
  | { mode: 'bp'; bp: number }
  | { mode: 'all' }
)

const MAX_TARGETS = 500 // flags.targets (RFC 04 §2)
/** Shared by hBulkReject and the bulk-reject challenge shape (spec 014 DD7), so they can't drift. */
export const BULK_REJECT_MAX = 500

function rolloutValue(r: RolloutInput): string {
  switch (r.mode) {
    case 'targets': {
      const targets = sortedUnique(r.targets.map((t) => id('target', t)))
      if (targets.length < 1 || targets.length > MAX_TARGETS) throw invalid(`targets must hold 1..${MAX_TARGETS} unique ids`)
      return jcs(targets)
    }
    case 'bp':
      return int('bp', r.bp, 0, 10_000)
    case 'all':
      return 'all'
    default:
      throw invalid('mode must be targets, bp or all')
  }
}

export const hRollout = contentHash('sl:rollout:v1', (r: RolloutInput) => ({
  request_id: id('requestId', r.requestId),
  mode: r.mode,
  value: rolloutValue(r),
  doc_version: int('docVersion', r.docVersion, 0),
}))

export const hEnableConfirm = contentHash(
  'sl:enable_confirm:v1',
  (e: { requestId: string; deploymentId: string; flagKey: string }) => ({
    request_id: id('requestId', e.requestId),
    deployment_id: id('deploymentId', e.deploymentId),
    flag_key: id('flagKey', e.flagKey),
  }),
)

export const hNotificationPolicy = contentHash(
  'sl:notification_policy:v1',
  (n: { siteId: string; baseVersion: number; override: unknown }) => ({
    site_id: id('siteId', n.siteId),
    base_version: int('baseVersion', n.baseVersion, 0),
    override: jcs(n.override),
  }),
)

export const hSiteConfig = contentHash(
  'sl:site_config:v1',
  (c: { siteId: string; setting: string; baseVersion: number; value: unknown }) => ({
    site_id: id('siteId', c.siteId),
    setting: id('setting', c.setting),
    base_version: int('baseVersion', c.baseVersion, 0),
    value: jcs(c.value),
  }),
)

// Spec 014: content hashes for step-up actions the RFC table has no prefix for.
function canonicalB64(name: string, value: string): string {
  if (value === '' || !isCanonicalBase64url(value)) throw invalid(`${name} must be canonical unpadded base64url`)
  return value
}

export const hAuthenticator = contentHash(
  'sl:authenticator:v1',
  (a: { ownerId: string; op: 'add' | 'remove'; credentialId: string; publicKeyCose: string }) => ({
    owner_id: id('ownerId', a.ownerId),
    op: oneOf('op', a.op, ['add', 'remove']),
    credential_id: canonicalB64('credentialId', a.credentialId),
    public_key_cose: canonicalB64('publicKeyCose', a.publicKeyCose),
  }),
)

export const hBulkReject = contentHash('sl:bulk_reject:v1', (b: { siteId: string; requestIds: readonly string[] }) => {
  const n = Array.isArray(b.requestIds) ? b.requestIds.length : 0
  if (n < 1 || n > BULK_REJECT_MAX) throw invalid(`requestIds must be an array of 1..${BULK_REJECT_MAX} ids`)
  const ids = byteSort(b.requestIds.map((r) => id('requestId', r)))
  // A bulk reject authorizes an enumerated set (SR-35), so a duplicate is a caller error.
  if (ids.some((r, i) => i > 0 && r === ids[i - 1])) throw invalid('duplicate request id')
  return { site_id: id('siteId', b.siteId), request_ids: jcs(ids) }
})
