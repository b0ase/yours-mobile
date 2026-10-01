import validate from 'bitcoin-address-validation';
import { Utils } from '@bsv/sdk';
import { BWALLET_PAYMAIL_DOMAIN } from './config';

/**
 * "Send to a name": classify what the user typed in a recipient box and resolve it to
 * something upstream's send code already understands (a P2PKH address or a paymail).
 *
 *   1ABC…            → address (passed straight through)
 *   $boase           → HandCash handle → boase@handcash.io paymail
 *   name@domain.tld  → paymail (bsvalias capability discovery)
 *   satchmo          → OpNS name (1Sat on-chain name) → current owner address
 *
 * Every network call goes through an injectable fetch so tests can mock it.
 * Nothing here signs or broadcasts.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type Parsed =
  | { kind: 'empty' }
  | { kind: 'address'; address: string }
  | { kind: 'handle'; handle: string; paymail: string }
  | { kind: 'paymail'; paymail: string }
  | { kind: 'opns'; name: string }
  | { kind: 'invalid'; reason: string };

const PAYMAIL_RE = /^([a-z0-9._+-]{1,64})@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i;
const HANDLE_RE = /^\$([a-z0-9_.-]{1,50})$/i;
// OpNS names: the covenant only accepts a-z, 0-9 and - (opns.md "Character set").
const OPNS_RE = /^[a-z0-9-]{1,64}$/i;

export const HANDCASH_DOMAIN = 'handcash.io';

export const parseRecipient = (raw: string): Parsed => {
  const s = raw.trim();
  if (!s) return { kind: 'empty' };
  if (validate(s)) return { kind: 'address', address: s };
  const h = s.match(HANDLE_RE);
  if (h) {
    const handle = h[1].toLowerCase();
    return { kind: 'handle', handle, paymail: `${handle}@${HANDCASH_DOMAIN}` };
  }
  if (s.startsWith('$')) return { kind: 'invalid', reason: 'Handles look like $name' };
  if (s.includes('@')) {
    return PAYMAIL_RE.test(s)
      ? { kind: 'paymail', paymail: s.toLowerCase() }
      : { kind: 'invalid', reason: 'Not a valid paymail' };
  }
  // Long base58-ish strings that failed address validation are mistyped addresses, not names.
  if (s.length >= 26 && /^[13mn][1-9A-HJ-NP-Za-km-z]+$/.test(s)) {
    return { kind: 'invalid', reason: 'Not a valid address' };
  }
  if (OPNS_RE.test(s)) return { kind: 'opns', name: s.toLowerCase() };
  return { kind: 'invalid', reason: 'Enter an address, $handle, paymail or name' };
};

export type Via = 'address' | 'p2p-paymail' | 'paymail-address' | 'opns-owner';

export const VIA_LABEL: Record<Via, string> = {
  address: 'Bitcoin address',
  'p2p-paymail': 'Paymail P2P (fresh derived address each payment)',
  'paymail-address': 'Paymail address',
  'opns-owner': 'OpNS name owner address',
};

export type Resolved = {
  input: string;
  /** What to hand upstream's send: a paymail (BSV P2P path) or an address. */
  target: string;
  targetKind: 'paymail' | 'address';
  via: Via;
  displayName?: string;
  avatar?: string;
  /** Paymail identity pubkey (pki) or OpNS-bound identity key, when known. */
  pubkey?: string;
  /** Where tokens (BSV-21 / ordinals) would go, if this name can receive them. */
  ordAddress?: string;
};

export class ResolveError extends Error {}

export const SERVICES = {
  doh: 'https://dns.google.com/resolve',
  opnsApi: 'https://ordinals.gorillapool.io/api/opns',
  opnsOrigin: 'https://api.1sat.app/1sat/opns/origin',
  opnsMine: 'https://api.1sat.app/1sat/opns/mine',
  inscriptionLatest: 'https://ordinals.gorillapool.io/api/inscriptions',
};

const getJson = async (f: Fetch, url: string, init?: RequestInit): Promise<any> => {
  const res = await f(url, init);
  if (!res.ok) throw new ResolveError(`HTTP ${res.status}`);
  return res.json();
};

const tryJson = async (f: Fetch, url: string, init?: RequestInit): Promise<any | undefined> => {
  try {
    return await getJson(f, url, init);
  } catch {
    return undefined;
  }
};

export const fill = (tpl: string, alias: string, domain: string) =>
  tpl.replace('{alias}', encodeURIComponent(alias)).replace('{domain.tld}', domain);

/** bsvalias host via SRV (handcash.io → cloud.handcash.io), else the domain itself. */
export const discoverHost = async (f: Fetch, domain: string): Promise<string> => {
  const dns = await tryJson(f, `${SERVICES.doh}?name=_bsvalias._tcp.${domain}&type=SRV`);
  const ans = dns?.Answer?.find((a: { type: number }) => a.type === 33);
  if (ans?.data) {
    const parts = String(ans.data).trim().split(/\s+/);
    const host = parts[3]?.replace(/\.$/, '');
    const port = parts[2];
    if (host) return port && port !== '443' ? `${host}:${port}` : host;
  }
  return domain;
};

export type Capabilities = Record<string, string | boolean>;

export const getCapabilities = async (f: Fetch, domain: string): Promise<Capabilities> => {
  const host = await discoverHost(f, domain);
  let doc = await tryJson(f, `https://${host}/.well-known/bsvalias`);
  if (!doc?.capabilities && host !== domain) doc = await tryJson(f, `https://${domain}/.well-known/bsvalias`);
  if (!doc?.capabilities) throw new ResolveError(`${domain} doesn't host paymail`);
  return doc.capabilities as Capabilities;
};

// bsvalias BRFC ids.
export const CAP = {
  pki: 'pki',
  paymentDestination: 'paymentDestination',
  publicProfile: 'f12f968c92d6',
  p2pDestination: '2a40af698840',
  receiveBeef: '5c55a7fdb7bb',
} as const;

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** 1Sat paymail ordinal-receive capability (`ordAddress`); any url-valued key naming "ord". */
export const ordCapability = (caps: Capabilities): string | undefined =>
  str(caps.ordAddress) ??
  Object.entries(caps)
    .find(([k, v]) => /ord/i.test(k) && str(v))?.[1]
    ?.toString();

export const scriptToAddress = (hex: string): string | undefined => {
  const m = hex.match(/^76a914([0-9a-f]{40})88ac$/i);
  return m ? Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]) : undefined;
};

export const resolvePaymail = async (f: Fetch, paymail: string, input = paymail): Promise<Resolved> => {
  const [alias, domain] = paymail.split('@');
  const caps = await getCapabilities(f, domain);
  const r: Partial<Resolved> = { input };

  const prof = str(caps[CAP.publicProfile]);
  if (prof) {
    const p = await tryJson(f, fill(prof, alias, domain));
    r.displayName = str(p?.name);
    r.avatar = str(p?.avatar);
  }
  const pki = str(caps[CAP.pki]);
  if (pki) r.pubkey = str((await tryJson(f, fill(pki, alias, domain)))?.pubkey);

  const ord = ordCapability(caps);
  if (ord) r.ordAddress = str((await tryJson(f, fill(ord, alias, domain)))?.address);

  // Prefer P2P (BRC-29-style per-payment outputs) — upstream sendBsv handles it natively.
  const p2p = str(caps[CAP.p2pDestination]);
  if (p2p && (str(caps[CAP.receiveBeef]) || str(caps['5f1323cddf31']))) {
    return { ...r, target: paymail, targetKind: 'paymail', via: 'p2p-paymail' } as Resolved;
  }
  // Fallback: basic address resolution (some servers require a signed request; try unsigned).
  const pd = str(caps[CAP.paymentDestination]);
  if (pd) {
    const out = await tryJson(f, fill(pd, alias, domain), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ senderHandle: 'bwallet@bwallet', dt: new Date().toISOString(), purpose: 'payment' }),
    });
    const address = out?.output ? scriptToAddress(out.output) : undefined;
    if (address) return { ...r, target: address, targetKind: 'address', via: 'paymail-address' } as Resolved;
  }
  if (r.pubkey === undefined && !prof) throw new ResolveError(`${paymail} not found`);
  throw new ResolveError(`${paymail} can't receive payments`);
};

export const resolveOpns = async (f: Fetch, name: string): Promise<Resolved> => {
  // Primary: GorillaPool OpNS index (owner + MAP, incl. opns.idKey).
  const rec = await tryJson(f, `${SERVICES.opnsApi}/${encodeURIComponent(name)}`);
  let owner = str(rec?.owner);
  let pubkey = str(rec?.map?.['opns.idKey']);
  if (!owner) {
    // Fallback: 1sat-stack origin → latest inscription location.
    const o = await tryJson(f, `${SERVICES.opnsOrigin}/${encodeURIComponent(name)}`);
    const origin = str(o?.outpoint);
    if (!origin) throw new ResolveError(`No one has the name "${name}"`);
    const latest = await tryJson(f, `${SERVICES.inscriptionLatest}/${origin.replace('.', '_')}/latest?script=false`);
    owner = str(latest?.owner);
    pubkey ??= str(latest?.data?.map?.['opns.idKey']);
    if (!owner) throw new ResolveError(`Couldn't locate the owner of "${name}"`);
  }
  return {
    input: name,
    target: owner,
    targetKind: 'address',
    via: 'opns-owner',
    displayName: name,
    pubkey,
    ordAddress: owner,
  };
};

export const resolveRecipient = async (f: Fetch, p: Parsed): Promise<Resolved> => {
  switch (p.kind) {
    case 'address':
      return { input: p.address, target: p.address, targetKind: 'address', via: 'address', ordAddress: p.address };
    case 'handle':
      return resolvePaymail(f, p.paymail, `$${p.handle}`);
    case 'paymail':
      return resolvePaymail(f, p.paymail);
    case 'opns':
      return resolveOpns(f, p.name);
    default:
      throw new ResolveError(p.kind === 'invalid' ? p.reason : 'Enter a recipient');
  }
};

export const TOKENS_UNSUPPORTED = "This name can't receive tokens";

/** Pick the destination for a send. Tokens only go to a name with an ordinal-receive address. */
export const destinationFor = (
  r: Resolved,
  asset: 'bsv' | 'token',
): { ok: true; to: string } | { ok: false; error: string } => {
  if (asset === 'bsv') return { ok: true, to: r.target };
  return r.ordAddress ? { ok: true, to: r.ordAddress } : { ok: false, error: TOKENS_UNSUPPORTED };
};

export type Availability =
  | { status: 'taken'; name: string; owner?: string; origin: string; listing?: { outpoint: string; price: number } }
  | { status: 'available'; name: string; mineFrom?: string }
  | { status: 'invalid'; name: string; reason: string };

/** Read-only OpNS availability: origin exists → taken; else the mine tree's nearest parent. */
export const checkOpnsAvailability = async (f: Fetch, raw: string): Promise<Availability> => {
  const name = raw.trim().toLowerCase().replace(/^@/, '');
  if (!OPNS_RE.test(name)) return { status: 'invalid', name, reason: 'Letters, numbers and - only' };
  const o = await tryJson(f, `${SERVICES.opnsOrigin}/${encodeURIComponent(name)}`);
  if (str(o?.outpoint)) {
    const rec = await tryJson(f, `${SERVICES.opnsApi}/${encodeURIComponent(name)}`);
    // For sale? The latest location carries an OrdLock listing (price in sats) while unspent.
    const latest = await tryJson(
      f,
      `${SERVICES.inscriptionLatest}/${String(o.outpoint).replace('.', '_')}/latest?script=false`,
    );
    const price = Number(latest?.data?.list?.price);
    const listing =
      price > 0 && !latest?.spend && str(latest?.outpoint)
        ? { outpoint: String(latest.outpoint).replace('_', '.'), price }
        : undefined;
    return {
      status: 'taken',
      name,
      origin: o.outpoint,
      owner: str(rec?.owner ?? latest?.owner),
      ...(listing && { listing }),
    };
  }
  const mine = await tryJson(f, `${SERVICES.opnsMine}/${encodeURIComponent(name)}`);
  return { status: 'available', name, mineFrom: str(mine?.outpoint) };
};

/** bWallet-hosted paymail (name@BWALLET_PAYMAIL_DOMAIN) — disabled until the server exists (docs/NAMES.md). */
export const bwalletPaymail = (name: string) =>
  BWALLET_PAYMAIL_DOMAIN ? `${name}@${BWALLET_PAYMAIL_DOMAIN}` : undefined;
