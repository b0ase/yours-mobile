/**
 * Exchange › Contracts, the wallet side: list (site/api/contracts.js), publish (mint the original + register),
 * buy (one transaction pays the author + the 1% market fee and mints your copy, then the catalogue counts it).
 */
import type { OneSatContext } from '@1sat/actions';
import { ONESAT_BASKET } from '@1sat/types';
import { withFeeOutput } from '../mint/mint';
import { marketFeeAddress, marketFeeSats } from '../market/fee';
import { mintJson, prove } from '../strategies/market';
import type { Fetch } from '../names/names';
import { isOurDomain, resolvePaymail } from '../names/names';
import { shortKey } from '../names/pubkeyRecipient';
import {
  canonical,
  CONTRACT_CONTENT_TYPE,
  contractAuthorKey,
  signContractEnvelope,
  type ContractEnvelope,
} from './contractNft';

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

/**
 * Publish: sign the envelope as this account (signContractEnvelope: its identity key, `handle` = its bWalletX
 * paymail, and the reserved contract-signing key; the wallet's own publish, no site involved), mint the original
 * and list it.
 */
export const publishContract = async (ctx: OneSatContext, env: ContractEnvelope, handle?: string) => {
  const signed = await signContractEnvelope(ctx.wallet, env, handle);
  const outpoint = await mintJson(ctx, signed, CONTRACT_CONTENT_TYPE, MAP(signed));
  const proof = await prove(ctx, 'publish', outpoint);
  await api({ method: 'POST', body: JSON.stringify({ action: 'publish', outpoint, ...proof }) });
  return outpoint;
};

export const contractPriceSats = (env: ContractEnvelope, bsvUsd: number) =>
  env.sale.priceUsd > 0 ? Math.ceil((env.sale.priceUsd / bsvUsd) * 1e8) : 0;

/** Raw content of the inscription at an outpoint (ORDFS, no origin resolution), read from outside the catalogue. */
export const ORDFS_CONTENT = 'https://ordfs.network/content/';
const OUTPOINT_RE = /^[0-9a-f]{64}_\d{1,10}$/;

/**
 * The listing's terms as its author inscribed them. The catalogue serves `envelope` (whose sale.payTo is paid) and
 * `body` (what is minted); both must be exactly the original inscription at `origin`, read from the chain through
 * ORDFS, not from the catalogue. A catalogue that names its own payee from the start then fails here (b-Aware
 * 25 Oct 2026, fzsusanto row 115: 0579bc2b only caught a change between showing and paying). Throws when the
 * original can't be read or differs: nothing is paid.
 */
export const checkAgainstOriginal = async (listing: Pick<ContractListing, 'origin' | 'envelope' | 'body'>) => {
  const refuse = (why: string) => new Error(`${why} Nothing was paid.`);
  if (!OUTPOINT_RE.test(listing.origin)) throw refuse('This contract has no valid original on chain.');
  let text: string;
  try {
    const r = await fetch(`${ORDFS_CONTENT}${listing.origin}`);
    if (!r.ok) throw new Error(String(r.status));
    text = await r.text();
  } catch {
    throw refuse("Couldn't read this contract's original on chain to check who is paid. Try again shortly.");
  }
  let onChain: ContractEnvelope | null;
  try {
    onChain = JSON.parse(text) as ContractEnvelope;
  } catch {
    onChain = null;
  }
  if (text !== listing.body || !onChain || typeof onChain !== 'object' || !sameEnvelope(onChain, listing.envelope))
    throw refuse("This listing doesn't match the contract its author put on chain.");
};

/**
 * An earlier listing of the same contract (descriptor and description) by a different author address, or undefined.
 * Anyone can inscribe a copy of someone's contract with their own name and payee and list it (review of row 115, 14
 * Nov 2026): the copy is a valid inscription, so checkAgainstOriginal passes it. Nothing on chain ties an author's
 * address to the original (it is locked to a fresh wallet key, not to author.address), so the earliest listing is
 * the one paid; a later copy under another address is refused. Best effort: it sees what the catalogue lists.
 */
export const copiedFrom = (listing: ContractListing, all: readonly ContractListing[]): ContractListing | undefined => {
  const at = Date.parse(listing.createdAt);
  const same = (o: ContractListing) =>
    JSON.stringify(canon(o.envelope.contract)) === JSON.stringify(canon(listing.envelope.contract)) &&
    o.envelope.description === listing.envelope.description;
  return all.find(
    (o) =>
      o.origin !== listing.origin &&
      same(o) &&
      o.envelope.author.address !== listing.envelope.author.address &&
      !(Date.parse(o.createdAt) > at),
  );
};

/**
 * Buy a copy: mint the exact published text, paying the author (and the 1% fee) in the same transaction.
 * `approved` is the listing the buyer saw and pressed Buy on (the sheet shows the author's address, which is the
 * payee, in full). The catalogue is asked again (sold out?), and the buy is refused if its price, payee, copies or
 * text differ from what was approved (b-Aware 25 Oct 2026): the catalogue must never change what is paid or minted
 * between showing it and paying. A paid buy also needs: the payee to be the author's own address (as every publish
 * writes it), the author's signature over the whole envelope (contractAuthorKey; owner, 14 Nov 2026), the terms to
 * be the inscription at the origin (checkAgainstOriginal), and the listing not to be a later copy of another
 * author's contract (copiedFrom).
 */
export const buyContract = async (ctx: OneSatContext, approved: ContractListing, bsvUsd: number) => {
  const c = await getContract(approved.origin);
  if (c.origin !== approved.origin || !sameEnvelope(c.envelope, approved.envelope) || c.body !== approved.body)
    throw new Error('This contract changed since you opened it. Nothing was paid; refresh and check it again.');
  const env = approved.envelope;
  if (c.sold >= env.sale.copies) throw new Error('Sold out');
  if (env.sale.priceUsd > 0 && !(bsvUsd > 0)) throw new Error('No BSV price right now; try again shortly.');
  if (env.sale.priceUsd > 0) {
    if (env.sale.payTo !== env.author.address)
      throw new Error("This contract pays someone other than its author's address. Nothing was paid.");
    if (!(await contractAuthorKey(env)))
      throw new Error("This contract isn't signed by its author, so it can't be bought. Nothing was paid.");
    await checkAgainstOriginal(approved);
    let all: ContractListing[];
    try {
      all = await listContracts();
    } catch {
      throw new Error("Couldn't check this contract against the catalogue. Nothing was paid; try again shortly.");
    }
    const first = copiedFrom({ ...approved, createdAt: c.createdAt }, all);
    if (first)
      throw new Error(
        `This listing copies a contract first listed by ${first.envelope.author.address}. Nothing was paid.`,
      );
  }
  const sats = contractPriceSats(env, bsvUsd);
  const paying =
    sats > 0 ? withFeeOutput(withFeeOutput(ctx, marketFeeSats(sats), marketFeeAddress()), sats, env.sale.payTo) : ctx;
  const outpoint = await mintJson(paying, approved.body, CONTRACT_CONTENT_TYPE, MAP(env));
  await claimContract(ctx, outpoint);
  return outpoint;
};

/** Key-order-independent deep equality of two envelopes (JSON values only). */
const canon = canonical;
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

/**
 * How a listing's author is shown. Signed (contractAuthorKey): the $name whose signed name binding points at the
 * signing key (the envelope's signed `handle`, resolved now: its key must be the author's and its binding 'signed'),
 * else the short key; the typed name never. Unsigned: null (the sheet shows the typed name as the author's own words,
 * and a paid one can't be bought).
 */
export const contractAuthorLabel = async (
  f: Fetch,
  env: ContractEnvelope,
): Promise<{ label: string; named: boolean } | null> => {
  const key = await contractAuthorKey(env);
  if (!key) return null;
  const handle = env.author.handle;
  const [alias, domain] = typeof handle === 'string' ? handle.toLowerCase().split('@') : [];
  if (alias && domain && isOurDomain(domain)) {
    try {
      const r = await resolvePaymail(f, `${alias}@${domain}`);
      // A forward is declared by the paymail server, not signed by the name's owner: show the name only when the
      // handle itself resolves to the key, never through a forward (review of 00176fbe).
      if (!r.forwardsTo && r.pubkey?.toLowerCase() === key && r.nameBinding === 'signed')
        return { label: `$${alias}`, named: true };
    } catch {
      /* unresolvable: the short key */
    }
  }
  return { label: shortKey(key), named: false };
};
