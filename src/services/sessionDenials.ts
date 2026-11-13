/**
 * Fewer prompts before play (TokenBlaster Assault playtest, 25 Oct 2026: five sheets before the game started).
 *
 * 1. Basket read denials, remembered for the browser session. A site that lists a basket the user said No to
 *    (listOutputs on "ordinals", "ordnance"…) used to get a fresh sheet every time its window regained focus. Now
 *    the No stands, per site and per basket, until the browser session ends (chrome.storage.session). Nothing is
 *    stored for longer, and a No is never turned into a Yes: the site's call is refused without a sheet.
 * 2. The site's manifest on its first identity-key request. The grouped (manifest.json) sheet used to open only
 *    from waitForAuthentication, so a site connecting with getPublicKey({ identityKey: true }) got one sheet per
 *    basket, label and protocol instead. Now its first identity-key request in a session shows the manifest as ONE
 *    sheet (docs/ONE-SHEET-PERMISSIONS.md); the manager asks only for what the site does not already hold.
 *
 * Pure apart from the injected store, so it can be unit tested.
 */

export const SESSION_DENIALS_KEY = 'bwx.basketReadDenials';
const MAX_KEYS = 500;

export type SessionStore = {
  load(): Promise<string[]>;
  save(keys: string[]): Promise<void>;
};

/** The host a site is tracked under: lower case, no scheme, path or default port. */
const site = (originator: string): string =>
  originator
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/:443$/, '')
    .toLowerCase();

const keyFor = (originator: string, basket: string) => `${site(originator)}\n${basket.trim().toLowerCase()}`;

/** Read-only basket access: a listOutputs, nothing inserted or removed. */
export const isBasketRead = (r: { type?: string; basket?: unknown; usageType?: unknown }): boolean =>
  r.type === 'basket' && typeof r.basket === 'string' && r.basket.trim() !== '' && r.usageType === 'listing';

export class SessionBasketDenials {
  private keys = new Set<string>();
  private loaded: Promise<void> | undefined;

  constructor(private readonly store?: SessionStore) {}

  private ready(): Promise<void> {
    this.loaded ??= (this.store?.load() ?? Promise.resolve([]))
      .then((ks) => {
        for (const k of ks) if (typeof k === 'string') this.keys.add(k);
      })
      .catch(() => undefined);
    return this.loaded;
  }

  async has(originator: string | undefined, basket: unknown): Promise<boolean> {
    if (!originator || typeof basket !== 'string') return false;
    await this.ready();
    return this.keys.has(keyFor(originator, basket));
  }

  async add(originator: string | undefined, basket: unknown): Promise<void> {
    if (!originator || typeof basket !== 'string' || !basket.trim()) return;
    await this.ready();
    this.keys.add(keyFor(originator, basket));
    const all = [...this.keys].slice(-MAX_KEYS);
    this.keys = new Set(all);
    await this.store?.save(all).catch(() => undefined);
  }

  /** "Forget site" or a grant in Settings: the site may ask again. */
  async forget(originator: string): Promise<void> {
    await this.ready();
    const prefix = `${site(originator)}\n`;
    for (const k of [...this.keys]) if (k.startsWith(prefix)) this.keys.delete(k);
    await this.store?.save([...this.keys]).catch(() => undefined);
  }
}

/** Whether a getPublicKey call should first show the site's manifest sheet. */
export const wantsManifestSheet = (
  params: { identityKey?: unknown } | undefined,
  originator: string | undefined,
  adminOriginator: string,
): originator is string => params?.identityKey === true && !!originator && originator !== adminOriginator;

/**
 * Shows a site's manifest sheet once per session. Calls that arrive while it is open wait for the same sheet; a
 * refusal is remembered for the session (the site's own requests still ask one by one, as they always did).
 */
export class ManifestOnce {
  private runs = new Map<string, Promise<void>>();

  run(originator: string, ask: () => Promise<unknown>): Promise<void> {
    const k = site(originator);
    let p = this.runs.get(k);
    if (!p) {
      p = ask().then(
        () => undefined,
        () => undefined,
      );
      this.runs.set(k, p);
    }
    return p;
  }

  /** The site's grants were removed (Forget site, Disconnect in Settings): its next connect may show it again. */
  forget(originator: string): void {
    this.runs.delete(site(originator));
  }
}

/**
 * How long a "Not now" to a one-signature request stands for that site (review of 1020b69c; 3 minutes, not 10, after
 * the review of fc614295: a real retry after a mistaken Not now must not be stuck for long, and a minutes-long pause
 * already ends a sheet loop: the site's next request a few minutes later is a single sheet, not a storm).
 */
export const ONCE_DENIAL_MS = 3 * 60_000;
/** chrome.storage.session key: survives the MV3 service worker restarting (about 30 s idle), not the browser session. */
export const ONCE_DENIALS_KEY = 'bwx.onceDenials';
/** Most one-signature sheets shown in any rolling minute, all sites together. More are refused without a sheet. */
export const ONCE_SHEETS_PER_MINUTE = 6;

/**
 * Hosting suffixes where every subdomain is a different owner's site (a free one each). A "Not now" there stays with
 * that one host, never the whole platform. Not the full public suffix list (none is bundled), so a suffix missing here
 * is grouped too broadly: siblings on it are refused for a few minutes, never allowed.
 */
const SHARED_HOSTING = [
  'vercel.app',
  'netlify.app',
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'web.app',
  'firebaseapp.com',
  'appspot.com',
  'herokuapp.com',
  'onrender.com',
  'fly.dev',
  'railway.app',
  'replit.app',
  'repl.co',
  'glitch.me',
  'surge.sh',
  'deno.dev',
  'netlify.com',
  'azurewebsites.net',
  'cloudfront.net',
  'blogspot.com',
  'ngrok.io',
  'ngrok-free.app',
  'trycloudflare.com',
  'myshopify.com',
  'webflow.io',
  'neocities.org',
  // Whole host kept (below): buckets and services sit at different depths (bucket.s3.amazonaws.com,
  // bucket.s3.us-east-1.amazonaws.com, x.execute-api.eu-west-1.amazonaws.com).
  'amazonaws.com',
  'paired.invalid',
];

/** Shared-hosting suffixes whose hosts are each kept whole (phone pairings, AWS). */
const WHOLE_HOST = new Set(['paired.invalid', 'amazonaws.com']);

/**
 * Second-level public suffixes, where a registrable domain has three labels ("example.co.uk"). A short, hand-kept
 * subset of the public suffix list (none is bundled): the common commercial, organisation and network suffixes of
 * the larger country domains. A suffix missing here groups too broadly (example.xx.yy under xx.yy): siblings are
 * refused for a few minutes, never allowed (review of 276ee663: a rule "any 2-letter suffix after a short label"
 * let x.ev.io and y.ev.io rotate past a Not now).
 */
const SECOND_LEVEL = new Set([
  ...['co', 'org', 'me', 'ltd', 'plc', 'net', 'ac', 'gov', 'nhs', 'sch'].map((x) => `${x}.uk`),
  ...['com', 'net', 'org', 'edu', 'gov', 'asn', 'id'].map((x) => `${x}.au`),
  ...['co', 'net', 'org', 'ac', 'govt', 'school', 'geek', 'kiwi'].map((x) => `${x}.nz`),
  ...['co', 'ne', 'or', 'ac', 'go', 'ad', 'ed', 'gr', 'lg'].map((x) => `${x}.jp`),
  ...['co', 'or', 'ne', 'ac', 'go', 're'].map((x) => `${x}.kr`),
  ...['com', 'net', 'org', 'gov', 'edu'].flatMap((x) =>
    ['br', 'cn', 'hk', 'sg', 'tw', 'mx', 'ar', 'tr', 'my', 'ph', 'vn', 'pk', 'ng', 'eg', 'ua', 'sa', 'co', 'pe'].map(
      (cc) => `${x}.${cc}`,
    ),
  ),
  ...['co', 'net', 'org', 'firm', 'gen', 'ind', 'ac', 'gov', 'edu'].map((x) => `${x}.in`),
  ...['co', 'org', 'net', 'ac', 'gov', 'web'].map((x) => `${x}.za`),
  ...['co', 'org', 'net', 'ac', 'gov'].map((x) => `${x}.il`),
  ...['co', 'or', 'ac', 'go', 'in', 'mi', 'net'].map((x) => `${x}.th`),
  ...['co', 'or', 'ac', 'go', 'web', 'my'].map((x) => `${x}.id`),
  ...['co', 'or'].map((x) => `${x}.at`),
  ...['com', 'org', 'nom'].map((x) => `${x}.es`),
  ...['com', 'net', 'org'].map((x) => `${x}.pl`),
  'gov.ie',
  'co.ke',
  'or.ke',
]);

/**
 * The key a one-signature "Not now" is kept under: the site's registrable domain, so a site can't escape it by moving
 * to another subdomain of its own (a.evil.example, b.evil.example). Without a public suffix list: two labels, or three
 * under a known second-level suffix (SECOND_LEVEL: "example.co.uk"); a host on a shared-hosting suffix keeps its own
 * label under it (one.vercel.app), a phone pairing or an AWS host its full name; an IP address or a single label is
 * kept whole.
 */
export const onceSiteKey = (originator: string): string => {
  const host = site(originator).replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || /^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) return host;
  if (SHARED_HOSTING.some((s) => host === s || host.endsWith(`.${s}`))) {
    const base = SHARED_HOSTING.find((s) => host === s || host.endsWith(`.${s}`))!;
    if (WHOLE_HOST.has(base)) return host;
    const own = host
      .slice(0, host.length - base.length - 1)
      .split('.')
      .pop();
    return own ? `${own}.${base}` : host;
  }
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const n = SECOND_LEVEL.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
};

export type OnceStore = {
  load(): Promise<[string, number][]>;
  save(entries: [string, number][]): Promise<void>;
};

/**
 * "Not now" to a one-signature request (services/sharedKeySigning.ts), remembered per registrable domain for
 * ONCE_DENIAL_MS, in chrome.storage.session so a service worker restart doesn't wipe it. A site could otherwise loop
 * SIGN ONCE sheets, one straight after each "Not now", until the user gave in. While a site's No stands, its next
 * one-signature requests are refused (the standard "Permission denied.") without a sheet. Cleared when the user opens
 * Permissions in the wallet or forgets the site. Never turned into a Yes. Also caps one-signature sheets at
 * ONCE_SHEETS_PER_MINUTE across all sites (memory only), so many different sites can't storm either.
 */
export class OnceDenials {
  private until = new Map<string, number>();
  private shown: number[] = [];
  private loaded: Promise<void> | undefined;

  constructor(
    private readonly store?: OnceStore,
    private readonly now: () => number = Date.now,
  ) {}

  private ready(): Promise<void> {
    this.loaded ??= (this.store?.load() ?? Promise.resolve([]))
      .then((entries) => {
        for (const e of Array.isArray(entries) ? entries : [])
          if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number')
            this.until.set(e[0], Math.max(this.until.get(e[0]) ?? 0, e[1]));
      })
      .catch(() => undefined);
    return this.loaded;
  }

  private async save(): Promise<void> {
    const t = this.now();
    for (const [k, v] of this.until) if (v <= t) this.until.delete(k);
    await this.store?.save([...this.until]).catch(() => undefined);
  }

  async note(originator: string | undefined): Promise<void> {
    if (!originator) return;
    await this.ready();
    this.until.set(onceSiteKey(originator), this.now() + ONCE_DENIAL_MS);
    await this.save();
  }

  async active(originator: string | undefined): Promise<boolean> {
    if (!originator) return false;
    await this.ready();
    const t = this.until.get(onceSiteKey(originator));
    return t !== undefined && this.now() < t;
  }

  /** A one-signature sheet is about to be shown: false when ONCE_SHEETS_PER_MINUTE showed in the last minute. */
  allowSheet(): boolean {
    const t = this.now();
    this.shown = this.shown.filter((x) => t - x < 60_000);
    if (this.shown.length >= ONCE_SHEETS_PER_MINUTE) return false;
    this.shown.push(t);
    return true;
  }

  async forget(originator: string): Promise<void> {
    await this.ready();
    this.until.delete(onceSiteKey(originator));
    await this.save();
  }

  async clear(): Promise<void> {
    await this.ready();
    this.until.clear();
    await this.save();
  }
}
