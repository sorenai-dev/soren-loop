import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import { SchemaError } from '../../src/index.ts'

/** Runs fn, asserts it threw a SchemaError, and returns the error's reason. */
export function reasonOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError)
    return (error as SchemaError).reason
  }
  throw new Error('expected a SchemaError, but nothing was thrown')
}

export interface Vector<I = Record<string, unknown>> {
  id: string
  description: string
  input: I
  expected_bytes_hex?: string
  expected_hash?: string
  expected_error?: string
  [extra: string]: unknown
}

export function loadVectors(file: 'hash.json' | 'normalize.json'): Vector[] {
  const url = new URL(`../../test-vectors/${file}`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as Vector[]
}

export function vector<I = Record<string, unknown>>(file: 'hash.json' | 'normalize.json', id: string): Vector<I> {
  const found = loadVectors(file).find((v) => v.id === id)
  if (!found) throw new Error(`vector ${id} not found in ${file}`)
  return found as Vector<I>
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

export function utf8Hex(s: string): string {
  return Buffer.from(s, 'utf8').toString('hex')
}
