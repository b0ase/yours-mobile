import { APP_NAME } from '../storeBuild';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ArrowLeft, Check, Eye, EyeOff, FileLock2, PenLine, ShieldCheck } from 'lucide-react';
import { accountNamesFor } from '../names/accountNames';
import { isAgentAccount } from '../agents/agentAccounts';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import {
  backupDownloadUrl,
  createBackupFile,
  saveBackupFile,
  saveRoute,
  WrongPasswordError,
  type SaveRoute,
} from './backupFile';
import {
  backupCovers,
  markBackedUp,
  pickQuizPositions,
  quizCorrect,
  type BackupExit,
  type BackupMethod,
} from './backupState';
import { ErrorActions } from '../errors/ErrorActions';

type Props = {
  /** How the user may leave without backing up (backupState.backupExit). */
  exit: BackupExit;
  /** Web app: copy says "this browser"; native: "this device". */
  web: boolean;
  onComplete: (method: BackupMethod) => void;
  /** Remind me later / Skip / Cancel / Close. */
  onExit: () => void;
};

type Page = 'choose' | 'file-password' | 'file-ready' | 'phrase-password' | 'phrase-show' | 'quiz' | 'done';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const RED = '#FDA29B';

const primary = (enabled = true) => ({ background: GOLD, color: '#000', opacity: enabled ? 1 : 0.4 }) as const;

/**
 * "Back up your wallet" (after create / restore, before Receive, from the Wallet banner).
 * Two ways: an encrypted backup file (the master backup, locked with the wallet password; shared
 * to Files / Mail / AirDrop where the browser can) or the recovery phrase written down and checked
 * with a 3-word quiz. The phrase lives only in this component's state while it is open.
 */
export const BackupStep = ({ exit, web, onComplete, onExit }: Props) => {
  const { chromeStorageService, keysService } = useServiceContext();
  const [page, setPage] = useState<Page>('choose');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // Share sheet failed: offer a plain download link (web only) and the recovery phrase.
  const [shareFailed, setShareFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [route, setRoute] = useState<SaveRoute>('none');
  const [savedOnce, setSavedOnce] = useState(false);
  const [words, setWords] = useState<string[]>([]);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(['', '', '']);
  const [method, setMethod] = useState<BackupMethod>('file');
  const [confirmSkip, setConfirmSkip] = useState(false);
  const where = web ? 'this browser' : 'this device';
  const [show, setShow] = useState(false);
  // The account this step backs up, fixed when it opens: the master backup walks every account and a switch
  // could happen meanwhile, so nothing below reads "the current account" again (owner, 6 Oct 2026).
  const [target] = useState(() => {
    const { account } = chromeStorageService.getCurrentAccountObject();
    const id = account?.addresses?.identityAddress ?? '';
    const names = accountNamesFor(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '');
    return { id, name: names.displayName || account?.name || 'this account', agent: isAgentAccount(id) };
  });
  // Every account in the wallet (the encrypted file holds them all). Read per render: storage can refresh later.
  const allIds = chromeStorageService
    .getAllAccounts()
    .map((a) => a.addresses?.identityAddress ?? (a as { address?: string }).address ?? '')
    .filter(Boolean);
  const others = allIds.filter((a) => a !== target.id).length;

  // Forget the phrase and file as soon as the sheet goes away.
  useEffect(
    () => () => {
      setWords([]);
      setFile(null);
    },
    [],
  );

  const go = (p: Page) => {
    setError('');
    setShow(false);
    setPassword('');
    setPage(p);
  };

  const finish = async (m: BackupMethod) => {
    setError('');
    try {
      await markBackedUp(chromeStorageService, m, Date.now(), backupCovers(m, target.id, allIds));
    } catch (e) {
      // Never a silent failure: say so and stay on this page.
      setError(`Couldn't mark ${target.name} as backed up (${e instanceof Error ? e.message : String(e)}). Try again.`);
      return;
    }
    setMethod(m);
    setWords([]);
    setFile(null);
    setPage('done');
  };

  const makeFile = async () => {
    setBusy(true);
    setError('');
    try {
      const f = await createBackupFile(chromeStorageService, password);
      setPassword('');
      setFile(f);
      setRoute(saveRoute(f, isNative));
      setPage('file-ready');
    } catch (e) {
      setError(e instanceof WrongPasswordError ? 'Incorrect password' : 'Could not make the backup. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveFile = async () => {
    if (!file) return;
    setError('');
    try {
      const ok = await saveBackupFile(file, route);
      if (ok) setSavedOnce(true);
    } catch (e) {
      const why = e instanceof Error ? `${e.name}${e.message ? `: ${e.message}` : ''}` : String(e);
      setError(`The share sheet didn't open (${why.slice(0, 120)}).`);
      setShareFailed(true);
    }
  };

  const revealPhrase = async () => {
    setBusy(true);
    setError('');
    try {
      const keys = await keysService.retrieveKeys(password);
      if (keys.identityAddress && target.id && keys.identityAddress !== target.id) {
        setPassword('');
        setError('The open account changed. Close this and start the backup again.');
        return;
      }
      const list = (keys.mnemonic ?? '').trim().split(/\s+/).filter(Boolean);
      setPassword('');
      if (!list.length) {
        setError('This account was imported without a recovery phrase. Save an encrypted backup instead.');
        return;
      }
      setWords(list);
      setPositions(pickQuizPositions(list.length, 3));
      setAnswers(['', '', '']);
      setPage('phrase-show');
    } catch {
      setError('Incorrect password');
    } finally {
      setBusy(false);
    }
  };

  const exitLabel =
    exit === 'remind-later' ? 'Remind me later' : exit === 'skip' ? 'Skip' : exit === 'cancel' ? 'Not now' : 'Close';

  const header = (title: string, back?: () => void) => (
    <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
      {back ? (
        <button onClick={back} aria-label="Back" className="p-2 bg-transparent border-0">
          <ArrowLeft size={20} color="white" />
        </button>
      ) : (
        <span className="w-9" />
      )}
      <span className="text-[16px] font-bold text-white">{title}</span>
    </div>
  );

  const passwordForm = (label: string, onSubmit: () => void) => (
    <form
      className="w-full flex flex-col items-center"
      onSubmit={(e) => {
        e.preventDefault();
        if (password && !busy) onSubmit();
      }}
    >
      <input type="text" name="username" autoComplete="username" value={APP_NAME} readOnly hidden />
      <div className="relative w-full">
        <input
          type={show ? 'text' : 'password'}
          name="password"
          autoComplete="current-password"
          placeholder="Your wallet password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-xl pl-4 pr-11 py-3 text-white outline-none"
          style={{ background: '#16181D', border: '1px solid #2A2E36' }}
          autoFocus
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-transparent border-0"
          style={{ color: MUTED }}
        >
          {show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {error && (
<div className="flex flex-col gap-1.5"><p className="text-xs mt-2 self-start" style={{ color: RED }}>
          {error}
        </p><ErrorActions message={String(error)} /></div>
)}
      <button
        type="submit"
        disabled={!password || busy}
        className="mt-5 w-full rounded-xl py-3 font-bold border-0"
        style={primary(!!password && !busy)}
      >
        {busy ? 'Working…' : label}
      </button>
    </form>
  );

  const accountChip = (
    <div className="mx-5 mb-1 flex items-center gap-2 text-xs" style={{ color: MUTED }}>
      <span>Account:</span>
      <span className="font-bold text-white truncate" data-testid="backup-account" data-accounts={allIds.length}>
        {target.name}
      </span>
      {target.agent && (
        <span
          className="rounded px-1.5 py-[1px] text-[10px] font-bold"
          style={{ background: '#7A5AF833', color: '#BDB4FE' }}
        >
          AGENT
        </span>
      )}
    </div>
  );
  const passwordNote = (
    <p className="text-xs mt-0 mb-4" style={{ color: MUTED }}>
      This is your existing wallet password, the one you unlock {APP_NAME} with. It's the same for every account; you
      don't make a new one here.
    </p>
  );

  let body: JSX.Element;
  if (page === 'choose') {
    body = (
      <>
        {header(`Back up ${target.name}`)}
        {accountChip}
        <div className="flex flex-col px-5 pb-10 overflow-y-auto">
          <div className="flex items-start gap-3 rounded-xl p-3 mt-2" style={{ background: '#2A1215' }}>
            <AlertTriangle size={20} color={RED} className="shrink-0 mt-0.5" />
            <p className="text-sm m-0" style={{ color: '#FECDCA' }}>
              This wallet lives only in {where}. If {web ? 'the browser clears its data' : 'you lose this device'}, the
              money is gone unless you have a backup.{web ? ' You need one before you can receive money.' : ''}
            </p>
          </div>
          <button
            onClick={() => go('file-password')}
            className="mt-5 flex items-start gap-3 rounded-2xl p-4 text-left border-0"
            style={{ background: '#16181D' }}
          >
            <FileLock2 size={24} color={GOLD} className="shrink-0" />
            <span>
              <span className="block font-bold text-white">Save an encrypted backup</span>
              <span className="block text-sm mt-1" style={{ color: MUTED }}>
                A file locked with your wallet password (the one you unlock with).{' '}
                {others > 0 ? `It holds all ${others + 1} accounts in this wallet, including ${target.name}. ` : ''}
                Save it to Files, email it to yourself or AirDrop it. Keep the password too: the file can't be opened
                without it.
              </span>
            </span>
          </button>
          <button
            onClick={() => go('phrase-password')}
            className="mt-3 flex items-start gap-3 rounded-2xl p-4 text-left border-0"
            style={{ background: '#16181D' }}
          >
            <PenLine size={24} color={GOLD} className="shrink-0" />
            <span>
              <span className="block font-bold text-white">Write down the recovery phrase</span>
              <span className="block text-sm mt-1" style={{ color: MUTED }}>
                {others > 0 ? `${target.name}'s own 12 words` : '12 words'} on paper restore
                {others > 0 ? ' this account' : ' this wallet'} anywhere, no password needed. Anyone with them can take
                the money, so keep them private.
              </span>
            </span>
          </button>
          <button
            onClick={() => void finish('imported')}
            className="mt-4 text-sm underline bg-transparent border-0 self-center"
            style={{ color: MUTED }}
          >
            I restored this wallet from my own phrase or backup
          </button>
          {error && (
<div className="flex flex-col gap-1.5"><p className="text-xs mt-2 text-center" style={{ color: RED }}>
              {error}
            </p><ErrorActions message={String(error)} /></div>
)}
          {exit !== 'none' && !confirmSkip && (
            <button
              onClick={() => (exit === 'skip' ? setConfirmSkip(true) : onExit())}
              className="mt-6 bg-transparent border-0 text-sm underline"
              style={{ color: MUTED }}
            >
              {exitLabel}
            </button>
          )}
          {exit === 'remind-later' && (
            <p className="text-xs text-center mt-2" style={{ color: MUTED }}>
              You'll still need a backup before you can receive money.
            </p>
          )}
          {confirmSkip && (
            <div className="mt-6 rounded-xl p-3" style={{ background: '#2A1215' }}>
              <p className="text-sm m-0" style={{ color: '#FECDCA' }}>
                Without a backup, losing {where} means losing this wallet and everything in it. No one, including us,
                can recover it.
              </p>
              <div className="flex gap-3 mt-3">
                <button
                  onClick={() => setConfirmSkip(false)}
                  className="flex-1 rounded-xl py-2.5 font-bold border-0"
                  style={primary()}
                >
                  Back up now
                </button>
                <button
                  onClick={onExit}
                  className="flex-1 rounded-xl py-2.5 font-bold border-0"
                  style={{ background: '#2A2E36', color: 'white' }}
                >
                  Skip anyway
                </button>
              </div>
            </div>
          )}
        </div>
      </>
    );
  } else if (page === 'file-password') {
    body = (
      <>
        {header('Encrypted backup', () => go('choose'))}
        {accountChip}
        <div className="flex flex-col px-5 pb-10">
          <p className="text-sm mt-2 mb-2" style={{ color: MUTED }}>
            Enter your wallet password. The backup file is locked with it, so you'll need the same password to restore
            from the file.{others > 0 ? ` The file holds all ${others + 1} accounts.` : ''}
          </p>
          {passwordNote}
          {passwordForm('Make backup file', () => void makeFile())}
        </div>
      </>
    );
  } else if (page === 'file-ready') {
    body = (
      <>
        {header('Save your backup', () => go('choose'))}
        <div className="flex flex-col px-5 pb-10">
          <div className="flex items-center gap-3 rounded-xl p-3 mt-2" style={{ background: '#16181D' }}>
            <FileLock2 size={22} color={GOLD} />
            <span className="text-sm text-white break-all">{file?.name}</span>
          </div>
          {route === 'none' ? (
            <p className="text-sm mt-4" style={{ color: RED }}>
              Saving files isn't available in this app yet. Go back and write down the recovery phrase instead.
            </p>
          ) : (
            <>
              <p className="text-sm mt-4" style={{ color: MUTED }}>
                {route === 'share'
                  ? 'Tap Save, then choose Save to Files, Mail (send it to yourself) or AirDrop. Somewhere off this phone is best.'
                  : 'Tap Save to download the file. Keep a copy somewhere other than this device.'}
              </p>
              <button
                onClick={() => void saveFile()}
                className="mt-5 w-full rounded-xl py-3 font-bold border-0"
                style={primary()}
              >
                {savedOnce ? 'Save another copy' : 'Save backup file'}
              </button>
              {error && (
<div className="flex flex-col gap-1.5"><p className="text-xs mt-2" style={{ color: RED }}>
                  {error}
                </p><ErrorActions message={String(error)} /></div>
)}
              {shareFailed && file && (
                <div className="flex flex-col gap-2 mt-3">
                  {!isNative && (
                    <a
                      href={backupDownloadUrl(file)}
                      download={file.name}
                      onClick={() => setSavedOnce(true)}
                      className="w-full rounded-xl py-3 font-bold text-center"
                      style={{ background: '#2A2E36', color: 'white' }}
                    >
                      Download the file instead
                    </a>
                  )}
                  <button
                    onClick={() => go('phrase-password')}
                    className="w-full rounded-xl py-3 font-bold border-0"
                    style={{ background: 'transparent', color: GOLD, border: `1px solid ${GOLD}88` }}
                  >
                    Write down the recovery phrase instead
                  </button>
                </div>
              )}
              {savedOnce && (
                <button
                  onClick={() => void finish('file')}
                  className="mt-3 w-full rounded-xl py-3 font-bold border-0"
                  style={{ background: '#2A2E36', color: 'white' }}
                >
                  I've saved it
                </button>
              )}
            </>
          )}
        </div>
      </>
    );
  } else if (page === 'phrase-password') {
    body = (
      <>
        {header('Recovery phrase', () => go('choose'))}
        {accountChip}
        <div className="flex flex-col px-5 pb-10">
          <p className="text-sm mt-2 mb-2" style={{ color: MUTED }}>
            Make sure no one can see your screen. Enter your wallet password to show {target.name}'s phrase.
          </p>
          {passwordNote}
          {passwordForm('Show recovery phrase', () => void revealPhrase())}
        </div>
      </>
    );
  } else if (page === 'phrase-show') {
    body = (
      <>
        {header(`${target.name}: write these words down`, () => go('choose'))}
        <div className="flex flex-col px-5 pb-10 overflow-y-auto">
          <p className="text-sm mt-2" style={{ color: MUTED }}>
            On paper, in order. Don't screenshot them or store them in notes or email.
          </p>
          <ol className="grid grid-cols-3 gap-2 mt-4 p-0 list-none" data-private="true">
            {words.map((w, i) => (
              <li key={i} className="rounded-lg px-2 py-2 text-sm text-white" style={{ background: '#16181D' }}>
                <span style={{ color: MUTED }}>{i + 1}.</span> {w}
              </li>
            ))}
          </ol>
          <button
            onClick={() => setPage('quiz')}
            className="mt-6 w-full rounded-xl py-3 font-bold border-0"
            style={primary()}
          >
            I've written them down
          </button>
        </div>
      </>
    );
  } else if (page === 'quiz') {
    const ok = quizCorrect(words, positions, answers);
    body = (
      <>
        {header('Check your words', () => setPage('phrase-show'))}
        <form
          className="flex flex-col px-5 pb-10"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) void finish('phrase');
            else setError("That doesn't match. Check your paper, or go back to see the words again.");
          }}
        >
          <p className="text-sm mt-2 mb-3" style={{ color: MUTED }}>
            Type these words from your paper.
          </p>
          {positions.map((p, i) => (
            <label key={p} className="flex items-center gap-3 mt-2">
              <span className="w-16 text-sm text-white">Word {p + 1}</span>
              <input
                value={answers[i]}
                onChange={(e) => {
                  const next = [...answers];
                  next[i] = e.target.value;
                  setAnswers(next);
                  setError('');
                }}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                className="flex-1 rounded-xl px-3 py-2.5 text-white outline-none"
                style={{ background: '#16181D', border: '1px solid #2A2E36' }}
              />
            </label>
          ))}
          {error && (
<div className="flex flex-col gap-1.5"><p className="text-xs mt-3" style={{ color: RED }}>
              {error}
            </p><ErrorActions message={String(error)} /></div>
)}
          <button
            type="submit"
            disabled={answers.some((a) => !a.trim())}
            className="mt-6 w-full rounded-xl py-3 font-bold border-0"
            style={primary(!answers.some((a) => !a.trim()))}
          >
            Confirm
          </button>
        </form>
      </>
    );
  } else {
    body = (
      <div className="flex flex-col items-center text-center px-6" style={{ paddingTop: '20vh' }}>
        <ShieldCheck size={44} color="#2ecc71" />
        <p className="mt-3 text-lg font-bold text-white" data-testid="backup-done">
          Backed up ✓ {target.name}
        </p>
        {method === 'file' && others > 0 && (
          <p className="mt-1 text-sm" style={{ color: '#2ecc71' }}>
            The file also covers your other {others} account{others === 1 ? '' : 's'}.
          </p>
        )}
        <p className="mt-2 text-sm" style={{ color: MUTED }}>
          {method === 'file'
            ? 'Keep the file and your wallet password. Together they restore this wallet on any device.'
            : method === 'imported'
              ? 'Keep the phrase or backup you restored from safe and private. It restores this wallet on any device.'
              : 'Keep the paper safe and private. Those words restore this wallet on any device.'}
        </p>
        <button
          onClick={() => onComplete(method)}
          className="mt-8 w-full rounded-xl py-3 font-bold border-0"
          style={primary()}
        >
          <Check size={16} className="inline mr-1" /> Continue
        </button>
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-x-0 bottom-0 z-[450] flex flex-col overflow-y-auto"
      // Below the web app's beta banner (src/web/web.css); 0 in the apps.
      style={{ top: 'var(--web-banner-height, 0px)', background: '#010101' }}
      role="dialog"
      aria-modal="true"
    >
      {body}
    </div>,
    document.body,
  );
};
