import { SchemaError } from './errors.ts'

// With the `u` flag a surrogate pair is one code point, so this matches only lone surrogates.
const LONE_SURROGATE = /[\uD800-\uDFFF]/u

/** Throws invalid_utf8 for a string with no UTF-8 encoding (a lone surrogate). */
export function assertWellFormed(s: string): void {
  // TextEncoder would silently replace a lone surrogate with U+FFFD, so "a\uD800" and
  // "a�" would frame identically.
  if (LONE_SURROGATE.test(s)) throw new SchemaError('invalid_utf8', 'string contains a lone surrogate')
}
