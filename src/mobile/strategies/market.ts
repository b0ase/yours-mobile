/**
 * Exchange › Strategies, the wallet side: publish (mint the author's copy + register its key), buy (one
 * transaction pays the author + the 1% market fee and mints the buyer's copy), unlock (prove ownership
 * of a copy with the key that holds it, get the content key, decrypt). Key service: site/api/strategies.js.
 */
import { inscribe, type OneSatContext } from '@1sat/actions';
import { ONESAT_BASKET } from '@1sat/types';
import { Utils } from '@bsv/sdk';
import { derivationOf } from '../chat/tokenRooms';
import { withFeeOutput } from '../mint/mint';
import { marketFeeAddress, marketFeeSats } from '../market/fee';
import type { Strategy } from '../agents/strategy';
import { openStrategy, parseEnvelope, proofMessage, STRATEGY_CONTENT_TYPE, type Envelope } from './strategyNft';

export const STRATEGIES_API = 'https://www.bwallet.space/api/strategies';

export type Listing = { origin: string; envelope: Omit<Envelope, 'iv' | 'ciphertext'>; sold: number; createdAt: string };

const api = async <T>(init?: RequestInit, query = ''): Promise<T> => {
  const r = await fetch(`${STRATEGIES_API}${query}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `Key service answered ${r.status}`);
  return j;
};

export const listStrategies = () => api<{ strategies: Listing[] }>().then((r) => r.strategies);
export const getStrategy = (origin: string) =>
  api<{ strategy: { origin: string; envelope: Envelope; sold: number } }>(undefined, `?origin=${encodeURIComponent(origin)}`).then((r) => r.strategy);

type Out = { outpoint: string; tags?: string[]; customInstructions?: string; spendable?: boolean };
const outputs = async (ctx: OneSatContext): Promise<Out[]> => {
  const res = await ctx.wallet.listOutputs({ basket: ONESAT_BASKET, includeTags: true, includeCustomInstructions: true, limit: 500 });
  return (res.outputs as Out[]).filter((o) => o.spendable !== false && o.outpoint);
};
const norm = (op: string) => op.replace('.', '_');

/** Strategy NFTs this account holds (any copy: authored, bought, or received). */
export const ownedStrategyOutpoints = async (ctx: OneSatContext) =>
  (await outputs(ctx)).filter((o) => o.tags?.includes(`type:${STRATEGY_CONTENT_TYPE}`)).map((o) => norm(o.outpoint));

/** Sign the key service's proof with the exact key that locks `outpoint`. */
const prove = async (ctx: OneSatContext, action: 'publish' | 'unlock', outpoint: string) => {
  let o: Out | undefined;
  for (let i = 0; i < 5 && !o; i++) {
    o = (await outputs(ctx)).find((x) => norm(x.outpoint) === outpoint);
    if (!o) await new Promise((r) => setTimeout(r, 1500)); // a fresh mint can take a moment to be listed
  }
  const d = o && derivationOf(o.customInstructions);
  if (!d) throw new Error('This wallet doesn’t hold that copy');
  const message = proofMessage(action, outpoint, Date.now());
  const args = { protocolID: d.protocolID, keyID: d.keyID, counterparty: d.counterparty };
  const { publicKey } = await ctx.wallet.getPublicKey({ ...args, forSelf: true });
  const { signature } = await ctx.wallet.createSignature({ ...args, data: Utils.toArray(message, 'utf8') });
  return { message, pubkey_hex: publicKey, signature: Utils.toHex(signature) };
};

const mintEnvelope = async (ctx: OneSatContext, env: Envelope) => {
  const base64Content = btoa(unescape(encodeURIComponent(JSON.stringify(env))));
  const res = await inscribe.execute(ctx, {
    base64Content,
    contentType: STRATEGY_CONTENT_TYPE,
    map: { app: 'bwalletx', type: 'strategy', name: env.name },
  });
  if (!res.txid || res.error) throw new Error(res.error || 'Mint failed');
  // The copy is this tx's 1-sat output with our content type (don't assume its index).
  for (let i = 0; i < 5; i++) {
    const o = (await outputs(ctx)).find((x) => norm(x.outpoint).startsWith(`${res.txid}_`) && x.tags?.includes(`type:${STRATEGY_CONTENT_TYPE}`));
    if (o) return norm(o.outpoint);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return `${res.txid}_0`;
};

/** Publish & sell: mint the author's copy, then register its content key. */
export const publishStrategy = async (ctx: OneSatContext, env: Envelope, key: string) => {
  const outpoint = await mintEnvelope(ctx, env);
  const proof = await prove(ctx, 'publish', outpoint);
  await api({ method: 'POST', body: JSON.stringify({ action: 'publish', outpoint, key, ...proof }) });
  return outpoint;
};

/** Sats the author is paid for one copy at today's price. */
export const priceSats = (env: Pick<Envelope, 'sale'>, bsvUsd: number) => Math.ceil((env.sale.priceUsd / bsvUsd) * 1e8);

/** Buy a copy: pay the author + the market fee and mint the buyer's copy in one transaction, then unlock it. */
export const buyStrategy = async (ctx: OneSatContext, origin: string, bsvUsd: number): Promise<{ outpoint: string; strategy: Strategy }> => {
  if (!(bsvUsd > 0)) throw new Error('No BSV price right now; try again shortly.');
  const { envelope, sold } = await getStrategy(origin);
  if (sold >= envelope.sale.copies) throw new Error('Sold out');
  const sats = priceSats(envelope, bsvUsd);
  const paying = withFeeOutput(withFeeOutput(ctx, marketFeeSats(sats), marketFeeAddress()), sats, envelope.sale.payTo);
  const outpoint = await mintEnvelope(paying, envelope);
  return { outpoint, strategy: await unlockStrategy(ctx, outpoint) };
};

/** Decrypt a copy this wallet holds. */
export const unlockStrategy = async (ctx: OneSatContext, outpoint: string): Promise<Strategy> => {
  const proof = await prove(ctx, 'unlock', outpoint);
  const { key, origin } = await api<{ key: string; origin: string }>({ method: 'POST', body: JSON.stringify({ action: 'unlock', outpoint, ...proof }) });
  const env = parseEnvelope((await getStrategy(origin)).envelope);
  if (!env) throw new Error('Bad strategy envelope');
  return openStrategy(env, key);
};
