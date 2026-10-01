import { bsv21FieldsFromOutput, deployBsv21Mint, type OneSatContext } from '@1sat/actions';
import { BSV21_BASKET } from '@1sat/types';
import { isNative } from '../native';
import { fundAfterDeploy, indexCostSats } from '../tokens/indexFund';
import { BchatClient, defaultHttp, loadSession, saveSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { proveHoldings } from '../chat/holdings';
import {
  PERSONAL_DECIMALS,
  PERSONAL_MIN,
  PERSONAL_PURPOSE,
  BWALLET_MARK_ICON,
  cleanSupply,
  getPersonalLink,
  personalKey,
  personalTicker,
  pickOwnDeploy,
  rememberPersonal,
  type OwnDeploy,
  setPersonalLink,
  validateSupply,
  withPersonalMap,
  type PersonalLink,
} from './personalToken';

/**
 * The two network halves of "claim your name": (1) deploy the personal BSV-21 token — a wallet
 * transaction, run only after the user confirms the SendConfirmation sheet; (2) open the personal
 * room in bit-sign — signatures only (bChat sign-in + key proofs), nothing spent.
 *
 * A just-deployed token is not indexed for a while, and bit-sign re-checks the holding through
 * the indexer, so (2) can fail at first. The link keeps `roomTicker: null` and the Chat tab
 * retries (`retryPersonalRoom`) until it goes through.
 */

// deploy+mint inscription (~250 B) + MAP (~100 B) + inputs/change at ~100 sat/kB.
export const PERSONAL_NETWORK_FEE_SATS = 80;
/** Indexing: the creator pre-funds the token's 1sat-stack fee address at mint (tokens/indexFund.ts). */
export const PERSONAL_INDEX_SATS = indexCostSats();
/** Everything the confirm sheet shows for the token + room. */
export const PERSONAL_FEE_ESTIMATE_SATS = PERSONAL_NETWORK_FEE_SATS + PERSONAL_INDEX_SATS;

export async function deployPersonalToken(
  ctx: OneSatContext,
  input: { identityAddress: string; name: string; supply: string; icon?: string },
): Promise<PersonalLink> {
  const ticker = personalTicker(input.name);
  if (!ticker) throw new Error('That name cannot be a token ticker');
  const bad = validateSupply(input.supply);
  if (bad) throw new Error(bad);
  const supply = cleanSupply(input.supply);
  const res = await deployBsv21Mint.execute(withPersonalMap(ctx, input.name, ticker), {
    symbol: ticker,
    amount: supply,
    decimals: PERSONAL_DECIMALS,
    icon: input.icon || BWALLET_MARK_ICON,
  });
  if (res.error || !res.tokenId) throw new Error(res.error || 'Token deploy failed');
  const link: PersonalLink = {
    name: personalKey(input.name),
    tokenId: res.tokenId,
    ticker,
    supply,
    createdAt: Date.now(),
    roomTicker: null,
  };
  setPersonalLink(input.identityAddress, link);
  // Second tx: fund indexing so other wallets, the Market and bit-sign's room gate can see it.
  // Never fails the claim (the token is minted and in this wallet); "Finish setting up" retries.
  const fund = await fundAfterDeploy(ctx, res.tokenId, ticker);
  if (!fund.ok) console.warn('[personal] indexing not funded yet:', fund.error);
  return link;
}

async function chatClient(ctx: OneSatContext): Promise<BchatClient> {
  const client = new BchatClient(defaultHttp(isNative), loadSession());
  if (!client.handle) saveSession(await client.signIn(walletSigner(ctx)));
  return client;
}

/** Open (idempotently) the personal room for a link. Returns its ticker, or null if not yet. */
export async function openPersonalRoom(
  ctx: OneSatContext,
  identityAddress: string,
  link: PersonalLink,
  client?: BchatClient,
): Promise<string | null> {
  const c = client ?? (await chatClient(ctx));
  const key = `bsv21:${link.tokenId}`;
  await proveHoldings(ctx, c, key).catch(() => 0);
  const ticker = await c.startTokenRoom(key, {
    name: `$${link.ticker}`,
    min: PERSONAL_MIN,
    purpose: PERSONAL_PURPOSE,
    // bit-sign binds the name only if it is the caller's own handle; otherwise it is a plain
    // token room (still gated, still yours) and the ✓ stays local.
    ...(c.handle && personalKey(c.handle) === link.name ? { personal_name: link.name } : {}),
  });
  setPersonalLink(identityAddress, { ...link, roomTicker: ticker });
  return ticker;
}

/** Chat tab: finish a personal room that could not be opened right after the deploy. */
export async function retryPersonalRoom(ctx: OneSatContext, identityAddress: string, client: BchatClient) {
  const link = getPersonalLink(identityAddress);
  if (!link || link.roomTicker) return null;
  return openPersonalRoom(ctx, identityAddress, link, client).catch(() => null);
}

/** Learn (and cache) the token bound to a name from bit-sign. */
export async function lookupPersonal(client: BchatClient, name: string): Promise<string | null> {
  const r = await client.personalToken(personalKey(name)).catch(() => null);
  if (r?.tokenId) rememberPersonal({ name, tokenId: r.tokenId });
  return r?.tokenId ?? null;
}

/**
 * Restore a lost local link (e.g. app data cleared, or minted from another screen): look for this
 * wallet's own deploy of $HANDLE in the BSV-21 basket. Read-only; returns the restored link or null.
 */
export async function recoverPersonalLink(
  ctx: OneSatContext,
  identityAddress: string,
  handle: string,
): Promise<PersonalLink | null> {
  const existing = getPersonalLink(identityAddress);
  if (existing) return existing;
  const ticker = personalTicker(handle);
  if (!ticker) return null;
  const res = await ctx.wallet
    .listOutputs({
      basket: BSV21_BASKET,
      tags: ['bsv21:deploy'],
      includeTags: true,
      includeCustomInstructions: true,
      limit: 200,
    })
    .catch(() => null);
  const deploys: OwnDeploy[] = [];
  for (const o of res?.outputs ?? []) {
    const f = bsv21FieldsFromOutput({ tags: o.tags, customInstructions: o.customInstructions, outpoint: o.outpoint });
    if (f.isDeploy && f.tokenId && f.sym && f.amt) deploys.push({ tokenId: f.tokenId, sym: f.sym, amt: f.amt });
  }
  const d = pickOwnDeploy(deploys, ticker);
  if (!d) return null;
  const link: PersonalLink = {
    name: personalKey(handle),
    tokenId: d.tokenId,
    ticker,
    supply: d.amt,
    createdAt: Date.now(),
    roomTicker: null,
  };
  setPersonalLink(identityAddress, link);
  return link;
}
