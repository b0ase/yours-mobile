import type { OneSatContext } from '@1sat/actions';
import { isNative } from '../../native';
import { BchatClient, defaultHttp, loadSession } from '../../chat/api';
import { chatClient, deployBsv21, openRoom } from '../../tickets/mintTicket';
import { mintFeeAddress, withFeeOutput } from '../../mint/mint';
import { fundIndexing } from '../../tokens/indexFund';
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
import type { VerifiedVesting, VestPlan } from './vesting';
import { lockVesting } from './vestingNet';

/**
 * Launch network steps, run only after Allow on the one approval sheet. The icon is inscribed by the
 * caller. Deploy (fixed supply to self, flat launch fee output, optional MAP coin card) → holders'
 * room (same as Wallet › Mint a token) → registry → optional indexing fund. Only the deploy must
 * succeed; the rest is best effort and reported back.
 */
export async function deployLaunch(
  ctx: OneSatContext,
  form: TokenForm,
  opts: LaunchOptions,
  extra: { icon: string | null; launchFeeSats: number; vest?: VestPlan },
): Promise<{
  launch: Launch;
  supply: string;
  roomError: boolean;
  indexError: string | null;
  vesting: VerifiedVesting | null;
  vestError: string | null;
}> {
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

  // Creator vesting: straight after the deploy, before anything else touches the new coin. If it fails the
  // creator is told plainly and can lock from the done screen (retryVesting); nothing else is signed for it.
  let vesting: VerifiedVesting | null = null;
  let vestError: string | null = null;
  if (extra.vest && extra.vest.keepBps > 0) {
    try {
      vesting = await lockVesting(ctx, vestStartFor(tokenId, c, extra.icon), extra.vest);
    } catch (e) {
      vestError = e instanceof Error ? e.message : String(e);
    }
  }

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

  let indexError: string | null = null;
  if (o.indexNow)
    indexError = await fundIndexing(ctx, tokenId, c.ticker, { timeoutMs: 60_000 })
      .then(() => null)
      .catch((e) => (e instanceof Error ? e.message : String(e)));
  return { launch: done, supply: c.supply, roomError: !roomTicker, indexError, vesting, vestError };
}

const vestStartFor = (tokenId: string, c: ReturnType<typeof cleanToken>, icon: string | null) => ({
  tokenId,
  sym: c.ticker,
  supply: BigInt(c.amount),
  decimals: c.decimals,
  icon,
});

/** Done screen › "Lock it now": the same vesting transaction, for a launch whose lock did not go through. */
export const retryVesting = (
  ctx: OneSatContext,
  form: TokenForm,
  opts: LaunchOptions,
  tokenId: string,
  icon: string | null,
  plan: VestPlan,
) => lockVesting(ctx, vestStartFor(tokenId, cleanToken(withOptions(form, opts)), icon), plan);

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
