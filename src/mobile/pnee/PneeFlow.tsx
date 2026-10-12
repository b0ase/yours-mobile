import { useState } from 'react';
import { Lock } from 'lucide-react';
import { useSnackbar } from '../../hooks/useSnackbar';
import { PNEE_ICON } from '../notes/pnee';
import {
  BACK_PNEE_DONE_HINT,
  BACK_PNEE_EXPLAINER,
  BACK_PNEE_LABEL,
  BACK_PNEE_PRESETS,
  BACK_PNEE_QUESTION,
  backPneeDoneTitle,
  nextBackPneeStep,
  parseBsvAmount,
  type BackPneeEvent,
  type BackPneeStep,
} from '../notes/backPnee';
import { backsUpToLine } from './math';
import { lockConfirm, type Confirm } from './confirm';
import { lockVault } from './vaults';
import { usePnee } from './usePnee';
import { bsvToSats, PNEE_CARD } from './copy';
import { Button, CARD, ConfirmSheet, GOLD, Lines, MUTED, Sheet } from './PneeSheet';

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-xl p-3" style={{ background: CARD }}>
    <div className="text-sm font-bold text-white mb-1">{title}</div>
    <div className="text-xs leading-relaxed" style={{ color: '#D0D5DD' }}>
      {children}
    </div>
  </div>
);

/**
 * Back PNEEs (Wallet › PNEEs lock icon, Pots & Locks): card → amount → exact confirm → the wallet's approval → done.
 * Opens a PNEE vault; it never makes a plain time-lock.
 */
export default function PneeFlow({
  start = 'card',
  rate,
  onWallet,
  onPots,
}: {
  start?: BackPneeStep;
  rate: number;
  onWallet: () => void;
  onPots: () => void;
}) {
  const { addSnackbar } = useSnackbar();
  const p = usePnee();
  const [step, setStep] = useState<BackPneeStep>(start);
  const [raw, setRaw] = useState('');
  const [confirm, setConfirm] = useState<{
    c: Confirm;
    sats: bigint;
    round: Awaited<ReturnType<typeof p.round>>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const bsv = parseBsvAmount(raw);
  const go = (ev: BackPneeEvent) => {
    const next = nextBackPneeStep(step, ev);
    if (next === 'wallet') return onWallet();
    if (next === 'pots') return onPots();
    setStep(next);
  };
  const cents = BigInt(Math.round(rate * 100));

  const toConfirm = async () => {
    if (!bsv) return;
    setBusy(true);
    try {
      const round = await p.round();
      const sats = bsvToSats(bsv);
      setConfirm({ c: lockConfirm(sats, BigInt(round.median)), sats, round });
      go('continue');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const lock = async () => {
    if (!confirm || !p.wallet || !p.cfg) return;
    setBusy(true);
    try {
      await lockVault(p.wallet, p.cfg, confirm.round, confirm.sats, p.identity);
      addSnackbar('Vault opened.', 'success');
      go('locked');
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  if (step === 'card')
    return (
      <Sheet
        title="Back PNEEs with your BSV"
        icon={<img src={PNEE_ICON} alt="" className="w-8 h-8" />}
        onClose={() => go('close')}
      >
        <p className="text-sm m-0" style={{ color: '#D0D5DD' }}>
          {PNEE_CARD.intro}
        </p>
        <Box title="How it works">{PNEE_CARD.how}</Box>
        <Box title="The 150% floor">{PNEE_CARD.floor}</Box>
        <Box title="The price">{PNEE_CARD.signers}</Box>
        <Button onClick={() => go('lock')}>
          <Lock size={16} /> {BACK_PNEE_LABEL}
        </Button>
      </Sheet>
    );

  if (step === 'amount')
    return (
      <Sheet title={BACK_PNEE_QUESTION} icon={<Lock size={20} color={GOLD} />} onClose={() => go('close')}>
        <p className="text-xs m-0" style={{ color: MUTED }}>
          {BACK_PNEE_EXPLAINER}
        </p>
        <label className="rounded-xl p-3 flex items-center gap-2" style={{ background: CARD }}>
          <input
            inputMode="decimal"
            autoFocus
            placeholder="0.00"
            aria-label="Amount in BSV"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            className="flex-1 min-w-0 bg-transparent border-0 outline-none text-2xl font-bold text-white"
          />
          <span className="text-sm font-bold" style={{ color: GOLD }}>
            BSV
          </span>
        </label>
        <div className="text-xs font-bold" style={{ color: GOLD }}>
          {bsv && cents > 0n ? backsUpToLine(bsvToSats(bsv), cents) : ' '}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {BACK_PNEE_PRESETS.map((x) => (
            <button
              key={x}
              type="button"
              onClick={() => setRaw(String(x))}
              className="rounded-full border py-2 text-xs font-bold bg-transparent cursor-pointer"
              style={{ borderColor: bsv === x ? GOLD : '#F5B80055', color: GOLD }}
            >
              {x} BSV
            </button>
          ))}
        </div>
        <Button disabled={!bsv || busy} onClick={() => void toConfirm()}>
          {busy ? 'Getting the price…' : 'Continue'}
        </Button>
      </Sheet>
    );

  if (step === 'confirm' && confirm)
    return <ConfirmSheet confirm={confirm.c} busy={busy} onConfirm={() => void lock()} onClose={() => go('back')} />;

  if (step === 'done')
    return (
      <Sheet title={backPneeDoneTitle(bsv ?? 0)} icon={<Lock size={20} color={GOLD} />} onClose={() => go('close')}>
        <p className="text-sm m-0" style={{ color: MUTED }}>
          {BACK_PNEE_DONE_HINT}
        </p>
        {confirm && <Lines lines={confirm.c.lines.slice(0, 3)} />}
        <Button onClick={() => go('toWallet')}>Back to Wallet</Button>
        <Button ghost onClick={() => go('toPots')}>
          Open Pots &amp; Locks
        </Button>
      </Sheet>
    );
  return null;
}
