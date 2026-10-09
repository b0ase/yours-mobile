import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { WalletInterface } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isFriend as isCallFriend } from '../calls/friends';
import { loadMyProfile, saveMyProfile } from '../calls/bphone';
import { usdToSats, useBsvUsd } from '../money/money';
import { acknowledge, fetchMail, myKey, openMail, sendMail, type SendArgs } from './client';
import { split } from './route';
import { cachedExchangeRate } from '../../utils/wallet';
import {
  addReceived,
  loadMail,
  loadPending,
  saveMail,
  subscribeMail,
  updateMail,
  type MailState,
  type Received,
} from './store';
import { friendlyMailError } from './friendlyError';

let version = 0;
subscribeMail(() => {
  version++;
});

const f = (u: string, i?: RequestInit) => fetch(u, i);

/** The active identity's bMail: boxes, actions, price to reach me. */
export const useBMail = () => {
  const { apiContext } = useServiceContext();
  const wallet = apiContext.wallet as unknown as WalletInterface;
  const [me, setMe] = useState('');
  useEffect(() => {
    let live = true;
    myKey(wallet)
      .then((k) => live && setMe(k))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet]);
  const v = useSyncExternalStore(subscribeMail, () => version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo<MailState>(() => loadMail(me), [me, v]);
  const rate = useBsvUsd();
  const priceSats = usdToSats(state.priceUsd, rate) ?? 0;
  const [newest, setNewest] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const isFriend = useCallback((k: string) => isCallFriend(k) || state.contacts.includes(k), [state.contacts]);
  const boxes = useMemo(
    () => split(state.received, { isFriend, priceSats, newest }),
    [state.received, isFriend, priceSats, newest],
  );

  const refresh = useCallback(async () => {
    if (!me) return;
    setLoading(true);
    setError('');
    try {
      const s = loadMail(me);
      const { items, ack } = await fetchMail(wallet, {
        me,
        sent: s.sent,
        known: new Set(s.received.map((r) => r.id)),
      });
      updateMail(me, (x) => addReceived(x, items));
      await acknowledge(wallet, ack).catch(() => undefined);
    } catch (e) {
      setError(friendlyMailError(e, { whole: true }));
    } finally {
      setLoading(false);
    }
  }, [me, wallet]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pull my published price once (so it follows me across devices).
  useEffect(() => {
    if (!me) return;
    loadMyProfile(f, me)
      .then((p) => {
        if (p.mail && p.mail.usd !== loadMail(me).priceUsd) updateMail(me, (x) => ({ ...x, priceUsd: p.mail!.usd }));
      })
      .catch(() => undefined);
  }, [me]);

  const open = useCallback(
    async (r: Received) => {
      const sealed = r.opened ?? (await openMail(wallet, r.env));
      updateMail(me, (s) => ({
        ...s,
        received: s.received.map((x) => (x.id === r.id ? { ...x, opened: sealed, read: true } : x)),
      }));
      return sealed;
    },
    [me, wallet],
  );

  const send = useCallback(
    async (a: SendArgs) => {
      const sent = await sendMail(wallet, a);
      updateMail(me, (s) => ({
        ...s,
        sent: [sent, ...s.sent],
        contacts: s.contacts.includes(a.to) ? s.contacts : [...s.contacts, a.to],
        usedCredits: a.usesReplyCredit && a.inReplyTo ? [...s.usedCredits, a.inReplyTo] : s.usedCredits,
      }));
      return sent;
    },
    [me, wallet],
  );

  const setPrice = useCallback(
    async (usd: number) => {
      saveMail(me, { ...loadMail(me), priceUsd: usd });
      const p = await loadMyProfile(f, me);
      await saveMyProfile(f, wallet, { ...p, mail: { usd } });
    },
    [me, wallet],
  );

  const unread = boxes.inbox.filter((r) => !r.read).length;
  return {
    me,
    state,
    boxes,
    priceSats,
    rate,
    newest,
    setNewest,
    loading,
    error,
    refresh,
    open,
    send,
    setPrice,
    unread,
  };
};

/**
 * Top-bar badge: unread Inbox mail already fetched plus Inbox-routed mail the notifier saw on the relay (pending).
 * Reads local state only: never fetches or acknowledges, so it cannot steal mail from the notifier or the screen.
 */
export const useBMailUnread = (): number => {
  const { apiContext } = useServiceContext();
  const wallet = apiContext?.wallet as unknown as WalletInterface | undefined;
  const [me, setMe] = useState('');
  useEffect(() => {
    let live = true;
    if (wallet)
      myKey(wallet)
        .then((k) => live && setMe(k))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet]);
  const v = useSyncExternalStore(subscribeMail, () => version);
  return useMemo(() => {
    if (!me) return 0;
    const s = loadMail(me);
    const priceSats = usdToSats(s.priceUsd, cachedExchangeRate()) ?? 0;
    const isFriend = (k: string) => isCallFriend(k) || s.contacts.includes(k);
    const have = new Set(s.received.map((r) => r.id));
    const unread = split(s.received, { isFriend, priceSats }).inbox.filter((r) => !r.read).length;
    return unread + loadPending(me).filter((id) => !have.has(id)).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, v]);
};
