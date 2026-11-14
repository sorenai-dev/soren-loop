// Item 9 (row 16): the branch-confinement ruleset with the owner-chosen bypass list, write + maintain
// + admin (2026-11-14). Run on the public upstream: rulesets behave the same for both visibilities, and
// the App is already installed there. It shows the App is still confined when human roles bypass;
// that a non-admin writer gets through needs a second human account and rests on GitHub's docs.
// Also S9: what the App's own token can see of a ruleset's bypass list.
import { defer, expectStatus, expectValue, note, type Context } from '../lib/context.ts';
import { api, mint, owner } from '../lib/github.ts';
import { SAME_REPO } from './c7-same-repo.ts';
import { ROLE, confineRuleset } from './c8-same-repo-gaps.ts';

export async function run(ctx: Context): Promise<void> {
  const up = ctx.cfg.upstreamPublic;
  const guard = { denialGuard: true };
  const t = await mint(ctx.cfg, 'pr', up, SAME_REPO);
  expectStatus(ctx, 16, 'App mints the same-repo set', t.evidence, [201]);
  if (!t.token) return;
  const tok = t.token;
  const main = (owner('GET', `/repos/${up}/git/ref/heads/main`).body as { object: { sha: string } }).object.sha;
  const del = (b: string) => defer(ctx, `delete ${up}:${b}`, () => void owner('DELETE', `/repos/${up}/git/refs/heads/${b}`));

  confineRuleset(ctx, up, [ROLE.write, ROLE.maintain, ROLE.admin], 16);
  note(ctx, 16, 'ruleset bypass as GitHub stores it', owner('GET', `/repos/${up}/rulesets`).body);
  const blocked = `feature/s1g-roles-${ctx.runId}`;
  del(blocked);
  expectStatus(ctx, 16, 'write+maintain+admin bypass: App creates feature/* branch', await api(tok, 'POST', `/repos/${up}/git/refs`, { ref: `refs/heads/${blocked}`, sha: main }), [403, 409, 422], guard);
  const ok = `soren-loop/s1g-roles-${ctx.runId}`;
  del(ok);
  expectStatus(ctx, 16, 'write+maintain+admin bypass: App creates soren-loop/* branch', await api(tok, 'POST', `/repos/${up}/git/refs`, { ref: `refs/heads/${ok}`, sha: main }), [201]);
  const human = `feature/s1g-roles-owner-${ctx.runId}`;
  del(human);
  expectStatus(ctx, 16, 'write+maintain+admin bypass: owner creates feature/* branch', owner('POST', `/repos/${up}/git/refs`, { ref: `refs/heads/${human}`, sha: main }), [201]);

  // S9: the App can't read bypass lists, but sees whether it can bypass itself.
  const id = (owner('GET', `/repos/${up}/rulesets`).body as Array<{ id: number; name: string }>).find((r) => r.name.startsWith('s1g-confine-app-'))?.id;
  if (id) {
    const seen = (await api(tok, 'GET', `/repos/${up}/rulesets/${id}`)).body as Record<string, unknown>;
    expectValue(ctx, 16, 'S9: App GET ruleset includes bypass_actors', 'bypass_actors' in seen, [false]);
    expectValue(ctx, 16, 'S9: App current_user_can_bypass (App not a bypass actor)', seen.current_user_can_bypass, ['never']);
    const appBypass = owner('POST', `/repos/${up}/rulesets`, { name: `s1g-app-bypass-${ctx.runId}`, target: 'branch', enforcement: 'active', bypass_actors: [{ actor_type: 'Integration', actor_id: ctx.cfg.apps.pr.id, bypass_mode: 'always' }], conditions: { ref_name: { include: ['refs/heads/s1g-none/**'], exclude: [] } }, rules: [{ type: 'creation' }] });
    const bid = (appBypass.body as { id?: number } | null)?.id;
    if (bid) {
      defer(ctx, `delete ruleset ${bid}`, () => void owner('DELETE', `/repos/${up}/rulesets/${bid}`));
      const b = (await api(tok, 'GET', `/repos/${up}/rulesets/${bid}`)).body as Record<string, unknown>;
      expectValue(ctx, 16, 'S9: App current_user_can_bypass once the App is a bypass actor', b.current_user_can_bypass, ['always']);
    }
  }
}
