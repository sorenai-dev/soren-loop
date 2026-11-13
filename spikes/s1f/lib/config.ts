// Spike S1-F configuration: sandbox org names, the two test Apps, and key locations.
// App IDs are public (GET /apps/{slug}); the private keys live outside the repo.
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AppName = 'pr' | 'push';

export interface Config {
  org: string;
  botOrg: string;
  upstreamPrivate: string;
  upstreamPublic: string;
  forkPrivate: string;
  forkPublic: string;
  apps: Record<AppName, { id: number; slug: string; keyPath: string }>;
  allowOrgToggle: boolean;
  only: Set<number> | null;
}

const KEY_DIR = join(homedir(), '.soren-loop-sandbox');
const ALLOWED_ORG = 'sorenai-dev-sandbox';

export function parseArgs(argv: string[]): Config {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const org = flag('--org');
  if (org !== ALLOWED_ORG) {
    throw new Error(`--org must be ${ALLOWED_ORG} (decision 35: never real repos); got ${org ?? 'nothing'}`);
  }
  const botOrg = `${org}-bot`;
  const only = flag('--only');
  return {
    org,
    botOrg,
    upstreamPrivate: `${org}/sl-upstream-private`,
    upstreamPublic: `${org}/sl-upstream-public`,
    forkPrivate: `${botOrg}/sl-upstream-private`,
    forkPublic: `${botOrg}/sl-upstream-public`,
    apps: {
      pr: { id: 5590874, slug: 'sl-sandbox-pr-abad', keyPath: join(KEY_DIR, 'pr', 'app.pem') },
      push: { id: 5590892, slug: 'sl-sandbox-push-abad', keyPath: join(KEY_DIR, 'push', 'app.pem') },
    },
    allowOrgToggle: argv.includes('--allow-org-toggle'),
    only: only ? new Set(only.split(',').map(Number)) : null,
  };
}

// The PR App's full decision-26 / SR-08 installed set. ST-48 mints with exactly this.
export const PR_APP_FULL = {
  pull_requests: 'write',
  issues: 'write',
  deployments: 'read',
  contents: 'read',
  metadata: 'read',
} as const;

export const PUSH_APP_FULL = { contents: 'write', metadata: 'read' } as const;
