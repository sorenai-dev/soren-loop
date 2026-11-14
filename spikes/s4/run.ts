// Spike S4 runner: `node run.ts [--only 1,2,3] [--quick]`
// Needs Docker and `npx playwright install chromium`. Bundles the page, starts the stub sync server
// on 127.0.0.1:8099, drives flagd through docker compose, and writes results/run-<id>.json.
// --quick takes fewer latency samples (smoke test). Exit 0 when every row matches.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { q1 } from './checks/q1-sync-auth.ts';
import { q2 } from './checks/q2-latency.ts';
import { q3 } from './checks/q3-provider.ts';
import * as flagd from './lib/flagd.ts';
import { newRun, print, write } from './lib/record.ts';
import { SyncStub } from './lib/sync-stub.ts';

const argv = process.argv.slice(2);
const onlyArg = argv[argv.indexOf('--only') + 1];
const only = argv.includes('--only') && onlyArg ? new Set(onlyArg.split(',').map(Number)) : null;
const quick = argv.includes('--quick');

const bundle = spawnSync('npx', ['esbuild', 'page/app.ts', '--bundle', '--format=esm', '--outfile=page/dist/app.js', '--log-level=warning'], { cwd: import.meta.dirname, encoding: 'utf8' });
if (bundle.status !== 0) throw new Error(`bundle failed: ${bundle.stderr}`);

// A fresh random credential per run: the sync endpoint's bearer. Never written to results.
const token = randomUUID();
const stub = new SyncStub(token, {
  sl_on_alice: { targets: ['alice'] },
  sl_off: { targets: ['carol'] },
  sl_bob_only: { targets: ['bob'] },
  sl_secret_alice: { targets: ['alice'] },
});
await stub.listen(flagd.SYNC_PORT);

const run = newRun();
const steps: Array<[number, () => Promise<void>]> = [
  [1, () => q1(run, stub, token)],
  [2, () => q2(run, stub, token, quick ? [[1, 3], [5, 2]] : [[1, 20], [5, 20], [10, 10]])],
  [3, () => q3(run, stub, token)],
];
try {
  for (const [q, fn] of steps) {
    if (only && !only.has(q)) continue;
    console.log(`== Q${q}`);
    try {
      await fn();
    } catch (e) {
      run.rows.push({ q, check: `error: ${(e as Error).message}`, expected: '-', observed: 'threw', ok: false });
    }
  }
} finally {
  flagd.down();
  await stub.close();
}

console.log('');
print(run.rows);
const file = write(JSON.parse(JSON.stringify(run).split(token).join('[redacted]')));
console.log(`\nevidence: ${join('results', file.split('/results/')[1] ?? file)}`);
process.exit(run.rows.every((r) => r.ok) ? 0 : 1);
