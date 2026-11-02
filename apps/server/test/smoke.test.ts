import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { PACKAGE_NAME } from '../src/index.ts'

test('[T001-1] smoke: the entry point loads and names its package', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string }
  expect(PACKAGE_NAME).toBe(manifest.name)
})
