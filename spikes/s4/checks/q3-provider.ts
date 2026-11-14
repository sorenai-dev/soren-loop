// Q3 (gating, T25; ST-68, ST-51 shape): does the stock OFREP web provider work through an
// allowlist-filtered bulk handler, and what does that mean for the kill switch in the browser?
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import * as flagd from '../lib/flagd.ts';
import { Host } from '../lib/host.ts';
import { check, expect, note, type Run } from '../lib/record.ts';
import type { SyncStub } from '../lib/sync-stub.ts';

export const ALLOWLIST = ['sl_on_alice', 'sl_off', 'sl_bob_only'];
const KEYS = [...ALLOWLIST, 'sl_secret_alice'];
const DROP = 8097;
const PROXY = 8098;

type Detail = { key: string; value: boolean; reason?: string; errorCode: string | null };

async function open(ctx: BrowserContext, port: number, query: string): Promise<{ page: Page; ready: string; bodies: string[] }> {
  const page = await ctx.newPage();
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (r.url().endsWith('/ofrep/v1/evaluate/flags') && r.status() === 200) bodies.push(await r.text().catch(() => ''));
  });
  await page.goto(`http://127.0.0.1:${port}/?${query}`);
  const ready = await page.evaluate(() => (window as unknown as { __s4: { ready: Promise<number> } }).__s4.ready.then(() => 'ready', (e: Error) => `error: ${e.message}`));
  return { page, ready, bodies };
}

const evalIn = (page: Page, keys: string[]) =>
  page.evaluate((k) => (window as unknown as { __s4: { eval: (k: string[]) => Detail[] } }).__s4.eval(k), keys);

const valueOf = async (page: Page, key: string) => (await evalIn(page, [key]))[0]?.value;

async function context(browser: Browser, sub: string | null): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  if (sub) await ctx.addCookies([{ name: 's4user', value: sub, domain: '127.0.0.1', path: '/' }]);
  return ctx;
}

// Time from the sync-source change until the page reports `want`, or null after `timeoutMs`.
async function browserLatency(page: Page, stub: SyncStub, on: boolean, timeoutMs: number): Promise<number | null> {
  const t0 = stub.set('sl_on_alice', on ? { targets: ['alice'] } : { targets: [] });
  while (performance.now() - t0 < timeoutMs) {
    if ((await valueOf(page, 'sl_on_alice')) === on) return Math.round(performance.now() - t0);
    await flagd.sleep(50);
  }
  return null;
}

async function reset(stub: SyncStub): Promise<void> {
  stub.set('sl_on_alice', { targets: ['alice'] });
  await flagd.waitFor('sl_on_alice', 'alice', true, 10_000);
}

export async function q3(run: Run, stub: SyncStub, token: string): Promise<void> {
  await flagd.up(`Bearer ${token}`, 1);
  await reset(stub);
  const drop = new Host(DROP, { flagdUrl: flagd.FLAGD, allowlist: ALLOWLIST, sse: 'drop' });
  const proxy = new Host(PROXY, { flagdUrl: flagd.FLAGD, allowlist: ALLOWLIST, sse: 'proxy' });
  await drop.listen();
  await proxy.listen();
  const browser = await chromium.launch();
  try {
    // A. The stock provider through the filtering handler.
    const a = await context(browser, 'alice');
    const A = await open(a, DROP, 'cache=disabled&change=none');
    expect(run, 3, 'stock provider initialises through the handler', A.ready, ['ready']);
    expect(run, 3, 'provider calls only POST bulk (no single-flag calls)', [...new Set(drop.hits.map((h) => `${h.method} ${h.path}`))], [['POST /ofrep/v1/evaluate/flags']]);
    const d = Object.fromEntries((await evalIn(A.page, KEYS)).map((x) => [x.key, x]));
    expect(run, 3, 'allowlisted flag targeting the session user', { value: d.sl_on_alice?.value, reason: d.sl_on_alice?.reason }, [{ value: true, reason: 'TARGETING_MATCH' }]);
    expect(run, 3, 'allowlisted flag not targeting the user', d.sl_off?.value, [false]);
    expect(run, 3, 'forged browser targetingKey "bob" is ignored', d.sl_bob_only?.value, [false], d.sl_bob_only);
    expect(run, 3, 'non-allowlisted flag targeting the user resolves to default', { value: d.sl_secret_alice?.value, errorCode: d.sl_secret_alice?.errorCode }, [{ value: false, errorCode: 'FLAG_NOT_FOUND' }]);
    const body = A.bodies[0] ?? '';
    expect(run, 3, 'bulk response the browser saw: keys', (JSON.parse(body || '{}') as { flags?: Array<{ key: string }> }).flags?.map((f) => f.key).sort(), [[...ALLOWLIST].sort()]);
    expect(run, 3, 'bulk response contains no metadata or eventStreams', /metadata|eventStreams/.test(body), [false]);
    const direct = await flagd.evalBulk('alice');
    const directKeys = ((direct.body as { flags?: Array<{ key: string }> } | null)?.flags ?? []).map((f) => f.key);
    expect(run, 3, 'control: flagd bulk direct returns every flag (enumeration)', directKeys.includes('sl_secret_alice'), [true], directKeys);
    await a.close();

    // B. No host session.
    const b = await context(browser, null);
    const B = await open(b, DROP, 'cache=disabled&change=none');
    expect(run, 3, 'no session: handler 401, provider fails to initialise', { ready: B.ready.startsWith('error'), last: drop.hits.at(-1)?.status }, [{ ready: true, last: 401 }], B.ready);
    expect(run, 3, 'no session: flags fall back to default', await valueOf(B.page, 'sl_on_alice'), [false]);
    await b.close();

    // C-E. Kill switch in the browser: polling, SSE dropped by the handler, SSE relayed.
    const scenarios: Array<[string, number, string, number]> = [
      ['polling 1s', DROP, 'cache=disabled&change=polling&poll=1000', 8_000],
      ['SSE advertised but dropped, no polling', DROP, 'cache=disabled&change=sse&poll=0', 12_000],
      ['SSE relayed by the handler', PROXY, 'cache=disabled&change=sse&poll=0', 8_000],
    ];
    for (const [label, port, query, timeout] of scenarios) {
      await reset(stub);
      const ctx = await context(browser, 'alice');
      const s = await open(ctx, port, query);
      await flagd.sleep(1_500);
      const ms = await browserLatency(s.page, stub, false, timeout);
      check(run, 3, `kill switch, ${label}: sync change → browser off (ms)`, ms, label.includes('dropped') ? ms === null : ms !== null, label.includes('dropped') ? `null (never within ${timeout} ms)` : 'not null');
      await ctx.close();
    }

    // F. The default cache mode: a killed flag after a reload.
    await reset(stub);
    const f = await context(browser, 'alice');
    const F1 = await open(f, DROP, 'cache=local-cache-first&change=none');
    expect(run, 3, 'local-cache-first: first load sees the flag on', await valueOf(F1.page, 'sl_on_alice'), [true]);
    await F1.page.close();
    stub.set('sl_on_alice', { targets: [] });
    await flagd.waitFor('sl_on_alice', 'alice', false, 10_000);
    const F2 = await open(f, DROP, 'cache=local-cache-first&change=none');
    const atReady = await valueOf(F2.page, 'sl_on_alice');
    const t0 = performance.now();
    let after: number | null = null;
    while (performance.now() - t0 < 5_000) {
      if ((await valueOf(F2.page, 'sl_on_alice')) === false) {
        after = Math.round(performance.now() - t0);
        break;
      }
      await flagd.sleep(50);
    }
    // Finding: the default cache mode serves the killed flag as on until the background refresh lands.
  expect(run, 3, 'local-cache-first (default): reload after kill, value at ready is stale', atReady, [true], { refreshedToOffAfterMs: after });
  check(run, 3, 'local-cache-first: background refresh then turns it off (ms)', after, after !== null, 'not null');
    note(run, '3:local-cache-first refresh after ready (ms)', after);
    note(run, '3:localStorage keys', await F2.page.evaluate(() => Object.keys(localStorage)));
    await f.close();
  } finally {
    await browser.close();
    await drop.close();
    await proxy.close();
  }
}
