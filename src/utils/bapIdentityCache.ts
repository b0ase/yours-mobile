/**
 * The account's BAP identity (BAP ID, published or not, profile) loaded once per session per identity.
 *
 * Several mounted screens asked for it on their own (wallet home, notifications, feed, settings, the name sync every
 * 150 s), and each ask is a getPublicKey plus three listOutputs on the "bap" basket, one of them limit 10000 (owner's
 * iPhone, 1 Nov 2026). Now they share one load. `force` reloads (after a profile save, or a forced name sync).
 * A lock clears it (sessionCaches.ts).
 */
import { computeBapId, getProfile, resolveBapId, type OneSatContext, type ProfileResponse } from '@1sat/actions';
import { PublicKey } from '@bsv/sdk';
import { onSessionReset } from './sessionCaches';

export type BapIdentity = {
  /** Deterministic BAP ID (always derivable). */
  bapId: string;
  /** A `type:id` record exists in the bap basket. */
  isPublished: boolean;
  /** getProfile's answer when published, else null. */
  profile: ProfileResponse | null;
};

type Loader = {
  computeBapId: (ctx: OneSatContext) => Promise<string>;
  resolveBapId: (ctx: OneSatContext) => Promise<string | null>;
  getProfile: (ctx: OneSatContext) => Promise<ProfileResponse>;
  /** The identity address `ctx` signs as, or null. */
  ctxIdentity: (ctx: OneSatContext) => Promise<string | null>;
};

const defaultLoader: Loader = {
  computeBapId,
  resolveBapId,
  getProfile: (ctx) => getProfile.execute(ctx, {}),
  ctxIdentity: async (ctx) => {
    try {
      const { publicKey } = await ctx.wallet.getPublicKey({ identityKey: true });
      return PublicKey.fromString(publicKey).toAddress();
    } catch {
      return null;
    }
  },
};

const loads = new Map<string, Promise<BapIdentity>>();

/** Drop every cached identity (lock). */
export const clearBapIdentityCache = () => loads.clear();
onSessionReset(clearBapIdentityCache);

/** "No profile yet" and "malformed" are real answers; anything else (network, wallet busy) is not kept. */
const settled = (p: ProfileResponse | null) =>
  !p?.error || p.error.startsWith('no-profile') || p.error.startsWith('malformed');

const loadUncached = async (ctx: OneSatContext, l: Loader): Promise<BapIdentity> => {
  const [bapId, resolvedId] = await Promise.all([l.computeBapId(ctx), l.resolveBapId(ctx)]);
  const isPublished = resolvedId !== null;
  const profile = isPublished ? await l.getProfile(ctx) : null;
  return { bapId, isPublished, profile };
};

/**
 * The BAP identity for `identityAddress`, shared by every caller this session. Loaded uncached (and not stored)
 * when `ctx` is not that account's wallet (right after a switch the background can still be the previous account).
 */
export const loadBapIdentity = async (
  ctx: OneSatContext,
  identityAddress: string | undefined,
  opts: { force?: boolean } = {},
  loader: Loader = defaultLoader,
): Promise<BapIdentity> => {
  if (!identityAddress) return loadUncached(ctx, loader);
  if (!opts.force) {
    const hit = loads.get(identityAddress);
    if (hit) return hit;
  }
  let keep = true;
  const p = (async () => {
    if ((await loader.ctxIdentity(ctx)) !== identityAddress) keep = false;
    const r = await loadUncached(ctx, loader);
    if (!settled(r.profile)) keep = false;
    return r;
  })();
  // Set before the first await, so callers arriving meanwhile share this load.
  loads.set(identityAddress, p);
  const drop = () => {
    if (loads.get(identityAddress) === p) loads.delete(identityAddress);
  };
  p.then(() => !keep && drop(), drop);
  return p;
};
