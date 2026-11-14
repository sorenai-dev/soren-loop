/**
 * Reasons a value is rejected before it is hashed or stored. Callers map every SchemaError to
 * HTTP 422, and the reason travels as `invalid_params[].reason` (RFC 05 §2), so this union is a
 * wire contract: extend it deliberately, never widen it to `string`.
 */
export type SchemaErrorReason =
  | 'invalid_utf8'
  | 'not_json'
  | 'invalid_prefix'
  | 'path_traversal'
  | 'path_absolute'
  | 'path_empty'
  | 'path_invalid'

export class SchemaError extends Error {
  readonly reason: SchemaErrorReason

  constructor(reason: SchemaErrorReason, message: string = reason) {
    super(message)
    this.name = 'SchemaError'
    this.reason = reason
  }
}
