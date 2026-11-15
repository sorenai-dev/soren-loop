// The closed request object sl.request.v1 (RFC 04 §3.3): every key always present, null rather
// than omission, no extra keys. No .max(): zod counts UTF-16 units, and caps are code points,
// enforced by nIntake.
import { z } from 'zod'
import { SchemaError } from './errors.ts'

const schema = z.strictObject({
  title: z.string(),
  problem: z.string(),
  acceptance_criteria: z.array(z.string()),
  area: z.string().nullable(),
  owner_context: z.string().nullable(),
})

export interface RequestV1 {
  title: string
  problem: string
  acceptance_criteria: string[]
  area: string | null
  owner_context: string | null
}

export const RequestV1Schema: z.ZodType<RequestV1> = schema

const KEYS: readonly string[] = Object.keys(schema.shape)

export function parseRequestV1(input: unknown): RequestV1 {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SchemaError('invalid_type', 'sl.request.v1 must be an object')
  }
  const missing = KEYS.find((k) => !Object.hasOwn(input, k))
  if (missing !== undefined) throw new SchemaError('missing_key', `missing key ${missing}`)
  const unknown = Object.keys(input).find((k) => !KEYS.includes(k))
  if (unknown !== undefined) throw new SchemaError('unknown_key', `unknown key ${unknown}`)
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw new SchemaError('invalid_type', `invalid ${parsed.error.issues[0]?.path.join('.') ?? 'value'}`)
  }
  return parsed.data
}
