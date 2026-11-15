// L3 field keys for sl.request.v1 (spec 017 DD6). PC-S, PC-A and stored spans all use these
// keys, so a span recorded on the server lines up with the same text on the CLI.
import type { RequestV1 } from '../request.ts'

export function l3FieldsFor(req: RequestV1): { fields: Record<string, string>; requesterFields: string[] } {
  const fields: Record<string, string> = { title: req.title, problem: req.problem }
  req.acceptance_criteria.forEach((c, i) => {
    fields[`acceptance_criteria[${i}]`] = c
  })
  if (req.area !== null) fields.area = req.area
  const requesterFields = Object.keys(fields)
  if (req.owner_context !== null) fields.owner_context = req.owner_context
  return { fields, requesterFields }
}
