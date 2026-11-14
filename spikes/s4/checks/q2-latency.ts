// Q2 (`10` §4 kill switch): latency from a change in the sync source ("DB change") to flagd's
// evaluation changing, at three poll intervals. Excludes the server's own render time.
import * as flagd from '../lib/flagd.ts';
import { check, note, type Run } from '../lib/record.ts';
import type { SyncStub } from '../lib/sync-stub.ts';

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN);
};

export async function q2(run: Run, stub: SyncStub, token: string, plan: Array<[number, number]>): Promise<void> {
  for (const [interval, samples] of plan) {
    stub.set('sl_on_alice', { targets: ['alice'] });
    await flagd.up(`Bearer ${token}`, interval);
    await flagd.waitFor('sl_on_alice', 'alice', true, (interval + 10) * 1000);
    let current = true;
    const lat: number[] = [];
    let missed = 0;
    for (let i = 0; i < samples; i++) {
      // Random phase, so changes land anywhere in the poll cycle.
      await flagd.sleep(Math.random() * interval * 1000);
      current = !current;
      stub.set('sl_on_alice', current ? { targets: ['alice'] } : { targets: [] });
      const ms = await flagd.waitFor('sl_on_alice', 'alice', current, (interval + 5) * 1000);
      if (ms === null) missed++;
      else lat.push(ms);
    }
    const stats = { n: lat.length, missed, p50: pct(lat, 50), p95: pct(lat, 95), max: Math.round(Math.max(...lat)) };
    note(run, `2:interval ${interval}s samples`, lat.map(Math.round));
    const bound = interval * 1000 + 1000;
    check(run, 2, `interval ${interval}s: change → evaluation latency (ms)`, stats, missed === 0 && stats.max <= bound, `max ≤ ${bound}, none missed`);
  }
}
