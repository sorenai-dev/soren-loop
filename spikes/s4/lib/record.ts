// Result rows, raw evidence and the printed table for S4 (same shape as spikes/s1f).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Row {
  q: number;
  check: string;
  expected: string;
  observed: string;
  ok: boolean;
}

export interface Run {
  rows: Row[];
  evidence: Record<string, unknown>;
  runId: string;
}

export const newRun = (): Run => ({ rows: [], evidence: {}, runId: new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) });

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

export function expect(run: Run, q: number, check: string, observed: unknown, expected: unknown[], extra?: unknown): Row {
  const ok = expected.some((e) => canonical(e) === canonical(observed));
  return push(run, q, check, observed, expected.map(canonical).join('|'), ok, extra);
}

// For a predicate over the observation (a bound, a membership), with a human-readable expectation.
export function check(run: Run, q: number, name: string, observed: unknown, ok: boolean, expected: string, extra?: unknown): Row {
  return push(run, q, name, observed, expected, ok, extra);
}

function push(run: Run, q: number, check: string, observed: unknown, expected: string, ok: boolean, extra: unknown): Row {
  const row: Row = { q, check, expected, observed: canonical(observed), ok };
  run.rows.push(row);
  run.evidence[`${q}:${check}`] = { observed, ...(extra === undefined ? {} : { extra }) };
  return row;
}

export function note(run: Run, key: string, value: unknown): void {
  run.evidence[key] = value;
}

export function write(run: Run): string {
  const dir = join(import.meta.dirname, '..', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${run.runId}.json`);
  writeFileSync(file, JSON.stringify(run, null, 2) + '\n');
  return file;
}

export function print(rows: Row[]): void {
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  for (const r of rows) {
    console.log(`${String(r.q).padEnd(2)} ${(r.ok ? 'pass' : 'FAIL').padEnd(5)} ${cut(r.expected, 28).padEnd(28)} ${cut(r.observed, 34).padEnd(34)} ${r.check}`);
  }
}
