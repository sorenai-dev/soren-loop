import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { checkWorkflowDir, findUnpinnedActions } from '../check-action-pins.mjs'

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1'

describe('findUnpinnedActions', () => {
  test('[T001-8] accepts an action pinned by a full commit SHA', () => {
    const yaml = `steps:\n  - uses: actions/checkout@${SHA} # v7.0.1\n`
    expect(findUnpinnedActions(yaml, 'ci.yml')).toEqual([])
  })

  test('[T001-9] reports a tag-pinned action with its file and line', () => {
    const yaml = `steps:\n  - run: echo hi\n  - uses: actions/checkout@v7\n`
    expect(findUnpinnedActions(yaml, 'ci.yml')).toEqual([
      { file: 'ci.yml', line: 3, ref: 'actions/checkout@v7' },
    ])
  })

  test('[T001-10] reports a branch ref, a short SHA and a missing ref', () => {
    const yaml = [
      'jobs:',
      '  a:',
      '    uses: org/repo/.github/workflows/x.yml@main',
      '  b:',
      '    steps:',
      "      - uses: 'actions/setup-node@949feb2'",
      '      - uses: actions/setup-node',
    ].join('\n')
    expect(findUnpinnedActions(yaml, 'w.yml').map((f) => f.line)).toEqual([3, 6, 7])
  })

  test('[T001-11] allows local actions and digest-pinned docker images', () => {
    const yaml = [
      '- uses: ./.github/actions/setup',
      `- uses: docker://ghcr.io/org/img@sha256:${'a'.repeat(64)}`,
    ].join('\n')
    expect(findUnpinnedActions(yaml, 'w.yml')).toEqual([])
  })

  test('[T001-12] reports a docker image pinned only by tag', () => {
    expect(findUnpinnedActions('- uses: docker://alpine:3.20', 'w.yml')).toHaveLength(1)
  })
})

describe('checkWorkflowDir', () => {
  test('[T001-13] scans every .yml and .yaml file in the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-'))
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'a.yml'), `- uses: actions/checkout@${SHA}\n`)
    writeFileSync(join(dir, 'b.yaml'), '- uses: actions/checkout@v7\n')
    writeFileSync(join(dir, 'notes.md'), '- uses: actions/checkout@v7\n')
    expect(checkWorkflowDir(dir).map((f) => f.file)).toEqual([join(dir, 'b.yaml')])
  })
})
