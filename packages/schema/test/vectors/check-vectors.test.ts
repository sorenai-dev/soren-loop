import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildManifest, checkVectors } from '../../scripts/check-vectors.ts'
import type { Manifest } from '../../scripts/check-vectors.ts'
import type { VectorFile } from '../../src/vectors/run.ts'

const PKG = new URL('../../', import.meta.url).pathname
const VECTOR_DIR = join(PKG, 'test-vectors')
const FILES: VectorFile[] = ['normalize.json', 'hash.json', 'challenge.json', 'receipt.json']
type Vectors = Record<VectorFile, Record<string, unknown>[]>

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T
const committed = (): Vectors =>
  Object.fromEntries(FILES.map((f) => [f, readJson(join(VECTOR_DIR, f))])) as Vectors
const manifest = (): Manifest => readJson(join(VECTOR_DIR, 'MANIFEST.json'))

/** A deep copy with one vector's field changed. */
function edit(vectors: Vectors, file: VectorFile, id: string, patch: Record<string, unknown>): Vectors {
  const copy = structuredClone(vectors)
  const v = copy[file].find((x) => x.id === id)
  if (!v) throw new Error(`no ${id}`)
  Object.assign(v, patch)
  return copy
}

describe('checkVectors (spec 016 batch B)', () => {
  test('[T016-4] the committed vector files match the committed manifest', () => {
    expect(checkVectors({ vectors: committed(), manifest: manifest() })).toEqual({ ok: true, problems: [] })
  })

  test('[T016-5] a changed, removed or unrecorded vector fails, naming it', () => {
    const changed = edit(committed(), 'hash.json', 'H-01', { expected_hash: '0'.repeat(64) })
    expect(checkVectors({ vectors: changed, manifest: manifest() }).problems).toEqual(['changed: hash.json H-01'])
    const removed = { ...committed(), 'challenge.json': committed()['challenge.json'].filter((v) => v.id !== 'C-03') }
    expect(checkVectors({ vectors: removed, manifest: manifest() }).problems).toEqual(['removed: challenge.json C-03'])
    const added = committed()
    added['hash.json'].push({ id: 'H-99', fn: 'P', input: { path: 'a' }, expected_normalized: 'a' })
    expect(checkVectors({ vectors: added, manifest: manifest() })).toEqual({ ok: false, problems: ['unrecorded: hash.json H-99'] })
  })

  test('[T016-5] an id that appears twice in a file is a problem', () => {
    const dup = committed()
    const h01 = dup['hash.json'].find((v) => v.id === 'H-01') as Record<string, unknown>
    dup['hash.json'].unshift({ ...h01, expected_hash: '0'.repeat(64) })
    expect(checkVectors({ vectors: dup, manifest: manifest() }).problems).toContain('duplicate: hash.json H-01')
  })

  test('[T016-5] editing only a description is not a contract change', () => {
    const relabelled = edit(committed(), 'normalize.json', 'N-01', { description: 'reworded' })
    expect(checkVectors({ vectors: relabelled, manifest: manifest() }).ok).toBe(true)
  })

  test('[T016-5] the digest covers input and fn, not only expectations', () => {
    const input = edit(committed(), 'hash.json', 'H-12c', { input: { requestId: 'req_2', kind: 'plan', body: 'Use a stream.' } })
    expect(checkVectors({ vectors: input, manifest: manifest() }).problems).toEqual(['changed: hash.json H-12c'])
    const fn = edit(committed(), 'hash.json', 'H-12c', { fn: 'hRework' })
    expect(checkVectors({ vectors: fn, manifest: manifest() }).problems).toEqual(['changed: hash.json H-12c'])
  })

  test('[T016-6] an unfrozen base allows a re-recorded change (before the release gate)', () => {
    const base = buildManifest(committed(), false)
    const changed = edit(committed(), 'hash.json', 'H-01', { expected_hash: '0'.repeat(64) })
    expect(checkVectors({ vectors: changed, manifest: buildManifest(changed, false), base })).toEqual({ ok: true, problems: [] })
  })

  test('[T016-6] with a frozen base, a removed vector fails even when the manifest was rebuilt', () => {
    const base = buildManifest(committed(), true)
    const removed = { ...committed(), 'challenge.json': committed()['challenge.json'].filter((v) => v.id !== 'C-03') }
    expect(checkVectors({ vectors: removed, manifest: buildManifest(removed, true), base }).problems)
      .toEqual(['removed: challenge.json C-03'])
  })

  test('[T016-6] with a frozen base, a changed vector fails even when the working manifest was updated', () => {
    const base = { ...buildManifest(committed(), true) }
    const changed = edit(committed(), 'hash.json', 'H-01', { expected_hash: '0'.repeat(64) })
    const result = checkVectors({ vectors: changed, manifest: buildManifest(changed, true), base })
    expect(result).toEqual({ ok: false, problems: ['changed: hash.json H-01'] })
  })

  test('[T016-6] with a frozen base, an added and recorded vector passes; unfreezing fails', () => {
    const base = buildManifest(committed(), true)
    const added = committed()
    added['hash.json'].push({ id: 'H-99', fn: 'P', input: { path: 'a' }, expected_normalized: 'a' })
    expect(checkVectors({ vectors: added, manifest: buildManifest(added, true), base }).ok).toBe(true)
    const unfrozen = checkVectors({ vectors: committed(), manifest: buildManifest(committed(), false), base })
    expect(unfrozen).toEqual({ ok: false, problems: ['unfrozen: the base manifest is frozen'] })
  })
})

describe('check:vectors CLI (spec 016 batch B)', () => {
  const temps: string[] = []
  afterEach(() => {
    for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
  })
  /** A temp copy of test-vectors, optionally with the manifest rewritten. */
  function copy(change?: (dir: string) => void): string {
    const dir = mkdtempSync(join(tmpdir(), 'sl-vectors-'))
    temps.push(dir)
    cpSync(VECTOR_DIR, dir, { recursive: true })
    change?.(dir)
    return dir
  }
  const setFrozen = (frozen: boolean) => (dir: string): void => {
    const m = readJson<Manifest>(join(dir, 'MANIFEST.json'))
    writeFileSync(join(dir, 'MANIFEST.json'), `${JSON.stringify({ ...m, frozen }, null, 2)}\n`)
  }
  const freeze = setFrozen(true)
  const addVector = (d: string): void => {
    const hash = readJson<Record<string, unknown>[]>(join(d, 'hash.json'))
    hash.push({ id: 'H-99', fn: 'P', description: 'added', input: { path: 'a' }, expected_normalized: 'a' })
    writeFileSync(join(d, 'hash.json'), `${JSON.stringify(hash, null, 2)}\n`)
  }
  // Needs a full clone (CI checks out with fetch-depth 0): in a shallow clone the root commit is
  // the shallow boundary, which may already hold a manifest.
  const rootCommit = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: PKG, encoding: 'utf8' }).stdout.trim()
  const editHash = (dir: string): void => {
    const hash = readJson<Record<string, unknown>[]>(join(dir, 'hash.json'))
    const v = hash.find((x) => x.id === 'H-01') as Record<string, unknown>
    v.expected_hash = '0'.repeat(64)
    writeFileSync(join(dir, 'hash.json'), `${JSON.stringify(hash, null, 2)}\n`)
  }
  function run(args: string[], env: Record<string, string> = {}) {
    const clean = { ...process.env }
    delete clean.CI
    delete clean.VECTOR_BASE_REF
    const r = spawnSync(process.execPath, [join(PKG, 'scripts/check-vectors.ts'), ...args], {
      cwd: PKG, encoding: 'utf8', env: { ...clean, VECTOR_BASE_REF: 'HEAD', ...env },
    })
    return { code: r.status, out: `${r.stdout}${r.stderr}` }
  }

  test('[T016-7] exits 0 on the repo and 1 naming the id on an edited copy', () => {
    expect(run([]).code).toBe(0)
    const dir = copy(editHash)
    const r = run(['--dir', dir])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/changed: hash\.json H-01/)
  })

  test('[T016-7] --update with a frozen base and a changed vector is refused and leaves the manifest alone', () => {
    const base = copy(freeze)
    const dir = copy(editHash)
    const before = readFileSync(join(dir, 'MANIFEST.json'))
    const r = run(['--dir', dir, '--update', '--base', join(base, 'MANIFEST.json')])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/refusing/)
    expect(r.out).toMatch(/changed: hash\.json H-01/)
    expect(readFileSync(join(dir, 'MANIFEST.json')).equals(before)).toBe(true)
  })

  test('[T016-7] --update records an added vector when nothing is frozen', () => {
    const dir = copy((d) => {
      setFrozen(false)(d)
      addVector(d)
    })
    const r = run(['--dir', dir])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/unrecorded: hash\.json H-99/)
    expect(run(['--dir', dir, '--update']).code).toBe(0)
    expect(run(['--dir', dir]).code).toBe(0)
  })

  test('[T016-7] --update over a frozen base records an added vector and stays frozen', () => {
    const base = copy(freeze)
    const dir = copy((d) => {
      freeze(d)
      addVector(d)
    })
    expect(run(['--dir', dir, '--update', '--base', join(base, 'MANIFEST.json')]).code).toBe(0)
    const m = readJson<Manifest>(join(dir, 'MANIFEST.json'))
    expect(m.frozen).toBe(true)
    expect(Object.keys(m.vectors['hash.json'])).toContain('H-99')
    expect(run(['--dir', dir, '--base', join(base, 'MANIFEST.json')]).code).toBe(0)
  })

  test('[T016-7] --update creates a missing manifest', () => {
    const dir = copy((d) => rmSync(join(d, 'MANIFEST.json')))
    expect(run(['--dir', dir, '--update']).code).toBe(0)
    expect(run(['--dir', dir]).code).toBe(0)
  })

  test('[T016-6] a ref that resolves but has no manifest yet means no base, even under CI', () => {
    expect(rootCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(run([], { VECTOR_BASE_REF: rootCommit, CI: '1' }).code).toBe(0)
  })

  test('[T016-6] an unreadable base ref fails when frozen or under CI, and only warns otherwise', () => {
    const frozen = copy(freeze)
    expect(run(['--dir', frozen], { VECTOR_BASE_REF: 'no-such-ref' }).code).toBe(1)
    const unfrozen = copy(setFrozen(false))
    const ci = run(['--dir', unfrozen], { VECTOR_BASE_REF: 'no-such-ref', CI: '1' })
    expect(ci.code).toBe(1)
    expect(ci.out).toMatch(/no-such-ref/)
    const r = run(['--dir', unfrozen], { VECTOR_BASE_REF: 'no-such-ref' })
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/warning/i)
  })

  test('[T016-7] the CLI runs when invoked through a symlinked path', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'sl-link-')), 'pkg')
    temps.push(link)
    symlinkSync(PKG, link)
    const dir = copy((d) => rmSync(join(d, 'MANIFEST.json')))
    const r = spawnSync(process.execPath, [join(link, 'scripts/check-vectors.ts'), '--dir', dir], { encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(`${r.stdout}${r.stderr}`).toMatch(/MANIFEST\.json is missing/)
  })

  test.each([['an unknown flag', ['--udpate']], ['--dir without a value', ['--dir']]])('[T016-7] %s exits 1', (_name, args) => {
    const r = run(args)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/unknown option|needs a value/)
  })

  test('[T016-7] a base manifest that does not parse exits 1', () => {
    const bad = copy((d) => writeFileSync(join(d, 'MANIFEST.json'), '{ not json'))
    const r = run(['--base', join(bad, 'MANIFEST.json')])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/base manifest/)
  })

  test('[T016-6] a base manifest at the git ref that does not parse exits 1, even unfrozen and outside CI', () => {
    // Unreferenced git objects: a commit whose manifest is not JSON, touching no ref or work tree.
    const git = (args: string[], input?: string): string =>
      spawnSync('git', args, { cwd: PKG, encoding: 'utf8', ...(input === undefined ? {} : { input }) }).stdout.trim()
    let tree = git(['mktree'], `100644 blob ${git(['hash-object', '-w', '--stdin'], '{not json')}\tMANIFEST.json\n`)
    for (const name of ['test-vectors', 'schema', 'packages']) tree = git(['mktree'], `040000 tree ${tree}\t${name}\n`)
    const commit = git(['commit-tree', tree, '-m', 'probe'])
    expect(commit).toMatch(/^[0-9a-f]{40}$/)
    const r = run(['--dir', copy(setFrozen(false))], { VECTOR_BASE_REF: commit })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/does not parse/)
  })

  test('[T016-6] a missing manifest exits 1', () => {
    const dir = copy((d) => rmSync(join(d, 'MANIFEST.json')))
    const r = run(['--dir', dir])
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/MANIFEST\.json is missing/)
  })
})

describe('packaging (spec 016 batch C)', () => {
  test('[T016-8] exports, publishConfig and no publish script; root ci runs check:vectors', () => {
    const pkg = readJson<{ exports: Record<string, string>; publishConfig?: { access?: string }; scripts: Record<string, string> }>(
      join(PKG, 'package.json'),
    )
    expect(pkg.exports).toMatchObject({
      '.': './src/index.ts',
      './receipt': './src/receipt.ts',
      './vectors': './src/vectors/run.ts',
      './testing/virtual-authenticator': './test/fixtures/virtual-authenticator.ts',
      './test-vectors/*.json': './test-vectors/*.json',
      './corpus/l3/*.json': './test/corpus/l3/*.json',
    })
    expect(pkg.publishConfig?.access).toBe('public')
    expect(Object.keys(pkg.scripts).filter((s) => /publish/.test(s))).toEqual([])
    expect(pkg.scripts['check:vectors']).toBeDefined()
    const root = readJson<{ scripts: Record<string, string> }>(join(PKG, '../../package.json'))
    expect(root.scripts.ci).toMatch(/check:vectors/)
  })
})
