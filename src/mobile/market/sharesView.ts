// Market › Shares, decided from the server only (bit-sign GET /api/bitsign/bshares/me). Pure: no network.
// No offer details are bundled with the app; a viewer who is not on the register (or a director) sees none.
import { mayOpenBshares, type BsharesMe, type PlacementOffer } from '../placement/placement';
import { normHandle } from '../placement/partnership/partnership';

export type SharesView = { kind: 'members-only' } | { kind: 'member'; company: string; offers: PlacementOffer[] };

/**
 * `me` is null when /me answered 401/403 or failed: members only, nothing else.
 * A member (or director) sees only the bCorp tranches made out to their own handle; directors' view of every
 * tranche stays in the bShares app.
 */
export const sharesView = (me: BsharesMe | null, viewerHandle: string | null | undefined): SharesView => {
  if (!me || !mayOpenBshares(me)) return { kind: 'members-only' };
  const viewer = normHandle(viewerHandle ?? me.viewer ?? '');
  const offers = viewer ? me.offers.filter((o) => normHandle(o.investorHandle) === viewer) : [];
  return { kind: 'member', company: me.company.name, offers };
};
