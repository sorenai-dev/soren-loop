// Sandbox fixtures. Owner-side changes go through `gh` and each registers its own revert.
import { PR_APP_FULL, PUSH_APP_FULL } from './config.ts';
import { defer, note, type Context } from './context.ts';
import { api, mint, owner, pick, type Res } from './github.ts';

const WORKFLOW_PATH = '.github/workflows/s1f-ci.yml';
const WORKFLOW = `name: s1f-ci
on: pull_request
permissions: {}
jobs:
  probe:
    runs-on: ubuntu-latest
    steps:
      - run: echo "s1f event=\${{ github.event_name }} actor=\${{ github.actor }}"
`;

const b64 = (s: string) => Buffer.from(s).toString('base64');

function check(res: Res, what: string): Res {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(pick(res).body)}`);
  }
  return res;
}

// A pull_request workflow on upstream main, so fork-PR approval gating is observable (item 4).
export function ensureWorkflow(ctx: Context, upstream: string, path = WORKFLOW_PATH, content = WORKFLOW): void {
  const existing = owner('GET', `/repos/${upstream}/contents/${path}?ref=main`);
  if (existing.status === 200) return;
  const put = check(
    owner('PUT', `/repos/${upstream}/contents/${path}`, {
      message: 'chore: add s1f probe workflow (spike S1-F)',
      content: b64(content),
      branch: 'main',
    }),
    `add workflow to ${upstream}`,
  );
  const sha = (put.body as { content: { sha: string } }).content.sha;
  defer(ctx, `remove workflow from ${upstream}`, () => {
    check(
      owner('DELETE', `/repos/${upstream}/contents/${path}`, {
        message: 'chore: remove s1f probe workflow (spike S1-F)',
        sha,
        branch: 'main',
      }),
      `remove workflow from ${upstream}`,
    );
  });
}

// The push App writes a branch with one commit on the bot fork, as `submit` would.
export async function pushForkBranch(ctx: Context, fork: string, branch: string): Promise<Res> {
  const t = await mint(ctx.cfg, 'push', fork, PUSH_APP_FULL);
  if (!t.token) throw new Error(`push App mint on ${fork} failed: ${JSON.stringify(t.evidence)}`);
  const main = check(await api(t.token, 'GET', `/repos/${fork}/git/ref/heads/main`), `read ${fork} main`);
  const sha = (main.body as { object: { sha: string } }).object.sha;
  check(
    await api(t.token, 'POST', `/repos/${fork}/git/refs`, { ref: `refs/heads/${branch}`, sha }),
    `create ${fork}:${branch}`,
  );
  defer(ctx, `delete ${fork}:${branch}`, async () => {
    const d = await mint(ctx.cfg, 'push', fork, PUSH_APP_FULL);
    if (d.token) await api(d.token, 'DELETE', `/repos/${fork}/git/refs/heads/${branch}`);
  });
  return api(t.token, 'PUT', `/repos/${fork}/contents/s1f/${branch}.txt`, {
    message: `feat: s1f probe change on ${branch}`,
    content: b64(`spike S1-F ${ctx.runId}\n`),
    branch,
  });
}

// Opens a fork-head PR with the PR App's full installed set; closes it on cleanup.
export async function openPr(ctx: Context, upstream: string, branch: string): Promise<Res> {
  const t = await mint(ctx.cfg, 'pr', upstream, PR_APP_FULL);
  if (!t.token) throw new Error(`PR App mint on ${upstream} failed: ${JSON.stringify(t.evidence)}`);
  const res = await api(t.token, 'POST', `/repos/${upstream}/pulls`, {
    title: `S1-F probe ${branch}`,
    head: `${ctx.cfg.botOrg}:${branch}`,
    base: 'main',
    body: 'Spike S1-F sandbox probe. Safe to close.',
    maintainer_can_modify: false,
  });
  const n = (res.body as { number?: number } | null)?.number;
  if (res.status === 201 && n) {
    defer(ctx, `close ${upstream}#${n}`, () => {
      owner('PATCH', `/repos/${upstream}/pulls/${n}`, { state: 'closed' });
    });
  }
  return res;
}

// One shared fork-head PR on the public upstream for items that only need "an open bot PR".
// (Private forks were dropped after S1-F finding P1; private repos use the same-repo model, item 7.)
export async function sharedPr(ctx: Context): Promise<number> {
  const { upstreamPublic: upstream, forkPublic: fork } = ctx.cfg;
  const cached = ctx.prs.get(upstream);
  if (cached) return cached;
  const branch = `s1f-public-${ctx.runId}`;
  check(await pushForkBranch(ctx, fork, branch), `push ${fork}:${branch}`);
  const pr = check(await openPr(ctx, upstream, branch), `open PR on ${upstream}`);
  const n = (pr.body as { number: number }).number;
  ctx.prs.set(upstream, n);
  note(ctx, 0, `shared PR ${upstream}`, pick(pr, ['number', 'html_url', 'maintainer_can_modify']));
  return n;
}

// Sets a JSON setting through `gh`, restoring the captured previous value on cleanup.
export function withSetting(ctx: Context, path: string, method: 'PUT' | 'PATCH', next: object): Res {
  const before = owner('GET', path);
  check(before, `read ${path}`);
  const prev = Object.fromEntries(Object.keys(next).map((k) => [k, (before.body as Record<string, unknown>)[k]]));
  const res = owner(method, path, next);
  if (res.status >= 200 && res.status < 300) {
    // Verify by read-back: an org-level restore can cascade to the repo, and a repo-level write
    // right after an org change was once refused (422 "Policy is forbidden by entity owner").
    defer(ctx, `restore ${path}`, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const w = owner(method, path, prev);
        const now = owner('GET', path).body as Record<string, unknown>;
        if (Object.entries(prev).every(([k, v]) => now[k] === v)) return;
        if (attempt === 2) check(w, `restore ${path}`);
        await new Promise((r) => setTimeout(r, 3_000));
      }
    });
  }
  return res;
}

// Polls the upstream's workflow runs for a PR head until one appears or the timeout passes.
export async function waitForRun(upstream: string, headSha: string, timeoutMs = 90_000): Promise<Res> {
  const deadline = Date.now() + timeoutMs;
  let last: Res = { status: 0, body: null };
  while (Date.now() < deadline) {
    last = owner('GET', `/repos/${upstream}/actions/runs?head_sha=${headSha}&event=pull_request`);
    const runs = (last.body as { workflow_runs?: unknown[] } | null)?.workflow_runs ?? [];
    if (runs.length) return last;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  return last;
}
