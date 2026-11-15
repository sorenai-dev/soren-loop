// The prefix registry (RFC 04 §3.4). Each field list is frozen per version: changing one means
// a new prefix version and a major release of @sorenai/loop-schema.
const fields = (...names: string[]): readonly string[] => Object.freeze(names)

export const PREFIXES = Object.freeze({
  'sl:req:v1': fields('site_id', 'request_id', 'rev', 'kind', 'parent_h_req', 'fields'),
  'sl:g1:v1': fields('h_req', 'eligibility_class'),
  'sl:spec:v1': fields('h_req', 'h_fb', 'envelope'),
  'sl:fb:v1': fields('request_id', 'kind', 'body'),
  'sl:rework:v1': fields('h_spec', 'h_fb'),
  'sl:hold_clear:v1': fields('request_id', 'verdict_id', 'content_hash', 'l2_fingerprint'),
  'sl:l2:v1': fields('trusted_sha', 'base_sha', 'entries'),
  'sl:rollout:v1': fields('request_id', 'mode', 'value', 'doc_version'),
  'sl:enable_confirm:v1': fields('request_id', 'deployment_id', 'flag_key'),
  'sl:notification_policy:v1': fields('site_id', 'base_version', 'override'),
  'sl:site_config:v1': fields('site_id', 'setting', 'base_version', 'value'),
  'sl:webauthn:v1': fields('action', 'targets', 'content_hash', 'nonce'),
  // Added by spec 014 for step-up actions the RFC table has no prefix for (owner, 2026-11-14).
  'sl:authenticator:v1': fields('owner_id', 'op', 'credential_id', 'public_key_cose'),
  'sl:bulk_reject:v1': fields('site_id', 'request_ids'),
})

export type RegisteredPrefix = keyof typeof PREFIXES
