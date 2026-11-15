import { z } from 'zod'
import { type IdPrefix, isId } from '../ids.ts'

// RFC 03 §2, in table order. `runs` is the lease authority, so no schema below admits lease
// data: every ctx is a strict object (spec 020, Appendix B).
export const STATES = Object.freeze([
  'intake', 'submitted', 'security_hold', 'owner_approved', 'planning', 'plan_review', 'plan_feedback',
  'needs_info', 'plan_approved', 'building', 'paused_rate_limited', 'stalled', 'in_review',
  'changes_requested', 'merged', 'deployed', 'enabled_for_requester', 'rollout_targeted',
  'rollout_percentage', 'rollout_all', 'flag_off', 'matched_existing', 'rejected', 'closed',
] as const)

export type State = (typeof STATES)[number]

export const LIVE_STATES = Object.freeze([
  'enabled_for_requester', 'rollout_targeted', 'rollout_percentage', 'rollout_all',
] as const satisfies readonly State[])

// P, the pre-merge states a hold can return to (RFC 03 §2, Zod m2), minus the hold itself.
const RETURN_TO = [
  'submitted', 'owner_approved', 'planning', 'plan_review', 'plan_feedback', 'needs_info', 'plan_approved',
  'building', 'paused_rate_limited', 'stalled', 'in_review', 'changes_requested', 'matched_existing',
] as const satisfies readonly State[]

const hex64 = z.string().regex(/^[0-9a-f]{64}$/)
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
const iso = z.iso.datetime({ offset: true })
const prNum = z.number().int().positive()
const str = z.string().min(1)
const id = (prefix: IdPrefix) => z.string().refine((v) => isId(prefix, v), `expected a ${prefix}_ ID`)

const stalledShape = {
  phase: z.enum(['plan', 'build']),
  reason: str,
  // Untrusted model output: any JSON value, including null, but the key must be present so the
  // stored ctx (after JSON.stringify drops undefined) still parses.
  advisory: z.unknown().refine((v) => v !== undefined, 'advisory is required (use null)'),
  feedback_id: id('fb').nullable(),
  rework_of: id('fb').nullable(),
  pr_number: prNum.nullable(),
}

const live = z.strictObject({ flag_id: id('sl'), archived: z.boolean() })

const STATE_CTX_SCHEMAS = {
  intake: z.strictObject({
    session_id: str,
    turns: z.array(z.strictObject({ role: z.enum(['requester', 'assistant']), text: z.string() })),
  }),
  submitted: z.strictObject({ rev: z.number().int().min(1), h_req: hex64 }),
  security_hold: z.strictObject({
    checkpoint: z.enum(['PC-S', 'PC-I', 'PC-A', 'PC-B', 'PC-C']),
    reason: z.enum(['flagged', 'precheck_unavailable']),
    verdict_id: id('pck'),
    content_hash: hex64,
    l2_fingerprint: hex64.nullable(),
    return_to: z.enum(RETURN_TO),
  }),
  owner_approved: z.strictObject({ h_req: hex64, approval_id: id('apr') }),
  planning: z.strictObject({ run_id: id('run'), base_sha: sha }),
  plan_review: z.strictObject({ spec_id: id('spec'), h_spec: hex64 }),
  plan_feedback: z.strictObject({ feedback_id: id('fb') }),
  needs_info: z.strictObject({ from: z.enum(['owner', 'requester']), question_id: id('q') }),
  plan_approved: z.strictObject({ h_spec: hex64, approval_id: id('apr') }),
  building: z.strictObject({
    sub: z.enum(['running', 'ready', 'submitting']),
    run_id: id('run'),
    head_branch: z.string().regex(/^soren-loop\/ref_[0-9A-Za-z]{22}\/[0-9]+$/),
    base_sha: sha,
    rework_of: id('fb').nullable(),
    head_sha: sha.nullable(),
  }),
  paused_rate_limited: z.strictObject({
    resume_to: z.enum(['planning', 'building']),
    resets_at: iso,
    run_id: id('run'),
    ...stalledShape,
  }),
  stalled: z.strictObject(stalledShape),
  in_review: z.strictObject({ pr_number: prNum, head_sha: sha }),
  changes_requested: z.strictObject({ feedback_id: id('fb'), pr_number: prNum }),
  merged: z.strictObject({ merge_sha: sha, merged_at: iso, needs_confirm: z.boolean() }),
  deployed: z.strictObject({ sub: z.enum(['queued', 'awaiting_confirm']), deployment_id: id('dep') }),
  enabled_for_requester: live,
  rollout_targeted: live,
  rollout_percentage: live,
  rollout_all: live,
  flag_off: z.strictObject({ previous: z.enum([...LIVE_STATES, 'none']) }),
  matched_existing: z.strictObject({ flag_id: id('sl'), needs_owner_confirm: z.boolean() }),
  rejected: z.strictObject({ reason: str }),
  closed: z.strictObject({ reason: z.enum(['withdrawn', 'no_response', 'pr_closed']) }),
} satisfies Record<State, z.ZodType>

export type StateCtx = { [S in State]: z.infer<(typeof STATE_CTX_SCHEMAS)[S]> }

export class StateCtxError extends Error {
  readonly state: string
  readonly issues: string[]

  constructor(state: string, issues: string[]) {
    super(`invalid state_ctx for ${state}: ${issues.join('; ')}`)
    this.name = 'StateCtxError'
    this.state = state
    this.issues = issues
  }
}

export function parseStateCtx<S extends State>(state: S, ctx: unknown): StateCtx[S] {
  if (!Object.hasOwn(STATE_CTX_SCHEMAS, state)) throw new StateCtxError(String(state), ['unknown state'])
  const result = STATE_CTX_SCHEMAS[state].safeParse(ctx)
  if (!result.success) {
    throw new StateCtxError(state, result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))
  }
  return result.data as StateCtx[S]
}
