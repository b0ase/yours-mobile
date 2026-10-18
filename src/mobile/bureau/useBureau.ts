import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WalletInterface } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBMail } from '../bmail/useBMail';
import { openMail } from '../bmail/client';
import { isLive, updateMail } from '../bmail/store';
import { quote, PENNY_POST_USD } from '../bmail/route';
import { fetchPeerBPhone } from '../calls/bphone';
import { usdToSats } from '../money/money';
import { mergeParts, parsePart, verifySig, type AgreementPart } from './agreement';
import type { AgreementItem } from './folders';

const f = (u: string, i?: RequestInit) => fetch(u, i);
/** How many unopened letters the Bureau decrypts to find agreements (newest first). */
const SCAN_MAX = 200;

const archKey = (me: string) => `bwallet.bureau.archived.${me}`;
const readArchived = (me: string): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(archKey(me)) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const scanKey = (me: string) => `bwallet.bureau.scan.${me}`;
const readScan = (me: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(localStorage.getItem(scanKey(me)) || '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
const writeScan = (me: string, v: Record<string, unknown>) => {
  try {
    localStorage.setItem(scanKey(me), JSON.stringify(v));
  } catch {
    /* storage full or unavailable: scanned again next time */
  }
};

/**
 * The Bureau's data: agreements found in bMail (sent + received, quarantined mail never opened), merged per
 * agreement, signatures verified. Sending an agreement or an update is a normal bMail send with postage.
 */
export const useBureau = () => {
  const { apiContext } = useServiceContext();
  const wallet = apiContext.wallet as unknown as WalletInterface;
  const mail = useBMail();
  const { me, state, rate } = mail;

  // Look inside letters not opened yet for an agreement, without opening them in bMail (no read mark, no
  // preview): the result is kept in the Bureau's own cache, per letter id (null = not an agreement).
  const [scan, setScan] = useState<Record<string, unknown>>({});
  useEffect(() => setScan(me ? readScan(me) : {}), [me]);
  useEffect(() => {
    if (!me) return;
    const blocked = state.blocked ?? [];
    const known = readScan(me);
    const todo = state.received
      .filter((r) => !r.opened && !r.erased && isLive(r, blocked) && !(r.id in known))
      .sort((a, b) => b.at - a.at)
      .slice(0, SCAN_MAX);
    if (!todo.length) return;
    let live = true;
    void (async () => {
      for (const r of todo) {
        if (!live) return;
        const sealed = await openMail(wallet, r.env).catch(() => null);
        if (!sealed) continue;
        const next = { ...readScan(me), [r.id]: sealed.agreement ?? null };
        writeScan(me, next);
        if (live) setScan(next);
      }
    })();
    return () => {
      live = false;
    };
  }, [me, wallet, state.received, state.blocked]);

  const parts = useMemo(() => {
    const raw = [
      ...state.received.filter((r) => !r.deleted && !r.spam).map((r) => r.opened?.agreement ?? scan[r.id]),
      ...state.sent.map((s) => s.agreement),
    ];
    return mergeParts(raw.map(parsePart).filter((p): p is AgreementPart => !!p));
  }, [state.received, state.sent, scan]);

  const [archived, setArchivedIds] = useState<string[]>([]);
  useEffect(() => setArchivedIds(me ? readArchived(me) : []), [me]);
  const setArchived = useCallback(
    (id: string, on: boolean) => {
      const next = on ? [...new Set([...readArchived(me), id])] : readArchived(me).filter((x) => x !== id);
      try {
        localStorage.setItem(archKey(me), JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      setArchivedIds(next);
    },
    [me],
  );

  const [items, setItems] = useState<AgreementItem[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(
      parts.map(async (part) => {
        const ok = await Promise.all(part.sigs.map((s) => verifySig(part.doc, s)));
        return { part, signed: part.sigs.filter((_, i) => ok[i]).map((s) => s.key), archived: false };
      }),
    ).then((list) => live && setItems(list));
    return () => {
      live = false;
    };
  }, [parts]);
  const withArchive = useMemo(
    () => items.map((it) => ({ ...it, archived: archived.includes(it.part.doc.id) })),
    [items, archived],
  );

  /** Postage to each party (their bMail price, Penny post when unknown), in sats. */
  const postageFor = useCallback(
    async (key: string) => {
      const card = await fetchPeerBPhone(f, key).catch(() => null);
      const usd = card?.profile.mail?.usd ?? PENNY_POST_USD;
      return quote(usdToSats(usd, rate) ?? 0, 'standard').total;
    },
    [rate],
  );

  /** Send this agreement part to every other party by bMail (one letter each, normal postage). */
  const deliver = useCallback(
    async (part: AgreementPart, subject: string, body: string, labels: Record<string, string> = {}) => {
      for (const to of part.doc.parties.filter((p) => p !== me)) {
        await mail.send({
          to,
          toLabel: labels[to] ?? to.slice(0, 10),
          sealed: { subject, body, agreement: part },
          sats: await postageFor(to),
          replyPaidSats: 0,
        });
      }
      // A copy for me even with no other party (a note to self is still a record I keep).
      if (part.doc.parties.every((p) => p === me)) {
        updateMail(me, (s) => ({
          ...s,
          sent: [
            {
              id: part.doc.id + Date.now().toString(16),
              to: me,
              toLabel: 'me',
              at: Date.now(),
              subject,
              body,
              sats: 0,
              replyPaidSats: 0,
              agreement: part,
            },
            ...s.sent,
          ],
        }));
      }
    },
    [me, mail, postageFor],
  );

  return {
    me,
    wallet,
    items: withArchive,
    setArchived,
    deliver,
    postageFor,
    rate,
    refresh: mail.refresh,
    loading: mail.loading,
    error: mail.error,
  };
};
