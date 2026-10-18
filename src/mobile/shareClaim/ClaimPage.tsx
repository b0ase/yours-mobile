import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Check, ShieldCheck } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { buildClaim, postClaim } from './claim';
import { saveClaim } from './claimStore';
import { confirmLock, type LockedTranche } from './confirm';
import { fetchInvite, type CheckedInvite } from './invite';
import logo from './assets/npg-logo.png';

/**
 * /m/claim/:inviteId?c=npg (bWalletX only, lazy chunk behind SHARE_CLAIM_ENABLED).
 * Fetch + verify the invite → one approval sheet → derive the lock key → POST the signed claim → if the company
 * returns a lock txid, check the outputs on chain before saying "done". Wording stays factual: no price or value.
 */
const MUTED = '#98A2B3';
const PINK = '#ff2e88';

type Stage =
  | { k: 'loading' }
  | { k: 'error'; msg: string }
  | { k: 'ready'; inv: CheckedInvite }
  | { k: 'claimed'; inv: CheckedInvite; locked: LockedTranche[] | null; note?: string };

const n = (x: number) => x.toLocaleString('en-GB');

const ClaimPage = () => {
  const { inviteId = '' } = useParams();
  const [qs] = useSearchParams();
  const company = qs.get('c') ?? '';
  const navigate = useNavigate();
  const { apiContext } = useServiceContext();
  const [stage, setStage] = useState<Stage>({ k: 'loading' });
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    fetchInvite({ inviteId, company })
      .then((inv) => live && setStage({ k: 'ready', inv }))
      .catch((e: Error) => live && setStage({ k: 'error', msg: e.message }));
    return () => {
      live = false;
    };
  }, [inviteId, company]);

  const allow = async (inv: CheckedInvite) => {
    try {
      setBusy('Signing…');
      const body = await buildClaim(apiContext.wallet, inv.inviteId);
      setBusy('Sending to the company…');
      const res = await postClaim(inv, body);
      saveClaim({
        inviteId: inv.inviteId,
        company,
        lockPubKey: body.lockPubKey,
        claimedAt: new Date().toISOString(),
        txid: res.txid,
        tranches: inv.tokens.map((t) => ({ tranche: t.tranche, tokenId: t.id, amount: t.amount })),
      });
      let locked: LockedTranche[] | null = null;
      let note: string | undefined;
      if (res.txid) {
        setBusy('Checking the lock on chain…');
        try {
          locked = await confirmLock(res.txid, inv, body.lockPubKey);
          saveClaim({
            inviteId: inv.inviteId,
            company,
            lockPubKey: body.lockPubKey,
            claimedAt: new Date().toISOString(),
            txid: res.txid,
            tranches: locked.map((l) => ({ ...l })),
          });
        } catch (e) {
          note = (e as Error).message;
        }
      }
      setStage({ k: 'claimed', inv, locked, note });
    } catch (e) {
      setStage({ k: 'error', msg: (e as Error).message });
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="flex flex-col gap-4 p-4 text-white" style={{ background: '#0b0b0f', minHeight: '100%' }}>
      <img src={logo} alt="Ninja Punk Girls" style={{ width: 160, height: 'auto' }} />
      <h1 className="text-xl font-extrabold m-0">Claim your shares</h1>
      {stage.k === 'loading' && <p style={{ color: MUTED }}>Checking your invite…</p>}
      {stage.k === 'error' && (
        <>
          <p style={{ color: '#ff8a8a' }}>{stage.msg}</p>
          <button type="button" className="bw-pill min-h-[44px]" onClick={() => navigate('/m')}>
            Close
          </button>
        </>
      )}
      {stage.k === 'claimed' && (
        <div className="flex flex-col gap-2">
          {stage.locked ? (
            <p className="flex items-center gap-2 m-0">
              <ShieldCheck size={18} color="#A1FF8B" /> Done. Your {n(stage.inv.holder.shares)} shares are held 2-of-2
              with the company.
            </p>
          ) : (
            <p className="m-0">
              Claim sent. The company will move your tokens into the 2-of-2 lock; this wallet checks the lock on chain
              when it appears.{stage.note ? ` (${stage.note})` : ''}
            </p>
          )}
          <button type="button" className="bw-pill bw-pill-gold min-h-[44px]" onClick={() => navigate('/m')}>
            Back to wallet
          </button>
        </div>
      )}
      {stage.k === 'ready' && (
        <ClaimSheet inv={stage.inv} busy={busy} onAllow={() => void allow(stage.inv)} onCancel={() => navigate('/m')} />
      )}
    </section>
  );
};

/** The one approval sheet: every fact listed, one Allow, nothing to untick. */
const ClaimSheet = ({
  inv,
  busy,
  onAllow,
  onCancel,
}: {
  inv: CheckedInvite;
  busy: string;
  onAllow: () => void;
  onCancel: () => void;
}) => {
  useBackClose(true, onCancel);
  const lines = [
    { label: 'Company', value: `${inv.pin.name} · No. ${inv.pin.number}` },
    { label: 'Name on the register', value: inv.holder.nameOnRegister },
    { label: 'Register entry', value: inv.holder.registerEntry },
    ...inv.tokens.map((t) => ({ label: `Tranche ${t.tranche}`, value: `${n(t.amount)} shares` })),
    { label: 'Total', value: `${n(inv.holder.shares)} shares` },
  ];
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/70" onClick={onCancel}>
      <div
        role="dialog"
        aria-label="Approve share claim"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] rounded-t-2xl p-5 flex flex-col gap-3"
        style={{
          background: '#0d0e11',
          borderTop: `2px solid ${PINK}`,
          paddingBottom: 'max(20px, env(safe-area-inset-bottom))',
        }}
      >
        <div className="flex items-center gap-2 text-white text-lg font-extrabold">
          <ShieldCheck size={18} color={PINK} /> Claim your shares?
        </div>
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {lines.map((l) => (
            <li key={l.label} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2" style={{ color: MUTED }}>
                <Check size={14} color="#A1FF8B" /> {l.label}
              </span>
              <span className="text-white font-semibold text-right">{l.value}</span>
            </li>
          ))}
        </ul>
        <p className="text-[12px] m-0" style={{ color: MUTED }}>
          One token is one share on the register of members. Your NPG will be locked 2-of-2 with the company: moving it
          needs your signature and the company’s. The lock key comes from your recovery phrase.
        </p>
        <button
          type="button"
          disabled={!!busy}
          onClick={onAllow}
          className="bw-pill bw-pill-gold min-h-[48px] w-full text-base font-bold disabled:opacity-60"
        >
          {busy || 'Allow'}
        </button>
        <button
          type="button"
          disabled={!!busy}
          onClick={onCancel}
          className="text-sm bg-transparent border-0 cursor-pointer disabled:opacity-40"
          style={{ color: MUTED }}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
};

export default ClaimPage;
