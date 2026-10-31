// Spike S1 runner. Usage: node run-spike.mjs [q5|q3|q1q2|q4|all]
// Evidence (status codes + trimmed bodies, tokens redacted) is written to results/*.json.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { api, mint, summarize, record, trackSecret, scrub, UPSTREAM, FORK } from './lib.mjs';

const HERE = import.meta.dirname;
const STATE = join(HERE, 'results', 'state.json');
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
const b64 = (s) => Buffer.from(s).toString('base64');
const PR_ONLY = { pull_requests: 'write', metadata: 'read' };
const FORK_PUSH = { contents: 'write', metadata: 'read' };

async function branch(token, repo, name) {
  const main = await api(token, 'GET', `/repos/${repo}/git/ref/heads/main`);
  return api(token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${name}`, sha: main.body.object.sha });
}

const putFile = (token, repo, path, branchName, content, sha) =>
  api(token, 'PUT', `/repos/${repo}/contents/${path}`, {
    message: `s1: write ${path}`, content: b64(content), branch: branchName, ...(sha ? { sha } : {}),
  });

async function q5() {
  const up = await mint(UPSTREAM, PR_ONLY);
  const listed = await api(up.token, 'GET', '/installation/repositories');
  const writeContents = await putFile(up.token, UPSTREAM, 'q5-probe.txt', 'main', 'probe');
  const overGrant = await mint(UPSTREAM, { workflows: 'write' });
  const forkWithUpstreamInstall = await mint(FORK, PR_ONLY);
  record('q5-downscoping', {
    upstream_pr_only_token: up.evidence,
    repos_visible_to_token: listed.body?.repositories?.map((r) => r.full_name),
    upstream_contents_write_with_pr_only_token: summarize(writeContents),
    mint_permission_app_lacks_workflows: overGrant.evidence,
    note_fork_token_is_minted_from_the_fork_installation: forkWithUpstreamInstall.evidence,
  });
}

function git(cwd, args, token) {
  const header = token ? ['-c', `http.extraHeader=Authorization: Basic ${b64(`x-access-token:${token}`)}`] : [];
  const r = spawnSync('git', [...header, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, stderr: scrub(r.stderr.trim()) };
}

async function q3() {
  const fork = await mint(FORK, FORK_PUSH);
  trackSecret(b64(`x-access-token:${fork.token}`));
  const ev = { fork_token: fork.evidence };

  ev.api_create_feature_branch = summarize(await branch(fork.token, FORK, 's1-feature'));
  ev.api_put_normal_file = summarize(await putFile(fork.token, FORK, 'feature.txt', 's1-feature', 'hello from the bot\n'));
  ev.api_add_workflow = summarize(await putFile(fork.token, FORK, '.github/workflows/evil.yml', 's1-feature', 'name: evil\non: push\njobs: {}\n'));
  const existing = await api(fork.token, 'GET', `/repos/${FORK}/contents/.github/workflows/secret-check.yml?ref=s1-feature`);
  ev.api_modify_workflow = summarize(await putFile(fork.token, FORK, '.github/workflows/secret-check.yml', 's1-feature', '# tampered\n', existing.body?.sha));
  ev.api_write_upstream_with_fork_token = summarize(await putFile(fork.token, UPSTREAM, 'x.txt', 'main', 'x'));
  ev.control_branch = summarize(await branch(fork.token, FORK, 's1-control'));
  ev.control_file = summarize(await putFile(fork.token, FORK, 'control.txt', 's1-control', 'control\n'));

  const work = mkdtempSync(join(HERE, '.work-'));
  const clone = git(HERE, ['clone', '-q', `https://github.com/${FORK}.git`, work]);
  const id = ['-c', 'user.name=s1-bot', '-c', 'user.email=s1-bot@users.noreply.github.com'];
  git(work, ['checkout', '-q', '-b', 's1-git-normal']);
  writeFileSync(join(work, 'git-normal.txt'), 'normal\n');
  git(work, ['add', '-A']); git(work, [...id, 'commit', '-qm', 's1: normal file']);
  ev.git_push_normal = git(work, ['push', '-q', 'origin', 's1-git-normal'], fork.token);

  git(work, ['checkout', '-q', '-b', 's1-git-workflow-add']);
  mkdirSync(join(work, '.github/workflows'), { recursive: true });
  writeFileSync(join(work, '.github/workflows/evil2.yml'), 'name: evil2\non: push\njobs: {}\n');
  git(work, ['add', '-A']); git(work, [...id, 'commit', '-qm', 's1: add workflow']);
  ev.git_push_add_workflow = git(work, ['push', '-q', 'origin', 's1-git-workflow-add'], fork.token);

  git(work, ['checkout', '-q', 'main']); git(work, ['checkout', '-q', '-b', 's1-git-workflow-modify']);
  writeFileSync(join(work, '.github/workflows/secret-check.yml'), '# tampered\n');
  git(work, ['add', '-A']); git(work, [...id, 'commit', '-qm', 's1: modify workflow']);
  ev.git_push_modify_workflow = git(work, ['push', '-q', 'origin', 's1-git-workflow-modify'], fork.token);
  ev.git_push_upstream_with_fork_token = git(work, ['push', '-q', `https://github.com/${UPSTREAM}.git`, 's1-git-normal'], fork.token);
  ev.clone = clone;
  record('q3-workflow-push', ev);
}

async function openPr(token, headBranch, title) {
  return api(token, 'POST', `/repos/${UPSTREAM}/pulls`, {
    title, head: `sorenai-dev:${headBranch}`, base: 'main', body: 'Spike S1 test PR.', maintainer_can_modify: false,
  });
}

async function q1q2() {
  const ev = {};
  const variants = [
    ['pr_only', PR_ONLY],
    ['pr_plus_contents_read', { ...PR_ONLY, contents: 'read' }],
  ];
  let opened;
  for (const [name, perms] of variants) {
    const t = await mint(UPSTREAM, perms);
    const r = await openPr(t.token, 's1-feature', `S1 fork PR (${name})`);
    ev[`open_pr_${name}`] = { minted: t.evidence, ...summarize(r, ['number', 'html_url', 'message', 'errors', 'maintainer_can_modify']) };
    if (r.status === 201) { opened = { name, perms, number: r.body.number, token: t.token }; break; }
  }
  if (opened) {
    state.pr = opened.number; state.pr_variant = opened.name; save();
    const head = await api(opened.token, 'GET', `/repos/${UPSTREAM}/pulls/${opened.number}`);
    ev.pr_head = { repo: head.body?.head?.repo?.full_name, user: head.body?.user?.login, sha: head.body?.head?.sha };
    ev.merge_with_same_token = summarize(await api(opened.token, 'PUT', `/repos/${UPSTREAM}/pulls/${opened.number}/merge`, { merge_method: 'squash' }));
    // Control: the Option B posture. Upstream contents:write lets the App merge a second PR.
    const ctl = await openPr(opened.token, 's1-control', 'S1 control PR (merge with contents:write)');
    ev.control_pr = summarize(ctl, ['number', 'message', 'errors']);
    if (ctl.status === 201) {
      const cw = await mint(UPSTREAM, { ...PR_ONLY, contents: 'write' });
      ev.control_merge_with_contents_write = { minted: cw.evidence, ...summarize(await api(cw.token, 'PUT', `/repos/${UPSTREAM}/pulls/${ctl.body.number}/merge`, { merge_method: 'squash' }), ['merged', 'message', 'sha']) };
    }
  }
  record('q1q2-open-and-merge', ev);
}

function ghJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return r.status === 0 ? JSON.parse(r.stdout || 'null') : { error: r.stderr.trim() };
}

async function q4() {
  if (!state.pr) throw new Error('run q1q2 first');
  const pr = ghJson(['api', `repos/${UPSTREAM}/pulls/${state.pr}`]);
  const runs = ghJson(['api', `repos/${UPSTREAM}/actions/runs?head_sha=${pr.head.sha}`, '--jq', '[.workflow_runs[] | {id, event, status, conclusion, head_repository: .head_repository.full_name}]']);
  const ev = { pr: state.pr, head_sha: pr.head.sha, runs };
  for (const run of Array.isArray(runs) ? runs : []) {
    const log = spawnSync('gh', ['run', 'view', String(run.id), '-R', UPSTREAM, '--log'], { encoding: 'utf8' });
    run.report = (log.stdout.match(/head_repo=[^$\s]+ is_fork=(true|false) secret_present=(true|false)/) ?? [null])[0];
  }
  record('q4-fork-pr-secrets', ev);
}

const steps = { q5, q3, q1q2, q4 };
const which = process.argv[2] ?? 'all';
for (const [name, fn] of Object.entries(steps)) {
  if (which === 'all' ? name !== 'q4' : which === name) await fn();
}
