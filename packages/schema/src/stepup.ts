// Step-up challenge derivation (spec 014, RFC 04 §3.4, 05 §1.2, SR-05, SR-35). One passkey tap
// signs over this challenge, so it binds exactly one action, one target set and one content hash.
import { hexToBytes } from '@noble/hashes/utils.js'
import { encodeBase64url } from './base64url.ts'
import { BULK_REJECT_MAX, contentHash } from './hash/content.ts'
import { compareUtf8 } from './hash/framing.ts'
import { jcs } from './hash/jcs.ts'
import { hash, id, invalid } from './hash/validate.ts'
import { assertWellFormed } from './utf8.ts'
import type { ContentHash } from './hash/content.ts'
import type { RegisteredPrefix } from './hash/prefixes.ts'

export type StepupAction =
  | 'request.approve' | 'spec.approve' | 'hold.clear' | 'rework.approve' | 'rollout.widen'
  | 'enablement.confirm' | 'notification_policy.update' | 'site_config.update'
  | 'authenticator.add' | 'authenticator.remove' | 'requests.bulk_reject'
export type TargetType = 'request' | 'site' | 'verdict' | 'owner' | 'outbox'
export interface Target { type: TargetType; id: string }
export type TargetShape =
  | { kind: 'exact'; types: readonly TargetType[] }
  | { kind: 'many'; type: TargetType; max: number }
export interface ChallengeInput {
  action: StepupAction
  targets: readonly Target[]
  contentHash: string
  nonce: string
}

export const TARGET_TYPES: readonly TargetType[] = Object.freeze(['request', 'site', 'verdict', 'owner', 'outbox'])

// Exact shapes keep their types in UTF-8 order, the order checkTargets compares against.
const exact = (...types: TargetType[]): TargetShape =>
  Object.freeze({ kind: 'exact', types: Object.freeze(types.sort(compareUtf8)) })

// Spec 014 DD1: each action's content-hash prefix and the targets it binds.
const ACTIONS: Readonly<Record<StepupAction, { prefix: RegisteredPrefix; shape: TargetShape }>> = Object.freeze({
  'request.approve': { prefix: 'sl:g1:v1', shape: exact('request') },
  'spec.approve': { prefix: 'sl:spec:v1', shape: exact('request') },
  'hold.clear': { prefix: 'sl:hold_clear:v1', shape: exact('request', 'verdict') },
  'rework.approve': { prefix: 'sl:rework:v1', shape: exact('request') },
  'rollout.widen': { prefix: 'sl:rollout:v1', shape: exact('request') },
  'enablement.confirm': { prefix: 'sl:enable_confirm:v1', shape: exact('request') },
  'notification_policy.update': { prefix: 'sl:notification_policy:v1', shape: exact('site') },
  'site_config.update': { prefix: 'sl:site_config:v1', shape: exact('site') },
  'authenticator.add': { prefix: 'sl:authenticator:v1', shape: exact('owner') },
  'authenticator.remove': { prefix: 'sl:authenticator:v1', shape: exact('owner') },
  'requests.bulk_reject': {
    prefix: 'sl:bulk_reject:v1', shape: Object.freeze({ kind: 'many', type: 'request', max: BULK_REJECT_MAX }),
  },
})

export const STEPUP_ACTIONS: readonly StepupAction[] = Object.freeze(Object.keys(ACTIONS) as StepupAction[])

function entry(action: StepupAction): { prefix: RegisteredPrefix; shape: TargetShape } {
  if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) throw invalid(`unknown step-up action ${String(action)}`)
  return ACTIONS[action]
}

export const contentHashPrefixFor = (action: StepupAction): RegisteredPrefix => entry(action).prefix
export const targetShapeFor = (action: StepupAction): TargetShape => entry(action).shape

const byTypeThenId = (a: Target, b: Target): number => compareUtf8(a.type, b.type) || compareUtf8(a.id, b.id)

/** Validates targets against the action's shape and returns fresh {id, type} objects, sorted. */
function checkTargets(shape: TargetShape, targets: readonly Target[]): Target[] {
  if (!Array.isArray(targets)) throw invalid('targets must be an array')
  const max = shape.kind === 'exact' ? shape.types.length : shape.max
  if (targets.length < 1 || targets.length > max) throw invalid('targets do not match the action')
  const sorted = targets.map((t: Target) => {
    if (typeof t !== 'object' || t === null || !TARGET_TYPES.includes(t.type)) throw invalid('unknown target type')
    id('target id', t.id)
    assertWellFormed(t.id)
    return { id: t.id, type: t.type }
  }).sort(byTypeThenId)
  if (sorted.some((t, i) => i > 0 && byTypeThenId(t, sorted[i - 1] as Target) === 0)) throw invalid('duplicate target')
  const types = sorted.map((t) => t.type)
  const fits = shape.kind === 'exact'
    ? types.length === shape.types.length && shape.types.every((ty, i) => ty === types[i])
    : types.length >= 1 && types.length <= shape.max && types.every((ty) => ty === shape.type)
  if (!fits) throw invalid('targets do not match the action')
  return sorted
}

const NONCE = /^[0-9a-f]{32}$/

export const deriveChallenge: ContentHash<[ChallengeInput]> = contentHash('sl:webauthn:v1', (c: ChallengeInput) => {
  const { shape } = entry(c.action)
  const targets = checkTargets(shape, c.targets)
  if (typeof c.nonce !== 'string' || !NONCE.test(c.nonce)) throw invalid('nonce must be 32 lowercase hex')
  return {
    action: c.action,
    targets: jcs(targets),
    content_hash: hash('contentHash', c.contentHash),
    nonce: c.nonce,
  }
})

/** The clientDataJSON.challenge value: unpadded base64url of the 32 digest bytes (DD6). */
export function webauthnChallenge(challengeHex: string): string {
  return encodeBase64url(hexToBytes(hash('challenge', challengeHex)))
}
