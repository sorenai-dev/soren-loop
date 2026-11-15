import type { Kysely } from 'kysely'
import type {
  FeedbackTable, QuestionsTable, RequesterEventsTable, RequestRevisionsTable, RequestsTable,
  RequestTransitionsTable, SpecsTable,
} from './tables/aggregate.ts'
import type {
  AuthenticatorsTable, CliTokensTable, OwnerSessionsTable, OwnersTable, RecoveryCodesTable,
  RepoBindingsTable, RequestersTable, SiteOwnersTable, SitesTable, TrustedCommitsTable,
} from './tables/identity.ts'

// Tables are added by the data-model tasks (RFC 04); each migration extends this map.
export interface Database {
  sites: SitesTable
  site_owners: SiteOwnersTable
  repo_bindings: RepoBindingsTable
  trusted_commits: TrustedCommitsTable
  owners: OwnersTable
  authenticators: AuthenticatorsTable
  recovery_codes: RecoveryCodesTable
  owner_sessions: OwnerSessionsTable
  cli_tokens: CliTokensTable
  requesters: RequestersTable
  requests: RequestsTable
  request_revisions: RequestRevisionsTable
  specs: SpecsTable
  feedback: FeedbackTable
  questions: QuestionsTable
  request_transitions: RequestTransitionsTable
  requester_events: RequesterEventsTable
}

export type Db = Kysely<Database>
