import { useEffect, useState } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { getPersonalLink } from '../names/personalToken';
import {
  OWN_TOKENS_EVENT,
  getFundRecord,
  listOwnTokens,
  needsIndexFunding,
  overlayStatus,
  withOwnToken,
  type OwnToken,
} from './indexFund';

/**
 * Own tokens (minted on this device, plus the account's personal $NAME token) whose indexing fee is
 * still unpaid and that the indexer already knows (so paying is possible). Shared by the Wallet tab
 * badge, the Wallet cards and the once-per-session reminder.
 */
const EVENT = 'bwallet-pending-indexing';
let pending: OwnToken[] = [];
let checking: Promise<void> | null = null;
let checkedFor: string | null = null;

const ownTokens = (identityAddress?: string): OwnToken[] => {
  let list = listOwnTokens();
  const link = getPersonalLink(identityAddress);
  if (link) list = withOwnToken(list, { tokenId: link.tokenId, ticker: link.ticker });
  return list;
};

const publish = (next: OwnToken[]) => {
  pending = next;
  window.dispatchEvent(new Event(EVENT));
};

export const recheckPendingIndexing = (ctx: OneSatContext, identityAddress?: string): Promise<void> => {
  if (checking) return checking;
  checkedFor = identityAddress ?? '';
  checking = (async () => {
    const out: OwnToken[] = [];
    for (const t of ownTokens(identityAddress)) {
      if (getFundRecord(t.tokenId)) continue;
      const s = await overlayStatus(ctx, t.tokenId).catch(() => null);
      if (s && needsIndexFunding(s)) out.push(t);
    }
    publish(out);
  })().finally(() => {
    checking = null;
  });
  return checking;
};

/** Drop a token right after its fee is paid (no wait for the indexer). */
export const markIndexingPaid = (tokenId: string) => publish(pending.filter((t) => t.tokenId !== tokenId));

export const usePendingIndexing = (ctx: OneSatContext | undefined, identityAddress?: string): OwnToken[] => {
  const [list, setList] = useState(pending);
  useEffect(() => {
    const on = () => setList(pending);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  useEffect(() => {
    if (!ctx) return;
    if (checkedFor !== (identityAddress ?? '')) void recheckPendingIndexing(ctx, identityAddress);
    const again = () => void recheckPendingIndexing(ctx, identityAddress);
    window.addEventListener(OWN_TOKENS_EVENT, again);
    return () => window.removeEventListener(OWN_TOKENS_EVENT, again);
  }, [ctx, identityAddress]);
  return list;
};

let remindedThisSession = false;
/** Once per app session: true the first time it's asked while something is pending. */
export const takeSessionReminder = (count: number): boolean => {
  if (remindedThisSession || count < 1) return false;
  remindedThisSession = true;
  return true;
};

/** Local notification only if permission was already granted (never prompts for this). */
export const notifyIfPermitted = async (title: string, body: string) => {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') return;
    await LocalNotifications.schedule({
      notifications: [{ id: 41_000 + Math.floor(Math.random() * 1000), title, body }],
    });
  } catch {
    /* notifications unavailable */
  }
};
