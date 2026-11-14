// Item 8 (rows 13-15): the three same-repo gaps the owner asked to close before the G03 PR.
//   13. T33: does a `push` workflow on `soren-loop/**` see repo secrets when the App pushes?
//   14. Can the repo App's token write branches outside `soren-loop/*`, and does a branch ruleset
//       with an admin-only bypass confine it while leaving humans and the default branch alone?
//   15. Does `maintainer_can_modify: false` mean anything on a same-repo PR (ST-49)?
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defer, expectStatus, expectValue, note, type Context } from '../lib/context.ts';
import { ensureWorkflow } from '../lib/fixtures.ts';
import { api, git, mint, owner, type Res } from '../lib/github.ts';
import { PROBE_NAME, SAME_REPO, addRuleset, gh, probeReport } from './c7-same-repo.ts';

const HERE = join(import.meta.dirname, '..');
const PUSH_WF_PATH = '.github/workflows/s1g-push-probe.yml';
const PUSH_WF = `name: s1g-push-probe
on:
  push:
    branches: ['soren-loop/**']
permissions: {}
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - env: { S: "\${{ secrets.${PROBE_NAME} }}" }
        run: if [ -n "$S" ]; then echo "s1g probe_present=true"; else echo "s1g probe_present=false"; fi
`;
const b64 = (s: string) => Buffer.from(s).toString('base64');
// GitHub's built-in repository role ids for ruleset bypass. Undocumented and NOT sequential:
// maintain 2, write 4, admin 5 (github/rest-api-description#4406). Guessing "write = 3" is wrong.
export const ROLE = { maintain: 2, write: 4, admin: 5 } as const;

async function branchWithCommit(tok: string, up: string, branch: string, base: string): Promise<{ ref: Res; commit: Res }> {
  const ref = await api(tok, 'POST', `/repos/${up}/git/refs`, { ref: `refs/heads/${branch}`, sha: base });
  const commit = await api(tok, 'PUT', `/repos/${up}/contents/s1g/${branch.replace(/\//g, '_')}.txt`, { message: 'feat: s1g probe', content: b64(`${branch}\n`), branch });
  return { ref, commit };
}

function dropBranch(ctx: Context, up: string, branch: string): void {
  defer(ctx, `delete ${up}:${branch}`, () => void owner('DELETE', `/repos/${up}/git/refs/heads/${branch}`));
}

export function confineRuleset(ctx: Context, up: string, roles: number[] = [ROLE.admin], item = 14): void {
  const res = owner('POST', `/repos/${up}/rulesets`, {
    name: `s1g-confine-app-${ctx.runId}`,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: roles.map((actor_id) => ({ actor_type: 'RepositoryRole', actor_id, bypass_mode: 'always' })),
    conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/soren-loop/**', '~DEFAULT_BRANCH'] } },
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
  });
  expectStatus(ctx, item, `owner adds a ruleset confining the App to soren-loop/**, bypass roles ${roles.join(',')} (reverted)`, res, [201]);
  const id = (res.body as { id?: number } | null)?.id;
  if (id) defer(ctx, `delete ruleset ${id}`, () => void owner('DELETE', `/repos/${up}/rulesets/${id}`));
}

export async function run(ctx: Context): Promise<void> {
  const up = ctx.cfg.upstreamPrivate;
  const guard = { denialGuard: true };
  const id = ctx.runId;

  expectValue(ctx, 13, 'owner sets random probe secret (reverted)', gh(['secret', 'set', PROBE_NAME, '-R', up], randomUUID()).status, [0]);
  defer(ctx, `delete ${PROBE_NAME}`, () => void gh(['secret', 'delete', PROBE_NAME, '-R', up]));
  ensureWorkflow(ctx, up, PUSH_WF_PATH, PUSH_WF);
  addRuleset(ctx, up, 13);

  const t = await mint(ctx.cfg, 'pr', up, SAME_REPO);
  expectStatus(ctx, 13, 'App mints the same-repo set', t.evidence, [201]);
  if (!t.token) return;
  const tok = t.token;
  const main = (owner('GET', `/repos/${up}/git/ref/heads/main`).body as { object: { sha: string } }).object.sha;

  // 13. T33: push workflows on soren-loop/** branches.
  const slBranch = `soren-loop/s1g-push-${id}`;
  dropBranch(ctx, up, slBranch);
  const pushed = await branchWithCommit(tok, up, slBranch, main);
  expectStatus(ctx, 13, 'App pushes a soren-loop/* branch', pushed.commit, [201]);
  const sha = (pushed.commit.body as { commit?: { sha?: string } } | null)?.commit?.sha;
  if (sha) {
    const r = await probeReport(up, sha, 'push');
    note(ctx, 13, 'push run', r.run);
    expectValue(ctx, 13, 'T33: push workflow on soren-loop/** sees the repo secret (risk)', r.report, ['s1g probe_present=true'], r.run);
  }

  // 14. Branches outside soren-loop/*: first unconfined (the gap), then with the confining ruleset.
  const free = `feature/s1g-${id}`;
  dropBranch(ctx, up, free);
  const before = await branchWithCommit(tok, up, free, main);
  expectStatus(ctx, 14, 'unconfined: App creates feature/* branch (gap)', before.ref, [201]);
  const work = mkdtempSync(join(HERE, '.work-'));
  try {
    git(HERE, ['clone', '-q', '--depth', '1', `https://github.com/${up}.git`, work], tok);
    writeFileSync(join(work, 's1g-git.txt'), `${id}\n`);
    git(work, ['add', '-A']);
    git(work, ['-c', 'user.name=s1g', '-c', 'user.email=s1g@users.noreply.github.com', 'commit', '-qm', 'test: s1g branch probe']);
    const gitFree = `release/s1g-${id}`;
    dropBranch(ctx, up, gitFree);
    const p1 = git(work, ['push', '-q', 'origin', `HEAD:refs/heads/${gitFree}`], tok);
    expectValue(ctx, 14, 'unconfined: App git push to release/* (gap)', p1.code, [0], p1.stderr);

    confineRuleset(ctx, up);
    const blocked = `feature/s1g-b-${id}`;
    dropBranch(ctx, up, blocked);
    expectStatus(ctx, 14, 'confined: App creates feature/* branch', await api(tok, 'POST', `/repos/${up}/git/refs`, { ref: `refs/heads/${blocked}`, sha: main }), [403, 409, 422], guard);
    expectStatus(ctx, 14, 'confined: App updates the earlier feature/* branch', await api(tok, 'PUT', `/repos/${up}/contents/s1g/late-${id}.txt`, { message: 's1g', content: b64('x'), branch: free }), [403, 409, 422], guard);
    const gitBlocked = `release/s1g-b-${id}`;
    dropBranch(ctx, up, gitBlocked);
    const p2 = git(work, ['push', '-q', 'origin', `HEAD:refs/heads/${gitBlocked}`], tok);
    ctx.rows.push({ item: 14, check: 'confined: App git push to release/*', expected: 'rejected', observed: `exit ${p2.code}`, ok: p2.code !== 0, ...(p2.code === 0 ? { stopTheLine: true } : {}) });
    note(ctx, 14, 'confined git push', p2);
    const ok = `soren-loop/s1g-ok-${id}`;
    dropBranch(ctx, up, ok);
    expectStatus(ctx, 14, 'confined: App still creates soren-loop/* branch', (await branchWithCommit(tok, up, ok, main)).commit, [201]);
    const human = `feature/s1g-owner-${id}`;
    dropBranch(ctx, up, human);
    expectStatus(ctx, 14, 'confined: owner (admin bypass) creates feature/* branch', owner('POST', `/repos/${up}/git/refs`, { ref: `refs/heads/${human}`, sha: main }), [201]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // 15. maintainer_can_modify on a same-repo PR.
  const pr = await api(tok, 'POST', `/repos/${up}/pulls`, { title: `S1-G probe ${id}`, head: slBranch, base: 'main', body: 'Spike S1-G probe. Safe to close.', maintainer_can_modify: false });
  expectStatus(ctx, 15, 'App opens same-repo PR with maintainer_can_modify:false', pr, [201]);
  const n = (pr.body as { number?: number } | null)?.number;
  if (n) {
    defer(ctx, `close ${up}#${n}`, () => void owner('PATCH', `/repos/${up}/pulls/${n}`, { state: 'closed' }));
    const field = (owner('GET', `/repos/${up}/pulls/${n}`).body as { maintainer_can_modify?: boolean } | null)?.maintainer_can_modify;
    expectValue(ctx, 15, 'same-repo PR: maintainer_can_modify as GitHub reports it', field, [false, true]);
  }
}
