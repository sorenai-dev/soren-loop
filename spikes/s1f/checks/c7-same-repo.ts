// Items 7-12: the same-repo ("Dependabot") model for private repos (owner decision 2026-11-14, after P1).
// The App holds `contents: write` upstream, so the control is a default-branch ruleset requiring one
// approving review with no bypass actors. Each check asks whether that ruleset actually holds.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defer, expectStatus, expectValue, note, type Context } from '../lib/context.ts';
import { ensureWorkflow } from '../lib/fixtures.ts';
import { api, git, mint, owner } from '../lib/github.ts';

export const SAME_REPO = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const;
// A repo Actions secret holding a random, meaningless value: CI only reports whether it is non-empty.
const PROBE_NAME = 'S1G_PROBE';
const WF_PATH = '.github/workflows/s1g-probe.yml';
const WF = `name: s1g-probe
on: pull_request
permissions: {}
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - env: { S: "\${{ secrets.${PROBE_NAME} }}" }
        run: if [ -n "$S" ]; then echo "s1g probe_present=true"; else echo "s1g probe_present=false"; fi
`;
const HERE = join(import.meta.dirname, '..');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gh(args: string[], input?: string) {
  return spawnSync('gh', args, { encoding: 'utf8', ...(input === undefined ? {} : { input }) });
}

function addRuleset(ctx: Context, up: string): void {
  const res = owner('POST', `/repos/${up}/rulesets`, {
    name: `s1g-require-review-${ctx.runId}`,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: true, required_review_thread_resolution: false } },
    ],
  });
  expectStatus(ctx, 7, 'owner adds require-review ruleset, no bypass (reverted)', res, [201]);
  const id = (res.body as { id?: number } | null)?.id;
  if (id) defer(ctx, `delete ruleset ${id}`, () => void owner('DELETE', `/repos/${up}/rulesets/${id}`));
}

async function decision(up: string, n: number): Promise<{ reviewDecision?: string; mergeStateStatus?: string } | null> {
  const [o, r] = up.split('/');
  for (let i = 0; i < 10; i++) {
    const res = owner('POST', '/graphql', { query: `query { repository(owner: "${o}", name: "${r}") { pullRequest(number: ${n}) { reviewDecision mergeStateStatus } } }` });
    const pr = (res.body as { data?: { repository?: { pullRequest?: { reviewDecision?: string; mergeStateStatus?: string } } } } | null)?.data?.repository?.pullRequest ?? null;
    if (pr?.mergeStateStatus && pr.mergeStateStatus !== 'UNKNOWN') return pr;
    await sleep(3_000);
  }
  return null;
}

async function probeReport(up: string, sha: string): Promise<{ run: unknown; report: string | null }> {
  for (let i = 0; i < 40; i++) {
    const runs = owner('GET', `/repos/${up}/actions/runs?head_sha=${sha}&event=pull_request`);
    const run = ((runs.body as { workflow_runs?: Array<{ id: number; status: string; conclusion: string | null; actor?: { login?: string } }> } | null)?.workflow_runs ?? [])[0];
    if (run?.status === 'completed') {
      const log = gh(['run', 'view', String(run.id), '-R', up, '--log']).stdout;
      return { run: { id: run.id, conclusion: run.conclusion, actor: run.actor?.login }, report: /s1g probe_present=(true|false)/.exec(log)?.[0] ?? null };
    }
    await sleep(5_000);
  }
  return { run: null, report: null };
}

export async function run(ctx: Context): Promise<void> {
  const up = ctx.cfg.upstreamPrivate;
  const guard = { denialGuard: true };

  // Fixtures in revert order: probe secret and workflow outlive the ruleset (admins are not bypass actors).
  expectValue(ctx, 7, 'owner sets random probe secret (reverted)', gh(['secret', 'set', PROBE_NAME, '-R', up], randomUUID()).status, [0]);
  defer(ctx, `delete ${PROBE_NAME}`, () => void gh(['secret', 'delete', PROBE_NAME, '-R', up]));
  ensureWorkflow(ctx, up, WF_PATH, WF);
  addRuleset(ctx, up);

  const t = await mint(ctx.cfg, 'pr', up, SAME_REPO);
  expectStatus(ctx, 7, 'App mints {contents:write, pull_requests:write} upstream', t.evidence, [201]);
  if (!t.token) return;
  const tok = t.token;
  const branch = `soren-loop/s1g-${ctx.runId}`;
  defer(ctx, `delete ${up}:${branch}`, () => void owner('DELETE', `/repos/${up}/git/refs/heads/${branch}`));

  // Item 7: the App can do its job on a soren-loop/* branch.
  const main = (await api(tok, 'GET', `/repos/${up}/git/ref/heads/main`)).body as { object: { sha: string } };
  expectStatus(ctx, 7, 'App creates soren-loop/* branch', await api(tok, 'POST', `/repos/${up}/git/refs`, { ref: `refs/heads/${branch}`, sha: main.object.sha }), [201]);
  expectStatus(ctx, 7, 'App commits to its branch', await api(tok, 'PUT', `/repos/${up}/contents/s1g/${ctx.runId}.txt`, { message: 'feat: s1g probe', content: b64('one\n'), branch }), [201]);

  // Item 8: no direct write to main, by API or git.
  expectStatus(ctx, 8, 'App PUT contents on main', await api(tok, 'PUT', `/repos/${up}/contents/s1g-direct.txt`, { message: 's1g', content: b64('x'), branch: 'main' }), [403, 409, 422], guard);
  const work = mkdtempSync(join(HERE, '.work-'));
  try {
    git(HERE, ['clone', '-q', '--depth', '1', `https://github.com/${up}.git`, work], tok);
    writeFileSync(join(work, 's1g-git.txt'), `${ctx.runId}\n`);
    git(work, ['add', '-A']);
    git(work, ['-c', 'user.name=s1g', '-c', 'user.email=s1g@users.noreply.github.com', 'commit', '-qm', 'test: s1g push probe']);
    const pushMain = git(work, ['push', '-q', 'origin', 'HEAD:main'], tok);
    ctx.rows.push({ item: 8, check: 'App git push to main', expected: 'rejected', observed: `exit ${pushMain.code}`, ok: pushMain.code !== 0, ...(pushMain.code === 0 ? { stopTheLine: true } : {}) });
    note(ctx, 8, 'App git push to main', pushMain);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // Item 9: open, self-approve, merge before review, then stale approval after a bot push.
  const pr = await api(tok, 'POST', `/repos/${up}/pulls`, { title: `S1-G probe ${ctx.runId}`, head: branch, base: 'main', body: 'Spike S1-G sandbox probe. Safe to close.' });
  expectStatus(ctx, 9, 'App opens same-repo PR', pr, [201]);
  const n = (pr.body as { number?: number } | null)?.number;
  if (!n) return;
  defer(ctx, `close ${up}#${n}`, () => void owner('PATCH', `/repos/${up}/pulls/${n}`, { state: 'closed' }));
  const p = `/repos/${up}/pulls/${n}`;
  expectStatus(ctx, 9, 'App approves its own PR', await api(tok, 'POST', `${p}/reviews`, { event: 'APPROVE' }), [422]);
  expectStatus(ctx, 9, 'App merges before any review', await api(tok, 'PUT', `${p}/merge`, { merge_method: 'merge' }), [403, 405, 409, 422], guard);
  expectStatus(ctx, 9, 'owner approves (human review)', owner('POST', `${p}/reviews`, { event: 'APPROVE' }), [200]);
  expectStatus(ctx, 9, 'App pushes a new commit after approval', await api(tok, 'PUT', `/repos/${up}/contents/s1g/${ctx.runId}-late.txt`, { message: 'feat: s1g late push', content: b64('late\n'), branch }), [201]);
  // A first run saw reviewDecision APPROVED / CLEAN after the late push and a generic 405 on merge,
  // which could be a mergeability race. Let GitHub settle, then try the merge again.
  await sleep(30_000);
  const after = await decision(up, n);
  note(ctx, 9, 'decision 30s after the bot push', after);
  expectStatus(ctx, 9, 'App merges after its own late push (settled)', await api(tok, 'PUT', `${p}/merge`, { merge_method: 'merge' }), [403, 405, 409, 422], guard);
  expectStatus(ctx, 9, 'App merges after its own late push (retry +15s)', await (async () => { await sleep(15_000); return api(tok, 'PUT', `${p}/merge`, { merge_method: 'merge' }); })(), [403, 405, 409, 422], guard);

  // Item 10: the App cannot weaken the control; can it read it (for the backend start-up check)?
  expectStatus(ctx, 10, 'App reads branch rules (GET rules/branches/main)', await api(tok, 'GET', `/repos/${up}/rules/branches/main`), [200, 403, 404]);
  expectStatus(ctx, 10, 'App lists rulesets', await api(tok, 'GET', `/repos/${up}/rulesets`), [200, 403, 404]);
  const id = (owner('GET', `/repos/${up}/rulesets`).body as Array<{ id: number }> | null)?.[0]?.id;
  if (id) {
    expectStatus(ctx, 10, 'App deletes the ruleset', await api(tok, 'DELETE', `/repos/${up}/rulesets/${id}`), [403, 404], guard);
    expectStatus(ctx, 10, 'App disables the ruleset', await api(tok, 'PUT', `/repos/${up}/rulesets/${id}`, { enforcement: 'disabled' }), [403, 404], guard);
  }

  // Item 11: no workflow edits without the `workflows` permission.
  expectStatus(ctx, 11, 'App adds a workflow file on its branch', await api(tok, 'PUT', `/repos/${up}/contents/.github/workflows/s1g-evil.yml`, { message: 's1g', content: b64('name: x\non: push\njobs: {}\n'), branch }), [403, 404], guard);

  // Item 12: does App-authored same-repo PR CI see repo secrets before review? (expected: yes, the risk)
  const head = (owner('GET', p).body as { head?: { sha?: string } } | null)?.head?.sha;
  if (head) {
    const r = await probeReport(up, head);
    note(ctx, 12, 'run for head', r.run);
    expectValue(ctx, 12, 'same-repo App PR CI sees the repo secret (risk)', r.report, ['s1g probe_present=true'], r.run);
  }

  // Item 9, last: a human approves the App's latest commit. Can the App then press merge itself?
  // Informational (the ruleset is satisfied); it decides whether "a human merges" is enforceable.
  expectStatus(ctx, 9, 'owner approves the latest commit', owner('POST', `${p}/reviews`, { event: 'APPROVE' }), [200]);
  await sleep(15_000);
  expectStatus(ctx, 9, 'App merges a PR whose last push a human approved', await api(tok, 'PUT', `${p}/merge`, { merge_method: 'merge' }), [200, 405]);
}
