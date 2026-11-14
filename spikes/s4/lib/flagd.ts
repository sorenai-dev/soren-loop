// flagd lifecycle for S4 through docker compose, plus direct OFREP calls that bypass the handler.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..');
export const FLAGD = 'http://127.0.0.1:8016';
export const SYNC_PORT = 8099;
const CONTAINER = 's4-flagd-1';

function compose(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync('docker', ['compose', ...args], { cwd: DIR, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

// Starts a fresh flagd; returns the start time (performance.now) so polls can be windowed.
export function start(authHeader: string, intervalSec: number): number {
  compose(['down', '--remove-orphans']);
  const started = performance.now();
  compose(['up', '-d'], {
    S4_SYNC_URL: `http://host.docker.internal:${SYNC_PORT}/flags.json`,
    S4_AUTH_HEADER: authHeader,
    S4_INTERVAL: String(intervalSec),
  });
  return started;
}

// `up --wait` returns before flagd listens (the image has no healthcheck), so poll /healthz.
export async function up(authHeader: string, intervalSec: number): Promise<number> {
  const started = start(authHeader, intervalSec);
  while (performance.now() - started < 30_000) {
    const ok = await fetch('http://127.0.0.1:8014/healthz').then((r) => r.ok, () => false);
    if (ok) return started;
    await sleep(200);
  }
  throw new Error('flagd did not become healthy within 30 s');
}

// Container status and exit code, e.g. "running 0" or "exited 1".
export function state(): string {
  return spawnSync('docker', ['inspect', CONTAINER, '--format', '{{.State.Status}} {{.State.ExitCode}}'], { encoding: 'utf8' }).stdout.trim();
}

export const down = (): void => void compose(['down', '--remove-orphans']);

export const logs = (): string[] => compose(['logs', '--no-color', 'flagd']).split('\n');

// Filesystem changes inside the flagd container since it started (question 4).
export function diff(): string[] {
  const r = spawnSync('docker', ['diff', CONTAINER], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean);
}

export async function evalOne(key: string, targetingKey: string): Promise<{ status: number; value?: unknown; reason?: string; errorCode?: string }> {
  const r = await fetch(`${FLAGD}/ofrep/v1/evaluate/flags/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { targetingKey } }),
  }).catch(() => null);
  if (!r) return { status: 0 };
  const body = (await r.json().catch(() => ({}))) as { value?: unknown; reason?: string; errorCode?: string };
  return { status: r.status, ...body };
}

export async function evalBulk(targetingKey: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${FLAGD}/ofrep/v1/evaluate/flags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: { targetingKey } }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waits until flagd's evaluation of `key` for `targetingKey` equals `value`; returns elapsed ms.
export async function waitFor(key: string, targetingKey: string, value: boolean, timeoutMs: number, stepMs = 20): Promise<number | null> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const r = await evalOne(key, targetingKey);
    if (r.value === value) return performance.now() - start;
    await sleep(stepMs);
  }
  return null;
}
