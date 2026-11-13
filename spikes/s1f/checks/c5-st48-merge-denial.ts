// Item 5 / ST-48 (SR-08, decision 26): a PR App token with its FULL installed set gets 403 on merge and
// is rejected on any write upstream. Any 2xx or git exit 0 here is a stop-the-line finding.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PR_APP_FULL } from '../lib/config.ts';
import { expectStatus, expectValue, type Context } from '../lib/context.ts';
import { sharedPr } from '../lib/fixtures.ts';
import { api, git, mint } from '../lib/github.ts';

const HERE = join(import.meta.dirname, '..');

function gitPushRow(ctx: Context, check: string, r: { code: number | null; stderr: string }): void {
  const accepted = r.code === 0;
  ctx.rows.push({ item: 5, check, expected: 'rejected', observed: `exit ${r.code}`, ok: !accepted, ...(accepted ? { stopTheLine: true } : {}) });
  ctx.evidence[`5:${check}`] = r;
}

async function probe(ctx: Context, which: 'private' | 'public'): Promise<void> {
  const up = which === 'private' ? ctx.cfg.upstreamPrivate : ctx.cfg.upstreamPublic;
  const n = await sharedPr(ctx, which);
  const t = await mint(ctx.cfg, 'pr', up, PR_APP_FULL);
  expectStatus(ctx, 5, `${which}: mint full PR App set`, t.evidence, [201]);
  expectValue(ctx, 5, `${which}: minted permissions equal the SR-08 set`, (t.evidence.body as { permissions?: unknown }).permissions, [PR_APP_FULL]);
  if (!t.token) return;
  const tok = t.token;

  const guard = { denialGuard: true };
  expectStatus(ctx, 5, `${which}: PUT /pulls/${n}/merge (merge)`, await api(tok, 'PUT', `/repos/${up}/pulls/${n}/merge`, { merge_method: 'merge' }), [403], guard);
  expectStatus(ctx, 5, `${which}: PUT /pulls/${n}/merge (squash)`, await api(tok, 'PUT', `/repos/${up}/pulls/${n}/merge`, { merge_method: 'squash' }), [403], guard);
  expectStatus(ctx, 5, `${which}: POST /merges into main`, await api(tok, 'POST', `/repos/${up}/merges`, { base: 'main', head: 'main', commit_message: 's1f' }), [403], guard);
  expectStatus(ctx, 5, `${which}: PUT contents on main`, await api(tok, 'PUT', `/repos/${up}/contents/s1f-st48.txt`, { message: 's1f', content: 'eA==', branch: 'main' }), [403], guard);
  expectStatus(ctx, 5, `${which}: POST git/refs new branch`, await api(tok, 'POST', `/repos/${up}/git/refs`, { ref: `refs/heads/s1f-st48-${ctx.runId}`, sha: '0000000000000000000000000000000000000000' }), [403, 404, 422], guard);

  const work = mkdtempSync(join(HERE, '.work-'));
  try {
    const clone = git(HERE, ['clone', '-q', '--depth', '1', `https://github.com/${up}.git`, work], tok);
    expectValue(ctx, 5, `${which}: git clone with contents:read`, clone.code, [0], clone.stderr);
    if (clone.code !== 0) return;
    const id = ['-c', 'user.name=s1f-probe', '-c', 'user.email=s1f-probe@users.noreply.github.com'];
    writeFileSync(join(work, 's1f-st48.txt'), `${ctx.runId}\n`);
    git(work, ['add', '-A']);
    git(work, [...id, 'commit', '-qm', 'test: s1f ST-48 push probe']);
    gitPushRow(ctx, `${which}: git push to upstream main`, git(work, ['push', '-q', 'origin', 'HEAD:main'], tok));
    gitPushRow(ctx, `${which}: git push new upstream branch`, git(work, ['push', '-q', 'origin', `HEAD:refs/heads/s1f-st48-${ctx.runId}`], tok));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function run(ctx: Context): Promise<void> {
  await probe(ctx, 'private');
  await probe(ctx, 'public');
}
