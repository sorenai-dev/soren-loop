import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { generateTable, writeTable } from '../../scripts/gen-unicode-table.ts'
import { UNICODE_VERSION, isAssigned } from '../../src/index.ts'
import { ASSIGNED_RANGES } from '../../src/normalize/unicode-15.1-assigned.ts'

const UCD_URL = new URL('../../scripts/data/DerivedGeneralCategory-15.1.0.txt', import.meta.url)
const TABLE_URL = new URL('../../src/normalize/unicode-15.1-assigned.ts', import.meta.url)
// SHA-256 of DerivedGeneralCategory.txt as served from unicode.org/Public/15.1.0 (spec 012).
const UCD_SHA256 = '760720ac034f96b630a3055879a744e0907184e8aa811e89ba34583a7a487e85'

test('[T012-12] isAssigned follows Unicode 15.1, not the runtime', () => {
  expect(UNICODE_VERSION).toBe('15.1')
  expect(isAssigned(0x41)).toBe(true)
  expect(isAssigned(0x378)).toBe(false)
  expect(isAssigned(0x1c89)).toBe(false) // assigned in 16.0; Node 24's ICU knows it
  expect(isAssigned(0xe000)).toBe(true) // private use is assigned
  expect(isAssigned(0xfffe)).toBe(false) // noncharacter (Cn)
  expect(isAssigned(0xfdd0)).toBe(false) // noncharacter (Cn)
  expect(isAssigned(-1)).toBe(false)
  expect(isAssigned(0x110000)).toBe(false)
  // Range ends are inclusive.
  for (const cp of [0x0, 0x377, 0x37a, 0x10fffd]) expect(isAssigned(cp), cp.toString(16)).toBe(true)
})

test('[T012-12] isAssigned is true for exactly 289,394 code points', () => {
  let count = 0
  for (let cp = 0; cp <= 0x10ffff; cp++) if (isAssigned(cp)) count++
  expect(count).toBe(289_394)
})

test('[T012-13] the generator refuses a UCD file that does not match the pin, and writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ucd-'))
  const out = join(dir, 'table.ts')
  const tampered = Buffer.concat([readFileSync(UCD_URL), Buffer.from('\n')])
  expect(() => writeTable(tampered, out)).toThrow(/does not match the pin/)
  expect(existsSync(out)).toBe(false)
})

test('[T012-13] the checked-in UCD file matches its pin', () => {
  expect(createHash('sha256').update(readFileSync(UCD_URL)).digest('hex')).toBe(UCD_SHA256)
})

test('[T012-13] the table on disk is exactly what the generator produces from the UCD file', () => {
  expect(generateTable(readFileSync(UCD_URL, 'utf8'))).toBe(readFileSync(TABLE_URL, 'utf8'))
})

test('[T012-13] the ranges are sorted, disjoint, non-adjacent, and cover 1,114,112 minus the Cn total', () => {
  // DerivedGeneralCategory-15.1.0.txt: the Cn section's own "# Total code points: 824718".
  const unassignedTotal = 824_718
  let covered = 0
  let previousEnd = -2
  for (const [start, end] of ASSIGNED_RANGES) {
    expect(start).toBeLessThanOrEqual(end)
    expect(start).toBeGreaterThan(previousEnd + 1)
    covered += end - start + 1
    previousEnd = end
  }
  expect(covered).toBe(0x110000 - unassignedTotal)
  expect(covered).toBe(289_394)
})
