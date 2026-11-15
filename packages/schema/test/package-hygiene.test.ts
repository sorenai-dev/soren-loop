import { readdirSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

function filesUnder(dir: string, ext: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith(ext))
    .map((f) => join(dir, f))
}

test('[T011-15] no src file imports a Node builtin, so the dashboard can run this package in a browser', () => {
  const specifier = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/gm
  const offenders: string[] = []
  for (const file of filesUnder('src', '.ts')) {
    const text = readFileSync(join(root, file), 'utf8')
    for (const m of text.matchAll(specifier)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
      if (isBuiltin(spec)) offenders.push(`${file}: ${spec}`)
    }
  }
  expect(filesUnder('src', '.ts').length).toBeGreaterThan(0)
  expect(offenders).toEqual([])
})

test('[T011-15] every shared vector file is ASCII-only JSON', () => {
  for (const file of filesUnder('test-vectors', '.json')) {
    const bytes = readFileSync(join(root, file))
    const nonAscii = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a))
    expect(nonAscii, file).toBe(-1)
  }
})

test('[T017-17] every L3 corpus file is ASCII-only JSON', () => {
  const files = filesUnder('test/corpus', '.json')
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) {
    const bytes = readFileSync(join(root, file))
    const nonAscii = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a))
    expect(nonAscii, file).toBe(-1)
  }
})

test('[T012-17] TypeScript sources are ASCII apart from the section sign, so no invisible character hides in a test', () => {
  const offenders: string[] = []
  for (const dir of ['src', 'test', 'scripts']) {
    for (const file of filesUnder(dir, '.ts')) {
      const text = readFileSync(join(root, file), 'utf8')
      const bad = [...text].filter((c) => c > '~' && c !== '§' && c !== '\n')
      if (bad.length > 0) offenders.push(`${file}: ${bad.map((c) => `U+${c.codePointAt(0)?.toString(16)}`).join(' ')}`)
    }
  }
  expect(offenders).toEqual([])
})
