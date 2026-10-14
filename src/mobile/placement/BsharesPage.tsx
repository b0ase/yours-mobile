/**
 * bShares (/m/bshares): The Bitcoin Corporation share placement, RESTRICTED to registered members and the director
 * (docs/BCORP-PLACEMENT.md). Never in a store build: the route is lazy and dropped there (PLACEMENT_ENABLED).
 * Tranche size, price and the BSV rate are typed in by the director; nothing here is a cap-table number.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lock, ShieldCheck } from 'lucide-react';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { issueShareToken, payTreasury, shareLockKey } from './actions';
import {
  STATUS_LABEL,
  bsv,
  mayOpenBshares,
  nextStep,
  pounds,
  satsFor,
  type BsharesMe,
  type PlacementOffer,
} from './placement';
import { DEFAULT_LOCK_MONTHS, shareLabel } from './scripts';
import { useBshares } from './useBshares';
import type { BsharesApi } from './api';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const CARD = 'rounded-2xl bg-[#17191E] border border-[#2b2f36] p-4 flex flex-col gap-2';

export const RestrictedNotice = () => (
  <div className={CARD} role="note">
    <div className="flex items-center gap-2 text-white font-bold">
      <Lock size={16} color={GOLD} aria-hidden="true" /> Restricted: for registered shareholders
    </div>
    <p className="m-0 text-sm" style={{ color: MUTED }}>
      bShares opens for members on The Bitcoin Corporation&apos;s register of members and its directors. Shares are not
      offered publicly.
    </p>
  </div>
);

const Field = ({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) => (
  <label className="flex flex-col gap-1 text-xs" style={{ color: MUTED }}>
    {label}
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-xl bg-[#0d0e11] border border-[#2b2f36] px-3 py-2 text-sm text-white"
    />
  </label>
);

const Btn = ({ onClick, children, busy }: { onClick: () => void; children: React.ReactNode; busy?: boolean }) => (
  <button
    type="button"
    disabled={busy}
    onClick={onClick}
    className="rounded-xl px-4 py-2 text-sm font-bold border-0 cursor-pointer disabled:opacity-50"
    style={{ background: GOLD, color: '#1a1300' }}
  >
    {children}
  </button>
);

/** Director: create a tranche offer for a named existing member. */
const NewTranche = ({ api, onDone }: { api: BsharesApi; onDone: () => void }) => {
  const { addSnackbar } = useSnackbar();
  const [handle, setHandle] = useState('');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [rate, setRate] = useState('');
  const [months, setMonths] = useState(String(DEFAULT_LOCK_MONTHS));
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  let quote = '';
  try {
    quote = bsv(satsFor(Number(shares), Math.round(Number(price) * 100), Math.round(Number(rate) * 100)));
  } catch {
    quote = '';
  }
  const submit = async () => {
    setBusy(true);
    try {
      await api.createOffer({
        investorHandle: handle.trim().replace(/^[@$]/, ''),
        shares: Number(shares),
        pricePence: Math.round(Number(price) * 100),
        gbpPerBsvPence: Math.round(Number(rate) * 100),
        rateDate: new Date().toISOString().slice(0, 10),
        lockMonths: Number(months),
        expiresAt: new Date(Date.now() + Number(days) * 86_400_000).toISOString(),
      });
      addSnackbar('Offer sent to the member', 'success');
      onDone();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Offer failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={CARD}>
      <div className="text-white font-bold">New tranche (director)</div>
      <Field label="Existing member (handle)" value={handle} onChange={setHandle} />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Shares" value={shares} onChange={setShares} type="number" />
        <Field label="Price per share (£)" value={price} onChange={setPrice} type="number" />
        <Field label="£ per BSV today" value={rate} onChange={setRate} type="number" />
        <Field label="Lock (months)" value={months} onChange={setMonths} type="number" />
        <Field label="Offer open (days)" value={days} onChange={setDays} type="number" />
      </div>
      {quote && (
        <p className="m-0 text-sm text-white">
          Member pays <b>{quote}</b> to the treasury multisig
        </p>
      )}
      <Btn onClick={submit} busy={busy}>
        Send offer
      </Btn>
    </div>
  );
};

const OfferCard = ({
  offer,
  me,
  api,
  onDone,
}: {
  offer: PlacementOffer;
  me: BsharesMe;
  api: BsharesApi;
  onDone: () => void;
}) => {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [busy, setBusy] = useState(false);
  const [minute, setMinute] = useState('');
  const role = me.role === 'director' ? 'director' : 'investor';
  const step = nextStep(offer, role);
  const run = async () => {
    setBusy(true);
    try {
      if (step === 'Accept') await api.accept(offer.id, await shareLockKey(apiContext, offer.id));
      else if (step === 'Pay') await api.paid(offer.id, await payTreasury(apiContext, me.company, offer));
      else if (step === 'Approve allotment') {
        if (!minute.trim()) throw new Error('Record the board approval first');
        await api.approve(offer.id, await shareLockKey(apiContext, offer.id), minute.trim());
      } else if (step === 'Issue share token') {
        const t = await issueShareToken(apiContext, offer, {
          p: '403',
          op: 'allot',
          ticker: me.company.ticker,
          company: me.company.name,
          shareClass: 'Ordinary',
          shares: offer.shares,
          holder: offer.investorHandle,
          offerId: offer.id,
          allottedAt: (offer.events.find((e) => e.kind === 'approved')?.at ?? new Date().toISOString()).slice(0, 10),
          register: `bit-sign register of members · ${me.company.ticker}`,
        });
        await api.token(offer.id, t.outpoint, t.lockingScriptHex);
      } else if (step === 'Withdraw') await api.decline(offer.id, 'Withdrawn by the director');
      else if (step === 'Record refund') {
        const txid = window.prompt('Refund transaction id (signed by the treasury directors)')?.trim();
        if (!txid) return;
        await api.refund(offer.id, txid);
      }
      onDone();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Failed', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-white font-bold">
          {offer.shares.toLocaleString('en-GB')} shares · {offer.investorHandle}
        </span>
        <span className="text-[11px] font-bold" style={{ color: GOLD }}>
          {STATUS_LABEL[offer.status]}
        </span>
      </div>
      <p className="m-0 text-xs" style={{ color: MUTED }}>
        {pounds(offer.pricePence)} a share · {bsv(offer.sats)} at {pounds(offer.gbpPerBsvPence)}/BSV ({offer.rateDate})
        · locked 2-of-2, yours alone after {offer.lockMonths} months
      </p>
      {step === 'Approve allotment' && (
        <Field label="Board approval (minute reference)" value={minute} onChange={setMinute} />
      )}
      {step && (
        <Btn onClick={run} busy={busy}>
          {step}
        </Btn>
      )}
      <details>
        <summary className="text-xs cursor-pointer" style={{ color: MUTED }}>
          Record
        </summary>
        <ul className="m-0 pl-4 text-xs" style={{ color: MUTED }}>
          {offer.events.map((e, i) => (
            <li key={i}>
              {e.at.slice(0, 16).replace('T', ' ')} · {e.kind} · {e.by}
              {e.note ? ` · ${e.note}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
};

export const Holdings = ({ me, height }: { me: BsharesMe; height: number }) => (
  <div className={CARD}>
    <div className="text-white font-bold">Your holding</div>
    {me.holdings.length === 0 && (
      <p className="m-0 text-sm" style={{ color: MUTED }}>
        Nothing on the register yet.
      </p>
    )}
    {me.holdings.map((h, i) => (
      <div key={i} className="text-sm text-white">
        {h.token
          ? shareLabel(h.shares, h.token.unlockHeight, height)
          : `bCorp shares · ${h.shares.toLocaleString('en-GB')}`}
        {h.token && (
          <span className="block text-xs" style={{ color: MUTED }}>
            Yours alone from block {h.token.unlockHeight.toLocaleString('en-GB')}
          </span>
        )}
      </div>
    ))}
    <p className="m-0 text-xs" style={{ color: MUTED }}>
      Legal title is the register of members ({me.company.sharesInIssue.toLocaleString('en-GB')} shares in issue).
    </p>
  </div>
);

export const BsharesPage = () => {
  const navigate = useNavigate();
  const { apiContext } = useServiceContext();
  const { api, me, loading, reload } = useBshares();
  const [height, setHeight] = useState(0);
  useEffect(() => {
    void apiContext.services?.chaintracks
      .currentHeight()
      .then(setHeight)
      .catch(() => undefined);
  }, [apiContext]);
  let body: React.ReactNode;
  if (loading) body = <p style={{ color: MUTED }}>Checking the register…</p>;
  else if (!me || !mayOpenBshares(me)) body = <RestrictedNotice />;
  else
    body = (
      <>
        <div className="flex items-center gap-2 text-white">
          <ShieldCheck size={18} color={GOLD} aria-hidden="true" />
          <span className="font-bold">{me.company.name}</span>
          <span className="text-[11px] rounded-full px-2 py-0.5" style={{ background: '#2a2100', color: GOLD }}>
            Restricted · members only
          </span>
        </div>
        <Holdings me={me} height={height} />
        {me.role === 'director' && <NewTranche api={api} onDone={reload} />}
        {me.offers.map((o) => (
          <OfferCard key={o.id} offer={o} me={me} api={api} onDone={reload} />
        ))}
        <button
          type="button"
          onClick={() => navigate('/m/lock')}
          className="text-xs bg-transparent border-0 cursor-pointer"
          style={{ color: MUTED }}
        >
          See it in your Vault
        </button>
      </>
    );
  return (
    <div className="px-4 pb-24">
      <TopNav />
      <div className="mt-14 flex flex-col gap-3">{body}</div>
    </div>
  );
};

export default BsharesPage;
