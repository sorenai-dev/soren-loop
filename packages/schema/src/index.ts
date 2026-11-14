export const PACKAGE_NAME = '@sorenai/loop-schema'

export { SchemaError } from './errors.ts'
export type { SchemaErrorReason } from './errors.ts'
export { P, byteSort, frame, hashFields, lp, sortedUnique } from './hash/framing.ts'
export type { Prefix } from './hash/framing.ts'
export { jcs } from './hash/jcs.ts'
