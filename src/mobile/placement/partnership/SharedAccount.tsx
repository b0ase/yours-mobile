/**
 * Partnership › Shared account: the partners' joint BSV, spent only with the agreement's number of approvals.
 * Pay in (one sheet), propose a payment (the proposer approves it at once), approve or decline requests, and send
 * once enough partners have approved. Requests travel as a line of text partners paste to each other; every pasted
 * copy is checked against this partnership's keys before it is shown, and only verified signatures are kept.
 */
import { useCallback, useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { useServiceContext } from '../../../hooks/useServiceContext';
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

type Stored = { requests: AccountProposal[]; sent: Record<string, string> };
const storeKey = (id: string) => `bwx.sharedAccount.${id}`;
function load(id: string): Stored {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey(id)) ?? 'null') as Stored | null;
    return s && Array.isArray(s.requests) ? { requests: s.requests, sent: s.sent ?? {} } : { requests: [], sent: {} };
  } catch {
    return { requests: [], sent: {} };
  }
}
function save(id: string, s: Stored) {
  try {
    localStorage.setItem(storeKey(id), JSON.stringify(s));
  } catch {
    /* private mode: requests live for this visit only */
  }
}

export function SharedAccount(props: {
  partnershipId: string;
  keyset: Keyset;
  keys: { handle: string; partnerKey: string }[];
  myKey: string;
}) {
  const { partnershipId, keyset, keys, myKey } = props;
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
    setStored(s);
    save(partnershipId, s);
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
    update({ ...stored, requests: [...stored.requests, p] });
    setTo('');
    setAmount('');
    return copy(exportAccountRequest(p));
  });

  const doPaste = run(async () => {
    const incoming = importAccountRequest(paste, keyset, partnershipId);
    update({ ...stored, requests: absorbRequest(stored.requests, incoming, paste) });
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

      {stored.requests.map((p) => {
        let card;
        try {
          card = checkAccountProposal(p, keyset);
        } catch (e) {
          return (
            <p key={p.proposalId} className="m-0 text-xs" style={{ color: '#f87171' }}>
              A saved request no longer matches this account ({e instanceof Error ? e.message : 'invalid'}). Decline it.
            </p>
          );
        }
        const signed = signedBy(p);
        const mineToSign = inputsFor(p, myKey).length > 0 && !signed.includes(myKey);
        const ready = isReady(p);
        const sentTx = stored.sent[p.proposalId];
        const status: ApprovalStatus = sentTx ? 'sent' : ready ? 'ready' : mineToSign ? 'needs-you' : 'waiting';
        const drop = () =>
          update({ requests: stored.requests.filter((r) => r.proposalId !== p.proposalId), sent: stored.sent });
        return (
          <ApprovalCard
            key={p.proposalId}
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
              status === 'needs-you'
                ? run(async () => {
                    const next = await approveSharedPayment(ctx, p, keyset);
                    update({
                      ...stored,
                      requests: stored.requests.map((r) => (r.proposalId === p.proposalId ? next : r)),
                    });
                    return isReady(next)
                      ? 'Approved. Enough partners have approved: send it to the network.'
                      : copy(exportAccountRequest(next));
                  })
                : undefined
            }
            onSend={
              status === 'ready'
                ? run(async () => {
                    const txid = await sendSharedPayment(p, keyset);
                    update({ ...stored, sent: { ...stored.sent, [p.proposalId]: txid } });
                    setTimeout(() => void refresh(), 3000);
                    return `Sent (${txid.slice(0, 12)}…).`;
                  })
                : undefined
            }
            onDecline={
              status === 'sent'
                ? undefined
                : () => {
                    drop();
                    setMsg(
                      'Declined on this device. With a majority rule, the payment can still go ahead if enough other partners approve.',
                    );
                  }
            }
            extra={
              status !== 'sent' ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={run(() => copy(exportAccountRequest(p)))}
                  className="rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer disabled:opacity-50"
                  style={{ background: '#2b2f36', color: '#fff' }}
                >
                  Copy request
                </button>
              ) : (
                <button
                  type="button"
                  onClick={drop}
                  className="rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer"
                  style={{ background: '#2b2f36', color: '#fff' }}
                >
                  Clear
                </button>
              )
            }
          />
        );
      })}

      <div className="flex flex-col gap-1">
        <textarea
          id={`sa-paste-${partnershipId}`}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={2}
          placeholder="Paste a request from a partner"
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

      {msg && (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          {msg}
        </p>
      )}
    </div>
  );
}
