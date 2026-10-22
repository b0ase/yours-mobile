/**
 * Wallet › token row › swipe › Lock: lock BSV-21 tokens until a date (vesting, savings), list this
 * token's locks with a countdown, unlock them when ready, and show / share the on-chain receipt.
 * Launchpad coins that have not graduated are ordinary BSV-21 outputs and lock the same way.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Copy, Lock as LockIcon, Search, Unlock, X } from 'lucide-react';
import type { Bsv21Balance } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { useAccountNames } from '../names/accountNames';
import { OVERLAY_ISSUES, bsv21ErrorMessage } from '../../utils/bsv21SendErrors';
import { dateForHeight, heightForDate, MAX_LOCK_BLOCKS } from './schedule';
import { fmtToken, fmtUnits, VERIFY_URL } from './receipt';
import { verifyLockTx, type VerifyResult } from './verify';
import { canUnlock, countdown, loadTokenLocks, parseTokenAmount, type TokenLockRecord } from './tokenLocks';
import { TokenLockError, createTokenLock, unlockTokenLock } from './tokenLockApi';
import { scanLine, useTokenLockScan } from './useTokenLockScan';

const GOLD = 'var(--bw-accent)';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const RED = '#F97066';
const GREEN = '#32D583';

const inputCls =
  'w-full min-w-0 rounded-xl px-3 py-2 text-sm text-white bg-[#0d0e11] border border-[#2b2f36] outline-none focus:border-[color:var(--bw-accent)]';
const dayInput = (d: Date) => d.toISOString().slice(0, 10);
const fmtDate = (d: Date) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const verifyLink = (txid: string) => `${VERIFY_URL}?tx=${txid}`;

type Step = 'form' | 'confirm';

export const TokenLockSheet = ({
  token,
  onClose,
  onDone,
}: {
  token: Bsv21Balance;
  onClose: () => void;
  onDone?: () => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const acct = chromeStorageService.getCurrentAccountObject().account;
  const account = acct?.addresses.identityAddress ?? '';
  const names = useAccountNames(account, acct?.name ?? '', acct?.settings?.socialProfile?.displayName ?? '');
  const sym = token.sym || 'tokens';
  const dec = token.dec || 0;
  const confirmed = token.all.confirmed;

  const [height, setHeight] = useState(0);
  const [locks, setLocks] = useState<TokenLockRecord[]>(() =>
    loadTokenLocks(account, chromeStorageService).filter((r) => r.tokenId === token.id),
  );
  const [step, setStep] = useState<Step>('form');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(() => dayInput(new Date(Date.now() + 30 * 86_400_000)));
  const [label, setLabel] = useState('Vesting');
  const [receipt, setReceipt] = useState(true);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [overlayIssue, setOverlayIssue] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, VerifyResult | string>>({});

  const reload = useCallback(
    () => setLocks(loadTokenLocks(account, chromeStorageService).filter((r) => r.tokenId === token.id)),
    [account, chromeStorageService, token.id],
  );
  // A restored wallet / new device: look on chain once when this token shows no locks here yet.
  const [autoScan] = useState(() => locks.length === 0);
  const scan = useTokenLockScan(apiContext, account, chromeStorageService, reload, autoScan);
  const scanText = scanLine(scan.state);

  useEffect(() => {
    let live = true;
    const tick = () =>
      apiContext.services?.chaintracks
        .currentHeight()
        .then((h) => live && setHeight(h))
        .catch(() => undefined);
    void tick();
    const t = setInterval(tick, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [apiContext]);

  const now = new Date();
  const amt = parseTokenAmount(amount, dec);
  const until = height ? heightForDate(new Date(`${date}T12:00:00`), now, height) : 0;
  const problem = useMemo(() => {
    if (!height) return 'Reading the block height…';
    if (amount && amt == null) return `Enter an amount with at most ${dec} decimal places.`;
    if (amt != null && amt > confirmed) return `You have ${fmtToken({ amt: String(confirmed), dec, sym })} confirmed.`;
    if (until - height < 1) return 'Pick a date in the future.';
    if (until - height > MAX_LOCK_BLOCKS) return 'Locks can be at most 10 years.';
    return null;
  }, [height, amount, amt, dec, confirmed, sym, until]);
  const ready = !!amt && !problem;

  const doLock = async (validateOverlay: boolean) => {
    if (!ready || typed !== 'LOCK' || !amt) return;
    setBusy(true);
    try {
      await createTokenLock(
        apiContext,
        account,
        {
          token: { id: token.id, sym: token.sym, dec, icon: token.icon },
          amt,
          until,
          label,
          receipt: receipt
            ? {
                handle: names.handle || undefined,
                paymail: names.paymail || undefined,
                idKey: acct?.pubKeys?.identityPubKey,
                address: account,
              }
            : undefined,
          validateOverlay,
        },
        chromeStorageService,
      );
      addSnackbar(`Locked ${fmtToken({ amt: String(amt), dec, sym })} until block ${until}.`, 'success');
      setStep('form');
      setTyped('');
      setAmount('');
      setOverlayIssue(null);
      reload();
      onDone?.();
    } catch (e) {
      const code = e instanceof TokenLockError ? e.code : '';
      if (validateOverlay && OVERLAY_ISSUES[code]) setOverlayIssue(code);
      else addSnackbar(bsv21ErrorMessage(code, sym) ?? (e instanceof Error ? e.message : 'Lock failed.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doUnlock = async (r: TokenLockRecord) => {
    setBusy(true);
    try {
      const txid = await unlockTokenLock(apiContext, account, r, chromeStorageService);
      addSnackbar(`Unlocked. ${sym} are back in your wallet (${txid.slice(0, 8)}…).`, 'success');
      reload();
      onDone?.();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Unlock failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const doVerify = async (r: TokenLockRecord) => {
    const txid = r.outpoint.split('.')[0];
    try {
      const v = await verifyLockTx(txid);
      setVerified((m) => ({ ...m, [r.outpoint]: v }));
    } catch (e) {
      setVerified((m) => ({ ...m, [r.outpoint]: e instanceof Error ? e.message : 'Could not verify.' }));
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => addSnackbar('Link copied.', 'success', 1500),
      () => addSnackbar(text, 'info', 6000),
    );
  };

  const issueText: Record<string, string> = {
    'token-not-active': `The BSV-21 indexer is not tracking ${sym} yet (common for new launchpad coins), so it cannot confirm your coins are valid before locking.`,
    'tokens-queued': `Some of your ${sym} are still waiting to be indexed. Waiting a few minutes is safest.`,
    'insufficient-valid-tokens': `The indexer does not see enough valid ${sym} in this wallet.`,
    'token-not-found': `Couldn't reach the token indexer.`,
  };

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/70" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-t-3xl p-5 flex flex-col gap-4"
        style={{ background: '#0b0b0c', borderTop: `1px solid ${LINE}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-white font-bold text-lg">
            <LockIcon size={18} color="var(--bw-accent)" /> Lock {sym}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>

        {locks.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-bold" style={{ color: MUTED }}>
              Your {sym} locks
            </div>
            {locks.map((r) => {
              const txid = r.outpoint.split('.')[0];
              const v = verified[r.outpoint];
              const open = !r.unlockedTxid && height > 0 && canUnlock(r.until, height);
              return (
                <div
                  key={r.outpoint}
                  className="rounded-2xl p-3 flex flex-col gap-2"
                  style={{ background: PANEL, border: `1px solid ${LINE}` }}
                >
                  <div className="flex justify-between gap-2">
                    <span className="text-sm font-bold text-white truncate">{r.label}</span>
                    <span className="text-sm text-white">{fmtToken(r)}</span>
                  </div>
                  <div className="flex justify-between text-xs" style={{ color: MUTED }}>
                    <span>
                      Block {r.until}
                      {height ? ` · ~${fmtDate(dateForHeight(r.until, now, height))}` : ''}
                    </span>
                    <span style={{ color: r.unlockedTxid ? MUTED : open ? GREEN : GOLD }}>
                      {r.unlockedTxid ? 'Unlocked' : height ? countdown(r.until, height) : '…'}
                    </span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {open && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void doUnlock(r)}
                        className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold"
                        style={{ background: GOLD, color: '#1a1300' }}
                      >
                        <Unlock size={13} /> Unlock
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void doVerify(r)}
                      className="rounded-lg px-3 py-1.5 text-xs font-bold text-white"
                      style={{ border: `1px solid ${LINE}` }}
                    >
                      Check on chain
                    </button>
                    <button
                      type="button"
                      onClick={() => copy(verifyLink(txid))}
                      className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold text-white"
                      style={{ border: `1px solid ${LINE}` }}
                    >
                      <Copy size={12} /> Share proof
                    </button>
                  </div>
                  {typeof v === 'string' && (
                    <div className="text-xs" style={{ color: RED }}>
                      {v}
                    </div>
                  )}
                  {v && typeof v !== 'string' && <ProofLines r={v} dec={r.dec} sym={r.sym} />}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <button
            type="button"
            disabled={scan.state.kind === 'scanning'}
            onClick={() => void scan.run()}
            className="self-start flex items-center gap-1 text-xs font-bold"
            style={{ color: scan.state.kind === 'scanning' ? MUTED : GOLD }}
          >
            <Search size={13} /> {scan.state.kind === 'scanning' ? 'Searching the chain…' : 'Find my token locks'}
          </button>
          {scanText && (
            <div className="text-xs" style={{ color: scan.state.kind === 'error' ? RED : MUTED }}>
              {scanText}
            </div>
          )}
        </div>

        {step === 'form' && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-xs" style={{ color: MUTED }}>
              Amount ({fmtToken({ amt: String(confirmed), dec, sym })} confirmed)
              <div className="flex gap-2">
                <input
                  className={inputCls}
                  inputMode="decimal"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button
                  type="button"
                  className="rounded-xl px-3 text-xs font-bold text-white"
                  style={{ border: `1px solid ${LINE}` }}
                  onClick={() => setAmount(fmtUnits(confirmed, dec, false))}
                >
                  Max
                </button>
              </div>
            </label>
            <label className="flex flex-col gap-1 text-xs" style={{ color: MUTED }}>
              Unlock on
              <input
                className={inputCls}
                type="date"
                value={date}
                min={dayInput(new Date(Date.now() + 86_400_000))}
                onChange={(e) => setDate(e.target.value)}
              />
              {height > 0 && until > height && (
                <span>
                  Block {until}, about {fmtDate(dateForHeight(until, now, height))}. Blocks are about 10 minutes, so the
                  real day can drift a little.
                </span>
              )}
            </label>
            <label className="flex flex-col gap-1 text-xs" style={{ color: MUTED }}>
              Label
              <input className={inputCls} maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="flex items-center gap-2 text-xs text-white">
              <input type="checkbox" checked={receipt} onChange={(e) => setReceipt(e.target.checked)} />
              Mint a public receipt (amount, unlock block and your identity), checkable by anyone on chain
            </label>
            {problem && amount && (
              <div className="text-xs" style={{ color: RED }}>
                {problem}
              </div>
            )}
            <button
              type="button"
              disabled={!ready}
              onClick={() => setStep('confirm')}
              className="rounded-xl py-3 text-sm font-bold"
              style={{ background: ready ? GOLD : '#2b2f36', color: ready ? '#1a1300' : MUTED }}
            >
              Review
            </button>
          </div>
        )}

        {step === 'confirm' && amt != null && (
          <div className="flex flex-col gap-3">
            <div
              className="rounded-2xl p-4 flex flex-col gap-2 text-sm text-white"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            >
              <div className="text-xl font-extrabold">{fmtToken({ amt: String(amt), dec, sym })}</div>
              <div>
                Locked until block {until} (about {fmtDate(dateForHeight(until, now, height))}).
              </div>
              <div style={{ color: MUTED }} className="text-xs">
                Nobody, including you, can move these tokens before then. After that only your wallet can unlock them,
                with a key from your recovery phrase. On a restored wallet or a new device, Find my token locks (here or
                in Pots &amp; Locks) lists them again from the chain.
              </div>
              <div style={{ color: GOLD }} className="text-xs flex items-center gap-1">
                <AlertTriangle size={13} /> New feature: test with a small amount first.
              </div>
            </div>
            {overlayIssue && (
              <div
                className="rounded-2xl p-3 flex flex-col gap-2 text-xs"
                style={{ border: `1px solid ${RED}`, color: '#F2F2F0' }}
              >
                <div>{issueText[overlayIssue] ?? 'The token indexer could not check these tokens.'}</div>
                {overlayIssue === 'token-not-active' && (
                  <>
                    <div style={{ color: MUTED }}>
                      You can still lock them. If any coin you lock turns out to be invalid, the locked tokens will be
                      invalid too.
                    </div>
                    <button
                      type="button"
                      disabled={busy || typed !== 'LOCK'}
                      onClick={() => void doLock(false)}
                      className="rounded-lg py-2 font-bold"
                      style={{ border: `1px solid ${GOLD}`, color: GOLD }}
                    >
                      Lock without the indexer check
                    </button>
                  </>
                )}
              </div>
            )}
            <label className="flex flex-col gap-1 text-xs" style={{ color: MUTED }}>
              Type LOCK to confirm
              <input
                className={inputCls}
                autoCapitalize="characters"
                value={typed}
                onChange={(e) => setTyped(e.target.value.toUpperCase())}
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setStep('form');
                  setOverlayIssue(null);
                }}
                className="flex-1 rounded-xl py-3 text-sm font-bold text-white"
                style={{ border: `1px solid ${LINE}` }}
              >
                Back
              </button>
              <button
                type="button"
                disabled={busy || typed !== 'LOCK'}
                onClick={() => void doLock(true)}
                className="flex-1 rounded-xl py-3 text-sm font-bold"
                style={{ background: typed === 'LOCK' ? GOLD : '#2b2f36', color: typed === 'LOCK' ? '#1a1300' : MUTED }}
              >
                {busy ? 'Locking…' : `Lock ${sym}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

/** What the chain says about one lock transaction, in a few lines. */
const ProofLines = ({ r, dec, sym }: { r: VerifyResult; dec: number; sym?: string }) => {
  const tl = r.locks.find((l) => l.token);
  return (
    <div className="text-xs flex flex-col gap-1" style={{ color: MUTED }}>
      <div className="flex items-center gap-1" style={{ color: r.receipt ? (r.receiptValid ? GREEN : RED) : MUTED }}>
        {r.receipt ? r.receiptValid ? <Check size={13} /> : <AlertTriangle size={13} /> : null}
        {r.receipt
          ? r.receiptValid
            ? 'Receipt matches the chain'
            : 'Receipt does NOT match the chain'
          : 'No receipt in this transaction'}
      </div>
      {tl?.token && (
        <div className="text-white">
          {fmtToken({ amt: tl.token.amt, dec, sym })} locked to {tl.address.slice(0, 8)}… until block {tl.height} ·{' '}
          {tl.spent ? 'unlocked' : tl.matured ? 'ready' : 'locked'}
        </div>
      )}
      {r.problems.map((p, i) => (
        <div key={i} style={{ color: RED }}>
          {p}
        </div>
      ))}
    </div>
  );
};

export default TokenLockSheet;
