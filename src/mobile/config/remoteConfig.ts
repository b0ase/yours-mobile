import { PublicKey, Signature, Utils } from '@bsv/sdk';
import { BILLING_ENABLED } from '../storeBuild';

/**
 * Remote config (docs/POTS-SUBSCRIPTIONS-PLAN.md §3): `GET https://push.bwalletx.com/config.json`, cached 24h.
 * It FAILS CLOSED: no config, a bad shape, a missing or bad signature, or a store build → billing OFF.
 * Billing is only ever read here; nothing in v1 charges.
 *
 * Signed body: `{ "body": "<JSON text>", "sig": "<DER hex>" }`, the signature by the bCorp config key over
 * the UTF-8 body. CONFIG_PUBKEY is empty today, so billing can't be switched on by the server at all.
 */
export const CONFIG_URL = 'https://push.bwalletx.com/config.json';
export const CONFIG_PUBKEY = '';
export const CONFIG_TTL = 24 * 3600_000;
const CACHE = 'bwallet.remoteConfig';

export type BillingConfig = {
  enabled: boolean;
  usdPerDay: number;
  graceDays: number;
  freeBefore: string | null;
  grandfatherCreatedBefore: string | null;
};
export type RemoteConfig = {
  billing: BillingConfig;
  features: { subscriptions: boolean; presigned: boolean; pnee: boolean };
};

export const DEFAULT_CONFIG: RemoteConfig = {
  billing: { enabled: false, usdPerDay: 0.01, graceDays: 30, freeBefore: null, grandfatherCreatedBefore: null },
  features: { subscriptions: true, presigned: false, pnee: false },
};

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** True when `sig` (DER hex) signs `body` with `pubkey` (hex). Any error → false. */
export const verifyConfig = (body: string, sig: unknown, pubkey: string): boolean => {
  if (!pubkey || typeof sig !== 'string' || !sig) return false;
  try {
    return PublicKey.fromString(pubkey).verify(Utils.toArray(body, 'utf8'), Signature.fromDER(sig, 'hex'));
  } catch {
    return false;
  }
};

/**
 * Parse a fetched config envelope. Features come from the body when it parses; billing can only be on when
 * the signature checks out against `pubkey`, the build allows billing, and the body says enabled.
 */
export const parseConfig = (raw: unknown, pubkey = CONFIG_PUBKEY, billingBuild = BILLING_ENABLED): RemoteConfig => {
  try {
    const env = raw as { body?: unknown; sig?: unknown } | null;
    if (!env || typeof env.body !== 'string') return DEFAULT_CONFIG;
    const o = JSON.parse(env.body) as { billing?: Record<string, unknown>; features?: Record<string, unknown> } | null;
    if (!o || typeof o !== 'object') return DEFAULT_CONFIG;
    const b = o.billing ?? {};
    const f = o.features ?? {};
    const signed = verifyConfig(env.body, env.sig, pubkey);
    const d = DEFAULT_CONFIG;
    return {
      billing: {
        enabled: billingBuild && signed && b.enabled === true,
        usdPerDay: num(b.usdPerDay, d.billing.usdPerDay),
        graceDays: num(b.graceDays, d.billing.graceDays),
        freeBefore: str(b.freeBefore),
        grandfatherCreatedBefore: str(b.grandfatherCreatedBefore),
      },
      features: {
        subscriptions: bool(f.subscriptions, d.features.subscriptions),
        presigned: bool(f.presigned, d.features.presigned),
        pnee: bool(f.pnee, d.features.pnee),
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
};

type Cached = { at: number; raw: unknown };
const readCache = (): Cached | null => {
  try {
    const v = localStorage.getItem(CACHE);
    return v ? (JSON.parse(v) as Cached) : null;
  } catch {
    return null;
  }
};

/** The config, from a fresh (<24h) cache or the network. Never throws; failures give DEFAULT_CONFIG (billing off). */
export const getRemoteConfig = async (
  f: (url: string) => Promise<Response> = (u) => fetch(u, { cache: 'no-store' }),
  now = Date.now(),
): Promise<RemoteConfig> => {
  const c = readCache();
  if (c && now - c.at < CONFIG_TTL) return parseConfig(c.raw);
  try {
    const r = await f(CONFIG_URL);
    if (!r.ok) throw new Error(String(r.status));
    const raw: unknown = await r.json();
    try {
      localStorage.setItem(CACHE, JSON.stringify({ at: now, raw }));
    } catch {
      /* storage unavailable */
    }
    return parseConfig(raw);
  } catch {
    return DEFAULT_CONFIG;
  }
};
