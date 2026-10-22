import { inscribe, listOrdinals, sendOrdinals, type OneSatContext } from '@1sat/actions';
import { Utils, type WalletInterface } from '@bsv/sdk';
import { fetchExchangeRate } from '../../utils/wallet';
import { usdToSats } from '../money/money';
import { withFeeOutput } from '../mint/mint';
import { BWALLET_PAYMAIL_API, BWALLET_PAYMAIL_DOMAIN } from './config';
import type { Fetch, Resolved } from './names';
import { SIGN_KEY_ID, SIGN_PROTOCOL, signRequest, type NameFee } from './paymail';

/**
 * Handle NFTs (docs/HANDLE-NFTS.md): a bWalletX handle represented by a 1Sat ordinal. Whoever holds the NFT
 * holds the handle. Server side: site/lib/handleNft.js (keep the content, message and MAP keys in step).
 *
 *   mint:  inscribe {p:'bwalletx-handle',v:1,alias,domain} to self, with a MAP genesis binding signed by our
 *          identity key and the 1¢ fee output in the same tx; then POST handle-nft-bind so the server follows it.
 *   send:  sendOrdinals to the recipient's ordinals address with a MAP binding that names the recipient's
 *          identity key, signed by ours (a "designation"); then POST handle-nft-sync.
 */

export const HANDLE_PROTOCOL = 'bwalletx-handle';
export const HANDLE_CONTENT_TYPE = 'application/json';
export const GENESIS = 'genesis';

export const handleContent = (alias: string, domain: string) =>
  JSON.stringify({ p: HANDLE_PROTOCOL, v: 1, alias, domain });

export type Binding = { alias: string; origin: string; spent: string; to: string; signer: string };

/** Same canonical string as the server's bindingMessage. */
export const bindingMessage = (b: Binding) => {
  const fields: Record<string, string> = {
    alias: b.alias,
    origin: b.origin || '',
    signer: b.signer,
    spent: b.spent,
    to: b.to,
  };
  const keys = Object.keys(fields).sort();
  return ['bwallet-paymail', 'v1', 'handle-bind', ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
};

type Signer = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>;

/** The binding signed by this wallet's identity key, as MAP fields for the NFT output. */
export const signedBindingMap = async (wallet: Signer, b: Omit<Binding, 'signer'>): Promise<Record<string, string>> => {
  const { publicKey: signer } = await wallet.getPublicKey({ identityKey: true });
  const full: Binding = { ...b, signer };
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(bindingMessage(full), 'utf8'),
    protocolID: SIGN_PROTOCOL,
    keyID: SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return {
    app: 'bwalletx',
    type: 'handle',
    'handle.alias': full.alias,
    'handle.origin': full.origin,
    'handle.spent': full.spent,
    'handle.to': full.to,
    'handle.signer': full.signer,
    'handle.sig': Utils.toHex(signature),
  };
};

const api = (op: string) => `${BWALLET_PAYMAIL_API}/api/paymail/${op}`;
const post = async (f: Fetch, op: string, body: unknown) => {
  const r = await f(api(op), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j?.error || `HTTP ${r.status}`), { status: r.status });
  return j;
};

/** What making a handle an NFT costs (null = no fee), from the server's config. */
export const handleNftFee = async (f: Fetch): Promise<NameFee | null> => {
  const r = await f(api('config'));
  const j = await r.json().catch(() => null);
  const n = j?.handleNft;
  return n && typeof n.address === 'string' && typeof n.usd === 'number' ? { address: n.address, usd: n.usd } : null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Mint `alias` as an NFT (one wallet approval) and ask the server to follow it. Call only after the user
 * confirmed. Returns the origin outpoint. The server checks the binding and the fee in the mint tx itself.
 */
export const mintHandleNft = async (
  f: Fetch,
  ctx: OneSatContext,
  alias: string,
  fee: NameFee | null,
): Promise<string> => {
  const domain = BWALLET_PAYMAIL_DOMAIN;
  if (!domain || !BWALLET_PAYMAIL_API) throw new Error('Paymail is not configured');
  const { publicKey: me } = await ctx.wallet.getPublicKey({ identityKey: true });
  const map = await signedBindingMap(ctx.wallet, { alias, origin: '', spent: GENESIS, to: me });
  let run = ctx;
  if (fee) {
    const sats = usdToSats(fee.usd, await fetchExchangeRate('main'));
    if (!sats) throw new Error("Couldn't get the BSV price. Try again in a minute.");
    run = withFeeOutput(ctx, sats, fee.address);
  }
  const res = await inscribe.execute(run, {
    base64Content: Utils.toBase64(Utils.toArray(handleContent(alias, domain), 'utf8')),
    contentType: HANDLE_CONTENT_TYPE,
    map,
  });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'Mint failed'));
  const origin = `${res.txid}_0`;
  // The indexers may not have the tx for a few seconds: retry the bind while the server can't see it.
  for (let i = 0; ; i++) {
    try {
      await post(f, 'handle-nft-bind', await signRequest(ctx.wallet, 'handle-nft-bind', { alias, origin }));
      return origin;
    } catch (e) {
      if ((e as { status?: number }).status !== 409 || i >= 5) throw e;
      await sleep(3000);
    }
  }
};

/** The NFT's current outpoint in this wallet (txid_vout), or undefined when the wallet doesn't hold it. */
export const handleNftOutpoint = async (ctx: OneSatContext, origin: string): Promise<string | undefined> => {
  const norm = (s: string) => s.replace('.', '_');
  for (let offset = 0; offset < 2000; offset += 500) {
    const r = await listOrdinals.execute(ctx, { limit: 500, offset });
    for (const o of r.outputs as { outpoint: string; tags?: string[] }[]) {
      const t = o.tags?.find((x) => x.startsWith('origin:'));
      if (norm(t ? t.slice(7) : o.outpoint) === norm(origin)) {
        if (o.tags?.some((x) => x === 'ordlock' || x.startsWith('ordlock:'))) return undefined;
        return norm(o.outpoint);
      }
    }
    if (r.outputs.length < 500) break;
  }
  return undefined;
};

export const SEND_HANDLE_NEEDS_KEY =
  'Send a handle to a bWalletX $handle or a paymail that publishes its identity key and takes ordinals.';

/** Where a handle can go: an ordinals address AND an identity key to bind it to. */
export const handleSendTarget = (r: Resolved): { ok: true; to: string; key: string } | { ok: false; error: string } => {
  const key = (r.pubkey || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(key) || !r.ordAddress) return { ok: false, error: SEND_HANDLE_NEEDS_KEY };
  return { ok: true, to: r.ordAddress, key };
};

/**
 * Send the handle NFT (one wallet approval) with a designation binding naming `toKey`, then ask the server
 * to re-check. Returns the txid. Call only after the user confirmed the warning.
 */
export const sendHandleNft = async (
  f: Fetch,
  ctx: OneSatContext,
  h: { alias: string; origin: string },
  target: { to: string; key: string },
): Promise<string> => {
  const spent = await handleNftOutpoint(ctx, h.origin);
  if (!spent) throw new Error("This wallet doesn't hold that handle's NFT (or it is listed for sale).");
  const map = await signedBindingMap(ctx.wallet, { alias: h.alias, origin: h.origin, spent, to: target.key });
  const res = await sendOrdinals.execute(ctx, { transfers: [{ id: spent, address: target.to, map }] });
  if (res.error || !res.txid) throw new Error(String(res.error ?? 'Send failed'));
  // Best effort: the server also follows on the next lookup.
  await post(f, 'handle-nft-sync', { alias: h.alias }).catch(() => undefined);
  return res.txid;
};
