// Field validators for content-hash inputs (spec 013, Design Decisions 2 and 5).
import { SchemaError } from '../errors.ts'

export const invalid = (why: string): SchemaError => new SchemaError('invalid_value', why)
const HEX64 = /^[0-9a-f]{64}$/

export function hash(name: string, value: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) throw invalid(`${name} must be 64 lowercase hex`)
  return value
}
export const optionalHash = (name: string, value: string | null): string => (value === null ? '' : hash(name, value))

export function id(name: string, value: string): string {
  if (typeof value !== 'string' || value === '') throw invalid(`${name} must be a non-empty string`)
  return value
}

/** Decimal ASCII, no leading zeros (RFC 04 §3.2). */
export function int(name: string, value: number, min: number, max = Number.MAX_SAFE_INTEGER): string {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(`${name} must be an integer in ${min}..${max}`)
  return String(value)
}

export function oneOf<T extends string>(name: string, value: T, allowed: readonly T[]): T {
  if (!allowed.includes(value)) throw invalid(`${name} must be one of ${allowed.join(', ')}`)
  return value
}
