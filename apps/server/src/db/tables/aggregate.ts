import type { Generated, GeneratedAlways } from 'kysely'
import type { State } from '../../machine/states.ts'
import type { CreatedAt, Json, JsonDefault, Timestamp } from './identity.ts'

// The request aggregate (RFC 04 §2; spec 020 Appendix A).

export interface RequestsTable {
  id: string
  public_ref: string
  site_id: string
  requester_id: string
  state: State
  state_ctx: Json<Record<string, unknown>>
  version: Generated<number>
  current_rev: number
  h_req_current: string
  h_spec_current: string | null
  eligibility_class: string | null
  throttled: Generated<boolean>
  requester_opted_out: Generated<boolean>
  duplicate_of: string | null
  flag_id: string | null
  pr_number: number | null
  merge_sha: string | null
  created_at: CreatedAt
  closed_at: Timestamp | null
  purge_after: Timestamp | null
  text_purge_after: Timestamp | null
}

export interface RequestRevisionsTable {
  id: string
  site_id: string
  request_id: string
  rev: number
  kind: 'requester' | 'owner_context'
  fields: Json<unknown>
  stripped: JsonDefault<unknown>
  h_req: string
  parent_h_req: string | null
  created_at: CreatedAt
}

export interface SpecsTable {
  id: string
  site_id: string
  request_id: string
  version: number
  envelope: Json<unknown>
  h_spec: string
  parent_h_req: string
  h_fb: string | null
  base_sha: string
  uploaded_by_run: string
  review_aids: Json<unknown> | null
  created_at: CreatedAt
}

export interface FeedbackTable {
  id: string
  site_id: string
  request_id: string
  kind: 'plan' | 'rework'
  body: string
  h_fb: string
  author: 'owner' | 'owner_github_review'
  approval_id: string | null
  created_at: CreatedAt
}

export interface QuestionsTable {
  id: string
  site_id: string
  request_id: string
  body: string
  asked_by: string
  answered_rev: number | null
  created_at: CreatedAt
}

export interface RequestTransitionsTable {
  seq: GeneratedAlways<string>
  site_id: string
  request_id: string
  from_state: string | null
  to_state: string | null
  event: string
  actor_type: 'requester' | 'owner' | 'cli_for_owner' | 'github' | 'system'
  actor_id: string | null
  cli_token_id: string | null
  approval_id: string | null
  idempotency_key: string | null
  payload_digest: string | null
  at: CreatedAt
}

export interface RequesterEventsTable {
  seq: GeneratedAlways<string>
  site_id: string
  request_id: string
  stage: 'received' | 'needs_your_input' | 'planning' | 'building' | 'shipping' | 'available' | 'closed'
  stage_since: Timestamp
  transition_seq: string | number | bigint
  at: CreatedAt
}
