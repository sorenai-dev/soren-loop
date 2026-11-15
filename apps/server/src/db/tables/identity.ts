import type { ColumnType, Generated, GeneratedAlways } from 'kysely'

// Configuration and identity tables (RFC 04 §2; spec 020 Appendix A).

export type Timestamp = ColumnType<Date, Date | string, Date | string>
export type CreatedAt = ColumnType<Date, Date | string | undefined, never>
/** jsonb: written as a serialized string, read back parsed (the `pg` driver's behaviour). */
export type Json<T> = ColumnType<T, string, string>
/** jsonb with a column default: optional on insert. */
export type JsonDefault<T> = ColumnType<T, string | undefined, string>
/** Postgres `bigint` comes back from `pg` as a string. */
export type BigIntColumn = ColumnType<string, string | number | bigint, string | number | bigint>

export interface SitesTable {
  id: string
  name: string
  widget_origins: Generated<string[]>
  jwks_url: string | null
  jwks_cache: Json<unknown> | null
  intake_mode: Generated<'form' | 'llm'>
  intake_key_enc: Buffer | null
  path_policy: Json<unknown> | null
  path_policy_confirmed_approval_id: string | null
  prod_environment: string | null
  issue_projection: Generated<boolean>
  enablement_mode: Generated<'auto' | 'merger_must_be_owner_login' | 'dashboard_confirm'>
  requester_email_enabled: Generated<boolean>
  caps: JsonDefault<unknown>
  flag_throttle: number | null
  intake_paused: Generated<boolean>
  config_version: Generated<number>
  created_at: CreatedAt
}

export interface SiteOwnersTable {
  site_id: string
  owner_id: string
  role: Generated<'owner'>
}

export interface RepoBindingsTable {
  site_id: string
  pr_app_id: BigIntColumn
  pr_app_installation_id: BigIntColumn
  push_app_id: BigIntColumn | null
  push_app_installation_id: BigIntColumn | null
  bot_owner_login: string | null
  upstream_full_name: string
  fork_full_name: string | null
  default_branch: string
  owner_github_login: string
  same_repo_mode: boolean
}

export interface TrustedCommitsTable {
  seq: GeneratedAlways<string>
  site_id: string
  sha: string
  set_by_approval_id: string
  created_at: CreatedAt
}

export interface OwnersTable {
  id: string
  email: string
  display_name: string | null
  contact_version: Generated<number>
  created_at: CreatedAt
}

export interface AuthenticatorsTable {
  credential_id: string
  owner_id: string
  public_key_cose: Buffer
  sign_count: Generated<string>
  transports: Generated<string[]>
  backup_eligible: boolean
  created_at: CreatedAt
  revoked_at: Timestamp | null
}

export interface RecoveryCodesTable {
  owner_id: string
  code_hmac: Buffer
  used_at: Timestamp | null
}

export interface OwnerSessionsTable {
  id_hmac: Buffer
  owner_id: string
  created_at: CreatedAt
  expires_at: Timestamp
}

export interface CliTokensTable {
  id: string
  owner_id: string
  site_id: string
  family_id: string
  access_hmac: Buffer
  refresh_hmac: Buffer
  device_label: string | null
  last_ip: string | null
  created_at: CreatedAt
  expires_at: Timestamp
  revoked_at: Timestamp | null
}

export interface RequestersTable {
  id: string
  site_id: string
  sub: string
  display_name: string | null
  email_enc: Buffer | null
  paused_until: Timestamp | null
  blocked: Generated<boolean>
  created_at: CreatedAt
}
