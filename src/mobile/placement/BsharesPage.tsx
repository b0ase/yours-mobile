/**
 * bShares (/m/bshares): share registers for any company (register of members, director approvals, locked shares).
 * The first register in testing is The Bitcoin Corporation Ltd. RESTRICTED to registered members and the director
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
import { OVERPAYMENT_TERM, allotmentMinute, excessRefundDue, type ExcessChoice } from './minute';
import {
  STATUS_LABEL,
  tickerLabel,
  bsv,
  mayOpenBshares,
  nextStep,
  pounds,
  satsFor,
  type BsharesMe,
  type PlacementOffer,
} from './placement';
import { DEFAULT_LOCK_MONTHS, shareLabel } from './scripts';
import { useBshares, useCompanies } from './useBshares';
import { CompanySetup, CreateCompany } from './CompanySetup';
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
      bShares keeps share registers for any company: register of members, director approvals and locked shares. It opens
      for members and directors of a company on bShares. Shares are not offered publicly.
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
  const [minuteNo, setMinuteNo] = useState('');
  const [excessChoice, setExcessChoice] = useState<ExcessChoice>('refund');
  const role = me.role === 'director' ? 'director' : 'investor';
  const step = nextStep(offer, role);
  const run = async () => {
    setBusy(true);
    try {
      if (step === 'Accept') await api.accept(offer.id, await shareLockKey(apiContext, offer.id));
      else if (step === 'Pay') await api.paid(offer.id, await payTreasury(apiContext, me.company, offer), excessChoice);
      else if (step === 'Approve allotment') {
        const no = Number(minuteNo);
        if (!Number.isInteger(no) || no < 1) throw new Error('Enter the next board minute number');
        await api.approve(offer.id, await shareLockKey(apiContext, offer.id), no);
      } else if (step === 'Refund excess') {
        const txid = window.prompt('Refund transaction id (two treasury keys signed it)')?.trim();
        if (!txid) return;
        await api.refundExcess(offer.id, txid);
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
  let preview = '';
  if (step === 'Approve allotment' && Number(minuteNo) >= 1 && me.company.nominalNanoPounds) {
    try {
      preview = allotmentMinute({
        company: { name: me.company.name, number: me.company.companyNumber ?? '' },
        date: new Date().toISOString().slice(0, 10),
        minuteNumber: Number(minuteNo),
        director: { name: 'Sole Director', handle: 'director' },
        allottee: { name: offer.investorHandle, handle: offer.investorHandle },
        offer: {
          id: offer.id,
          offeredAt: (offer.events[0]?.at ?? new Date().toISOString()).slice(0, 10),
          closesAt: offer.expiresAt.slice(0, 10),
          shares: offer.shares,
          pricePence: offer.pricePence,
          gbpPerBsvPence: offer.gbpPerBsvPence,
          rateDate: offer.rateDate,
          sats: offer.sats,
          lockMonths: offer.lockMonths,
        },
        payment: {
          txid: offer.paymentTxid ?? '',
          paidSats: offer.paidSats ?? offer.sats,
          excessChoice: offer.excessChoice ?? null,
        },
        register: {
          nominalNanoPounds: me.company.nominalNanoPounds,
          certificate: '(next)',
          holdingBefore: offer.holdingBefore ?? 0,
          issuedBefore: me.company.sharesInIssue,
          authorised: me.company.authorised ?? null,
        },
      }).text;
    } catch (e) {
      preview = e instanceof Error ? e.message : '';
    }
  }
  return (
    <div className={CARD}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-white font-bold">
          {offer.shares.toLocaleString('en-GB')} {tickerLabel(offer.ticker)} shares · {offer.investorHandle}
        </span>
        <span className="text-[11px] font-bold" style={{ color: GOLD }}>
          {STATUS_LABEL[offer.status]}
        </span>
      </div>
      <p className="m-0 text-xs" style={{ color: MUTED }}>
        {pounds(offer.pricePence)} a share · {bsv(offer.sats)} at {pounds(offer.gbpPerBsvPence)}/BSV ({offer.rateDate})
        · locked 2-of-2, yours alone after {offer.lockMonths} months
      </p>
      {step === 'Pay' && (
        <fieldset className="m-0 p-0 border-0 flex flex-col gap-1 text-xs" style={{ color: MUTED }}>
          <legend className="text-white text-sm mb-1">{OVERPAYMENT_TERM}</legend>
          {(
            [
              ['refund', 'Refund any excess to me in BSV'],
              ['premium', 'Treat any excess as share premium (no extra shares)'],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-2">
              <input
                type="radio"
                name={`excess-${offer.id}`}
                checked={excessChoice === v}
                onChange={() => setExcessChoice(v)}
              />
              {label}
            </label>
          ))}
        </fieldset>
      )}
      {offer.excessSats ? (
        <p className="m-0 text-xs" style={{ color: MUTED }}>
          Paid {bsv(offer.paidSats ?? offer.sats)}: {bsv(offer.excessSats)} over, as{' '}
          {offer.excessChoice === 'premium' ? 'share premium' : 'a refund'}
          {excessRefundDue(offer) ? ' · refund pending (director)' : offer.excessRefundTxid ? ' · refunded' : ''}
        </p>
      ) : null}
      {step === 'Approve allotment' && (
        <>
          <Field
            label="Board minute number (next in sequence, e.g. 11)"
            value={minuteNo}
            onChange={setMinuteNo}
            type="number"
          />
          {preview && (
            <details>
              <summary className="text-xs cursor-pointer" style={{ color: MUTED }}>
                Preview the minute (sole director resolution)
              </summary>
              <pre className="m-0 whitespace-pre-wrap text-[11px] text-white">{preview}</pre>
            </details>
          )}
        </>
      )}
      {offer.boardMinuteText && (
        <details>
          <summary className="text-xs cursor-pointer" style={{ color: MUTED }}>
            Board minute {offer.boardMinute}
          </summary>
          <pre className="m-0 whitespace-pre-wrap text-[11px] text-white">{offer.boardMinuteText}</pre>
        </details>
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
          ? shareLabel(h.shares, h.token.unlockHeight, height, me.company.name)
          : `${me.company.name} · ${h.shareClass} · ${h.shares.toLocaleString('en-GB')}`}
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
  const { companies, reload: reloadCompanies } = useCompanies();
  const [ticker, setTicker] = useState<string | undefined>(undefined);
  const { api, me, loading, reload } = useBshares(ticker);
  const [creating, setCreating] = useState(false);
  const switcher = (
    <div className="flex flex-wrap gap-2" role="tablist" aria-label="Company">
      {companies.map((c) => (
        <button
          key={c.ticker}
          type="button"
          role="tab"
          aria-selected={(ticker ?? me?.company.ticker) === c.ticker}
          onClick={() => {
            setCreating(false);
            setTicker(c.ticker);
          }}
          className="rounded-full px-3 py-1 text-xs font-bold border cursor-pointer"
          style={
            (ticker ?? me?.company.ticker) === c.ticker
              ? { background: GOLD, color: '#1a1300', borderColor: GOLD }
              : { background: 'transparent', color: 'white', borderColor: '#2b2f36' }
          }
        >
          {c.name}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="rounded-full px-3 py-1 text-xs font-bold border cursor-pointer bg-transparent"
        style={{ color: GOLD, borderColor: GOLD }}
      >
        + Create your company
      </button>
    </div>
  );
  const [height, setHeight] = useState(0);
  useEffect(() => {
    void apiContext.services?.chaintracks
      .currentHeight()
      .then(setHeight)
      .catch(() => undefined);
  }, [apiContext]);
  let body: React.ReactNode;
  if (creating)
    body = (
      <CreateCompany
        api={api}
        onOpen={(t) => {
          setCreating(false);
          setTicker(t);
          void reloadCompanies();
        }}
      />
    );
  else if (loading) body = <p style={{ color: MUTED }}>Checking the register…</p>;
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
        {me.role === 'director' && (!me.company.treasury || !(me.company.shareClasses ?? []).length) && (
          <CompanySetup api={api} me={me} onDone={reload} />
        )}
        {me.role === 'director' && <NewTranche api={api} onDone={reload} />}
        {me.offers.map((o) => (
          <OfferCard key={o.id} offer={o} me={me} api={api} onDone={reload} />
        ))}
        <details className={CARD}>
          <summary className="text-white font-bold cursor-pointer">How your shares are held</summary>
          <ul className="m-0 pl-4 text-xs flex flex-col gap-1" style={{ color: MUTED }}>
            <li>The register of members is the legal title. The $403 token in your wallet follows it.</li>
            <li>
              Your token is locked 2-of-2 (you and the director). After the lock period you can move it alone, with no
              server and no director: your key comes back from your seed and the offer id.
            </li>
            <li>
              Payments go to the company treasury
              {me.company.treasury ? `, a ${me.company.treasury.m}-of-${me.company.treasury.n} multisig` : ''} across
              the directors&apos; keys, each restorable from that director&apos;s own backup.
            </li>
            <li>
              If the director loses their share-lock key, nothing is lost: you can still move your shares alone after
              the lock period, and the company can re-issue your token to a new director key under a board minute.
            </li>
            <li>{OVERPAYMENT_TERM}</li>
          </ul>
        </details>
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
      <div className="mt-14 flex flex-col gap-3">
        {switcher}
        {body}
      </div>
    </div>
  );
};

export default BsharesPage;
