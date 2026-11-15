export const PACKAGE_NAME = '@sorenai/loop-schema'

export { SchemaError } from './errors.ts'
export type { SchemaErrorReason } from './errors.ts'
export { P, byteSort, frame, hashFields, lp, sortedUnique } from './hash/framing.ts'
export type { Prefix } from './hash/framing.ts'
export { jcs } from './hash/jcs.ts'
export { UNICODE_VERSION, isAssigned, nHash, nIntake } from './normalize/normalize.ts'
export type { IntakeResult, StrippedRecord } from './normalize/normalize.ts'
export { RequestV1Schema, parseRequestV1 } from './request.ts'
export type { RequestV1 } from './request.ts'
export { PREFIXES } from './hash/prefixes.ts'
export type { RegisteredPrefix } from './hash/prefixes.ts'
export {
  hEnableConfirm, hFb, hG1, hHoldClear, hNotificationPolicy, hReq, hRework, hRollout, hSiteConfig,
  hSpec, l2Fingerprint, hAuthenticator, hBulkReject,
} from './hash/content.ts'
export {
  STEPUP_ACTIONS, TARGET_TYPES, contentHashPrefixFor, deriveChallenge, targetShapeFor, webauthnChallenge,
} from './stepup.ts'
export type { ChallengeInput, StepupAction, Target, TargetShape, TargetType } from './stepup.ts'
