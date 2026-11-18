// Typed repository errors (spec 020 DD10). Driver errors never cross the repository boundary
// as known failure modes; anything unmapped is rethrown unchanged.

export type RepoErrorCode = 'invalid_reference' | 'invalid_request' | 'invalid_state_ctx'

export class RepoError extends Error {
  readonly code: RepoErrorCode

  constructor(code: RepoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RepoError'
    this.code = code
  }
}

const FOREIGN_KEY_VIOLATION = '23503'

/** Maps a database error to a `RepoError` where the code is a known case; otherwise returns it. */
export function mapDbError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code
  if (code === FOREIGN_KEY_VIOLATION) {
    return new RepoError('invalid_reference', 'a referenced row does not exist on this site', { cause: error })
  }
  return error
}
