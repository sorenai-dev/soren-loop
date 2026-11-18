import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const BUILDERS = ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom', 'mergeInto', 'replaceInto']

async function ruleHits(code: string, file: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repoRoot })
  const [result] = await eslint.lintText(code, { filePath: `${repoRoot}apps/server/src/${file}` })
  return (result?.messages ?? [])
    .map((m) => m.ruleId ?? '')
    .filter((id) => id === 'no-restricted-syntax' || id === 'no-restricted-properties')
}

test('[T020-22] query builders are allowed only in repo/ and db/; Math.random nowhere', async () => {
  for (const name of BUILDERS) {
    const code = `export const q = (db: any) => db.${name}('requests')\n`
    expect(await ruleHits(code, 'routes/x.ts'), name).toEqual(['no-restricted-syntax'])
    expect(await ruleHits(code, 'repo/x.ts'), name).toEqual([])
    expect(await ruleHits(code, 'db/x.ts'), name).toEqual([])
  }
  const random = 'export const r = () => Math.random()\n'
  expect(await ruleHits(random, 'routes/x.ts')).toEqual(['no-restricted-properties'])
  // IDs are minted in repo/, so the CSPRNG rule has no exemptions.
  expect(await ruleHits(random, 'repo/x.ts')).toEqual(['no-restricted-properties'])
  expect(await ruleHits(random, 'db/x.ts')).toEqual(['no-restricted-properties'])
}, 30_000)
