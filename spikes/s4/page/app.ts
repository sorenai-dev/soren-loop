// Browser page for S4: the stock OFREP web provider, unpatched, pointed at the host's handler.
// Query: ?cache=local-cache-first|network-first|disabled&change=sse|polling|none&poll=<ms>
// It deliberately sets a forged targetingKey ("bob") to show the handler ignores browser context.
import { OFREPWebProvider } from '@openfeature/ofrep-web-provider';
import { OpenFeature, ProviderEvents, type Provider } from '@openfeature/web-sdk';

type CacheMode = 'local-cache-first' | 'network-first' | 'disabled';
type Change = 'sse' | 'polling' | 'none';

const q = new URLSearchParams(location.search);
const events: Array<{ t: number; type: string; flags?: string[] }> = [];

const provider = new OFREPWebProvider({
  baseUrl: location.origin,
  cacheMode: (q.get('cache') ?? 'disabled') as CacheMode,
  changeDetection: (q.get('change') ?? 'none') as Change,
  pollInterval: Number(q.get('poll') ?? 0),
  disableVisibilityRefresh: true,
});

OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, (e) => {
  const flags = e?.flagsChanged as string[] | undefined;
  events.push({ t: performance.now(), type: 'changed', ...(flags ? { flags } : {}) });
});

const ready = (async () => {
  await OpenFeature.setContext({ targetingKey: 'bob' });
  // The provider's `hooks?: Hook[]` clashes with the SDK's `Provider` type under the repo's
  // exactOptionalPropertyTypes; it is the stock provider, used as shipped.
  await OpenFeature.setProviderAndWait(provider as unknown as Provider);
  return performance.now();
})();

const client = OpenFeature.getClient();

Object.assign(window, {
  __s4: {
    ready,
    events,
    now: () => performance.now(),
    eval: (keys: string[]) =>
      keys.map((k) => {
        const d = client.getBooleanDetails(k, false);
        return { key: k, value: d.value, reason: d.reason, errorCode: d.errorCode ?? null };
      }),
  },
});
