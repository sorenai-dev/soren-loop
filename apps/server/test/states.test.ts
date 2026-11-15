import { expect, test } from 'vitest'
import { encodeId } from '../src/ids.ts'
import { LIVE_STATES, type State, STATES, StateCtxError, parseStateCtx } from '../src/machine/states.ts'

// Fixture IDs and hashes are fixed so each ctx below is a literal from spec 020 Appendix B.
const id = (p: Parameters<typeof encodeId>[0], n: number) => encodeId(p, new Uint8Array(16).fill(n))
const HEX = 'a'.repeat(64)
const SHA40 = 'b'.repeat(40)
const ISO = '2026-11-15T12:00:00Z'
const stalledFields = { phase: 'build', reason: 'checks_failed', advisory: { note: 'x' }, feedback_id: null, rework_of: null, pr_number: null }

const VALID: Record<State, Record<string, unknown>> = {
  intake: { session_id: 's1', turns: [{ role: 'requester', text: 'hi' }] },
  submitted: { rev: 1, h_req: HEX },
  security_hold: {
    checkpoint: 'PC-S', reason: 'flagged', verdict_id: id('pck', 1), content_hash: HEX,
    l2_fingerprint: null, return_to: 'submitted',
  },
  owner_approved: { h_req: HEX, approval_id: id('apr', 1) },
  planning: { run_id: id('run', 1), base_sha: SHA40 },
  plan_review: { spec_id: id('spec', 1), h_spec: HEX },
  plan_feedback: { feedback_id: id('fb', 1) },
  needs_info: { from: 'owner', question_id: id('q', 1) },
  plan_approved: { h_spec: HEX, approval_id: id('apr', 2) },
  building: {
    sub: 'running', run_id: id('run', 2), head_branch: `soren-loop/${id('ref', 1)}/1`, base_sha: SHA40,
    rework_of: null, head_sha: null,
  },
  paused_rate_limited: { resume_to: 'building', resets_at: ISO, run_id: id('run', 3), ...stalledFields },
  stalled: stalledFields,
  in_review: { pr_number: 7, head_sha: 'c'.repeat(64) },
  changes_requested: { feedback_id: id('fb', 2), pr_number: 7 },
  merged: { merge_sha: SHA40, merged_at: ISO, needs_confirm: false },
  deployed: { sub: 'queued', deployment_id: id('dep', 1) },
  enabled_for_requester: { flag_id: id('sl', 1), archived: false },
  rollout_targeted: { flag_id: id('sl', 1), archived: false },
  rollout_percentage: { flag_id: id('sl', 1), archived: false },
  rollout_all: { flag_id: id('sl', 1), archived: true },
  flag_off: { previous: 'none' },
  matched_existing: { flag_id: id('sl', 2), needs_owner_confirm: true },
  rejected: { reason: 'out of scope' },
  closed: { reason: 'withdrawn' },
}

test('[T020-12] STATES is the 03 §2 list in table order; every state needs a field', () => {
  expect(STATES).toEqual([
    'intake', 'submitted', 'security_hold', 'owner_approved', 'planning', 'plan_review', 'plan_feedback',
    'needs_info', 'plan_approved', 'building', 'paused_rate_limited', 'stalled', 'in_review',
    'changes_requested', 'merged', 'deployed', 'enabled_for_requester', 'rollout_targeted',
    'rollout_percentage', 'rollout_all', 'flag_off', 'matched_existing', 'rejected', 'closed',
  ])
  expect(LIVE_STATES).toEqual(['enabled_for_requester', 'rollout_targeted', 'rollout_percentage', 'rollout_all'])
  for (const state of STATES) {
    let error: unknown
    try {
      parseStateCtx(state, {})
    } catch (e) {
      error = e
    }
    expect(error, state).toBeInstanceOf(StateCtxError)
    expect((error as StateCtxError).state).toBe(state)
    expect((error as StateCtxError).issues.length, state).toBeGreaterThan(0)
  }
})

test('[T020-13] one Appendix B ctx per state parses unchanged', () => {
  expect(Object.keys(VALID).sort()).toEqual([...STATES].sort())
  for (const state of STATES) expect(parseStateCtx(state, VALID[state]), state).toEqual(VALID[state])
})

test('[T020-14] ctxs outside Appendix B are rejected, including lease data', () => {
  const bad: [State, Record<string, unknown>][] = [
    ['submitted', { rev: 1 }],
    ['planning', { ...VALID.planning, lease_id: 'x' }],
    ['security_hold', { ...VALID.security_hold, reason: 'other' }],
    ['building', { ...VALID.building, head_branch: 'main' }],
    ['merged', { ...VALID.merged, merged_at: 'yesterday' }],
    ['flag_off', { previous: 'merged' }],
    ['stalled', { ...stalledFields, advisory: undefined }],
  ]
  for (const [state, ctx] of bad) expect(() => parseStateCtx(state, ctx), state).toThrow(StateCtxError)
  expect(() => parseStateCtx('bogus' as State, {})).toThrow(StateCtxError)
})
