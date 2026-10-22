/**
 * Mint › "A domain": prove you own a domain through dns-dex.com's DNS check, then mint a real BSV-21 coin for it
 * in this wallet and list it on dns-dex.com. Pure helpers + the dns-dex client; the sheet is DomainMint.tsx.
 *
 * Contract with dns-dex (v1):
 *   proof     TXT at `_dnsdex.<domain>` = `dnsdex-verify=<code>` (code issued by dns-dex /start)
 *   signing   createSignature(protocol [2,'dnsdex domain'], keyID '1', counterparty 'anyone') over the UTF-8 of
 *             canonicalMessage(); dns-dex verifies against the identity key. Hex DER in the request body.
 *   endpoints POST /api/bwallet/domain/start, POST /api/bwallet/domain/register, GET /api/bwallet/domain/status
 */
import { LockingScript, OP, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { MAP_PREFIX } from '../names/personalToken';
import { MINT_APP } from '../mint/mint';
import { isTicker } from '../tickets/tickets';

export const DNSDEX_ORIGIN = 'https://www.dns-dex.com';
export const DOMAIN_SIGN_PROTOCOL: [2, string] = [2, 'dnsdex domain'];
export const DOMAIN_SIGN_KEY_ID = '1';

// ── domain ──

export type NormalisedDomain = { ok: true; domain: string } | { ok: false; error: string };

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Lowercase host only: no scheme, path, port or trailing dot; IDN as punycode. Rejects IPs, localhost, bare names. */
export function normaliseDomain(input: string): NormalisedDomain {
  let s = (input || '').trim().toLowerCase();
  if (!s) return { ok: false, error: 'Type your domain, like example.com.' };
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^[^@/]*@/, '');
  s = s.split(/[/?#]/)[0];
  if (s.startsWith('[') || (s.match(/:/g) ?? []).length > 1)
    return { ok: false, error: 'Use a domain name, not an IP address.' };
  s = s.replace(/:\d*$/, '').replace(/\.+$/, '');
  let host: string;
  try {
    host = new URL(`http://${s}`).hostname.replace(/\.+$/, '');
  } catch {
    return { ok: false, error: "That doesn't look like a domain. Try something like example.com." };
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { ok: false, error: 'Use a domain name, not an IP address.' };
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, error: 'Use a public domain name.' };
  const labels = host.split('.');
  if (labels.length < 2) return { ok: false, error: 'Include the ending, like example.com.' };
  if (host.length > 253 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1]))
    return { ok: false, error: "That doesn't look like a domain. Try something like example.com." };
  return { ok: true, domain: host };
}

/** A ticker that passes the token form's rule (capitals, digits, - _ ; max 32): example.com → EXAMPLE-COM. */
export const suggestDomainTicker = (domain: string) => {
  const t = domain
    .toUpperCase()
    .replace(/\./g, '-')
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return isTicker(t) ? t : '';
};

export const domainCoinDescription = (domain: string) => `Coin for ${domain}, verified on dns-dex.com`;

/** MAP tag on the deploy tx: `app=bWallet type=domain domain=<d>`, so the coin itself names its domain. */
export function domainMapScript(domain: string): LockingScript {
  const s = new LockingScript();
  s.writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  for (const part of [MAP_PREFIX, 'SET', 'app', MINT_APP, 'type', 'domain', 'domain', domain])
    s.writeBin(Utils.toArray(part, 'utf8'));
  return s;
}

// ── signed messages ──

export type DomainAction = 'start' | 'register';

export interface SignedFields {
  action: DomainAction;
  domain: string;
  identityKey: string;
  tokenId?: string;
  ts: number;
}

/** Exactly the contract's key order; `tokenId` only for register. */
export function canonicalMessage(f: SignedFields): string {
  const o: Record<string, string | number> = { action: f.action, domain: f.domain, identityKey: f.identityKey };
  if (f.action === 'register') o.tokenId = f.tokenId ?? '';
  o.ts = f.ts;
  return JSON.stringify(o);
}

export interface DomainSigner {
  identityKey: () => Promise<string>;
  /** Hex DER signature over the UTF-8 of `message`. */
  sign: (message: string) => Promise<string>;
}

export const walletDomainSigner = (ctx: OneSatContext): DomainSigner => ({
  identityKey: async () => (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase(),
  sign: async (message) => {
    const { signature } = await ctx.wallet.createSignature({
      data: Utils.toArray(message, 'utf8'),
      protocolID: DOMAIN_SIGN_PROTOCOL,
      keyID: DOMAIN_SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return Utils.toHex(signature);
  },
});

export async function signedBody(signer: DomainSigner, f: Omit<SignedFields, 'identityKey' | 'ts'>, now = Date.now()) {
  const fields: SignedFields = { ...f, identityKey: await signer.identityKey(), ts: now };
  const message = canonicalMessage(fields);
  return { ...(JSON.parse(message) as Record<string, unknown>), signature: await signer.sign(message) };
}

// ── dns-dex client ──

type Fetch = typeof fetch;

export interface StartResult {
  domain: string;
  code: string;
  txtHost: string;
  txtValue: string;
  resumed: boolean;
}

export interface RegisterResult {
  domain: string;
  tokenId: string;
  url: string;
}

const UNREACHABLE = "Couldn't reach dns-dex.com. Check your connection and try again.";

async function post<T>(path: string, body: unknown, f: Fetch): Promise<T> {
  let res: Response;
  try {
    res = await f(`${DNSDEX_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  const json = (await res.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!res.ok || !json || json.ok === false)
    throw new Error(json?.error || `dns-dex.com said no (${res.status}). Try again in a moment.`);
  return json;
}

export async function startDomain(signer: DomainSigner, domain: string, f: Fetch = fetch, now = Date.now()) {
  const body = await signedBody(signer, { action: 'start', domain }, now);
  return post<StartResult>('/api/bwallet/domain/start', body, f);
}

export async function registerDomain(
  signer: DomainSigner,
  domain: string,
  tokenId: string,
  f: Fetch = fetch,
  now = Date.now(),
) {
  const body = await signedBody(signer, { action: 'register', domain, tokenId }, now);
  return post<RegisterResult>('/api/bwallet/domain/register', body, f);
}

// ── DNS (the wallet checks for itself before minting) ──

const DOH = [
  (name: string) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
  (name: string) => `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=TXT`,
];

/** One TXT answer's text: quoted chunks are one record split at 255 bytes, so they join without a space. */
export function txtText(data: string): string {
  const chunks = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!chunks) return data.trim();
  return chunks.map((c) => c.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
}

/** Does any record carry exactly `expected` as one of its space-separated values? */
export const txtMatches = (records: string[], expected: string) =>
  records.some((r) => txtText(r).split(/\s+/).includes(expected));

/** TXT records at `name` over DNS-over-HTTPS (Cloudflare, then Google). Throws only when both fail. */
export async function lookupTxt(name: string, f: Fetch = fetch): Promise<string[]> {
  let lastError: unknown = null;
  for (const url of DOH) {
    try {
      const res = await f(url(name), { headers: { accept: 'application/dns-json' } });
      if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`);
      const json = (await res.json()) as { Answer?: { type: number; data: string }[] };
      return (json.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === 'string').map((a) => a.data);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Couldn't look up DNS right now. Try again.");
}

// ── coins minted but not yet listed (retry survives a reload) ──

export interface PendingListing {
  domain: string;
  tokenId: string;
}

const PENDING_KEY = 'bwallet.dnsdex.pending';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const local = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function loadPending(store: Store | null = local()): PendingListing[] {
  try {
    const v = JSON.parse(store?.getItem(PENDING_KEY) || '[]') as unknown;
    return Array.isArray(v)
      ? v.filter((p): p is PendingListing => typeof p?.domain === 'string' && typeof p?.tokenId === 'string')
      : [];
  } catch {
    return [];
  }
}

function save(list: PendingListing[], store: Store | null) {
  try {
    store?.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the retry button still works for this session.
  }
}

export function savePending(p: PendingListing, store: Store | null = local()) {
  save([...loadPending(store).filter((x) => x.domain !== p.domain), p], store);
}

export function removePending(domain: string, store: Store | null = local()) {
  save(
    loadPending(store).filter((x) => x.domain !== domain),
    store,
  );
}
