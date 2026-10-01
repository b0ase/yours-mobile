import { deployBsv21Mint, type OneSatContext } from '@1sat/actions';
import { isNative } from '../native';
import { BchatClient, defaultHttp, loadSession, saveSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { proveHoldings } from '../chat/holdings';
import {
  PERSONAL_DECIMALS,
  PERSONAL_MIN,
  PERSONAL_PURPOSE,
  RING_B_ICON,
  cleanSupply,
  getPersonalLink,
  personalKey,
  personalTicker,
  rememberPersonal,
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
export const PERSONAL_FEE_ESTIMATE_SATS = 80;

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
    icon: input.icon || RING_B_ICON,
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
