// Shared run context: the result rows, raw evidence per item, and a LIFO cleanup stack so every
// sandbox change (settings, rulesets, PRs, branches) is reverted even when a check throws.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.ts';
import { redact, type Res } from './github.ts';

export interface Row {
  item: number;
  check: string;
  expected: string;
  observed: string;
  ok: boolean;
  // A 2xx where we expected denial on merge or upstream push: report before Phase 1 GitHub work.
  stopTheLine?: boolean;
}

export interface Context {
  cfg: Config;
  rows: Row[];
  evidence: Record<string, unknown>;
  cleanups: Array<{ label: string; fn: () => Promise<void> | void }>;
  runId: string;
  // Fixtures shared between items (open PR numbers per upstream), so `--only 5` still works.
  prs: Map<string, number>;
}

const RESULTS = join(import.meta.dirname, '..', 'results');

export function newContext(cfg: Config): Context {
  const runId = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  return { cfg, rows: [], evidence: {}, cleanups: [], runId, prs: new Map() };
}

// Records a row by comparing a raw HTTP status with the expected set. Never interprets bodies.
export function expectStatus(
  ctx: Context,
  item: number,
  check: string,
  res: Res,
  expected: number[],
  opts: { denialGuard?: boolean } = {},
): Row {
  const ok = expected.includes(res.status);
  const row: Row = {
    item,
    check,
    expected: expected.join('|'),
    observed: String(res.status),
    ok,
    ...(opts.denialGuard && res.status >= 200 && res.status < 300 ? { stopTheLine: true } : {}),
  };
  ctx.rows.push(row);
  ctx.evidence[`${item}:${check}`] = redact(res);
  return row;
}

// For observations that are a value, not a status (a setting, a review decision, git exit code).
// Key-order-independent JSON, so `{a, b}` from GitHub equals `{b, a}` from the contract.
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

export function expectValue(ctx: Context, item: number, check: string, observed: unknown, expected: unknown[], extra?: unknown): Row {
  const ok = expected.some((e) => canonical(e) === canonical(observed));
  const row: Row = { item, check, expected: expected.map((e) => JSON.stringify(e)).join('|'), observed: JSON.stringify(observed), ok };
  ctx.rows.push(row);
  ctx.evidence[`${item}:${check}`] = redact({ observed, extra });
  return row;
}

export function note(ctx: Context, item: number, check: string, observed: unknown): void {
  ctx.evidence[`${item}:${check}`] = redact(observed);
}

export function defer(ctx: Context, label: string, fn: () => Promise<void> | void): void {
  ctx.cleanups.push({ label, fn });
}

export async function runCleanups(ctx: Context): Promise<string[]> {
  const failures: string[] = [];
  while (ctx.cleanups.length) {
    const c = ctx.cleanups.pop();
    if (!c) break;
    try {
      await c.fn();
    } catch (e) {
      failures.push(`${c.label}: ${(e as Error).message}`);
    }
  }
  return failures;
}

export function writeResults(ctx: Context, cleanupFailures: string[]): string {
  mkdirSync(RESULTS, { recursive: true });
  const file = join(RESULTS, `run-${ctx.runId}.json`);
  const out = redact({ runId: ctx.runId, rows: ctx.rows, cleanupFailures, evidence: ctx.evidence });
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return file;
}

export function printTable(rows: Row[]): void {
  const lines = rows.map((r) => [
    String(r.item),
    r.stopTheLine ? 'STOP' : r.ok ? 'pass' : 'FAIL',
    r.expected,
    r.observed,
    r.check,
  ]);
  const head = ['#', 'result', 'expected', 'observed', 'check'];
  const widths = head.map((h, i) => Math.max(h.length, ...lines.map((l) => (l[i] ?? '').length)));
  const fmt = (l: string[]) => l.map((c, i) => (i === l.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join('  ');
  console.log(fmt(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const l of lines) console.log(fmt(l));
}
