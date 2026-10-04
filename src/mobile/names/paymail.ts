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

export const signRequest = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  action: string,
  fields: Record<string, string>,
  now = Date.now(),
) => {
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
  const timestamp = now;
  const all = { ...fields, identityKey, timestamp: String(timestamp) };
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(signedMessage(action, all), 'utf8'),
    protocolID: SIGN_PROTOCOL,
    keyID: SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return { identityKey, timestamp, fields, signature: Utils.toHex(signature) };
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
  extra: { ordAddress?: string; name?: string; avatar?: string; social?: { ticket: string; secret: string } } = {},
): Promise<string> => {
  if (!paymailEnabled()) throw new Error('Paymail is not configured');
  if (!PAYMAIL_ALIAS_RE.test(alias) && !SOCIAL_ALIAS_RE.test(alias)) throw new Error('Use a-z, 0-9, - or _ (up to 32)');
  const fields: Record<string, string> = { alias };
  if (extra.ordAddress) fields.ordAddress = extra.ordAddress;
  if (extra.name) fields.name = extra.name.slice(0, 64);
  if (extra.avatar) fields.avatar = extra.avatar.slice(0, 512);
  const signed = await signRequest(wallet, 'register', fields);
  // A verified social name (b0asex.x) carries the Continue with X / Google proof (src/mobile/social).
  const j = await postJson(f, api('register'), extra.social ? { ...signed, social: extra.social } : signed);
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

/** Is `alias@domain` free? (pki 404 = free) */
export const paymailAvailable = async (f: Fetch, alias: string): Promise<boolean> => {
  const r = await f(api(`id/${alias}@${BWALLET_PAYMAIL_DOMAIN}`));
  return r.status === 404;
};

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
