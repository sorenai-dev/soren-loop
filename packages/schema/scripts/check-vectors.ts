// The vector-change guard (spec 016 DD4). A published vector never changes: changing one needs a
// major release and a new prefix version (RFC 04 §3.5, 05 §4), so the old vector stays and the
// new prefix gets new vectors. MANIFEST.json records a digest per vector; once the release gate
// freezes it, any change or removal of a recorded vector fails CI.
//
//   pnpm --filter @sorenai/loop-schema run check:vectors [--update] [--dir <dir>] [--base <file>]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { jcs } from '../src/hash/jcs.ts'
import type { VectorFile } from '../src/vectors/run.ts'

export interface Manifest { frozen: boolean; vectors: Record<VectorFile, Record<string, string>> }
type Vectors = Record<VectorFile, readonly unknown[]>
interface Result { ok: boolean; problems: string[] }

const FILES: VectorFile[] = ['normalize.json', 'hash.json', 'challenge.json', 'receipt.json']
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const MANIFEST_IN_REPO = 'packages/schema/test-vectors/MANIFEST.json'

/** sha256 of the vector's normative content: everything but its id and description. */
function digest(v: unknown): string {
  const normative = Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'id' && k !== 'description'),
  )
  return bytesToHex(sha256(utf8ToBytes(jcs(normative))))
}

const idOf = (v: unknown): string => String((v as { id?: unknown }).id)

export function buildManifest(vectors: Vectors, frozen: boolean): Manifest {
  const out = {} as Manifest['vectors']
  for (const file of FILES) out[file] = Object.fromEntries((vectors[file] ?? []).map((v) => [idOf(v), digest(v)]))
  return { frozen, vectors: out }
}

export function checkVectors(opts: { vectors: Vectors; manifest: Manifest; base?: Manifest }): Result {
  const problems = new Set<string>()
  const current = buildManifest(opts.vectors, opts.manifest.frozen)
  const compare = (recorded: Manifest): void => {
    for (const file of FILES) {
      const now = current.vectors[file]
      for (const [id, d] of Object.entries(recorded.vectors[file] ?? {})) {
        if (!Object.hasOwn(now, id)) problems.add(`removed: ${file} ${id}`)
        else if (now[id] !== d) problems.add(`changed: ${file} ${id}`)
      }
    }
  }
  compare(opts.manifest)
  for (const file of FILES) {
    const seen = new Set<string>()
    for (const id of (opts.vectors[file] ?? []).map(idOf)) {
      if (seen.has(id)) problems.add(`duplicate: ${file} ${id}`)
      seen.add(id)
    }
  }
  for (const file of FILES) {
    for (const id of Object.keys(current.vectors[file])) {
      if (!Object.hasOwn(opts.manifest.vectors[file] ?? {}, id)) problems.add(`unrecorded: ${file} ${id}`)
    }
  }
  if (opts.base?.frozen) {
    compare(opts.base)
    if (!opts.manifest.frozen) problems.add('unfrozen: the base manifest is frozen')
  }
  return { ok: problems.size === 0, problems: [...problems] }
}

// ---- CLI ---------------------------------------------------------------------------------
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

class BaseError extends Error {}

function parseBase(text: string, where: string): Manifest {
  try {
    return JSON.parse(text) as Manifest
  } catch {
    throw new BaseError(`the base manifest at ${where} does not parse`)
  }
}

/** The base branch's manifest: undefined when the ref has none yet; throws when the ref is bad. */
function gitBase(ref: string): Manifest | undefined {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: 'pipe' })
  git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  try {
    git('cat-file', '-e', `${ref}:${MANIFEST_IN_REPO}`)
  } catch {
    return undefined // the ref predates the manifest
  }
  return parseBase(git('show', `${ref}:${MANIFEST_IN_REPO}`), `${ref}:${MANIFEST_IN_REPO}`)
}

interface Options { update: boolean; dir?: string; base?: string }

function parseArgs(argv: string[]): Options {
  const opts: Options = { update: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--update') {
      opts.update = true
    } else if (arg === '--dir' || arg === '--base') {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      opts[arg === '--dir' ? 'dir' : 'base'] = value
    } else {
      throw new Error(`unknown option ${arg}`)
    }
  }
  return opts
}

function main(argv: string[]): number {
  let opts: Options
  try {
    opts = parseArgs(argv)
  } catch (error) {
    console.error(`check:vectors: ${(error as Error).message}`)
    return 1
  }
  try {
    return check(opts)
  } catch (error) {
    if (!(error instanceof BaseError)) throw error
    console.error(`check:vectors: ${error.message}`)
    return 1
  }
}

function check(opts: Options): number {
  const dir = opts.dir ?? join(PACKAGE_DIR, 'test-vectors')
  const manifestPath = join(dir, 'MANIFEST.json')
  const { update } = opts
  const vectors = Object.fromEntries(FILES.map((f) => [f, readJson<unknown[]>(join(dir, f))])) as unknown as Vectors
  if (!existsSync(manifestPath) && !update) {
    console.error(`check:vectors: ${manifestPath} is missing; run with --update to create it`)
    return 1
  }
  const manifest = existsSync(manifestPath) ? readJson<Manifest>(manifestPath) : buildManifest(vectors, false)

  let base: Manifest | undefined
  if (opts.base !== undefined) {
    base = parseBase(readFileSync(opts.base, 'utf8'), opts.base)
  } else {
    const ref = process.env.VECTOR_BASE_REF ?? 'origin/main'
    try {
      base = gitBase(ref)
    } catch (error) {
      if (error instanceof BaseError) throw error
      const message = `check:vectors: cannot read base ref ${ref}`
      if (manifest.frozen || process.env.CI) {
        console.error(`${message}; set VECTOR_BASE_REF and fetch enough history`)
        return 1
      }
      console.warn(`warning: ${message}; checking without the base manifest`)
    }
  }

  if (update) {
    // Only additions may be recorded once the base is frozen.
    const frozenProblems = base?.frozen
      ? checkVectors({ vectors, manifest: buildManifest(vectors, true), base }).problems
      : []
    if (frozenProblems.length > 0) {
      console.error(`check:vectors: refusing --update over a frozen base:\n  ${frozenProblems.join('\n  ')}`)
      return 1
    }
    writeFileSync(manifestPath, `${JSON.stringify(buildManifest(vectors, manifest.frozen), null, 2)}\n`)
    console.log(`check:vectors: wrote ${manifestPath}`)
    return 0
  }

  const result = checkVectors({ vectors, manifest, ...(base ? { base } : {}) })
  if (!result.ok) {
    console.error(`check:vectors: ${result.problems.length} problem(s):\n  ${result.problems.join('\n  ')}`)
    console.error('A recorded vector never changes; add vectors under a new prefix version instead.')
    return 1
  }
  console.log('check:vectors: ok')
  return 0
}

// import.meta.main, not an argv[1] comparison: that one fails when run through a symlinked path.
if (import.meta.main) process.exitCode = main(process.argv.slice(2))
