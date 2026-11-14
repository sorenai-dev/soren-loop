// Spike S1-F runner: `node run.ts --org sorenai-dev-sandbox [--only 4,5,6,7]`
// Prints a pass/fail table of raw status codes, writes results/run-<id>.json, and reverts every
// sandbox change after each item. Exit 0: all as expected; 1: unexpected; 2: stop-the-line.
import { existsSync } from 'node:fs';
import { parseArgs } from './lib/config.ts';
import { newContext, printTable, runCleanups, writeResults, type Context } from './lib/context.ts';
import * as c4 from './checks/c4-approval-gate.ts';
import * as c5 from './checks/c5-st48-merge-denial.ts';
import * as c6 from './checks/c6-review-bypass.ts';
import * as c7 from './checks/c7-same-repo.ts';

// Items 1-3 (private forks, org fork policy, private fork-PR settings) were removed once private forks
// were dropped (S1-F P1, 2026-11-14). Their code is in commit 1ef94c9; results are in the write-up.
const ITEMS: Array<[number, (ctx: Context) => Promise<void>]> = [
  [4, c4.run],
  [5, c5.run],
  [6, c6.run],
  // Items 7-12 (same-repo model), selected together with --only 7. Not in the default run: they need
  // the PR App widened to contents:write, which the fork-model items must not have.
  [7, c7.run],
];

const cfg = parseArgs(process.argv.slice(2));
for (const app of Object.values(cfg.apps)) {
  if (!existsSync(app.keyPath)) throw new Error(`missing ${app.keyPath}: generate a key for ${app.slug} first`);
}

const ctx = newContext(cfg);
const cleanupFailures: string[] = [];
for (const [item, fn] of ITEMS) {
  if (cfg.only ? !cfg.only.has(item) : item === 7) continue;
  console.log(`\n== item ${item}`);
  try {
    await fn(ctx);
  } catch (e) {
    ctx.rows.push({ item, check: `error: ${(e as Error).message}`, expected: '-', observed: 'threw', ok: false });
  } finally {
    // Revert per item, so one item's settings never leak into the next (item 4 needs defaults).
    cleanupFailures.push(...(await runCleanups(ctx)));
    ctx.prs.clear();
  }
}

console.log('');
printTable(ctx.rows);
const file = writeResults(ctx, cleanupFailures);
console.log(`\nevidence: ${file}`);
if (cleanupFailures.length) console.log(`\nCLEANUP FAILED, revert by hand:\n  ${cleanupFailures.join('\n  ')}`);

const stop = ctx.rows.filter((r) => r.stopTheLine);
if (stop.length) {
  console.log('\nSTOP THE LINE: unexpected 2xx on merge or upstream write. Report before Tasks 060-066.');
  process.exit(2);
}
process.exit(ctx.rows.every((r) => r.ok) && !cleanupFailures.length ? 0 : 1);
