/**
 * Exchange › Contracts, the wallet side: list (site/api/contracts.js), publish (mint the original + register),
 * buy (one transaction pays the author + the 1% market fee and mints your copy, then the catalogue counts it).
 */
import type { OneSatContext } from '@1sat/actions';
import { ONESAT_BASKET } from '@1sat/types';
import { withFeeOutput } from '../mint/mint';
import { marketFeeAddress, marketFeeSats } from '../market/fee';
import { mintJson, prove } from '../strategies/market';
import { CONTRACT_CONTENT_TYPE, type ContractEnvelope } from './contractNft';

export const CONTRACTS_API = 'https://www.bwallet.space/api/contracts';
export type ContractListing = {
  origin: string;
  envelope: ContractEnvelope;
  body: string;
  sold: number;
  createdAt: string;
};

const api = async <T>(init?: RequestInit, query = ''): Promise<T> => {
  const r = await fetch(`${CONTRACTS_API}${query}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `Contracts catalogue answered ${r.status}`);
  return j;
};

export const listContracts = () => api<{ contracts: ContractListing[] }>().then((r) => r.contracts);
export const getContract = (origin: string) =>
  api<{ contract: ContractListing }>(undefined, `?origin=${encodeURIComponent(origin)}`).then((r) => r.contract);

const MAP = (env: ContractEnvelope) => ({ app: 'bwalletx', type: 'contract', name: env.contract.name });

/** Contract NFTs this account holds. */
export const ownedContractOutpoints = async (ctx: OneSatContext) => {
  const res = await ctx.wallet.listOutputs({ basket: ONESAT_BASKET, includeTags: true, limit: 500 });
  return (res.outputs as { outpoint: string; tags?: string[]; spendable?: boolean }[])
    .filter((o) => o.spendable !== false && o.tags?.includes(`type:${CONTRACT_CONTENT_TYPE}`))
    .map((o) => o.outpoint.replace('.', '_'));
};

/** Publish: mint the original and list it. */
export const publishContract = async (ctx: OneSatContext, env: ContractEnvelope) => {
  const outpoint = await mintJson(ctx, env, CONTRACT_CONTENT_TYPE, MAP(env));
  const proof = await prove(ctx, 'publish', outpoint);
  await api({ method: 'POST', body: JSON.stringify({ action: 'publish', outpoint, ...proof }) });
  return outpoint;
};

export const contractPriceSats = (env: ContractEnvelope, bsvUsd: number) =>
  env.sale.priceUsd > 0 ? Math.ceil((env.sale.priceUsd / bsvUsd) * 1e8) : 0;

/**
 * Buy a copy: mint the exact published text, paying the author (and the 1% fee) in the same transaction.
 * `approved` is the listing the buyer saw and pressed Buy on. The catalogue is asked again (sold out?), and the
 * buy is refused if its price, payee, copies or text differ from what was approved (b-Aware 25 Oct 2026): the
 * catalogue must never change what is paid or minted between showing it and paying.
 */
export const buyContract = async (ctx: OneSatContext, approved: ContractListing, bsvUsd: number) => {
  const c = await getContract(approved.origin);
  if (c.origin !== approved.origin || !sameEnvelope(c.envelope, approved.envelope) || c.body !== approved.body)
    throw new Error('This contract changed since you opened it. Nothing was paid; refresh and check it again.');
  const env = approved.envelope;
  if (c.sold >= env.sale.copies) throw new Error('Sold out');
  if (env.sale.priceUsd > 0 && !(bsvUsd > 0)) throw new Error('No BSV price right now; try again shortly.');
  const sats = contractPriceSats(env, bsvUsd);
  const paying =
    sats > 0 ? withFeeOutput(withFeeOutput(ctx, marketFeeSats(sats), marketFeeAddress()), sats, env.sale.payTo) : ctx;
  const outpoint = await mintJson(paying, approved.body, CONTRACT_CONTENT_TYPE, MAP(env));
  await claimContract(ctx, outpoint);
  return outpoint;
};

/** Key-order-independent deep equality of two envelopes (JSON values only). */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;
export const sameEnvelope = (a: ContractEnvelope, b: ContractEnvelope) =>
  JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Register a copy this wallet holds with the catalogue (counts it as sold; idempotent). */
export const claimContract = async (ctx: OneSatContext, outpoint: string) => {
  const proof = await prove(ctx, 'unlock', outpoint);
  return api<{ ok: boolean; contract: string; original: boolean }>({
    method: 'POST',
    body: JSON.stringify({ action: 'claim', outpoint, ...proof }),
  });
};
