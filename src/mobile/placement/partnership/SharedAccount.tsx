/**
 * Partnership › Shared account: the partners' joint BSV, spent only with the agreement's number of approvals.
 * Pay in (one sheet), propose a payment (the proposer approves it at once), approve or decline requests, and send
 * once enough partners have approved. Requests travel through bit-sign's mailbox (/partnership/<ticker>/account,
 * accountMailbox.ts), which pushes the other partners; signing is always done here first, so a mailbox error never
 * blocks it. When the mailbox can't be reached a request can still go as a line of text partners paste to each
 * other ("Share by message instead"). Every copy, from the mailbox or pasted, is checked against this partnership's
 * keys before it is shown, and only verified signatures are kept.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { ChatApiError } from '../../chat/api';
import type { BsharesApi } from '../api';
import { moneyWithSats, parseUsdInput, usdToSats, useBsvUsd } from '../../money/money';
import { ApprovalCard, type ApprovalStatus } from './ApprovalCard';
import {
  approveSharedPayment,
  payIntoSharedAccount,
  proposeSharedPayment,
  sendSharedPayment,
  sharedAccountBalance,
} from './accountActions';
import { inputsFor, isReady, signedBy } from './multisig';
import { combineRequests, fromMailbox, isMailboxUnavailable, mySigs, type MailboxRequest } from './accountMailbox';
import { PARTNER_REQUEST_EVENT, takePartnerRequest } from './openRequest';
import type { Keyset } from './partnerLock';
import {
  absorbRequest,
  checkAccountProposal,
  exportAccountRequest,
  importAccountRequest,
  type AccountProposal,
} from './accountRules';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const btn = 'self-start rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer disabled:opacity-50';
const input = 'rounded-lg bg-[#101216] text-white text-sm px-2 py-1 border border-[#2b2f36]';
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
const newId = () => hex(Array.from(crypto.getRandomValues(new Uint8Array(12))));

// Requests kept on this device: pasted ones, ones the mailbox couldn't take, payments sent, requests hidden here.
type Stored = { requests: AccountProposal[]; sent: Record<string, string>; hidden: string[] };
const storeKey = (id: string) => `bwx.sharedAccount.${id}`;
function load(id: string): Stored {
  const none: Stored = { requests: [], sent: {}, hidden: [] };
  try {
    const s = JSON.parse(localStorage.getItem(storeKey(id)) ?? 'null') as Partial<Stored> | null;
    return s && Array.isArray(s.requests)
      ? { requests: s.requests, sent: s.sent ?? {}, hidden: Array.isArray(s.hidden) ? s.hidden : [] }
      : none;
  } catch {
    return none;
  }
}
function save(id: string, s: Stored) {
  try {
    localStorage.setItem(storeKey(id), JSON.stringify(s));
  } catch {
    /* private mode: requests live for this visit only */
  }
}
const POLL_MS = 30_000;
const httpStatus = (e: unknown) => (e instanceof ChatApiError ? e.status : undefined);
const SAME_MOMENT = /same moment/i;
const NOTHING_NEW = /no new signatures/i;

export function SharedAccount(props: {
  api: BsharesApi;
  ticker: string;
  partnershipId: string;
  keyset: Keyset;
  keys: { handle: string; partnerKey: string }[];
  myKey: string;
}) {
  const { api, ticker, partnershipId, keyset, keys, myKey } = props;
  const { apiContext: ctx } = useServiceContext();
  const rate = useBsvUsd();
  const [balance, setBalance] = useState<number | null>(null);
  const [stored, setStored] = useState<Stored>(() => load(partnershipId));
  const [payIn, setPayIn] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Mailbox requests (null until the first answer); offline = the mailbox couldn't be reached last time.
  const [remote, setRemote] = useState<MailboxRequest[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const storedRef = useRef(stored);
  storedRef.current = stored;

  const who = (k: string) => {
    const h = keys.find((x) => x.partnerKey === k)?.handle;
    return h ? `$${h}` : `${k.slice(0, 8)}…`;
  };
  const refresh = useCallback(
    () =>
      sharedAccountBalance(keyset)
        .then(setBalance)
        .catch(() => setBalance(null)),
    [keyset],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const update = (s: Stored) => {
    storedRef.current = s;
    setStored(s);
    save(partnershipId, s);
  };

  const reloadMailbox = useCallback(async () => {
    try {
      setRemote(fromMailbox(await api.partnerAccount(ticker), keyset, partnershipId));
      setOffline(false);
    } catch (e) {
      // Keep what was last shown; local and pasted requests still work.
      if (isMailboxUnavailable(httpStatus(e))) setOffline(true);
    }
  }, [api, ticker, keyset, partnershipId]);
  useEffect(() => {
    void reloadMailbox();
    const t = setInterval(() => document.visibilityState !== 'hidden' && void reloadMailbox(), POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void reloadMailbox();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reloadMailbox]);

  // A tapped push for this partnership: reload and scroll to the request.
  useEffect(() => {
    const take = () => {
      const id = takePartnerRequest(ticker);
      if (id === undefined) return;
      setFocus(id);
      void reloadMailbox();
    };
    take();
    window.addEventListener(PARTNER_REQUEST_EVENT, take);
    return () => window.removeEventListener(PARTNER_REQUEST_EVENT, take);
  }, [ticker, reloadMailbox]);
  // Scroll once, when the request has arrived (the next poll may be what brings it).
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || scrolled.current === focus) return;
    const el = document.getElementById(`sa-req-${focus}`);
    if (!el) return;
    scrolled.current = focus;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus, remote]);

  /** Keep a request on this device too (pasted, or the mailbox couldn't take it). */
  const keepLocal = (p: AccountProposal) => {
    const s = storedRef.current;
    const has = s.requests.some((r) => r.proposalId === p.proposalId);
    update({
      ...s,
      requests: has ? s.requests.map((r) => (r.proposalId === p.proposalId ? p : r)) : [...s.requests, p],
    });
  };
  /** Off this device's list: declined, withdrawn, cleared after sending. */
  const hide = (proposalId: string) => {
    const s = storedRef.current;
    update({
      requests: s.requests.filter((r) => r.proposalId !== proposalId),
      sent: s.sent,
      hidden: [...s.hidden.filter((h) => h !== proposalId), proposalId].slice(-200),
    });
  };
  const offlineMsg = (what: string) =>
    `${what} on this device, but the partners' mailbox couldn't be reached. Tap "Share by message instead" to send it to your partners.`;

  /** Post this partner's signatures; one retry when someone signed at the same moment. Null = the mailbox has them. */
  const postSigs = async (mailboxId: string, p: AccountProposal): Promise<string | null> => {
    const sigs = mySigs(p, myKey);
    if (!Object.keys(sigs).length) return null;
    for (let attempt = 0; ; attempt++) {
      try {
        await api.partnerAccountAction(ticker, { action: 'sign', id: mailboxId, sigs });
        return null;
      } catch (e) {
        const m = e instanceof Error ? e.message : '';
        if (httpStatus(e) === 400 && NOTHING_NEW.test(m)) return null;
        if (httpStatus(e) === 409 && SAME_MOMENT.test(m) && attempt === 0) {
          await reloadMailbox();
          continue;
        }
        return m || 'The mailbox did not take the approval';
      }
    }
  };
  const run = (f: () => Promise<string | void>) => async () => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg((await f()) || null);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };
  const satsFrom = (s: string) => {
    const usd = parseUsdInput(s);
    if (usd === null) throw new Error('Enter a dollar amount, like 25 or 25.50');
    const sats = usdToSats(usd, rate);
    if (sats === null) throw new Error('Waiting for the BSV price. Try again in a moment.');
    return sats;
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return 'Request copied. Send it to your partners in any chat; they paste it here.';
    } catch {
      setPaste(text);
      setShowPaste(true);
      return 'Copy the request from the box below and send it to your partners.';
    }
  };

  const doPayIn = run(async () => {
    const sats = satsFrom(payIn);
    await payIntoSharedAccount(ctx, keyset, sats);
    setPayIn('');
    setTimeout(() => void refresh(), 3000);
    return `Paid ${moneyWithSats(sats, rate)} into the shared account.`;
  });

  const doPropose = run(async () => {
    const sats = satsFrom(amount);
    const p = await proposeSharedPayment(ctx, { partnershipId, keyset, to, sats, proposalId: newId() });
    setTo('');
    setAmount('');
    try {
      await api.partnerAccountAction(ticker, { action: 'propose', proposal: p });
      await reloadMailbox();
      return 'Proposed and approved by you. Your partners have been notified.';
    } catch (e) {
      keepLocal(p);
      if (isMailboxUnavailable(httpStatus(e))) {
        setOffline(true);
        return offlineMsg('Proposed and approved');
      }
      return `Proposed and approved on this device, but the mailbox refused it: ${e instanceof Error ? e.message : 'error'}. You can share it by message instead.`;
    }
  });

  const doPaste = run(async () => {
    const incoming = importAccountRequest(paste, keyset, partnershipId);
    update({ ...stored, requests: absorbRequest(stored.requests, incoming, paste) });
    setShowPaste(false);
    setPaste('');
    return 'Request added.';
  });

  return (
    <div className="flex flex-col gap-2 border-t border-[#2b2f36] pt-2" aria-label="Shared account">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-white font-bold">
          <Users size={14} color={GOLD} aria-hidden="true" /> Shared account
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          className="bg-transparent border-0 text-xs cursor-pointer"
          style={{ color: MUTED }}
        >
          {balance === null ? 'Check balance' : moneyWithSats(balance, rate)}
        </button>
      </div>
      <p className="m-0 text-xs" style={{ color: MUTED }}>
        Held together. Payments need {keyset.m} of {keyset.pubKeys.length} partners to approve in their wallets.
      </p>

      <div className="flex flex-wrap gap-2 items-center">
        <input
          id={`sa-payin-${partnershipId}`}
          value={payIn}
          onChange={(e) => setPayIn(e.target.value)}
          inputMode="decimal"
          placeholder="$ amount"
          aria-label="Amount to pay in, in dollars"
          className={`${input} w-28`}
        />
        <button
          type="button"
          disabled={busy || !payIn}
          onClick={doPayIn}
          className={btn}
          style={{ background: '#2b2f36', color: '#fff' }}
        >
          Pay into the shared account
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input
          id={`sa-to-${partnershipId}`}
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Pay $handle, paymail or address"
          aria-label="Who to pay"
          className={`${input} flex-1 min-w-[10rem]`}
        />
        <input
          id={`sa-amt-${partnershipId}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="$ amount"
          aria-label="Amount to pay, in dollars"
          className={`${input} w-28`}
        />
        <button
          type="button"
          disabled={busy || !to || !amount}
          onClick={doPropose}
          className={btn}
          style={{ background: GOLD, color: '#1a1300' }}
        >
          Propose a payment
        </button>
      </div>

      {offline && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          The partners' mailbox can't be reached right now. You can still approve here and share requests by message.
        </p>
      )}
      {combineRequests(stored.requests, remote ?? [])
        .filter((r) => !stored.hidden.includes(r.proposal.proposalId))
        .map(({ proposal: p, mailboxId, stale }) => {
          let card;
          try {
            card = checkAccountProposal(p, keyset);
          } catch (e) {
            return (
              <p key={p.proposalId} className="m-0 text-xs" style={{ color: '#f87171' }}>
                A saved request no longer matches this account ({e instanceof Error ? e.message : 'invalid'}).{' '}
                <button
                  type="button"
                  onClick={() => hide(p.proposalId)}
                  className="bg-transparent border-0 underline cursor-pointer text-xs"
                  style={{ color: '#f87171' }}
                >
                  Remove it
                </button>
              </p>
            );
          }
          const signed = signedBy(p);
          const mineToSign = inputsFor(p, myKey).length > 0 && !signed.includes(myKey);
          const ready = isReady(p);
          const sentTx = stored.sent[p.proposalId];
          const status: ApprovalStatus = sentTx ? 'sent' : ready ? 'ready' : mineToSign ? 'needs-you' : 'waiting';
          const mine = p.proposedBy === myKey;
          const share = (
            <button
              type="button"
              disabled={busy}
              onClick={run(() => copy(exportAccountRequest(p)))}
              className="rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer disabled:opacity-50"
              style={{ background: '#2b2f36', color: '#fff' }}
            >
              Share by message instead
            </button>
          );
          return (
            <div
              key={p.proposalId}
              id={mailboxId ? `sa-req-${mailboxId}` : undefined}
              className="flex flex-col gap-1 rounded-xl"
              style={focus && focus === mailboxId ? { outline: `1px solid ${GOLD}` } : undefined}
            >
              {stale && !sentTx && (
                <p className="m-0 text-xs" style={{ color: '#f87171' }}>
                  The shared account has changed since this was proposed, so it can no longer be signed. Propose it
                  again.
                </p>
              )}
              <ApprovalCard
                what={`Payment from the shared account · proposed by ${who(p.proposedBy)}`}
                to={`${card.label} (${card.address})`}
                amount={moneyWithSats(card.sats, rate)}
                fee={`${card.fee.toLocaleString('en-US')} sats`}
                rule={`Needs ${card.m} of ${card.n} partners`}
                signed={signed.map(who)}
                waiting={keyset.pubKeys.filter((k) => !signed.includes(k)).map(who)}
                status={status}
                busy={busy}
                onApprove={
                  status === 'needs-you' && !stale
                    ? run(async () => {
                        // Sign here first (all the card-vs-transaction checks); the mailbox only carries the result.
                        const next = await approveSharedPayment(ctx, p, keyset);
                        if (stored.requests.some((r) => r.proposalId === p.proposalId)) keepLocal(next);
                        const failed = mailboxId ? await postSigs(mailboxId, next) : 'not on the mailbox';
                        if (failed) {
                          keepLocal(next);
                          if (mailboxId) setOffline(true);
                          return isReady(next)
                            ? 'Approved. Enough partners have approved: send it to the network.'
                            : offlineMsg('Approved');
                        }
                        await reloadMailbox();
                        return isReady(next)
                          ? 'Approved. Enough partners have approved: send it to the network.'
                          : 'Approved. Your partners have been notified.';
                      })
                    : undefined
                }
                onSend={
                  status === 'ready'
                    ? run(async () => {
                        const txid = await sendSharedPayment(p, keyset);
                        // Kept here as Sent: the mailbox lists open requests only.
                        keepLocal(p);
                        update({ ...storedRef.current, sent: { ...storedRef.current.sent, [p.proposalId]: txid } });
                        setTimeout(() => void refresh(), 3000);
                        // Tell the mailbox (idempotent); the payment is already on its way either way.
                        if (mailboxId)
                          void api
                            .reportAccountBroadcast(ticker, mailboxId, txid)
                            .then(() => reloadMailbox())
                            .catch(() => {
                              /* the partners still see it sent once the mailbox catches up */
                            });
                        return `Sent (${txid.slice(0, 12)}…).`;
                      })
                    : undefined
                }
                onDecline={
                  status === 'sent'
                    ? undefined
                    : mine && mailboxId
                      ? run(async () => {
                          await api.partnerAccountAction(ticker, { action: 'withdraw', id: mailboxId });
                          hide(p.proposalId);
                          await reloadMailbox();
                          return 'Withdrawn. Your partners no longer see this request.';
                        })
                      : () => {
                          hide(p.proposalId);
                          setMsg(
                            'Declined on this device. With a majority rule, the payment can still go ahead if enough other partners approve.',
                          );
                        }
                }
                extra={
                  status !== 'sent' ? (
                    share
                  ) : (
                    <button
                      type="button"
                      onClick={() => hide(p.proposalId)}
                      className="rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer"
                      style={{ background: '#2b2f36', color: '#fff' }}
                    >
                      Clear
                    </button>
                  )
                }
              />
            </div>
          );
        })}

      {showPaste || offline ? (
        <div className="flex flex-col gap-1">
          <textarea
            id={`sa-paste-${partnershipId}`}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={2}
            placeholder="Paste a request a partner sent you by message"
            aria-label="Paste a shared account request"
            className={`${input} font-mono text-[11px]`}
          />
          <button
            type="button"
            disabled={busy || !paste.trim()}
            onClick={doPaste}
            className={btn}
            style={{ background: '#2b2f36', color: '#fff' }}
          >
            Open request
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowPaste(true)}
          className="self-start bg-transparent border-0 text-xs cursor-pointer p-0"
          style={{ color: MUTED }}
        >
          Got a request by message? Paste it
        </button>
      )}

      {msg && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
    </div>
  );
}
