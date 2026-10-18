import type { OneSatContext } from '@1sat/actions';
import { isNative } from '../../native';
import { BchatClient, defaultHttp, loadSession } from '../../chat/api';
import { chatClient, deployBsv21, openRoom } from '../../tickets/mintTicket';
import { mintFeeAddress, withFeeOutput } from '../../mint/mint';
import { fundIndexing, getFundRecord } from '../../tokens/indexFund';
import { cleanToken, tokenFoundingMessage, type TokenForm } from '../../tokens/token';
import {
  cleanOptions,
  hasMapExtras,
  launchMapScript,
  launchRegistration,
  parseLaunchList,
  roomMinRaw,
  saveLocalLaunch,
  withOptions,
  type Launch,
  type LaunchOptions,
} from './launch';

/**
 * Launch network steps, run only after Allow on the one approval sheet. The icon is inscribed by the
 * caller. Deploy (fixed supply to self, flat launch fee output, MAP coin card) → indexing deposit to
 * the token's fee address (its own tx: the address is derived from the deploy txid, so it can't ride in
 * the deploy) → holders' room (same as Wallet › Mint a token) → registry. Only the deploy must succeed;
 * a failed deposit is reported back with a retry ("Pay indexing deposit"), the rest is best effort.
 */
export async function deployLaunch(
  ctx: OneSatContext,
  form: TokenForm,
  opts: LaunchOptions,
  extra: { icon: string | null; launchFeeSats: number; depositSats: number },
): Promise<{ launch: Launch; supply: string; roomError: boolean; indexError: string | null }> {
  const f = withOptions(form, opts);
  const c = cleanToken(f);
  const o = cleanOptions(opts);
  const tokenId = await deployBsv21(withFeeOutput(ctx, extra.launchFeeSats, mintFeeAddress()), {
    symbol: c.ticker,
    amount: c.amount,
    decimals: c.decimals,
    icon: extra.icon,
    feeSats: 0,
    ...(hasMapExtras(o) ? { map: { script: launchMapScript(f, o), description: 'bWallet coin card (MAP)' } } : {}),
  });
  const launch: Launch = {
    tokenId,
    ticker: c.ticker,
    name: c.name,
    icon: extra.icon,
    category: o.category || null,
    roomTicker: null,
    createdAt: Date.now(),
  };
  saveLocalLaunch(launch);

  // The deposit the user approved, before the room: the room needs the indexer to know the token.
  const indexError = await payLaunchDeposit(ctx, tokenId, c.ticker, extra.depositSats)
    .then(() => null)
    .catch((e) => (e instanceof Error ? e.message : String(e)));

  // A just-deployed token may not be indexed yet; the room can also be opened later from Chat.
  const client = await chatClient(ctx).catch(() => null);
  const roomTicker = client
    ? await openRoom(
        ctx,
        tokenId,
        { name: c.name, min: roomMinRaw(o), founding: tokenFoundingMessage(c) },
        client,
      ).catch(() => null)
    : null;
  const done = { ...launch, roomTicker };
  saveLocalLaunch(done);
  await registerLaunch(done, client);
  return { launch: done, supply: c.supply, roomError: !roomTicker, indexError };
}

/**
 * Pay a launched coin's indexing deposit: exactly the approved sats, to the fee address its id derives
 * (cross-checked against the indexer's answer when it has one). Waits up to 20 s for the indexer to
 * learn the token, then pays the derived address anyway: the overlay credits it on its next check.
 * Already paid from this device (a retry after an unclear broadcast): nothing is sent again.
 */
export async function payLaunchDeposit(
  ctx: OneSatContext,
  tokenId: string,
  ticker: string,
  sats: number,
): Promise<{ txid: string; sats: number }> {
  const prior = getFundRecord(tokenId);
  if (prior) return { txid: prior.txid, sats: prior.sats };
  const r = await fundIndexing(ctx, tokenId, ticker, { sats, allowDerived: true, timeoutMs: 20_000 });
  return { txid: r.txid, sats: r.sats };
}

/**
 * Launch registry calls (bit-sign /api/bitsign/launches), kept out of chat/api.ts so the paths live only
 * in the Exchange chunk (store builds have none of it).
 */
class LaunchClient extends BchatClient {
  launches(): Promise<unknown> {
    return this.call('GET', '/api/bitsign/launches', undefined, false);
  }
  async registerLaunch(body: Record<string, unknown>): Promise<void> {
    await this.call('POST', '/api/bitsign/launches', body);
  }
}

/** Registry POST; a missing endpoint (not deployed yet) is not an error for the wallet. */
export async function registerLaunch(l: Launch, client: BchatClient | null): Promise<boolean> {
  if (!client) return false;
  return new LaunchClient(defaultHttp(isNative), loadSession())
    .registerLaunch(launchRegistration(l))
    .then(() => true)
    .catch(() => false);
}

/** The public registry list (empty when the endpoint is not deployed or unreachable). */
export async function registryLaunches(): Promise<Launch[]> {
  return new LaunchClient(defaultHttp(isNative), loadSession())
    .launches()
    .then(parseLaunchList)
    .catch(() => []);
}
