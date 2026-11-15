import { type CreateTableBuilder, type Kysely, sql } from 'kysely'
import type { Migration } from 'kysely/migration'

// RFC 04 §2: the configuration-and-identity and request-aggregate table groups (spec 020,
// Appendix A). Value lists are copied here, not imported, so this migration never changes
// after it ships. Chain columns and append-only rules for the chained tables are Task 030's.

const STATES = [
  'intake', 'submitted', 'security_hold', 'owner_approved', 'planning', 'plan_review', 'plan_feedback',
  'needs_info', 'plan_approved', 'building', 'paused_rate_limited', 'stalled', 'in_review',
  'changes_requested', 'merged', 'deployed', 'enabled_for_requester', 'rollout_targeted',
  'rollout_percentage', 'rollout_all', 'flag_off', 'matched_existing', 'rejected', 'closed',
]
const STAGES = ['received', 'needs_your_input', 'planning', 'building', 'shipping', 'available', 'closed']
const ACTOR_TYPES = ['requester', 'owner', 'cli_for_owner', 'github', 'system']
const IMMUTABLE = ['request_revisions', 'specs']

/** Tables in creation order; `down` drops them in reverse. */
const TABLES = [
  'sites', 'owners', 'site_owners', 'repo_bindings', 'trusted_commits', 'authenticators', 'recovery_codes',
  'owner_sessions', 'cli_tokens', 'requesters', 'requests', 'request_revisions', 'specs', 'feedback',
  'questions', 'request_transitions', 'requester_events',
]

type Table = CreateTableBuilder<string, string>

const oneOf = (column: string, values: readonly string[]) =>
  sql`${sql.ref(column)} in (${sql.join(values.map((v) => sql.lit(v)))})`

const now = sql`now()`

function site(t: Table): Table {
  return t.addColumn('site_id', 'text', (c) => c.notNull().references('sites.id'))
}

function created(t: Table): Table {
  return t.addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
}

/** `site_id` + `request_id`, with the composite FK that keeps a child on its request's site. */
function requestChild(t: Table, name: string): Table {
  return site(t)
    .addColumn('request_id', 'text', (c) => c.notNull())
    .addForeignKeyConstraint(`${name}_request_fk`, ['site_id', 'request_id'], 'requests', ['site_id', 'id'])
}

async function up(db: Kysely<unknown>): Promise<void> {
  const s = db.schema

  await created(
    s.createTable('sites')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('widget_origins', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
      .addColumn('jwks_url', 'text')
      .addColumn('jwks_cache', 'jsonb')
      .addColumn('intake_mode', 'text', (c) => c.notNull().defaultTo('form'))
      .addColumn('intake_key_enc', 'bytea')
      .addColumn('path_policy', 'jsonb')
      .addColumn('path_policy_confirmed_approval_id', 'text')
      .addColumn('prod_environment', 'text')
      .addColumn('issue_projection', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('enablement_mode', 'text', (c) => c.notNull().defaultTo('auto'))
      .addColumn('requester_email_enabled', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('caps', 'jsonb', (c) => c.notNull().defaultTo(sql`'{}'::jsonb`))
      .addColumn('flag_throttle', 'integer')
      .addColumn('intake_paused', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('config_version', 'integer', (c) => c.notNull().defaultTo(0)),
  )
    .addCheckConstraint('sites_intake_mode_check', oneOf('intake_mode', ['form', 'llm']))
    .addCheckConstraint(
      'sites_enablement_mode_check',
      oneOf('enablement_mode', ['auto', 'merger_must_be_owner_login', 'dashboard_confirm']),
    )
    .execute()

  await created(
    s.createTable('owners')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('email', 'text', (c) => c.notNull().unique())
      .addColumn('display_name', 'text')
      .addColumn('contact_version', 'integer', (c) => c.notNull().defaultTo(0)),
  ).execute()

  await site(s.createTable('site_owners'))
    .addColumn('owner_id', 'text', (c) => c.notNull().references('owners.id'))
    .addColumn('role', 'text', (c) => c.notNull().defaultTo('owner'))
    .addPrimaryKeyConstraint('site_owners_pkey', ['site_id', 'owner_id'])
    .addCheckConstraint('site_owners_role_check', oneOf('role', ['owner']))
    .execute()

  await s.createTable('repo_bindings')
    .addColumn('site_id', 'text', (c) => c.primaryKey().references('sites.id'))
    .addColumn('pr_app_id', 'bigint', (c) => c.notNull())
    .addColumn('pr_app_installation_id', 'bigint', (c) => c.notNull())
    .addColumn('push_app_id', 'bigint')
    .addColumn('push_app_installation_id', 'bigint')
    .addColumn('bot_owner_login', 'text')
    .addColumn('upstream_full_name', 'text', (c) => c.notNull())
    .addColumn('fork_full_name', 'text')
    .addColumn('default_branch', 'text', (c) => c.notNull())
    .addColumn('owner_github_login', 'text', (c) => c.notNull())
    .addColumn('same_repo_mode', 'boolean', (c) => c.notNull())
    // Decision 37: same-repo exactly when there is no push App and no fork (RFC 08 §1.9).
    .addCheckConstraint(
      'repo_bindings_same_repo_check',
      sql`same_repo_mode = (push_app_id is null and push_app_installation_id is null
        and bot_owner_login is null and fork_full_name is null)`,
    )
    .execute()

  await created(
    site(s.createTable('trusted_commits').addColumn('seq', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity()))
      .addColumn('sha', 'text', (c) => c.notNull())
      .addColumn('set_by_approval_id', 'text', (c) => c.notNull()),
  ).execute()

  await s.createTable('authenticators')
    .addColumn('credential_id', 'text', (c) => c.primaryKey())
    .addColumn('owner_id', 'text', (c) => c.notNull().references('owners.id'))
    .addColumn('public_key_cose', 'bytea', (c) => c.notNull())
    .addColumn('sign_count', 'bigint', (c) => c.notNull().defaultTo(0))
    .addColumn('transports', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'::text[]`))
    .addColumn('backup_eligible', 'boolean', (c) => c.notNull())
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('revoked_at', 'timestamptz')
    .execute()

  await s.createTable('recovery_codes')
    .addColumn('owner_id', 'text', (c) => c.notNull().references('owners.id'))
    .addColumn('code_hmac', 'bytea', (c) => c.notNull())
    .addColumn('used_at', 'timestamptz')
    .addPrimaryKeyConstraint('recovery_codes_pkey', ['owner_id', 'code_hmac'])
    .execute()

  await s.createTable('owner_sessions')
    .addColumn('id_hmac', 'bytea', (c) => c.primaryKey())
    .addColumn('owner_id', 'text', (c) => c.notNull().references('owners.id'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .execute()

  await site(
    s.createTable('cli_tokens')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('owner_id', 'text', (c) => c.notNull().references('owners.id')),
  )
    .addColumn('family_id', 'text', (c) => c.notNull())
    .addColumn('access_hmac', 'bytea', (c) => c.notNull().unique())
    .addColumn('refresh_hmac', 'bytea', (c) => c.notNull().unique())
    .addColumn('device_label', 'text')
    .addColumn('last_ip', sql`inet`)
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('revoked_at', 'timestamptz')
    .addUniqueConstraint('cli_tokens_site_id_id_key', ['site_id', 'id'])
    .execute()

  await created(
    site(s.createTable('requesters').addColumn('id', 'text', (c) => c.primaryKey()))
      .addColumn('sub', 'text', (c) => c.notNull())
      .addColumn('display_name', 'text')
      .addColumn('email_enc', 'bytea')
      .addColumn('paused_until', 'timestamptz')
      .addColumn('blocked', 'boolean', (c) => c.notNull().defaultTo(false)),
  )
    .addUniqueConstraint('requesters_site_id_sub_key', ['site_id', 'sub'])
    .addUniqueConstraint('requesters_site_id_id_key', ['site_id', 'id'])
    .execute()

  await requestsTable(db)
  await aggregateTables(db)
}

async function requestsTable(db: Kysely<unknown>): Promise<void> {
  await db.schema.createTable('requests')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('public_ref', 'text', (c) => c.notNull().unique())
    .addColumn('site_id', 'text', (c) => c.notNull().references('sites.id'))
    .addColumn('requester_id', 'text', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull())
    .addColumn('state_ctx', 'jsonb', (c) => c.notNull())
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('current_rev', 'integer', (c) => c.notNull())
    .addColumn('h_req_current', 'text', (c) => c.notNull())
    .addColumn('h_spec_current', 'text')
    .addColumn('eligibility_class', 'text')
    .addColumn('throttled', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('requester_opted_out', 'boolean', (c) => c.notNull().defaultTo(false))
    .addColumn('duplicate_of', 'text')
    .addColumn('flag_id', 'text')
    .addColumn('pr_number', 'integer')
    .addColumn('merge_sha', 'text')
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('closed_at', 'timestamptz')
    .addColumn('purge_after', 'timestamptz')
    .addColumn('text_purge_after', 'timestamptz')
    .addUniqueConstraint('requests_site_id_id_key', ['site_id', 'id'])
    .addForeignKeyConstraint('requests_requester_fk', ['site_id', 'requester_id'], 'requesters', ['site_id', 'id'])
    .addForeignKeyConstraint('requests_duplicate_of_fk', ['site_id', 'duplicate_of'], 'requests', ['site_id', 'id'])
    .addCheckConstraint('requests_state_check', oneOf('state', STATES))
    .addCheckConstraint('requests_current_rev_check', sql`current_rev >= 1`)
    .execute()
}

async function aggregateTables(db: Kysely<unknown>): Promise<void> {
  const s = db.schema

  await created(
    requestChild(s.createTable('request_revisions').addColumn('id', 'text', (c) => c.primaryKey()), 'request_revisions')
      .addColumn('rev', 'integer', (c) => c.notNull())
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('fields', 'jsonb', (c) => c.notNull())
      .addColumn('stripped', 'jsonb', (c) => c.notNull().defaultTo(sql`'[]'::jsonb`))
      .addColumn('h_req', 'text', (c) => c.notNull())
      .addColumn('parent_h_req', 'text'),
  )
    .addUniqueConstraint('request_revisions_request_id_rev_key', ['request_id', 'rev'])
    .addCheckConstraint('request_revisions_rev_check', sql`rev >= 1`)
    .addCheckConstraint('request_revisions_kind_check', oneOf('kind', ['requester', 'owner_context']))
    .execute()

  await created(
    requestChild(s.createTable('specs').addColumn('id', 'text', (c) => c.primaryKey()), 'specs')
      .addColumn('version', 'integer', (c) => c.notNull())
      .addColumn('envelope', 'jsonb', (c) => c.notNull())
      .addColumn('h_spec', 'text', (c) => c.notNull())
      .addColumn('parent_h_req', 'text', (c) => c.notNull())
      .addColumn('h_fb', 'text')
      .addColumn('base_sha', 'text', (c) => c.notNull())
      .addColumn('uploaded_by_run', 'text', (c) => c.notNull())
      .addColumn('review_aids', 'jsonb'),
  )
    .addUniqueConstraint('specs_request_id_version_key', ['request_id', 'version'])
    .addCheckConstraint('specs_version_check', sql`version >= 1`)
    .execute()

  await created(
    requestChild(s.createTable('feedback').addColumn('id', 'text', (c) => c.primaryKey()), 'feedback')
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('body', 'text', (c) => c.notNull())
      .addColumn('h_fb', 'text', (c) => c.notNull())
      .addColumn('author', 'text', (c) => c.notNull())
      .addColumn('approval_id', 'text'),
  )
    .addCheckConstraint('feedback_kind_check', oneOf('kind', ['plan', 'rework']))
    .addCheckConstraint('feedback_author_check', oneOf('author', ['owner', 'owner_github_review']))
    .execute()

  await created(
    requestChild(s.createTable('questions').addColumn('id', 'text', (c) => c.primaryKey()), 'questions')
      .addColumn('body', 'text', (c) => c.notNull())
      .addColumn('asked_by', 'text', (c) => c.notNull())
      .addColumn('answered_rev', 'integer'),
  )
    .addForeignKeyConstraint('questions_asked_by_fk', ['site_id', 'asked_by'], 'site_owners', ['site_id', 'owner_id'])
    .execute()

  await requestChild(
    s.createTable('request_transitions').addColumn('seq', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity()),
    'request_transitions',
  )
    .addColumn('from_state', 'text')
    .addColumn('to_state', 'text')
    .addColumn('event', 'text', (c) => c.notNull())
    .addColumn('actor_type', 'text', (c) => c.notNull())
    .addColumn('actor_id', 'text')
    .addColumn('cli_token_id', 'text')
    .addColumn('approval_id', 'text')
    .addColumn('idempotency_key', 'text')
    .addColumn('payload_digest', 'text')
    .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addForeignKeyConstraint('request_transitions_cli_token_fk', ['site_id', 'cli_token_id'], 'cli_tokens', ['site_id', 'id'])
    .addUniqueConstraint('request_transitions_site_request_seq_key', ['site_id', 'request_id', 'seq'])
    .addCheckConstraint('request_transitions_actor_type_check', oneOf('actor_type', ACTOR_TYPES))
    .execute()

  await requestChild(
    s.createTable('requester_events').addColumn('seq', 'bigint', (c) => c.primaryKey().generatedAlwaysAsIdentity()),
    'requester_events',
  )
    .addColumn('stage', 'text', (c) => c.notNull())
    .addColumn('stage_since', 'timestamptz', (c) => c.notNull())
    .addColumn('transition_seq', 'bigint', (c) => c.notNull())
    .addColumn('at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addForeignKeyConstraint(
      'requester_events_transition_fk',
      ['site_id', 'request_id', 'transition_seq'],
      'request_transitions',
      ['site_id', 'request_id', 'seq'],
    )
    .addCheckConstraint('requester_events_stage_check', oneOf('stage', STAGES))
    .execute()

  for (const table of IMMUTABLE) {
    const fn = sql.id(`sl_reject_update_${table}`)
    await sql`create function ${fn}() returns trigger language plpgsql as $$
      begin raise exception '% is immutable', tg_table_name; end $$`.execute(db)
    await sql`create trigger ${sql.id(`${table}_immutable`)} before update on ${sql.table(table)}
      for each row execute function ${fn}()`.execute(db)
  }
}

async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [...TABLES].reverse()) await db.schema.dropTable(table).execute()
  for (const table of IMMUTABLE) await sql`drop function ${sql.id(`sl_reject_update_${table}`)}()`.execute(db)
}

export const migration0001Core: Migration = { up, down }
