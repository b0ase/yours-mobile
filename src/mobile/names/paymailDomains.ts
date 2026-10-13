import type { Fetch } from './names';

/**
 * "Other wallet ▾" in the recipient box (owner, 13 Oct 2026). A $name is a bWalletX handle only; to pay
 * someone on another wallet the user picks its paymail domain explicitly, which builds name@domain and is
 * always shown in full with "outside bWalletX". Only domains whose bsvalias document answers are shown.
 */
export const OTHER_PAYMAIL_DOMAINS = [
  'handcash.io',
  'twetch.me',
  'relayx.io',
  'simply.cash',
  'centbee.com',
  'moneybutton.com',
] as const;

export const LIVE_CACHE_KEY = 'bw.paymailDomains.live.v1';
export const LIVE_CACHE_MS = 24 * 60 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 4000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
type Cached = { at: number; live: string[] };

const defaultStore = (): Store | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};

const readCache = (store: Store | undefined, now: number): string[] | undefined => {
  try {
    const c = JSON.parse(store?.getItem(LIVE_CACHE_KEY) ?? 'null') as Cached | null;
    if (c && Array.isArray(c.live) && now - c.at < LIVE_CACHE_MS) return c.live;
  } catch {
    /* no cache */
  }
  return undefined;
};

/** Does https://<domain>/.well-known/bsvalias answer with capabilities within the timeout? */
export const probeDomain = async (f: Fetch, domain: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> => {
  const ctl = typeof AbortController === 'undefined' ? undefined : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((res) => {
    timer = setTimeout(() => {
      ctl?.abort();
      res(false);
    }, timeoutMs);
  });
  const probe = (async () => {
    try {
      const res = await f(`https://${domain}/.well-known/bsvalias`, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) return false;
      const doc = (await res.json()) as { capabilities?: unknown };
      return !!doc?.capabilities && typeof doc.capabilities === 'object';
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** The known domains that answer right now (cached about a day). Dead ones are hidden. */
export const liveDomains = async (
  f: Fetch,
  opts: { store?: Store; now?: number; domains?: readonly string[]; timeoutMs?: number } = {},
): Promise<string[]> => {
  const store = opts.store ?? defaultStore();
  const now = opts.now ?? Date.now();
  const cached = readCache(store, now);
  if (cached) return cached;
  const domains = opts.domains ?? OTHER_PAYMAIL_DOMAINS;
  const ok = await Promise.all(domains.map((d) => probeDomain(f, d, opts.timeoutMs)));
  const live = domains.filter((_, i) => ok[i]);
  try {
    store?.setItem(LIVE_CACHE_KEY, JSON.stringify({ at: now, live } satisfies Cached));
  } catch {
    /* storage blocked */
  }
  return live;
};

/** "$boase" / "boase" / "boase@x.com" + "handcash.io" → "boase@handcash.io" ('' if there's no name). */
export const withDomain = (typed: string, domain: string): string => {
  const name = typed.trim().replace(/^\$/, '').split('@')[0].toLowerCase();
  return name ? `${name}@${domain}` : '';
};
