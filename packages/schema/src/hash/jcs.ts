// RFC 8785 JSON Canonicalization Scheme over the JSON subset content hashes use. Hand-rolled
// (no dependency) so it can reject inputs JSON.stringify silently drops, such as undefined
// values, which would otherwise let two different inputs hash the same.
import { SchemaError } from '../errors.ts'
import { assertWellFormed } from '../utf8.ts'

const notJson = (why: string): SchemaError => new SchemaError('not_json', why)

/** Nesting deeper than this is not_json, so hostile input can't overflow the stack (a 500). */
export const MAX_JCS_DEPTH = 64

export function jcs(value: unknown): string {
  return serialize(value, new Set())
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw notJson('non-finite number')
      // ECMAScript Number#toString is RFC 8785 §3.2.2.3's number form; -0 serializes as 0.
      return JSON.stringify(value)
    case 'string':
      return quote(value)
    case 'object':
      break
    default:
      throw notJson(`unsupported type ${typeof value}`)
  }
  if (stack.has(value)) throw notJson('cycle')
  if (stack.size >= MAX_JCS_DEPTH) throw notJson('nested too deeply')
  stack.add(value)
  try {
    return Array.isArray(value) ? serializeArray(value) : serializeObject(value)
  } finally {
    stack.delete(value)
  }

  function serializeArray(arr: unknown[]): string {
    if (Object.getPrototypeOf(arr) !== Array.prototype) throw notJson('array subclass')
    // Named properties on an array would be dropped silently, as JSON.stringify drops them.
    if (Object.keys(arr).length !== arr.length || Object.getOwnPropertySymbols(arr).length > 0) {
      throw notJson('array with extra properties')
    }
    const items: string[] = []
    for (let i = 0; i < arr.length; i++) {
      // A hole would otherwise serialize like null, so [,1] and [null,1] would collide.
      if (!Object.hasOwn(arr, i)) throw notJson('sparse array')
      items.push(serialize(arr[i], stack))
    }
    return `[${items.join(',')}]`
  }

  function serializeObject(obj: object): string {
    const proto: unknown = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) throw notJson('not a plain object')
    if (Object.getOwnPropertySymbols(obj).length > 0) throw notJson('symbol key')
    // RFC 8785 §3.2.3 sorts keys by UTF-16 code units, which is what `<` on JS strings does.
    // This differs from byteSort's UTF-8 order on purpose: D-M1 governs the registry's explicit
    // sorted() calls, while JCS governs object keys inside structured fields.
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const members = keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(obj, key)
      if (!descriptor || !('value' in descriptor)) throw notJson('accessor property')
      return `${quote(key)}:${serialize(descriptor.value, stack)}`
    })
    return `{${members.join(',')}}`
  }
}

/** JSON.stringify's string escaping (ES2019+) is RFC 8785 §3.2.2.2's, given well-formed input. */
function quote(s: string): string {
  assertWellFormed(s)
  return JSON.stringify(s)
}
