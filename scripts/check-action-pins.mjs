#!/usr/bin/env node
// Fails when any workflow `uses:` reference is not pinned to an immutable ref (SR-16).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const USES = /^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)/
const PINNED_ACTION = /^[\w.-]+\/[\w.-]+(?:\/[^@]+)?@[0-9a-f]{40}$/
const PINNED_IMAGE = /^docker:\/\/[^@]+@sha256:[0-9a-f]{64}$/

function isPinned(ref) {
  return ref.startsWith('./') || PINNED_ACTION.test(ref) || PINNED_IMAGE.test(ref)
}

export function findUnpinnedActions(text, file) {
  return text.split('\n').flatMap((content, index) => {
    const ref = USES.exec(content)?.[1]
    return ref && !isPinned(ref) ? [{ file, line: index + 1, ref }] : []
  })
}

export function checkWorkflowDir(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .flatMap((entry) => {
      const file = join(dir, entry.name)
      return findUnpinnedActions(readFileSync(file, 'utf8'), file)
    })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : ['.github/workflows']
  const findings = dirs.flatMap(checkWorkflowDir)
  for (const { file, line, ref } of findings) {
    console.error(`${file}:${line}: ${ref} is not pinned to a full commit SHA`)
  }
  process.exit(findings.length > 0 ? 1 : 0)
}
