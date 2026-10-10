import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BIG_LOCK_QUESTION,
  EMPTY_AMOUNTS,
  PLACEHOLDERS,
  PREVIEW_LABEL,
  PREVIEW_NOTE,
  START_SMALL_NOTE,
  needsSizeCheck,
  valuesEntered,
} from './builderForm';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Lock as LockIcon,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { useBackClose } from '../backStack';
import { TopNav } from '../../components/TopNav';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useAccountNames } from '../names/accountNames';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';
import {
  aggregate,
  buildGradual,
  buildOnce,
  buildPercent,
  DEFAULT_BUFFER_PCT,
  fmtBsv,
  fmtUsd,
  MAX_PIECES,
  defaultSurplusTo,
  payoutFor,
  percentAmounts,
  surplusHeight,
  type SurplusTo,
  planStatus,
  resplitTail,
  satsToUsd,
  type Frequency,
  type LockMode,
  type LockPlan,
  type PercentBase,
  type PercentResult,
  type ScheduleResult,
} from './schedule';
import {
  claimMatured,
  createLock,
  freshRate,
  loadPlans,
  relock,
  savePlans,
  syncClaimed,
  walletLockOutpoints,
} from './lockApi';
import { BackPneeAmountSheet } from '../notes/BackPneeAmountSheet';
import { BackPneeSheet } from '../notes/BackPneeSheet';
import { groupPots, PNEE_POT, potName } from './pots';
import { isBackPneeMode } from '../notes/backPnee';
import { MARKET_ENABLED } from '../storeBuild';
import { verifyLockTx, type VerifyResult } from './verify';
import { TEMPLATE_CONFIRM, TEMPLATE_NOTE, TEMPLATES, reviewAllowed, type LockTemplate } from './templates';
import {
  CURVE_NAMES,
  DEFAULT_S_STEEPNESS,
  DEFAULT_STEEPNESS,
  curveLabel,
  parsePcts,
  type Curve,
  type CurveKind,
} from './curves';

/**
 * /m/lock — the phone top bar's Lock BSV button (docs/TIME-LOCK-PLAN.md).
 * Locks list (many independent locks), claim of matured pieces, the schedule builder with a full
 * preview, the irreversible confirmation (type LOCK), and the verifier for any lock transaction.
 */
const GOLD = '#F5B800';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'confirm' } | { kind: 'verify'; tx?: string };
type Kind = 'once' | 'gradual';
type GradualMode = 'usd' | 'bsv' | 'percent';

const dayInput = (d: Date) => d.toISOString().slice(0, 10);
const fromDayInput = (s: string) => new Date(`${s}T12:00:00`);
const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const bsvToSats = (s: string) => Math.round(Number(s) * 1e8);

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="flex flex-1 min-w-0 flex-col gap-1 text-xs" style={{ color: MUTED }}>
    {label}
    {children}
  </label>
);
const inputCls =
  'w-full min-w-0 rounded-xl px-3 py-2 text-sm text-white bg-[#0d0e11] border border-[#2b2f36] outline-none focus:border-[#F5B800]';
const Seg = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) => (
  <div className="flex rounded-xl p-1 gap-1" style={{ background: '#0d0e11', border: `1px solid ${LINE}` }}>
    {options.map(([v, l]) => (
      <button
        key={v}
        type="button"
        onClick={() => onChange(v)}
        className="flex-1 rounded-lg py-2 text-xs font-bold"
        style={{ background: value === v ? GOLD : 'transparent', color: value === v ? '#1a1300' : MUTED }}
      >
        {l}
      </button>
    ))}
  </div>
);

const LockScreen = ({ initialVerify }: { initialVerify?: string }) => {
  const navigate = useNavigate();
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const acct = chromeStorageService.getCurrentAccountObject().account;
  const account = acct?.addresses.identityAddress ?? '';
  const names = useAccountNames(account, acct?.name ?? '', acct?.settings?.socialProfile?.displayName ?? '');
  const [view, setView] = useState<View>(
    initialVerify != null ? { kind: 'verify', tx: initialVerify } : { kind: 'list' },
  );
  useBackClose(true, () => (view.kind === 'list' ? navigate(-1) : setView({ kind: 'list' })));

  const [height, setHeight] = useState(0);
  const [rate, setRate] = useState(cachedExchangeRate());
  const [plans, setPlans] = useState<LockPlan[]>(() => loadPlans(account, chromeStorageService));
  const [busy, setBusy] = useState(false);
  // Wallet › PNEEs lock icon opens /m/lock?back=pnee: the Back PNEEs card first, then how much BSV, then the
  // builder filled in for the PNEEs pot (owner, 10 Oct 2026).
  const [backPnee, setBackPnee] = useState<'card' | 'amount' | null>(() =>
    isBackPneeMode(window.location.search) ? 'card' : null,
  );
  /** The pot the lock being built goes into (LockPlan.pot); undefined = Other locks. */
  const [pot, setPot] = useState<string | undefined>(undefined);
  const [openPot, setOpenPot] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const h = (await apiContext.services?.chaintracks.currentHeight()) ?? 0;
      setHeight(h);
      const unspent = new Set((await walletLockOutpoints(apiContext)).map((o) => o.outpoint));
      const synced = syncClaimed(loadPlans(account, chromeStorageService), unspent, h);
      savePlans(account, synced, chromeStorageService);
      setPlans(synced);
    } catch {
      // offline: show what we have
    }
    setRate(await fetchExchangeRate('main'));
  }, [apiContext, account, chromeStorageService]);
  useEffect(() => void refresh(), [refresh]);

  // ── builder state ──
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<Kind>('gradual');
  const [gmode, setGmode] = useState<GradualMode>('usd');
  const [amountBsv, setAmountBsv] = useState<string>(EMPTY_AMOUNTS.amountBsv);
  const [unlockOn, setUnlockOn] = useState(dayInput(new Date(Date.now() + 365 * 86_400_000)));
  const [start, setStart] = useState(dayInput(new Date(Date.now() + 86_400_000)));
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [customDays, setCustomDays] = useState('3');
  const [until, setUntil] = useState<'count' | 'end'>('count');
  const [count, setCount] = useState<string>(EMPTY_AMOUNTS.count);
  const [end, setEnd] = useState(dayInput(new Date(Date.now() + 30 * 86_400_000)));
  const [usdPer, setUsdPer] = useState<string>(EMPTY_AMOUNTS.usdPer);
  const [buffer, setBuffer] = useState(String(DEFAULT_BUFFER_PCT));
  const [bsvPer, setBsvPer] = useState<string>(EMPTY_AMOUNTS.bsvPer);
  const [pct, setPct] = useState<string>(EMPTY_AMOUNTS.pct);
  const [base, setBase] = useState<PercentBase>('original');
  const [receipt, setReceipt] = useState(false);
  const [curveKind, setCurveKind] = useState<CurveKind>('linear');
  const [steep, setSteep] = useState(String(DEFAULT_STEEPNESS));
  const [cliff, setCliff] = useState('3');
  const [every, setEvery] = useState('3');
  const [customPcts, setCustomPcts] = useState('');
  const curve: Curve = useMemo(() => {
    switch (curveKind) {
      case 'front':
      case 'back':
      case 's-curve':
        return { kind: curveKind, steepness: Number(steep) };
      case 'cliff':
        return { kind: 'cliff', cliff: Number(cliff) };
      case 'step':
        return { kind: 'step', every: Number(every) };
      case 'custom':
        return { kind: 'custom', pcts: parsePcts(customPcts) ?? [] };
      default:
        return { kind: 'linear' };
    }
  }, [curveKind, steep, cliff, every, customPcts]);
  const pickCurve = (k: CurveKind) => {
    setCurveKind(k);
    if (k === 's-curve') setSteep(String(DEFAULT_S_STEEPNESS));
    else if (k === 'front' || k === 'back') setSteep(String(DEFAULT_STEEPNESS));
  };
  /** null = automatic (extend for schedules over a year, else next). */
  const [surplusPick, setSurplusPick] = useState<SurplusTo | null>(null);
  const [templateUsed, setTemplateUsed] = useState<string | null>(null);
  const [templateChecked, setTemplateChecked] = useState(false);
  const applyTemplate = (t: LockTemplate) => {
    const v = t.values(new Date());
    const at = v.unlockOn ?? new Date(Date.now() + (v.startInDays ?? 30) * 86_400_000);
    setKind(v.kind);
    if (v.gmode) setGmode(v.gmode);
    if (v.kind === 'once') setUnlockOn(dayInput(at));
    else setStart(dayInput(at));
    if (v.frequency) setFrequency(v.frequency);
    if (v.customDays) setCustomDays(String(v.customDays));
    setUntil('count');
    setCount(v.count != null ? String(v.count) : EMPTY_AMOUNTS.count);
    setAmountBsv(v.amountBsv ?? EMPTY_AMOUNTS.amountBsv);
    setUsdPer(v.usdPer ?? EMPTY_AMOUNTS.usdPer);
    setBsvPer(v.bsvPer ?? EMPTY_AMOUNTS.bsvPer);
    setCurveKind(v.curve?.kind ?? 'linear');
    if (v.curve?.steep) setSteep(v.curve.steep);
    setCustomPcts(v.curve?.custom ?? '');
    setLabel(v.label);
    setTemplateUsed(t.id);
    setTemplateChecked(false);
    setPot(t.id);
  };
  const [typed, setTyped] = useState('');
  /** Soft check above 0.01 BSV: shown after Review, until answered. */
  const [sizeAsk, setSizeAsk] = useState(false);

  const entered = valuesEntered({ kind, gmode, until, amountBsv, usdPer, bsvPer, pct, count });
  const schedule: ScheduleResult | PercentResult | null = useMemo(() => {
    if (!height || !entered) return null;
    const now = new Date();
    if (kind === 'once') return buildOnce(bsvToSats(amountBsv), fromDayInput(unlockOn), now, height);
    const common = {
      start: fromDayInput(start),
      frequency,
      customDays: Number(customDays),
      ...(until === 'count' ? { count: Number(count) } : { end: fromDayInput(end) }),
    };
    if (gmode === 'percent')
      return buildPercent(
        {
          totalSats: bsvToSats(amountBsv),
          pct: Number(pct),
          base,
          start: common.start,
          frequency,
          customDays: Number(customDays),
        },
        now,
        height,
      );
    if (gmode === 'usd')
      return buildGradual(
        { ...common, usdPerPayout: Number(usdPer), rate, bufferPct: Number(buffer), curve },
        now,
        height,
      );
    return buildGradual({ ...common, perPayoutSats: bsvToSats(bsvPer), curve }, now, height);
  }, [
    height,
    entered,
    kind,
    amountBsv,
    unlockOn,
    start,
    frequency,
    customDays,
    until,
    count,
    end,
    gmode,
    pct,
    base,
    usdPer,
    rate,
    buffer,
    bsvPer,
    curve,
  ]);
  const curved = kind === 'gradual' && gmode !== 'percent' && curve.kind !== 'linear';

  const surplusTo: SurplusTo =
    surplusPick ?? (schedule?.pieces.length ? defaultSurplusTo(schedule.pieces, height) : 'next');
  const mode: LockMode =
    kind === 'once' ? 'date' : gmode === 'usd' ? 'usd-target' : gmode === 'percent' ? 'percent' : 'bsv';
  const ok = entered && schedule && !schedule.error && schedule.pieces.length > 0;

  const doLock = async () => {
    if (!ok || !schedule || schedule.error || typed !== 'LOCK') return;
    setBusy(true);
    try {
      const pr = schedule as PercentResult;
      await createLock(
        apiContext,
        account,
        {
          label: label.trim() || (kind === 'once' ? `Unlock ${fmtDate(schedule.pieces[0].date)}` : 'Payouts'),
          mode,
          pieces: schedule.pieces.map((p, i) => ({
            height: p.height,
            sats: p.sats,
            usdTarget: p.usdTarget,
            tail: pr.tail && i === schedule.pieces.length - 1,
          })),
          usdPerPayout: gmode === 'usd' && kind === 'gradual' ? Number(usdPer) : undefined,
          bufferPct: gmode === 'usd' && kind === 'gradual' ? Number(buffer) : undefined,
          pct: mode === 'percent' ? Number(pct) : undefined,
          base: mode === 'percent' ? base : undefined,
          frequency,
          customDays: Number(customDays),
          pendingAmounts: pr.tail
            ? (percentAmounts(bsvToSats(amountBsv), Number(pct), base) as number[]).slice(MAX_PIECES - 1)
            : undefined,
          surplusTo: mode === 'usd-target' ? surplusTo : undefined,
          curve: curved ? curve : undefined,
          pot,
          receipt: receipt
            ? {
                identity: {
                  handle: names.handle || undefined,
                  paymail: names.paymail || undefined,
                  idKey: acct?.pubKeys?.identityPubKey,
                  address: account,
                },
                rate,
              }
            : undefined,
        },
        chromeStorageService,
      );
      addSnackbar('Locked. It cannot be undone.', 'success');
      setTyped('');
      setView({ kind: 'list' });
      await refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Lock failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── claim + dollar payouts ──
  const totals = aggregate(plans, height);
  const [payouts, setPayouts] = useState<
    | {
        plan: LockPlan;
        lines: string[];
        relock?: { height: number; sats: number; usdTarget?: number; extend?: boolean };
        batch?: ReturnType<typeof resplitTail>;
      }[]
    | null
  >(null);

  const claim = async () => {
    setBusy(true);
    try {
      const before = plans;
      await claimMatured(apiContext);
      const todays = await freshRate();
      const out: NonNullable<typeof payouts> = [];
      for (const p of before) {
        const ready = p.pieces.filter((x) => !x.claimed && x.height <= height);
        if (!ready.length) continue;
        const target = surplusHeight(p, height);
        const lines: string[] = [];
        let surplus = 0;
        let batch: ReturnType<typeof resplitTail> | undefined;
        for (const x of ready) {
          if (x.tail && p.pendingAmounts?.length) {
            batch = resplitTail(p.pendingAmounts, x.height, p.frequency ?? 'daily', p.customDays);
            lines.push(
              `${fmtBsv(p.pendingAmounts[0])} payout. The remaining ${p.pendingAmounts.length - 1} payouts were held in one lock and are now in your wallet.`,
            );
            continue;
          }
          if (p.mode !== 'usd-target' || !x.usdTarget) {
            lines.push(`${fmtBsv(x.sats)} to your wallet`);
            continue;
          }
          const r = payoutFor(x.sats, x.usdTarget, todays, target != null);
          if (r.kind === 'wait')
            lines.push(`${fmtBsv(x.sats)} claimed. ${r.reason} The full piece is in your wallet as BSV.`);
          else if (r.kind === 'short') {
            x.paidUsd = r.paidUsd;
            lines.push(`Paid ${fmtUsd(r.paidUsd)} of ${fmtUsd(r.targetUsd)} (${fmtBsv(r.paySats)})`);
          } else {
            x.paidUsd = r.paidUsd;
            surplus += r.surplusSats;
            lines.push(
              `Paid ${fmtUsd(r.paidUsd)} (${fmtBsv(r.paySats)})${r.relock ? `, surplus ${fmtBsv(r.surplusSats)}` : ''}`,
            );
          }
        }
        out.push({
          plan: p,
          lines,
          relock:
            surplus && target != null
              ? { height: target, sats: surplus, usdTarget: p.usdPerPayout, extend: p.surplusTo === 'extend' }
              : undefined,
          batch: batch?.pieces.length ? batch : undefined,
        });
      }
      savePlans(
        account,
        loadPlans(account, chromeStorageService).map((p) => before.find((b) => b.id === p.id) ?? p),
        chromeStorageService,
      );
      setPayouts(out);
      await refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Claim failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const doRelock = async (planId: string, piece: { height: number; sats: number; usdTarget?: number }) => {
    setBusy(true);
    try {
      await relock(
        apiContext,
        account,
        planId,
        [{ vout: 0, height: piece.height, sats: piece.sats, usdTarget: piece.usdTarget }],
        undefined,
        chromeStorageService,
      );
      addSnackbar('Surplus re-locked', 'success');
      setPayouts((ps) => ps?.map((x) => (x.plan.id === planId ? { ...x, relock: undefined } : x)) ?? null);
      await refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Re-lock failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const doBatch = async (planId: string, b: ReturnType<typeof resplitTail>) => {
    setBusy(true);
    try {
      await relock(apiContext, account, planId, b.pieces, b.pendingAmounts, chromeStorageService);
      addSnackbar('Next payouts locked', 'success');
      setPayouts((ps) => ps?.map((x) => (x.plan.id === planId ? { ...x, batch: undefined } : x)) ?? null);
      await refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Re-lock failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // ── verify ──
  const [txInput, setTxInput] = useState(view.kind === 'verify' ? (view.tx ?? '') : '');
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  const [vErr, setVErr] = useState('');
  const runVerify = async (tx = txInput.trim()) => {
    setVErr('');
    setVerified(null);
    try {
      setVerified(await verifyLockTx(tx));
    } catch (e) {
      setVErr(e instanceof Error ? e.message : 'Could not verify');
    }
  };

  const header = (title: string, back: () => void) => (
    <div className="flex items-center gap-2 px-4 pt-3">
      <button
        aria-label="Back"
        onClick={back}
        className="w-9 h-9 flex items-center justify-center rounded-full"
        style={{ border: `1px solid ${LINE}` }}
      >
        <ArrowLeft size={16} color="#fff" />
      </button>
      <h1 className="text-lg font-extrabold text-white">{title}</h1>
    </div>
  );
  const card = 'rounded-2xl p-4 flex flex-col gap-3';
  const cardStyle = { background: PANEL, border: `1px solid ${LINE}` };
  const btn = 'rounded-xl py-3 text-sm font-bold disabled:opacity-40';
  const est = (sats: number) => (rate > 0 && sats > 0 ? ` · ≈ ${fmtUsd(satsToUsd(sats, rate))}` : '');

  let body: React.ReactNode;
  const pots = groupPots(plans, height);
  const startLock = (potId?: string) => {
    setTemplateUsed(null);
    setPot(potId);
    setView({ kind: 'new' });
  };
  const startPot = (t: LockTemplate) => {
    applyTemplate(t);
    setView({ kind: 'new' });
  };
  const lockForPnee = (bsv: number) => {
    setKind('once');
    setAmountBsv(String(bsv));
    setUnlockOn(dayInput(new Date(Date.now() + 365 * 86_400_000)));
    setLabel('PNEEs backing');
    setTemplateUsed(null);
    setPot(PNEE_POT);
    setBackPnee(null);
    setView({ kind: 'new' });
  };
  const renderPlan = (p: LockPlan) => {
    const s = planStatus(p, height);
    const total = p.pieces.reduce((a, x) => a + x.sats, 0);
    const pieceTxt = p.pieces.length === 1 ? 'one date' : `${p.pieces.length} payouts`;
    return (
      <div key={p.id} className={card} style={cardStyle}>
        <div className="flex justify-between gap-2">
          <span className="text-sm font-bold text-white truncate">{p.label}</span>
          <span className="text-xs font-bold" style={{ color: s.status === 'Ready to claim' ? GOLD : MUTED }}>
            {s.status}
          </span>
        </div>
        <div className="text-xs" style={{ color: MUTED }}>
          {modeLabel(p)} · {pieceTxt} · {fmtBsv(total)} locked at start
        </div>
        <div className="text-xs text-white">
          Still locked {fmtBsv(s.locked)}
          {s.next ? ` · next ≈ block ${s.next} (${fmtDate(new Date(Date.now() + (s.next - height) * 600_000))})` : ''}
        </div>
        {p.pieces.some((x) => x.paidUsd != null) && (
          <div className="text-xs" style={{ color: MUTED }}>
            {p.pieces
              .filter((x) => x.paidUsd != null)
              .slice(-3)
              .map((x) => `paid ${fmtUsd(x.paidUsd!)} of ${fmtUsd(x.usdTarget ?? 0)}`)
              .join(' · ')}
          </div>
        )}
        <button
          className="text-xs text-left"
          style={{ color: GOLD }}
          onClick={() => {
            setTxInput(p.txids[0]);
            setView({ kind: 'verify', tx: p.txids[0] });
            void runVerify(p.txids[0]);
          }}
        >
          Verify on chain
        </button>
      </div>
    );
  };

  if (view.kind === 'list') {
    body = (
      <>
        {header('Pots & Locks', () => navigate(-1))}
        <div className="px-4 flex flex-col gap-3">
          <div className="flex gap-2">
            <button
              onClick={() => startLock()}
              className={`${btn} flex-1 flex items-center justify-center gap-2`}
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <LockIcon size={16} /> Lock BSV
            </button>
            <button
              onClick={() => setOpenPot('__start')}
              className={`${btn} flex-1 flex items-center justify-center gap-2 text-white`}
              style={{ border: `1px solid ${LINE}` }}
            >
              <Plus size={16} /> Pot
            </button>
          </div>
          <div className={card} style={cardStyle}>
            <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: GOLD }}>
              In pots
            </div>
            <div className="text-3xl font-extrabold text-white">{fmtBsv(totals.locked)}</div>
            <div className="text-xs" style={{ color: MUTED }}>
              {pots.length} pot{pots.length === 1 ? '' : 's'} · {totals.count} lock{totals.count === 1 ? '' : 's'}
              {totals.next ? ` · next unlock ≈ block ${totals.next}` : ''}
              {est(totals.locked)}
            </div>
            {totals.ready > 0 && (
              <button
                disabled={busy}
                onClick={() => void claim()}
                className={btn}
                style={{ background: GOLD, color: '#1a1300' }}
              >
                Claim {fmtBsv(totals.ready)} ready now
              </button>
            )}
          </div>
          {payouts && payouts.length > 0 && (
            <div className={card} style={cardStyle}>
              <div className="text-sm font-bold text-white">Claimed</div>
              {payouts.map((p) => (
                <div key={p.plan.id} className="flex flex-col gap-1 text-xs" style={{ color: MUTED }}>
                  <span className="text-white font-semibold">{p.plan.label}</span>
                  {p.lines.map((l, i) => (
                    <span key={i}>{l}</span>
                  ))}
                  {p.batch && (
                    <div className="flex flex-col gap-2 mt-1">
                      <span>
                        Lock the next {p.batch.pieces.length} payouts (
                        {fmtBsv(p.batch.pieces.reduce((a, x) => a + x.sats, 0))}) on the same schedule? This is a new
                        lock and cannot be undone.
                      </span>
                      <button
                        disabled={busy}
                        className={btn}
                        style={{ background: GOLD, color: '#1a1300' }}
                        onClick={() => void doBatch(p.plan.id, p.batch!)}
                      >
                        Lock next payouts
                      </button>
                    </div>
                  )}
                  {p.relock && (
                    <div className="flex flex-col gap-2 mt-1">
                      <span>
                        Re-lock the extra {fmtBsv(p.relock.sats)}{' '}
                        {p.relock.extend
                          ? `as a new payout after your last one (block ${p.relock.height})`
                          : `into your next payout (block ${p.relock.height})`}
                        ? This is a new lock and cannot be undone. Or keep it in your wallet.
                      </span>
                      <div className="flex gap-2">
                        <button
                          disabled={busy}
                          className={`${btn} flex-1`}
                          style={{ background: GOLD, color: '#1a1300' }}
                          onClick={() => void doRelock(p.plan.id, p.relock!)}
                        >
                          Re-lock surplus
                        </button>
                        <button
                          className={`${btn} flex-1 text-white`}
                          style={{ border: `1px solid ${LINE}` }}
                          onClick={() =>
                            setPayouts((ps) => ps?.map((x) => (x === p ? { ...x, relock: undefined } : x)) ?? null)
                          }
                        >
                          Keep in wallet
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {pots.map((pt) => {
            const open = openPot === pt.id;
            return (
              <div key={pt.id} className="flex flex-col gap-2">
                <button
                  onClick={() => setOpenPot(open ? null : pt.id)}
                  aria-expanded={open}
                  className={`${card} text-left`}
                  style={cardStyle}
                >
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-sm font-bold text-white truncate">{pt.name}</span>
                    <span className="flex items-center gap-1 text-sm font-bold text-white">
                      {fmtBsv(pt.locked)}
                      {open ? <ChevronUp size={16} color={MUTED} /> : <ChevronDown size={16} color={MUTED} />}
                    </span>
                  </div>
                  <div className="text-xs" style={{ color: MUTED }}>
                    {pt.id === PNEE_POT ? 'Locked to back PNEEs · ' : ''}
                    {pt.plans.length} lock{pt.plans.length === 1 ? '' : 's'}
                    {pt.ready > 0
                      ? ` · ${fmtBsv(pt.ready)} ready to claim`
                      : pt.next
                        ? ` · locked until ≈ ${fmtDate(new Date(Date.now() + (pt.next - height) * 600_000))}`
                        : ''}
                    {est(pt.locked)}
                  </div>
                </button>
                {open && (
                  <>
                    {pt.plans.map(renderPlan)}
                    <button
                      onClick={() =>
                        pt.id === PNEE_POT ? setBackPnee('amount') : startLock(pt.id === 'other' ? undefined : pt.id)
                      }
                      className="text-xs py-1 flex items-center gap-1 justify-center"
                      style={{ color: GOLD }}
                    >
                      <Plus size={14} /> Add to {potName(pt.id)}
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {(plans.length === 0 || openPot === '__start') && (
            <div className={card} style={cardStyle}>
              <div className="text-sm font-bold text-white">Start a pot</div>
              <p className="text-xs m-0" style={{ color: MUTED }}>
                A pot is BSV you lock for something: until a date, or as payouts over time. Nobody can unlock it early,
                not even you. Pick one to fill in example values, then check them.
              </p>
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => startPot(t)}
                    className="rounded-full px-3 py-2 text-xs font-bold"
                    style={{ border: `1px solid ${LINE}`, color: '#fff', background: PANEL }}
                  >
                    {t.name}
                  </button>
                ))}
                {MARKET_ENABLED && (
                  <button
                    onClick={() => setBackPnee('card')}
                    className="rounded-full px-3 py-2 text-xs font-bold"
                    style={{ border: `1px solid ${GOLD}`, color: GOLD, background: PANEL }}
                  >
                    Back PNEEs
                  </button>
                )}
              </div>
            </div>
          )}
          <button
            className="text-xs py-2 flex items-center gap-1 justify-center"
            style={{ color: MUTED }}
            onClick={() => setView({ kind: 'verify' })}
          >
            <ShieldCheck size={14} /> Verify any lock
          </button>
        </div>
      </>
    );
  } else if (view.kind === 'new') {
    const pr = schedule as PercentResult | null;
    body = (
      <>
        {header(pot ? `New lock · ${potName(pot)}` : 'New lock', () => setView({ kind: 'list' }))}
        <div className="px-4 flex flex-col gap-3">
          <div
            className="rounded-2xl p-3 text-xs font-semibold flex gap-2"
            style={{ background: '#2a1d00', border: `1px solid ${GOLD}`, color: GOLD }}
          >
            <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {START_SMALL_NOTE}
          </div>
          <Field label="Name (only you see this)">
            <input
              className={inputCls}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Savings 2027"
            />
          </Field>
          <div className="flex flex-col gap-2">
            <div className="text-xs" style={{ color: MUTED }}>
              Templates (fill in example values when tapped)
            </div>
            <div className="flex flex-wrap gap-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className="rounded-full px-3 py-1.5 text-xs font-semibold"
                  style={{
                    border: `1px solid ${templateUsed === t.id ? GOLD : LINE}`,
                    color: templateUsed === t.id ? GOLD : '#fff',
                    background: templateUsed === t.id ? '#2a1d00' : PANEL,
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
            {templateUsed && (
              <div
                className="rounded-2xl p-3 text-xs flex flex-col gap-2"
                style={{ background: '#2a1d00', border: `1px solid ${GOLD}`, color: GOLD }}
              >
                <span className="font-bold">{TEMPLATE_NOTE}</span>
                <span style={{ color: '#F2F2F0' }}>{TEMPLATES.find((t) => t.id === templateUsed)?.blurb}</span>
                <label className="flex items-center gap-2" style={{ color: '#F2F2F0' }}>
                  <input
                    type="checkbox"
                    checked={templateChecked}
                    onChange={(e) => setTemplateChecked(e.target.checked)}
                  />{' '}
                  {TEMPLATE_CONFIRM}
                </label>
              </div>
            )}
          </div>
          <Seg
            value={kind}
            onChange={setKind}
            options={[
              ['gradual', 'Gradual payouts'],
              ['once', 'One unlock date'],
            ]}
          />
          {kind === 'once' ? (
            <>
              <Field label="Amount (BSV)">
                <input
                  className={inputCls}
                  inputMode="decimal"
                  placeholder={PLACEHOLDERS.amountBsv}
                  value={amountBsv}
                  onChange={(e) => setAmountBsv(e.target.value)}
                />
              </Field>
              <Field label="Unlock on (approximate)">
                <input
                  className={inputCls}
                  type="date"
                  value={unlockOn}
                  onChange={(e) => setUnlockOn(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <>
              <Seg
                value={gmode}
                onChange={setGmode}
                options={[
                  ['usd', '$ per payout'],
                  ['bsv', 'BSV per payout'],
                  ['percent', '% of lock'],
                ]}
              />
              {gmode === 'usd' && (
                <>
                  <div className="flex gap-2">
                    <Field label="Dollars per payout (target)">
                      <input
                        className={inputCls}
                        inputMode="decimal"
                        placeholder={PLACEHOLDERS.usdPer}
                        value={usdPer}
                        onChange={(e) => setUsdPer(e.target.value)}
                      />
                    </Field>
                    <Field label="Buffer %">
                      <input
                        className={inputCls}
                        inputMode="numeric"
                        value={buffer}
                        onChange={(e) => setBuffer(e.target.value)}
                      />
                    </Field>
                  </div>
                  <p className="text-[11px]" style={{ color: MUTED }}>
                    You lock BSV, not dollars. Each piece is sized at today&apos;s price (
                    {rate > 0 ? fmtUsd(rate) : 'unavailable'}) plus the buffer. When a piece unlocks, your wallet pays
                    out the target at that day&apos;s price; a surplus can be re-locked, a shortfall pays the whole
                    piece. Dollar amounts are targets, not guarantees.
                  </p>
                  <Field label="Extra goes to">
                    <Seg
                      value={surplusTo}
                      onChange={setSurplusPick}
                      options={[
                        ['next', 'Next payment'],
                        ['extend', 'Extends the schedule'],
                      ]}
                    />
                  </Field>
                  <p className="text-[11px]" style={{ color: MUTED }}>
                    If BSV goes up, the extra can make your next payment bigger, or make your payouts last longer. You
                    approve each re-lock.
                    {surplusPick == null ? ' (Set automatically: longer than a year extends.)' : ''}
                  </p>
                </>
              )}
              {gmode === 'bsv' && (
                <Field label="BSV per payout">
                  <input
                    className={inputCls}
                    inputMode="decimal"
                    placeholder={PLACEHOLDERS.bsvPer}
                    value={bsvPer}
                    onChange={(e) => setBsvPer(e.target.value)}
                  />
                </Field>
              )}
              {gmode === 'percent' && (
                <>
                  <div className="flex gap-2">
                    <Field label="Amount (BSV)">
                      <input
                        className={inputCls}
                        inputMode="decimal"
                        placeholder={PLACEHOLDERS.amountBsv}
                        value={amountBsv}
                        onChange={(e) => setAmountBsv(e.target.value)}
                      />
                    </Field>
                    <Field label="% per payout">
                      <input
                        className={inputCls}
                        inputMode="decimal"
                        placeholder={PLACEHOLDERS.pct}
                        value={pct}
                        onChange={(e) => setPct(e.target.value)}
                      />
                    </Field>
                  </div>
                  <Seg
                    value={base}
                    onChange={setBase}
                    options={[
                      ['original', '% of original'],
                      ['remaining', '% of remaining'],
                    ]}
                  />
                  <p className="text-[11px]" style={{ color: MUTED }}>
                    {base === 'original'
                      ? 'The same amount every time; it ends after 100 ÷ X payouts.'
                      : 'A share of what is still locked, so payouts shrink. When a payout would drop below 1,000 sats, the rest is paid at once.'}
                  </p>
                </>
              )}
              <div className="flex gap-2">
                <Field label="Locked until (first payout)">
                  <input className={inputCls} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
                </Field>
                <Field label="Every">
                  <select
                    className={inputCls}
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value as Frequency)}
                  >
                    <option value="daily">Day</option>
                    <option value="weekly">Week</option>
                    <option value="monthly">Month</option>
                    <option value="custom">N days</option>
                  </select>
                </Field>
                {frequency === 'custom' && (
                  <Field label="Days">
                    <input
                      className={inputCls}
                      inputMode="numeric"
                      value={customDays}
                      onChange={(e) => setCustomDays(e.target.value)}
                    />
                  </Field>
                )}
              </div>
              {gmode !== 'percent' && (
                <>
                  <Seg
                    value={until}
                    onChange={setUntil}
                    options={[
                      ['count', 'Number of payouts'],
                      ['end', 'End date'],
                    ]}
                  />
                  {until === 'count' ? (
                    <input
                      className={inputCls}
                      inputMode="numeric"
                      placeholder={PLACEHOLDERS.count}
                      value={count}
                      onChange={(e) => setCount(e.target.value)}
                    />
                  ) : (
                    <input className={inputCls} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
                  )}
                  <CurvePicker
                    kind={curveKind}
                    onKind={pickCurve}
                    steep={steep}
                    onSteep={setSteep}
                    cliff={cliff}
                    onCliff={setCliff}
                    every={every}
                    onEvery={setEvery}
                    custom={customPcts}
                    onCustom={setCustomPcts}
                    usd={gmode === 'usd'}
                  />
                </>
              )}
            </>
          )}

          {schedule?.error && (
            <p className="text-xs flex gap-2" style={{ color: '#F97066' }}>
              <AlertTriangle size={14} className="shrink-0" /> {schedule.error}
            </p>
          )}
          {ok && (
            <div className={card} style={cardStyle}>
              <div className="flex justify-between text-sm text-white font-bold">
                <span>{PREVIEW_LABEL}</span>
                <span>{fmtBsv(schedule!.totalSats)}</span>
              </div>
              <div className="text-[11px] font-semibold" style={{ color: GOLD }}>
                {PREVIEW_NOTE}
              </div>
              <div className="text-xs" style={{ color: MUTED }}>
                {schedule!.pieces.length} lock output{schedule!.pieces.length === 1 ? '' : 's'}
                {est(schedule!.totalSats)}
                {mode === 'usd-target' ? ` · includes a ${buffer}% buffer` : ''}
                {pr?.periods ? ` · ${pr.periods} payouts, last ≈ ${fmtDate(pr.end!)}` : ''}
              </div>
              {kind === 'gradual' && (
                <div className="text-xs text-white">
                  Nothing unlocks before ≈ {fmtDate(schedule!.pieces[0].date)} (block {schedule!.pieces[0].height}).
                  Then{' '}
                  {schedule!.pieces.length > 1
                    ? `${frequency === 'custom' ? `every ${customDays} days` : frequency} until ≈ ${fmtDate(schedule!.pieces[schedule!.pieces.length - 1].date)}`
                    : 'that is the only payout'}
                  .
                </div>
              )}
              {schedule!.warning && (
                <div className="text-xs" style={{ color: GOLD }}>
                  {schedule!.warning}
                </div>
              )}
              {kind === 'gradual' && schedule!.pieces.length > 1 && (
                <div className="flex flex-col gap-1">
                  <div className="text-[11px]" style={{ color: MUTED }}>
                    Curve: <span className="text-white font-semibold">{curved ? curveLabel(curve) : 'linear'}</span>
                    {mode === 'usd-target' ? ' · bars are the dollar targets' : ''}
                  </div>
                  <Bars values={schedule!.pieces.map((p) => (mode === 'usd-target' ? (p.usdTarget ?? 0) : p.sats))} />
                </div>
              )}
              <div className="max-h-72 overflow-y-auto overflow-x-hidden">
                <table className="w-full table-fixed text-[11px] [overflow-wrap:anywhere]">
                  <thead style={{ color: MUTED }}>
                    <tr>
                      <th className="text-left font-semibold py-1 w-6">#</th>
                      <th className="text-left font-semibold">Date ≈</th>
                      <th className="text-right font-semibold">Block</th>
                      {mode === 'usd-target' && curved && <th className="text-right font-semibold">Target</th>}
                      <th className="text-right font-semibold">BSV</th>
                      <th className="text-right font-semibold">≈ USD</th>
                    </tr>
                  </thead>
                  <tbody className="text-white">
                    {schedule!.pieces.map((p, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${LINE}` }}>
                        <td className="py-1">{i + 1}</td>
                        <td>{fmtDate(p.date)}</td>
                        <td className="text-right">{p.height}</td>
                        {mode === 'usd-target' && curved && <td className="text-right">{fmtUsd(p.usdTarget ?? 0)}</td>}
                        <td className="text-right">
                          {(p.sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}
                        </td>
                        <td className="text-right">{rate > 0 ? fmtUsd(satsToUsd(p.sats, rate)) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px]" style={{ color: MUTED }}>
                Dates are estimates: the lock is set to a block height, about 144 blocks a day. USD is at today&apos;s
                price and will change.
              </p>
            </div>
          )}
          <label className="flex items-start gap-3 rounded-2xl p-3" style={cardStyle}>
            <input type="checkbox" className="mt-1" checked={receipt} onChange={(e) => setReceipt(e.target.checked)} />
            <span className="text-xs" style={{ color: MUTED }}>
              <span className="text-white font-semibold">Mint a public receipt</span> (an NFT in the same transaction).
              It is public and permanent: anyone can see it and verify the lock at bwalletx.com/lock/verify. It shows
              the amount, its USD value at lock time, the schedule and target, and your{' '}
              {names.handle ? `handle ${names.handle}, ` : ''}paymail and identity key, for good.
            </span>
          </label>
          {sizeAsk && ok ? (
            <div className={card} style={{ background: '#2a1d00', border: `1px solid ${GOLD}` }}>
              <p className="text-sm text-white font-semibold">{BIG_LOCK_QUESTION}</p>
              <div className="flex gap-2">
                <button
                  className={`${btn} flex-1`}
                  style={{ background: '#2b2f36', color: '#fff' }}
                  onClick={() => setSizeAsk(false)}
                >
                  Make it smaller
                </button>
                <button
                  className={`${btn} flex-1`}
                  style={{ background: GOLD, color: '#1a1300' }}
                  onClick={() => (setSizeAsk(false), setView({ kind: 'confirm' }))}
                >
                  Yes, continue
                </button>
              </div>
            </div>
          ) : (
            <button
              disabled={!ok || !reviewAllowed(entered, templateUsed != null, templateChecked)}
              onClick={() => (needsSizeCheck(schedule!.totalSats) ? setSizeAsk(true) : setView({ kind: 'confirm' }))}
              className={btn}
              style={{ background: GOLD, color: '#1a1300' }}
            >
              Review
            </button>
          )}
        </div>
      </>
    );
  } else if (view.kind === 'confirm') {
    body = (
      <>
        {header('Confirm lock', () => setView({ kind: 'new' }))}
        <div className="px-4 flex flex-col gap-3">
          <div className={card} style={{ background: '#2a1d00', border: `1px solid ${GOLD}` }}>
            <div className="flex items-center gap-2 text-sm font-bold" style={{ color: GOLD }}>
              <AlertTriangle size={16} /> This cannot be undone
            </div>
            <ul className="text-xs text-white flex flex-col gap-2 list-disc pl-4">
              <li>
                {fmtBsv(schedule?.totalSats ?? 0)} will be locked on the Bitcoin SV blockchain.{' '}
                <b>Nobody can unlock it early: not you, not bWalletX, not support.</b>
              </li>
              <li>
                Unlock dates are approximate. The lock opens at a block height; blocks come about every 10 minutes on
                average.
              </li>
              <li>The locked asset is BSV. Its dollar value will go up and down while it is locked.</li>
              <li>Only your 12 words can claim it. Lose them and the locks are lost for good.</li>
              {receipt && <li>The public receipt links your identity to this amount, permanently.</li>}
            </ul>
          </div>
          <Field label="Type LOCK to confirm">
            <input
              className={inputCls}
              autoCapitalize="characters"
              value={typed}
              onChange={(e) => setTyped(e.target.value.toUpperCase())}
            />
          </Field>
          <button
            disabled={busy || typed !== 'LOCK' || !ok}
            onClick={() => void doLock()}
            className={btn}
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy ? 'Locking…' : `Lock ${fmtBsv(schedule?.totalSats ?? 0)}`}
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        {header('Verify a lock', () => setView({ kind: 'list' }))}
        <div className="px-4 flex flex-col gap-3">
          <Field label="Lock transaction id">
            <input
              className={inputCls}
              value={txInput}
              onChange={(e) => setTxInput(e.target.value)}
              placeholder="64 hex characters"
            />
          </Field>
          <button onClick={() => void runVerify()} className={btn} style={{ background: GOLD, color: '#1a1300' }}>
            Check on chain
          </button>
          {vErr && (
            <p className="text-xs" style={{ color: '#F97066' }}>
              {vErr}
            </p>
          )}
          {verified && <VerifyCard r={verified} />}
        </div>
      </>
    );
  }

  return (
    <div
      className="w-full h-full flex flex-col overflow-y-auto overflow-x-hidden overscroll-x-none pb-44"
      style={{ background: '#010101' }}
    >
      <TopNav />
      <div className="mt-14 flex min-w-0 flex-col gap-3 [overflow-wrap:anywhere]">{body}</div>
      {MARKET_ENABLED && backPnee === 'card' && (
        <BackPneeSheet onClose={() => setBackPnee(null)} onLock={() => setBackPnee('amount')} />
      )}
      {MARKET_ENABLED && backPnee === 'amount' && (
        <BackPneeAmountSheet rate={rate} onClose={() => setBackPnee(null)} onContinue={lockForPnee} />
      )}
    </div>
  );
};

const modeLabel = (p: LockPlan) =>
  baseModeLabel(p) + (p.curve && p.curve.kind !== 'linear' ? ` · ${curveLabel(p.curve)}` : '');
const baseModeLabel = (p: LockPlan) =>
  p.mode === 'date'
    ? 'Unlock on a date'
    : p.mode === 'usd-target'
      ? `${fmtUsd(p.usdPerPayout ?? 0)} ${p.curve ? 'average ' : ''}target per payout`
      : p.mode === 'percent'
        ? `${p.pct}% of ${p.base === 'remaining' ? 'remaining' : 'original'}`
        : 'BSV per payout';

const CURVE_HINT: Record<CurveKind, string> = {
  linear: 'Every payout the same.',
  front: 'More early, then less. Steepness = how many times bigger the first payout is than the last.',
  back: 'Less early, more later, like a pension that grows. Steepness = how many times bigger the last payout is than the first.',
  's-curve': 'Slow, then fast, then slow. Higher steepness bunches more in the middle.',
  cliff: 'Nothing for the first payouts; at the cliff, everything owed so far, then equal payouts.',
  step: 'One payout every K periods, each worth K periods.',
  custom: 'Your own percentage for each payout, adding up to 100%.',
};

const CurvePicker = (p: {
  kind: CurveKind;
  onKind: (k: CurveKind) => void;
  steep: string;
  onSteep: (s: string) => void;
  cliff: string;
  onCliff: (s: string) => void;
  every: string;
  onEvery: (s: string) => void;
  custom: string;
  onCustom: (s: string) => void;
  usd: boolean;
}) => (
  <div className="flex flex-col gap-2">
    <Field label="Unlock curve">
      <select className={inputCls} value={p.kind} onChange={(e) => p.onKind(e.target.value as CurveKind)}>
        {(Object.keys(CURVE_NAMES) as CurveKind[]).map((k) => (
          <option key={k} value={k}>
            {CURVE_NAMES[k]}
          </option>
        ))}
      </select>
    </Field>
    {(p.kind === 'front' || p.kind === 'back' || p.kind === 's-curve') && (
      <Field label={p.kind === 's-curve' ? 'Steepness' : 'Steepness (×)'}>
        <input className={inputCls} inputMode="decimal" value={p.steep} onChange={(e) => p.onSteep(e.target.value)} />
      </Field>
    )}
    {p.kind === 'cliff' && (
      <Field label="Cliff (payouts with nothing)">
        <input className={inputCls} inputMode="numeric" value={p.cliff} onChange={(e) => p.onCliff(e.target.value)} />
      </Field>
    )}
    {p.kind === 'step' && (
      <Field label="One payout every K periods">
        <input className={inputCls} inputMode="numeric" value={p.every} onChange={(e) => p.onEvery(e.target.value)} />
      </Field>
    )}
    {p.kind === 'custom' && (
      <Field label="% per payout, comma separated (must add up to 100)">
        <textarea
          className={inputCls}
          rows={2}
          placeholder="e.g. 10, 20, 30, 40"
          value={p.custom}
          onChange={(e) => p.onCustom(e.target.value)}
        />
      </Field>
    )}
    <p className="text-[11px]" style={{ color: MUTED }}>
      {CURVE_HINT[p.kind]} The total is the same as {p.usd ? 'the dollars per payout' : 'the BSV per payout'} × the
      number of payouts; the curve only moves it between dates.
    </p>
  </div>
);

/** Amounts over time as a small bar chart. */
const Bars = ({ values }: { values: number[] }) => {
  const max = Math.max(...values, 1);
  const W = 300;
  const H = 48;
  const bw = W / values.length;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full h-12"
      role="img"
      aria-label="Payout amounts over time"
    >
      {values.map((v, i) => {
        const h = Math.max(1, (v / max) * H);
        return (
          <rect
            key={i}
            x={i * bw + bw * 0.1}
            y={H - h}
            width={Math.max(0.5, bw * 0.8)}
            height={h}
            rx={Math.min(2, bw * 0.2)}
            fill={GOLD}
          />
        );
      })}
    </svg>
  );
};

export const VerifyCard = ({ r }: { r: VerifyResult }) => (
  <div className="rounded-2xl p-4 flex flex-col gap-2" style={{ background: PANEL, border: `1px solid ${LINE}` }}>
    <div className="flex justify-between">
      <span className="text-sm font-bold text-white">{r.status}</span>
      <span className="text-xs" style={{ color: MUTED }}>
        {fmtBsv(r.totalSats)}
      </span>
    </div>
    <div
      className="text-xs flex items-center gap-1"
      style={{ color: r.receipt ? (r.receiptValid ? '#32D583' : '#F97066') : MUTED }}
    >
      {r.receipt ? r.receiptValid ? <Check size={14} /> : <AlertTriangle size={14} /> : null}
      {r.receipt
        ? r.receiptValid
          ? 'Receipt matches the lock outputs'
          : 'Receipt does NOT match the chain'
        : 'No receipt in this transaction'}
    </div>
    {r.description && <div className="text-xs text-white">{r.description}</div>}
    {r.receipt && (
      <div className="text-xs" style={{ color: MUTED }}>
        Locked by {r.receipt.identity.handle || r.receipt.identity.paymail || r.receipt.identity.address}
      </div>
    )}
    {r.problems.map((p, i) => (
      <div key={i} className="text-xs" style={{ color: '#F97066' }}>
        {p}
      </div>
    ))}
    <table className="w-full text-[11px] text-white">
      <tbody>
        {r.locks.slice(0, MAX_PIECES).map((l) => (
          <tr key={l.vout} style={{ borderTop: `1px solid ${LINE}` }}>
            <td className="py-1">#{l.vout}</td>
            <td>block {l.height}</td>
            <td className="text-right">{fmtBsv(l.sats)}</td>
            <td className="text-right" style={{ color: l.spent ? MUTED : '#32D583' }}>
              {l.spent ? 'claimed' : l.matured ? 'unlocked' : 'locked'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

export default LockScreen;
