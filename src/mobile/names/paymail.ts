import type { WalletInterface } from '@bsv/sdk';
import { Beef, Utils } from '@bsv/sdk';
import { BWALLET_PAYMAIL_API, BWALLET_PAYMAIL_DOMAIN } from './config';
import type { Fetch } from './names';

/**
 * Client for the bWallet paymail server (site/api/paymail.js).
 *
 * Auth: every write is signed by the account's identity key with BRC-43
 * protocol [2,'bwallet paymail'], keyID '1', counterparty 'anyone' over
 * signedMessage(action, fields) — the same canonical string the server rebuilds.
 * Nothing secret leaves the phone; the server learns only public keys.
 *
 * Receiving: the server parks P2P payments (BEEF + BRC-29 derivation) in an inbox.
 * collectPaymailInbox() fetches it, internalizes each payment into the wallet's default
 * basket as a "wallet payment" (sender = anyone key), then acks so the server marks it collected.
 */

export const SIGN_PROTOCOL: [2, string] = [2, 'bwallet paymail'];
export const SIGN_KEY_ID = '1';

export const paymailEnabled = () => !!BWALLET_PAYMAIL_DOMAIN && !!BWALLET_PAYMAIL_API;
export const paymailFor = (alias: string) => (paymailEnabled() ? `${alias}@${BWALLET_PAYMAIL_DOMAIN}` : undefined);

/** Same alias rule as the server. */
export const PAYMAIL_ALIAS_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
/** Verified social names (b0asex.x, theirname.gmail): only claimable after Continue with X / Google. */
export const SOCIAL_ALIAS_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?\.(x|gmail)$/;
export const toAlias = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);

export const signedMessage = (action: string, fields: Record<string, string>) => {
  const keys = Object.keys(fields).sort();
  return ['bwallet-paymail', 'v1', action, ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
};

/**
 * Actions our paymail server (site/lib/paymail.js verifySigned) checks with the request's own fields, whose signature
 * is not kept as a standing proof: these carry a random nonce, and the server refuses one it has seen (b-Aware
 * 26 Oct 2026, N3-6). 'ord', 'bind' and 'release' signatures are stored and re-checked later over fixed fields, and
 * other services build their own field lists, so those don't get one (the server still refuses an exact replay).
 */
export const NONCE_ACTIONS: ReadonlySet<string> = new Set([
  'register',
  'names-add',
  'names-primary',
  'names-remove',
  'delete',
  'unlink',
  'set-name',
  'inbox',
  'history',
  'ack',
  'apps-get',
  'apps-put',
  'release-cancel',
  'offer-register',
  'offer-receipts',
]);

const newNonce = () => Utils.toHex([...crypto.getRandomValues(new Uint8Array(16))]);

export const signRequest = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  action: string,
  fields: Record<string, string>,
  now = Date.now(),
) => {
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
  const timestamp = now;
  if (NONCE_ACTIONS.has(action) && fields.nonce === undefined) fields = { ...fields, nonce: newNonce() };
  const all = { ...fields, identityKey, timestamp: String(timestamp) };
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(signedMessage(action, all), 'utf8'),
    protocolID: SIGN_PROTOCOL,
    keyID: SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return { identityKey, timestamp, fields, signature: Utils.toHex(signature) };
};

/** "This identity key receives ordinals at ordAddress", signed by the key (action 'ord'; names.ts checkOrdProof). */
export const signOrdProof = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  ordAddress: string,
  now = Date.now(),
) => {
  const { timestamp, signature } = await signRequest(wallet, 'ord', { ordAddress }, now);
  return { timestamp: String(timestamp), signature };
};

const api = (path: string) => `${BWALLET_PAYMAIL_API}/api/paymail/${path}`;

const postJson = async (f: Fetch, url: string, body: unknown) => {
  const r = await f(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
};

export const claimPaymail = async (
  f: Fetch,
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  alias: string,
  extra: {
    ordAddress?: string;
    name?: string;
    avatar?: string;
    social?: { ticket: string; secret: string };
    /** The 1¢ name-fee payment (paymailConfig().nameFee): txid is signed; the tx hex helps a fresh tx through. */
    feeTxid?: string;
    feeTx?: string;
  } = {},
): Promise<string> => {
  if (!paymailEnabled()) throw new Error('Paymail is not configured');
  if (!PAYMAIL_ALIAS_RE.test(alias) && !SOCIAL_ALIAS_RE.test(alias)) throw new Error('Use a-z, 0-9, - or _ (up to 32)');
  const fields: Record<string, string> = { alias };
  if (extra.ordAddress) fields.ordAddress = extra.ordAddress;
  if (extra.name) fields.name = extra.name.slice(0, 64);
  if (extra.avatar) fields.avatar = extra.avatar.slice(0, 512);
  if (extra.feeTxid) fields.feeTxid = extra.feeTxid;
  const signed = await signRequest(wallet, 'register', fields);
  // A standing signature tying the ordinal address to this key (b_feedback 67): payers check it before a token send.
  const ordProof = extra.ordAddress ? await signOrdProof(wallet, extra.ordAddress) : undefined;
  // A verified social name (b0asex.x) carries the Continue with X / Google proof (src/mobile/social).
  const j = await postJson(f, api('register'), {
    ...signed,
    ...(ordProof ? { ordProof } : {}),
    ...(extra.social ? { social: extra.social } : {}),
    ...(extra.feeTx ? { feeTx: extra.feeTx } : {}),
  });
  return String(j.paymail);
};

/**
 * Account deletion: remove this identity's paymail alias and its inbox from the paymail server
 * (site/lib/paymail.js `delete`). Collect the inbox first, or uncollected payments' derivation
 * data is lost with it.
 */
export const deletePaymail = async (
  f: Fetch,
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
): Promise<{ alias: string | null }> => {
  if (!paymailEnabled()) return { alias: null };
  const j = await postJson(f, api('delete'), await signRequest(wallet, 'delete', { confirm: 'DELETE' }));
  return { alias: typeof j.alias === 'string' ? j.alias : null };
};

/** The paymail already registered for this identity key (public lookup), or undefined. */
export const lookupPaymail = async (f: Fetch, identityKey: string): Promise<string | undefined> => {
  if (!paymailEnabled()) return undefined;
  const r = await f(`${api('lookup')}?key=${identityKey}`);
  if (!r.ok) return undefined;
  const j = await r.json().catch(() => null);
  return typeof j?.paymail === 'string' ? j.paymail : undefined;
};

export type WalletName = { paymail: string; kind: 'plain' | 'x' | 'gmail'; main: boolean };

/** Every paymail that receives for this identity key, main one flagged (public lookup). */
export const listPaymails = async (f: Fetch, identityKey: string): Promise<WalletName[]> => {
  if (!paymailEnabled()) return [];
  const r = await f(`${api('lookup')}?key=${identityKey}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => null);
  if (Array.isArray(j?.names)) return j.names as WalletName[];
  return typeof j?.paymail === 'string' ? [{ paymail: j.paymail, kind: 'plain', main: true }] : [];
};

/** Unlink one of this wallet's names; it becomes free for anyone. */
export const unlinkPaymail = async (
  f: Fetch,
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  paymail: string,
): Promise<void> => {
  await postJson(f, api('unlink'), await signRequest(wallet, 'unlink', { alias: paymail.split('@')[0] }));
};

type NameSigner = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;
const aliasOf = (paymail: string) => paymail.split('@')[0].toLowerCase();

/**
 * Add an extra plain name to this wallet (it receives too; the main name stays main). With `fee` (the $1 extra-name
 * payment, paymailConfig().extraNameFee) the server checks that payment; without it, that bit-sign says this key
 * already paid for the name there (extraNames.ts).
 */
export const addPaymail = async (
  f: Fetch,
  wallet: NameSigner,
  alias: string,
  fee: { feeTxid?: string; feeTx?: string } = {},
): Promise<string> => {
  if (!paymailEnabled()) throw new Error('Paymail is not configured');
  const a = alias.trim().toLowerCase();
  if (!PAYMAIL_ALIAS_RE.test(a)) throw new Error('Use a-z, 0-9, - or _ (up to 32)');
  const fields: Record<string, string> = { alias: a };
  if (fee.feeTxid) fields.feeTxid = fee.feeTxid;
  const signed = await signRequest(wallet, 'names-add', fields);
  const j = await postJson(f, api('names-add'), fee.feeTx ? { ...signed, feeTx: fee.feeTx } : signed);
  return String(j.added);
};

/** Make one of this wallet's plain names the main one (what payments and the card show). */
export const makeMainPaymail = async (f: Fetch, wallet: NameSigner, paymail: string): Promise<string> => {
  const j = await postJson(
    f,
    api('names-primary'),
    await signRequest(wallet, 'names-primary', { alias: aliasOf(paymail) }),
  );
  return String(j.main);
};

/** Remove an extra name: it forwards to the main name for 90 days, then is released. */
export const removePaymail = async (f: Fetch, wallet: NameSigner, paymail: string): Promise<void> => {
  await postJson(f, api('names-remove'), await signRequest(wallet, 'names-remove', { alias: aliasOf(paymail) }));
};

/** Apps › Add app: this wallet's own app list, kept on the paymail server so a restore brings it back. */
export type SavedApp = { url: string; name: string };
type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;
export const loadUserApps = async (f: Fetch, wallet: Signer): Promise<SavedApp[]> => {
  if (!paymailEnabled()) return [];
  const j = await postJson(f, api('apps-get'), await signRequest(wallet, 'apps-get', {}));
  return Array.isArray(j?.apps) ? (j.apps as SavedApp[]) : [];
};
export const saveUserApps = async (f: Fetch, wallet: Signer, apps: SavedApp[]): Promise<void> => {
  if (!paymailEnabled()) return;
  await postJson(f, api('apps-put'), await signRequest(wallet, 'apps-put', { apps: JSON.stringify(apps) }));
};

export type PaymailAvailability = {
  state: 'free' | 'mine' | 'taken' | 'reserved' | 'invalid';
  message?: string;
};
/**
 * What a claim of `alias` by `identityKey` would meet, from the server's `available` op (same rules as
 * register, reserved names included). An older server without the op: fall back to pki (404 = free).
 */
export const paymailAvailability = async (
  f: Fetch,
  alias: string,
  identityKey?: string,
): Promise<PaymailAvailability> => {
  const q = new URLSearchParams({ alias, ...(identityKey ? { key: identityKey } : {}) });
  const r = await f(api(`available?${q.toString()}`));
  if (r.ok) {
    const j = (await r.json()) as { available?: boolean; reason?: string | null; message?: string };
    if (j.reason === 'mine') return { state: 'mine' };
    if (j.available) return { state: 'free' };
    if (j.reason === 'reserved' || j.reason === 'invalid') return { state: j.reason, message: j.message };
    return { state: 'taken' };
  }
  const pki = await f(api(`id/${alias}@${BWALLET_PAYMAIL_DOMAIN}`));
  return { state: pki.status === 404 ? 'free' : 'taken' };
};

/** Could anyone claim `alias@domain` right now? (reserved and taken names are not free) */
export const paymailAvailable = async (f: Fetch, alias: string): Promise<boolean> =>
  (await paymailAvailability(f, alias)).state === 'free';

export type InboxPayment = {
  reference: string;
  txid: string;
  beef: string | null;
  rawTx: string | null;
  sender?: string | null;
  outputs: { vout: number; satoshis: number; derivationPrefix: string; derivationSuffix: string }[];
};

/** AtomicBEEF for internalizeAction: from the stored BEEF, else from the network (raw-tx deliveries). */
export const atomicBeefFor = async (
  p: InboxPayment,
  fetchBeef?: (txid: string) => Promise<number[] | undefined>,
): Promise<number[]> => {
  if (p.beef) return Beef.fromString(p.beef, 'hex').toBinaryAtomic(p.txid);
  const b = fetchBeef && (await fetchBeef(p.txid));
  if (b) return Beef.fromBinary(b).toBinaryAtomic(p.txid);
  throw new Error('Payment has no BEEF yet');
};

export const collectPaymailInbox = async (
  f: Fetch,
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature' | 'internalizeAction'>,
  fetchBeef?: (txid: string) => Promise<number[] | undefined>,
): Promise<{ collected: number; satoshis: number }> => {
  if (!paymailEnabled()) return { collected: 0, satoshis: 0 };
  const inbox = await postJson(f, api('inbox'), await signRequest(wallet, 'inbox', {}));
  const done: string[] = [];
  let satoshis = 0;
  for (const p of (inbox.payments ?? []) as InboxPayment[]) {
    try {
      const tx = await atomicBeefFor(p, fetchBeef);
      await wallet.internalizeAction({
        tx,
        outputs: p.outputs.map((o) => ({
          outputIndex: o.vout,
          protocol: 'wallet payment' as const,
          paymentRemittance: {
            derivationPrefix: o.derivationPrefix,
            derivationSuffix: o.derivationSuffix,
            senderIdentityKey: inbox.senderIdentityKey,
          },
        })),
        description: `Paymail payment${p.sender ? ` from ${p.sender}` : ''}`.slice(0, 50),
        labels: ['paymail'],
      });
      done.push(p.reference);
      satoshis += p.outputs.reduce((s, o) => s + Number(o.satoshis), 0);
    } catch (e) {
      // Already internalized (e.g. a previous ack failed) → ack it; anything else stays queued for next time.
      if (/already|duplicate|exists/i.test(String(e))) done.push(p.reference);
      else console.warn('[paymail] could not internalize', p.txid, e);
    }
  }
  if (done.length) await postJson(f, api('ack'), await signRequest(wallet, 'ack', { references: done.join(',') }));
  return { collected: done.length, satoshis };
};

export type PaymailRestoreDeps = {
  /** Does the wallet already hold this output (any basket)? */
  hasOutput: (txid: string, vout: number) => Promise<boolean>;
  /** On-chain verdict: true unspent, false spent, undefined unknown (unknown is restored: never hide money). */
  isUnspent: (txid: string, vout: number) => Promise<boolean | undefined>;
  fetchBeef?: (txid: string) => Promise<number[] | undefined>;
};

export type PaymailRestoreReport = {
  payments: number;
  restored: number;
  satoshis: number;
  alreadyHeld: number;
  spent: number;
  errors: string[];
};

/**
 * Restore from seed (incident 14 Oct 2026, $bug): every paymail payment ever received for this identity, collected
 * ones too, comes back from the server's record (site/lib/paymail.js `history`), and each output the wallet lacks and
 * the chain still holds is internalized again with its original derivation. Idempotent: held outputs are skipped and
 * the toolbox merges a known txid. Nothing is acked or changed on the server.
 */
export const restorePaymailHistory = async (
  f: Fetch,
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature' | 'internalizeAction'>,
  deps: PaymailRestoreDeps,
): Promise<PaymailRestoreReport> => {
  const report: PaymailRestoreReport = { payments: 0, restored: 0, satoshis: 0, alreadyHeld: 0, spent: 0, errors: [] };
  if (!paymailEnabled()) return report;
  const hist = await postJson(f, api('history'), await signRequest(wallet, 'history', {}));
  const payments = (hist.payments ?? []) as InboxPayment[];
  report.payments = payments.length;
  for (const p of payments) {
    try {
      const wanted: InboxPayment['outputs'] = [];
      for (const o of p.outputs) {
        if (await deps.hasOutput(p.txid, o.vout)) {
          report.alreadyHeld++;
          continue;
        }
        if ((await deps.isUnspent(p.txid, o.vout)) === false) {
          report.spent++;
          continue;
        }
        wanted.push(o);
      }
      if (!wanted.length) continue;
      await wallet.internalizeAction({
        tx: await atomicBeefFor(p, deps.fetchBeef),
        outputs: wanted.map((o) => ({
          outputIndex: o.vout,
          protocol: 'wallet payment' as const,
          paymentRemittance: {
            derivationPrefix: o.derivationPrefix,
            derivationSuffix: o.derivationSuffix,
            senderIdentityKey: hist.senderIdentityKey,
          },
        })),
        description: `Paymail payment${p.sender ? ` from ${p.sender}` : ''}`.slice(0, 50),
        labels: ['paymail'],
      });
      report.restored++;
      report.satoshis += wanted.reduce((s, o) => s + Number(o.satoshis), 0);
    } catch (e) {
      report.errors.push(`${p.txid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
};

export const paymailRestoreSummary = (r: PaymailRestoreReport) =>
  r.restored
    ? `Restored ${r.restored} paymail payment${r.restored === 1 ? '' : 's'} (${r.satoshis.toLocaleString()} sats)`
    : r.errors.length
      ? `Could not restore ${r.errors.length} paymail payment${r.errors.length === 1 ? '' : 's'}`
      : 'No paymail payments missing';

/** Why the paymail can't be changed to `alias`, or null if it can (mirrors site/lib/paymail.js `register`). */
export const nameChangeBlocked = (current: string | null | undefined, alias: string): string | null => {
  // Owner, 9 Oct 2026 (handle rule): users choose their handle, and a wallet with a verified .x / .gmail
  // name may pick a plain one (the verified name keeps receiving). Only a NEW .x / .gmail name is refused:
  // those come from a provider, not a choice.
  const now = (current ?? '').split('@')[0];
  if (!alias || now === alias || !SOCIAL_ALIAS_RE.test(alias)) return null;
  return 'Choose a plain handle (a-z, 0-9, - or _).';
};

export type NameFee = { address: string; usd: number };
/** Name prices by length (owner pricing, 27 Oct 2026): 5+ characters free, 4 = $10, 3 = $100, 1-2 = $1000. */
export type NamePrices = { address: string; tiers: Record<string, number> };
const asFee = (nf: { address?: unknown; usd?: unknown } | null | undefined): NameFee | null =>
  nf && typeof nf.address === 'string' && Number(nf.usd) > 0 ? { address: nf.address, usd: Number(nf.usd) } : null;
const asPrices = (p: { address?: unknown; tiers?: unknown } | null | undefined): NamePrices | null => {
  if (!p || typeof p.address !== 'string' || !p.tiers || typeof p.tiers !== 'object') return null;
  const tiers: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.tiers as Record<string, unknown>)) if (Number(v) > 0) tiers[k] = Number(v);
  return { address: p.address, tiers };
};
/**
 * The server's name rules: `nameFee` = the old flat fee (now null) and `namePrices` = the price by length (null =
 * every name free). Never throws.
 */
export const paymailConfig = async (f: Fetch): Promise<{ nameFee: NameFee | null; namePrices: NamePrices | null }> => {
  if (!paymailEnabled()) return { nameFee: null, namePrices: null };
  try {
    const r = await f(api('config'));
    const j = r.ok ? await r.json() : null;
    return { nameFee: asFee(j?.nameFee), namePrices: asPrices(j?.namePrices) };
  } catch {
    return { nameFee: null, namePrices: null };
  }
};

/** What claiming `alias` costs (null = free). Social names (.x) are free. Pure; the server has the final say. */
export const nameFeeFor = (prices: NamePrices | null, alias: string): NameFee | null => {
  const a = alias.trim().toLowerCase();
  if (!prices || !a || a.includes('.')) return null;
  const usd = prices.tiers[String(a.length)] ?? 0;
  return usd > 0 ? { address: prices.address, usd } : null;
};

/** "$10" / "$1000" / "1¢". Pure. */
export const usdText = (usd: number): string =>
  usd >= 1 ? `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}` : `${Math.round(usd * 100)}¢`;

/** "$10 (≈ 12,345 sats)" at `rate` (USD per BSV), or "$10" without a rate. Pure. */
export const nameFeeLabel = (fee: NameFee | null, rate: number): string => {
  if (!fee) return '';
  const sats = rate > 0 ? Math.ceil((fee.usd / rate) * 1e8) : 0;
  return sats ? `${usdText(fee.usd)} (≈ ${sats.toLocaleString('en-US')} sats)` : usdText(fee.usd);
};

/** A legacy .gmail name shows the owner's Gmail address: the app asks them to choose a name. */
export const isGmailName = (paymail: string | null | undefined) => /\.gmail@/.test(paymail ?? '');

/** Display names (owner, 15 Oct 2026): a person's name beside the paymail, never blank. Same rules as site/lib/displayName.js. */
export const DISPLAY_NAME_MAX = 64;
const NAME_PLACEHOLDER_RE = /^(account\s*\d*|anonymous|anon|bwallet|bwalletx|yours|wallet|unknown|user)$/i;
const NAME_CONTROL_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const NAME_IMPERSONATE_RES = [
  /@\s*\S*/g,
  /\b[\w-]+\.(com|net|org|io|app|xyz|online|website|me|co|uk)\b/gi,
  /\bb?wallet\s*x\b/gi,
  /\bverified\b/gi,
  /\bofficial\b/gi,
  /\b(admin|support|staff|moderator)\b/gi,
  /[\u2713\u2714\u2705\u2611\u{1F512}\u{1F6E1}]/gu,
];

/** A name as typed → what the server stores ('' = nothing usable, e.g. "Anonymous" or "@bwalletx"). */
export const cleanDisplayName = (raw: string | null | undefined): string => {
  let s = String(raw ?? '')
    .normalize('NFC')
    .replace(NAME_CONTROL_RE, '');
  for (const re of NAME_IMPERSONATE_RES) s = s.replace(re, ' ');
  s = s
    .replace(/[<>]/g, '')
    .replace(/[([{]\s*[)\]}]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—·|:,.]+|[\s\-–—·|:,.]+$/g, '')
    .trim();
  if (NAME_PLACEHOLDER_RE.test(s)) return '';
  return Array.from(s).slice(0, DISPLAY_NAME_MAX).join('').trim();
};

/** The alias as a name: "mike" → "Mike". */
export const defaultDisplayName = (alias: string): string => {
  const base = String(alias || '')
    .split('@')[0]
    .replace(/\.(x|gmail)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
};

/** Set this wallet's display name on every one of its paymails (signed). Returns the name as stored. */
export const setDisplayName = async (
  f: Fetch,
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  name: string,
): Promise<string> => {
  if (!paymailEnabled()) throw new Error('Paymail is not configured');
  const clean = cleanDisplayName(name);
  if (!clean) throw new Error('Type a name (letters, not a paymail)');
  const j = await postJson(f, api('set-name'), await signRequest(wallet, 'set-name', { name: clean }));
  return String(j.name ?? clean);
};

/** The public display name of one of our paymails ('' when unknown). Never throws. */
export const fetchDisplayName = async (f: Fetch, paymail: string): Promise<string> => {
  if (!paymailEnabled() || !paymail) return '';
  try {
    const r = await f(`${api('profile')}/${encodeURIComponent(paymail)}`);
    if (!r.ok) return '';
    const j = await r.json().catch(() => null);
    return cleanDisplayName(typeof j?.name === 'string' ? j.name : '');
  } catch {
    return '';
  }
};

let bindFlight: Promise<number> | null = null;
/**
 * Sign the binding for every name of this wallet that isn't signed by it yet (docs/NAME-BINDINGS.md). Silent:
 * it signs only "my name -> my key", which any wallet then checks before paying. Returns how many it signed.
 */
export const bindMyNames = (
  f: Fetch,
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  identityKey: string,
): Promise<number> => {
  if (!paymailEnabled()) return Promise.resolve(0);
  if (bindFlight) return bindFlight;
  bindFlight = (async () => {
    const { checkBinding } = await import('./binding');
    let signed = 0;
    for (const n of await listPaymails(f, identityKey)) {
      const alias = aliasOf(n.paymail);
      const r = await f(api(`id/${alias}@${BWALLET_PAYMAIL_DOMAIN}`)).catch(() => null);
      const id = r?.ok
        ? ((await r.json().catch(() => null)) as { pubkey?: string; binding?: { seq?: number } } | null)
        : null;
      if (!id || String(id.pubkey ?? '').toLowerCase() !== identityKey.toLowerCase()) continue;
      if ((await checkBinding(alias, id.pubkey, id.binding)) === 'signed') continue;
      const seq = String((Number(id.binding?.seq) || 0) + 1);
      await postJson(f, api('bind'), await signRequest(wallet, 'bind', { alias, seq })).catch(() => undefined);
      signed++;
    }
    return signed;
  })().finally(() => {
    bindFlight = null;
  });
  return bindFlight;
};

/** Two-party handovers (docs/NAME-BINDINGS.md): the owner releases a name to a key; that key accepts. */
export type Handover = { alias: string; from_key: string; to_key: string; seq: number };

/** The name's current binding version (0 if never signed). */
export const bindingSeq = async (f: Fetch, alias: string): Promise<number> => {
  const r = await f(api(`id/${alias}@${BWALLET_PAYMAIL_DOMAIN}`)).catch(() => null);
  const j = r?.ok ? ((await r.json().catch(() => null)) as { binding?: { seq?: number } } | null) : null;
  return Number(j?.binding?.seq) || 0;
};

export const releaseName = async (f: Fetch, wallet: NameSigner, alias: string, to: string): Promise<number> => {
  const seq = (await bindingSeq(f, alias)) + 1;
  await postJson(f, api('handover-release'), await signRequest(wallet, 'release', { alias, to, seq: String(seq) }));
  return seq;
};

export const cancelRelease = async (f: Fetch, wallet: NameSigner, alias: string) =>
  postJson(f, api('handover-cancel'), await signRequest(wallet, 'release-cancel', { alias }));

export const incomingHandovers = async (f: Fetch, key: string): Promise<Handover[]> => {
  const r = await f(`${api('handovers-for')}?key=${key}`).catch(() => null);
  const j = r?.ok ? ((await r.json().catch(() => null)) as { handovers?: Handover[] } | null) : null;
  return j?.handovers ?? [];
};

export const acceptHandover = async (f: Fetch, wallet: NameSigner, h: Handover) =>
  postJson(f, api('handover-accept'), await signRequest(wallet, 'bind', { alias: h.alias, seq: String(h.seq) }));
