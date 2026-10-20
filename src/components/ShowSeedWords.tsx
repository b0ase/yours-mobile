import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Copy, Eye, Fingerprint, Lock } from 'lucide-react';
import { getPlatform } from '../platform';
import { copyWithAutoClear, revealSeed, SeedRevealError } from '../utils/seedReveal';

/**
 * Settings › Show my 12 words (owner, 19 Oct 2026). Warning → password (or Face ID / fingerprint where it is set up)
 * → the words of the CURRENT account in a numbered grid, blurred until tapped. The words live only in this
 * component's state and are dropped on close and on unmount; they are never logged or sent anywhere.
 *
 * Screenshots: Android release builds already set FLAG_SECURE on the whole app (MainActivity.java). iOS has no
 * secure-view plugin in this project, so nothing stops a screenshot there.
 */
export type ShowSeedWordsProps = {
  /** "$handle" or the account name, shown at the top so the user knows which wallet these words are for. */
  accountLabel: string;
  verifyPassword: (password: string) => Promise<boolean>;
  readMnemonic: () => Promise<string | undefined>;
  onDone: () => void;
  onCopied?: (text: string) => void;
};

type Step = 'warn' | 'confirm' | 'show';

const CARD = { backgroundColor: 'var(--bw-surface, #17191E)', border: '1px solid rgba(152,162,179,0.15)' };
const MUTED = { color: 'var(--bw-muted, #98A2B3)' };
const TEXT = { color: 'var(--bw-text, #FFFFFF)' };

export const ShowSeedWords = ({ accountLabel, verifyPassword, readMnemonic, onDone, onCopied }: ShowSeedWordsProps) => {
  const [step, setStep] = useState<Step>('warn');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const cancelClear = useRef<(() => void) | undefined>(undefined);
  const quick = getPlatform().quickUnlock;
  const [bioReady, setBioReady] = useState(false);

  useEffect(() => {
    let live = true;
    if (quick?.verify)
      void quick
        .isAvailable()
        .then((ok) => live && setBioReady(ok))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [quick]);

  // Drop the words when this screen goes away. The clipboard clear keeps running so a copy is still emptied.
  useEffect(
    () => () => {
      setWords([]);
      setPassword('');
    },
    [],
  );

  const reveal = async (opts: { password?: string; verified?: boolean }) => {
    setBusy(true);
    setError('');
    try {
      const w = await revealSeed({ verifyPassword, readMnemonic }, opts);
      setPassword('');
      setWords(w);
      setRevealed(false);
      setStep('show');
    } catch (e) {
      setError(e instanceof SeedRevealError ? e.message : 'Could not read the recovery phrase');
    } finally {
      setBusy(false);
    }
  };

  const confirmWithBiometrics = async () => {
    if (!quick?.verify) return;
    const ok = await quick.verify('Show your 12 words').catch(() => false);
    if (ok) await reveal({ verified: true });
    else setError('Not confirmed. Use your password.');
  };

  const copy = async () => {
    try {
      cancelClear.current?.();
      cancelClear.current = await copyWithAutoClear(words.join(' '), navigator.clipboard);
      onCopied?.('Copied. The clipboard is cleared in 60 seconds.');
    } catch {
      onCopied?.('Copy failed. Write the words down instead.');
    }
  };

  const close = () => {
    setWords([]);
    setRevealed(false);
    onDone();
  };

  const header = (
    <div className="rounded-xl px-4 py-3 mb-4 flex items-center gap-3" style={CARD}>
      <Lock size={16} style={{ color: 'var(--bw-accent-hi, #A1FF8B)' }} />
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-widest m-0" style={MUTED}>
          Recovery phrase for
        </p>
        <p className="text-sm font-semibold m-0 truncate" style={TEXT} data-testid="seed-account">
          {accountLabel}
        </p>
      </div>
    </div>
  );

  const primary =
    'w-full py-3 rounded-xl text-sm font-semibold border-0 cursor-pointer disabled:opacity-50 disabled:cursor-default';
  const primaryStyle = { background: 'var(--bw-accent-hi, #A1FF8B)', color: '#111' };
  const secondary = 'w-full py-3 rounded-xl text-sm font-semibold cursor-pointer bg-transparent';
  const secondaryStyle = { ...TEXT, border: '1px solid rgba(152,162,179,0.3)' };

  if (step === 'warn') {
    return (
      <div className="w-full">
        {header}
        <div
          className="rounded-xl p-4 mb-4"
          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={18} color="#ef4444" />
            <p className="text-sm font-bold m-0" style={TEXT}>
              Keep these words secret
            </p>
          </div>
          <ul className="text-xs leading-relaxed m-0 pl-4 space-y-1" style={MUTED}>
            <li>Anyone with these 12 words can take everything in this account.</li>
            <li>Never share them, type them into a website or send them in a chat.</li>
            <li>We will never ask for them. Nobody from bWalletX, b or support ever will.</li>
            <li>Write them on paper and keep it somewhere safe. Check nobody can see your screen.</li>
          </ul>
        </div>
        <button className={primary} style={primaryStyle} onClick={() => setStep('confirm')}>
          I understand, continue
        </button>
        <button className={`${secondary} mt-2`} style={secondaryStyle} onClick={close}>
          Cancel
        </button>
      </div>
    );
  }

  if (step === 'confirm') {
    return (
      <div className="w-full">
        {header}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void reveal({ password });
          }}
        >
          <label className="block text-xs mb-2" style={MUTED} htmlFor="seed-password">
            Enter your wallet password to see the words
          </label>
          <input
            id="seed-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            className="w-full rounded-xl px-3 py-3 text-sm mb-2 outline-none"
            style={{ ...CARD, ...TEXT }}
            placeholder="Password"
          />
          {error && (
            <p className="text-xs mb-2" style={{ color: '#ef4444' }} role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={`${primary} mt-2`} style={primaryStyle} disabled={busy || !password}>
            {busy ? 'Checking…' : 'Show my 12 words'}
          </button>
        </form>
        {bioReady && quick?.verify && (
          <button
            className={`${secondary} mt-2 flex items-center justify-center gap-2`}
            style={secondaryStyle}
            onClick={() => void confirmWithBiometrics()}
            disabled={busy}
          >
            <Fingerprint size={16} /> {quick.label}
          </button>
        )}
        <button className={`${secondary} mt-2`} style={secondaryStyle} onClick={close}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="w-full">
      {header}
      <div className="relative">
        <ol
          className="grid grid-cols-3 gap-2 list-none m-0 p-0 select-none"
          style={{ filter: revealed ? 'none' : 'blur(7px)', transition: 'filter 0.2s' }}
          aria-hidden={!revealed}
          data-testid="seed-grid"
        >
          {words.map((w, i) => (
            <li key={i} className="rounded-lg px-2 py-2 flex items-baseline gap-1.5" style={CARD}>
              <span className="text-[10px] w-4 text-right" style={MUTED}>
                {i + 1}
              </span>
              <span className="text-sm font-mono font-semibold" style={TEXT}>
                {revealed ? w : '••••••'}
              </span>
            </li>
          ))}
        </ol>
        {!revealed && (
          <button
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-transparent border-0 cursor-pointer"
            onClick={() => setRevealed(true)}
          >
            <Eye size={20} style={TEXT} />
            <span className="text-sm font-semibold" style={TEXT}>
              Tap to reveal
            </span>
            <span className="text-[11px]" style={MUTED}>
              Make sure nobody can see your screen
            </span>
          </button>
        )}
      </div>
      <p className="text-[11px] mt-3 mb-3" style={MUTED}>
        Write the words down in this order. With them you can restore this account in bWalletX on any device.
      </p>
      <button
        className={`${secondary} flex items-center justify-center gap-2`}
        style={secondaryStyle}
        onClick={() => void copy()}
        disabled={!revealed}
      >
        <Copy size={14} /> Copy (cleared after 60 s)
      </button>
      <button className={`${primary} mt-2`} style={primaryStyle} onClick={close}>
        I&apos;ve written them down
      </button>
    </div>
  );
};
