import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ExternalLink, Lock } from 'lucide-react';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { useServiceContext } from '../../hooks/useServiceContext';
import { openDappBrowser } from '../dappBrowser';
import { BAPPS } from '../bapps';
import { SHOW_OTHER_COMPANIES } from '../kyc/config';
import { bappOffers, parseShareOffers, shareGate, type ShareOffer, type ShareSection } from '../kyc/kyc';
import { loadAudit, recordShareEvent } from '../kyc/kycWallet';
import { useKyc } from '../kyc/useKyc';
import offersConfig from './shareListings.json';
import bwalletIcon from '../brand/bcorp/icon.png';

/**
 * Market → Tokens → Shares 🔒.
 *
 * Viewing needs BOTH a KYC certificate and a current investor self-certification; until then
 * nothing about any offer is rendered. Pre-launch: no price anywhere and no Buy. Each offer
 * has "Register interest" (recorded with bit-sign, identity-key signed). The country rule
 * only disables that button. See SHARE-LISTINGS.md.
 */
const CONFIG_OFFERS = parseShareOffers(offersConfig);
const BWALLET = { name: 'bWallet', verb: 'Hold, send and trade on Bitcoin', icon: bwalletIcon };
const ALL_OFFERS: ShareOffer[] = [
  ...CONFIG_OFFERS.filter((o) => o.section === 'bcorp'),
  ...bappOffers([BWALLET, ...BAPPS.filter((a) => a.name !== 'bWallet')]),
  ...(SHOW_OTHER_COMPANIES ? CONFIG_OFFERS.filter((o) => o.section === 'other') : []),
];

const SECTIONS: [ShareSection, string][] = [
  ['bcorp', 'bCorp'],
  ['bapps', 'bApps'],
  ...(SHOW_OTHER_COMPANIES ? ([['other', 'Other companies']] as [ShareSection, string][]) : []),
];

const GOLD = '#FFD24D';

const Step = ({ n, label, done, current }: { n: number; label: string; done: boolean; current: boolean }) => (
  <div className="flex items-center gap-2 text-xs" style={{ color: done ? '#2ecc71' : current ? '#fff' : '#667085' }}>
    <span
      className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold"
      style={{ background: done ? '#2ecc71' : current ? GOLD : '#2b2f36', color: '#010101' }}
    >
      {done ? <Check size={12} strokeWidth={3} /> : n}
    </span>
    {label}
  </div>
);

const OfferCard = ({
  o,
  canRegister,
  blockedReason,
  registered,
  busy,
  onRegister,
}: {
  o: ShareOffer;
  canRegister: boolean;
  blockedReason?: string;
  registered: boolean;
  busy: boolean;
  onRegister: () => void;
}) => {
  const third = o.section === 'other';
  return (
    <div className="rounded-xl bg-[#17191E] px-3 py-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        {o.icon ? (
          <img src={o.icon} alt="" className="h-8 w-8 rounded-lg object-cover shrink-0" />
        ) : (
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
            style={{ background: GOLD, color: '#010101' }}
          >
            b
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white truncate">{o.name}</div>
          <div className="text-[11px] text-[#98A2B3] truncate">{o.className}</div>
        </div>
        <span
          className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
          style={third ? { background: '#2b2f36', color: '#98A2B3' } : { background: GOLD, color: '#010101' }}
        >
          {third ? 'Third-party' : o.status}
        </span>
      </div>
      <p className="text-[11px] text-[#D0D5DD]">{o.tracks}</p>
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {o.nominee && <span className="rounded-full bg-[#2b2f36] px-2 py-0.5 text-[#D0D5DD]">Held via nominee</span>}
        <span className="rounded-full bg-[#2b2f36] px-2 py-0.5 text-[#D0D5DD]">
          {o.transferLocked
            ? `Locked until ${o.lockedUntil ? new Date(o.lockedUntil).toLocaleDateString() : 'a date to be confirmed'}`
            : 'Free to transfer'}
        </span>
      </div>
      <div className="text-[10px] text-[#98A2B3]">
        Class size: {o.classSize || 'to be confirmed'} · Issuer: {o.issuerName}
        {o.issuerCompanyNumber ? `, company no. ${o.issuerCompanyNumber}` : ', company no. to be confirmed'}
      </div>
      {third && (
        <p className="text-[10px] text-[#98A2B3]">
          Listed by {o.issuerName}
          {o.issuerCompanyNumber ? `, ${o.issuerCompanyNumber}` : ''}. Offer terms, statements and promises are the
          issuer's responsibility; The Bitcoin Corporation does not endorse or verify them.
        </p>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        {o.offerUrl ? (
          <button
            onClick={() => void openDappBrowser(o.offerUrl as string)}
            className="flex items-center gap-1 text-[11px] text-[#98A2B3]"
          >
            Offer document <ExternalLink size={11} />
          </button>
        ) : (
          <span className="text-[11px] text-[#667085]">Offer document: coming soon</span>
        )}
        {canRegister &&
          (registered ? (
            <span className="flex items-center gap-1 text-[11px] font-semibold" style={{ color: '#2ecc71' }}>
              <Check size={12} /> Interest registered
            </span>
          ) : (
            <button
              disabled={busy}
              onClick={onRegister}
              className="rounded-lg px-3 py-1 text-xs font-semibold disabled:opacity-50"
              style={{ background: GOLD, color: '#010101' }}
            >
              {busy ? 'Registering…' : 'Register interest'}
            </button>
          ))}
      </div>
      {!canRegister && blockedReason && <p className="text-[10px] text-[#F97066]">{blockedReason}</p>}
    </div>
  );
};

export const SharesPanel = () => {
  const { handleSelect } = useBottomMenu();
  const { apiContext } = useServiceContext();
  const { identityKey, kyc, investor, loading } = useKyc();
  const [section, setSection] = useState<ShareSection>('bcorp');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [registered, setRegistered] = useState<Set<string>>(new Set());
  const viewed = useRef(new Set<ShareSection>());

  const gate = shareGate(kyc, investor, identityKey, Date.now());
  const qualified = gate.state === 'qualified';
  const shown = useMemo(() => ALL_OFFERS.filter((o) => o.section === section), [section]);

  useEffect(() => {
    if (!identityKey) return;
    setRegistered(
      new Set(loadAudit(identityKey).flatMap((e) => (e.kind === 'interest' && e.synced && e.detail ? [e.detail] : []))),
    );
  }, [identityKey]);

  // Audit: one 'view' per section per visit, listing the offers that were on screen.
  useEffect(() => {
    if (!qualified || !apiContext || viewed.current.has(section) || !shown.length) return;
    viewed.current.add(section);
    void recordShareEvent(
      apiContext,
      'view',
      shown.map((o) => o.id),
    ).catch(() => undefined);
  }, [qualified, apiContext, section, shown]);

  if (loading) return <p className="text-xs text-[#98A2B3] text-center py-8">Checking your verification…</p>;

  if (gate.state !== 'qualified') {
    const step1 = gate.state === 'need-kyc';
    return (
      <div className="rounded-xl bg-[#17191E] px-4 py-5 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Lock size={18} color={GOLD} />
          <span className="text-sm font-semibold text-white">Share offers are for verified investors</span>
        </div>
        <p className="text-xs text-[#D0D5DD]">
          Shares in The Bitcoin Corporation and its bApps. Two steps to see the offers:
        </p>
        <Step n={1} label="Verify your identity (KYC)" done={!step1} current={step1} />
        <Step n={2} label="Confirm you qualify as an investor" done={false} current={!step1} />
        <button
          onClick={() => handleSelect('settings', step1 ? 'identity' : 'investor')}
          className="self-start rounded-lg px-4 py-2 text-xs font-semibold"
          style={{ background: GOLD, color: '#010101' }}
        >
          {step1 ? 'Get verified' : 'Qualify as an investor'}
        </button>
        {/* Preview: everyone sees WHICH share classes exist (name + icon only). Offer details,
            class sizes and Register interest stay behind KYC + investor self-certification. */}
        <div className="flex flex-col gap-1.5 pt-1">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[#98A2B3]">Share classes</span>
          {ALL_OFFERS.filter((o) => o.section !== 'other').map((o) => (
            <div key={o.id} className="flex items-center gap-2 rounded-lg bg-[#0f1013] px-2.5 py-2">
              {o.icon ? (
                <img src={o.icon} alt="" className="h-7 w-7 rounded-md object-cover shrink-0" />
              ) : (
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-bold"
                  style={{ background: GOLD, color: '#010101' }}
                >
                  {o.name.replace(/^b/, '').slice(0, 1).toUpperCase() || 'b'}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-white truncate">{o.name}</div>
                <div className="text-[10px] text-[#98A2B3] truncate">{o.className}</div>
              </div>
              <Lock size={12} color="#667085" />
            </div>
          ))}
          <p className="text-[10px] text-[#667085]">Verify and qualify to see each offer.</p>
        </div>
      </div>
    );
  }

  const register = async (o: ShareOffer) => {
    setBusy(o.id);
    setMsg('');
    try {
      await recordShareEvent(apiContext, 'interest', [o.id]);
      setRegistered((r) => new Set(r).add(o.id));
      setMsg(`Interest in ${o.name} registered. The Bitcoin Corporation will contact you about an allocation.`);
    } catch (e) {
      setMsg(e instanceof Error ? `Not registered: ${e.message}` : 'Not registered. Try again.');
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="flex gap-1.5 overflow-x-auto">
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSection(id)}
            className="shrink-0 rounded-full px-3 py-1 text-xs font-semibold"
            style={{ background: section === id ? GOLD : '#17191E', color: section === id ? '#010101' : '#98A2B3' }}
          >
            {label}
          </button>
        ))}
      </div>
      {msg && <p className="text-xs text-[#D0D5DD]">{msg}</p>}
      {shown.length === 0 && <p className="text-xs text-[#98A2B3] text-center py-6">No offers here yet.</p>}
      {shown.map((o) => (
        <OfferCard
          key={o.id}
          o={o}
          canRegister={gate.canRegister}
          blockedReason={gate.blockedReason}
          registered={registered.has(o.id)}
          busy={busy === o.id}
          onRegister={() => void register(o)}
        />
      ))}
      <p className="text-[10px] text-[#667085] text-center">
        Pre-launch. No prices are set and nothing can be bought here. Registering interest is not an application for
        shares.
      </p>
    </section>
  );
};
