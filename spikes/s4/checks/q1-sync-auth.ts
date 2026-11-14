// Q1 (ST-19, SR-13): can flagd's HTTP sync send a bearer credential, and what happens when it's wrong?
// Q4: does flagd persist any flag document to disk?
import { spawnSync } from 'node:child_process';
import * as flagd from '../lib/flagd.ts';
import { check, expect, note, type Run } from '../lib/record.ts';
import type { SyncStub } from '../lib/sync-stub.ts';

export async function q1(run: Run, stub: SyncStub, token: string): Promise<void> {
  const t0 = await flagd.up(`Bearer ${token}`, 1);
  await flagd.sleep(3_500);
  const polls = stub.polls.filter((p) => p.t > t0);
  expect(run, 1, 'every flagd poll carries the configured bearer', polls.every((p) => p.authorization === 'correct'), [true], { polls: polls.length });
  check(run, 1, 'flagd revalidates with If-None-Match; unchanged polls get 304', { ifNoneMatch: polls.some((p) => p.ifNoneMatch), s304: polls.filter((p) => p.status === 304).length }, polls.some((p) => p.status === 304), '304s present');
  expect(run, 1, 'flagd evaluates from the authenticated sync', (await flagd.evalOne('sl_on_alice', 'alice')).value, [true]);

  const anon = await fetch(`http://127.0.0.1:${flagd.SYNC_PORT}/flags.json`);
  expect(run, 1, 'ST-19 shape: sync endpoint without credentials', anon.status, [401]);

  // The credential sits in flagd's command line, readable by anyone who can inspect the container.
  const inspect = spawnSync('docker', ['inspect', 's4-flagd-1', '--format', '{{json .Args}}'], { encoding: 'utf8' }).stdout;
  expect(run, 1, 'bearer visible in container args (docker inspect)', inspect.includes(token), [true]);

  // Q4 on a container that has synced repeatedly: no document written anywhere.
  await flagd.sleep(2_000);
  expect(run, 4, 'flagd container filesystem changes after syncing (docker diff)', flagd.diff(), [[]]);

  // Credential rotated on the server while flagd runs with the old one (after a good start).
  const rotatedAt = performance.now();
  stub.rotate(`${token}-rotated`);
  stub.set('sl_on_alice', { targets: [] });
  await flagd.sleep(5_000);
  const afterRotate = stub.polls.filter((p) => p.t > rotatedAt);
  note(run, '1:rotation polls', afterRotate.map((p) => p.status));
  // Finding: flagd keeps running and serving its last good document; only its logs show the 401s.
  expect(run, 1, 'rotated credential: flagd keeps running', flagd.state(), ['running 0']);
  const probes = Object.fromEntries(await Promise.all(['healthz', 'readyz'].map(async (p) => [p, await fetch(`http://127.0.0.1:8014/${p}`).then((r) => r.status, () => 0)])));
  expect(run, 1, 'rotated credential: health and readiness probes', probes, [probes], probes);
  const metrics = await fetch('http://127.0.0.1:8014/metrics').then((r) => r.text(), () => '');
  note(run, '1:rotation sync-related metrics', metrics.split('\n').filter((l) => /sync|error|fail/i.test(l) && !l.startsWith('#')).slice(0, 12));
  const stale = await flagd.evalOne('sl_on_alice', 'alice');
  expect(run, 1, 'rotated credential: a killed flag still evaluates on (stale)', stale.value, [true], stale);
  note(run, '1:rotation flagd log', flagd.logs().filter((l) => /401|error|fatal|warn/i.test(l)).slice(0, 5));
  stub.rotate(token);
  stub.set('sl_on_alice', { targets: ['alice'] });

  // Wrong credential from the start: one refused poll, then flagd exits (fails closed).
  const t1 = flagd.start('Bearer not-the-configured-value', 1);
  await flagd.sleep(6_000);
  const wrong = stub.polls.filter((p) => p.t > t1);
  expect(run, 1, 'wrong bearer at start: polls refused', wrong.map((p) => `${p.authorization} ${p.status}`), [['wrong 401']]);
  expect(run, 1, 'wrong bearer at start: flagd exits', flagd.state(), ['exited 1']);
  note(run, '1:wrong-bearer flagd log', flagd.logs().filter((l) => /401|fatal/i.test(l)).slice(0, 3));
}
