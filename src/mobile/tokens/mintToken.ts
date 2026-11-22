import type { OneSatContext } from '@1sat/actions';
import type { LockingScript } from '@bsv/sdk';
import { deployBsv21, openRoom } from '../tickets/mintTicket';
import type { Curve } from '../../lib/curves';
import { cleanToken, tokenFoundingMessage, type TokenForm } from './token';
import { CURVE_COINS_ENABLED, TOKEN_ROOMS_ENABLED } from '../storeBuild';

/**
 * Mint a token network steps (after SendConfirmation): the icon is inscribed by the caller
 * (inscribeIcon), then the shared BSV-21 deploy (no ticket MAP tag) and the shared room open.
 */

export interface MintedToken {
  tokenId: string;
  ticker: string;
  name: string;
  supply: string;
  decimals: number;
  description: string;
  min: string;
}

export async function deployToken(
  ctx: OneSatContext,
  form: TokenForm,
  opts: {
    icon: string | null;
    feeSats: number;
    map?: { script: LockingScript; description: string };
    curve?: Curve | null;
  },
): Promise<MintedToken> {
  const c = cleanToken(form);
  const tokenId = await deployBsv21(ctx, {
    symbol: c.ticker,
    amount: c.amount,
    decimals: c.decimals,
    icon: opts.icon,
    feeSats: opts.feeSats,
    ...(opts.map ? { map: opts.map } : {}),
    curve: opts.curve ?? null,
  });
  return {
    tokenId,
    ticker: c.ticker,
    name: c.name,
    supply: c.supply,
    decimals: c.decimals,
    description: c.description,
    min: c.min,
  };
}

/** Open the token's holders' room (gate: hold 1 whole token). Returns the room ticker. */
export const openTokenRoom = (ctx: OneSatContext, t: MintedToken) =>
  openRoom(ctx, t.tokenId, { name: t.name, min: t.min, founding: tokenFoundingMessage(t) });

/**
 * The two store decisions of Mint a token, as functions so they are tested with the flag either way (TokenMint.tsx
 * calls them with the defaults).
 *
 * The curve a new token is deployed with: the chosen one in bWalletX, none in a store build (CURVE_COINS_ENABLED).
 */
export const curveForDeploy = (curve: Curve, curvesOn: boolean = CURVE_COINS_ENABLED): Curve | null =>
  curvesOn ? curve : null;

/**
 * Open the new token's room after a mint. A store build has no token rooms (TOKEN_ROOMS_ENABLED): nothing is
 * opened or asked of the server there, and the answer is null. A failed open is also null (the room can be set up
 * later), as before.
 */
export const openRoomAfterMint = async (
  ctx: OneSatContext,
  t: MintedToken,
  roomsOn: boolean = TOKEN_ROOMS_ENABLED,
  open: (ctx: OneSatContext, t: MintedToken) => Promise<string> = openTokenRoom,
): Promise<string | null> => (roomsOn ? open(ctx, t).catch(() => null) : null);
