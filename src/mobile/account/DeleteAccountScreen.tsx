/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { loadSession } from '../chat/api';
import { walletSigner } from '../chat/signer';
import { YoursNative } from '../native';
import { wipeLocalWallet } from '../forgot/wipe';
import { deleteKey } from '../agent/keyStore';
import { PROVIDER_IDS } from '../agent/providers';
import { openDappBrowser } from '../dappBrowser';
import { DELETE_ACCOUNT_URL, SUPPORT_EMAIL } from '../ugc/ugc';
import { confirmMatches, deleteAccount, type DeleteStep } from './deleteAccount';
import { ErrorActions } from '../errors/ErrorActions';

const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const RED = '#ff6b6b';

const DELETED = [
  'Your name@bwalletx.com paymail and $handle registration',
  'Your bChat profile, contacts, blocks and chat settings',
  'Your direct messages, and your messages in ordinary chat rooms',
  'Notification tokens, b agent payment quotes, call history and other records tied to your identity key',
  'This account’s data on this phone (its keys too, unless you have other accounts here)',
];
const KEPT = [
  'Anything on the blockchain: transactions, tokens, NFTs, inscriptions and on-chain posts are public and permanent. Nobody, including us, can delete them.',
  'Records the law requires us to keep (identity verification, signed agreements, company registers).',
];
const STEP_TEXT: Record<DeleteStep, string> = {
  paymail: 'Deleting your paymail…',
  bchat: 'Deleting your bChat account…',
  local: 'Removing it from this phone…',
};

/** Settings › Delete account. */
export const DeleteAccountScreen = ({ onBack }: { onBack: () => void }) => {
  const { apiContext, chromeStorageService } = useServiceContext() as any;
  const [busy, setBusy] = useState(false);
  useBackClose(true, () => !busy && onBack());
  const [handle, setHandle] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<DeleteStep | null>(null);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<string[] | null>(null);

  // The $handle to type, only if the saved bChat session is THIS account's.
  useEffect(() => {
    let live = true;
    const s = loadSession();
    if (!apiContext || !s) return;
    void walletSigner(apiContext)
      .address()
      .then((a) => live && a === s.address && setHandle(s.handle))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext]);

  const accounts: { addresses: { identityAddress: string } }[] = chromeStorageService?.getAllAccounts?.() ?? [];
  const current: string | undefined = chromeStorageService?.getCurrentAccountObject?.()?.selectedAccount;
  const others = accounts.filter((a) => a.addresses.identityAddress !== current);

  /** Last step: take the account off this phone (the whole wallet when it is the only one). */
  const removeFromDevice = async () => {
    if (current && others.length) {
      const next = others[0].addresses.identityAddress;
      await chromeStorageService.switchAccount(next);
      try {
        indexedDB.deleteDatabase(`txos-${current}-${chromeStorageService.getNetwork()}`);
      } catch {
        /* best effort */
      }
      await chromeStorageService.removeNested('accounts', current);
    } else {
      for (const p of PROVIDER_IDS) await deleteKey(p).catch(() => undefined);
      await wipeLocalWallet({ chrome: (globalThis as any).chrome, native: YoursNative, restore: false });
    }
    window.location.reload();
  };

  const run = async () => {
    if (!apiContext) return setError('Unlock the wallet first.');
    setBusy(true);
    setError('');
    try {
      const r = await deleteAccount(apiContext, { onStep: setStep });
      setNotes(r.notes);
      setStep(null);
    } catch (e) {
      setStep(null);
      setError(
        `${e instanceof Error ? e.message : String(e)} Nothing was removed from this phone. Try again, or email ${SUPPORT_EMAIL}.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const ok = confirmMatches(typed, handle);
  const list = (items: string[], color: string) => (
    <ul className="flex flex-col gap-1.5">
      {items.map((t) => (
        <li key={t} className="flex gap-2 text-[13px] leading-snug text-white">
          <span style={{ color }}>•</span>
          <span>{t}</span>
        </li>
      ))}
    </ul>
  );

  return createPortal(
    <div className="fixed inset-0 z-[150] flex flex-col" style={{ background: '#010101' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={onBack} disabled={busy} aria-label="Back" className="p-2 disabled:opacity-40">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Delete account</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 pb-24 flex flex-col gap-4">
        {notes ? (
          <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: PANEL }}>
            <div className="text-base font-bold text-white">Your account is deleted</div>
            {notes.map((n) => (
              <p key={n} className="text-xs" style={{ color: MUTED }}>
                {n}
              </p>
            ))}
            <p className="text-xs" style={{ color: MUTED }}>
              {others.length
                ? 'Next, this account is removed from this phone and bWallet switches to your other account.'
                : 'Next, the wallet is removed from this phone. Funds stay on the blockchain and can only be recovered with your recovery phrase.'}
            </p>
            <button
              onClick={() => void removeFromDevice()}
              className="rounded-full py-3 text-sm font-bold"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              {others.length ? 'Remove it from this phone' : 'Remove the wallet from this phone'}
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-2xl p-4 flex flex-col gap-2" style={{ background: PANEL }}>
              <div className="text-sm font-bold text-white">What is deleted</div>
              {list(DELETED, RED)}
            </div>
            <div className="rounded-2xl p-4 flex flex-col gap-2" style={{ background: PANEL }}>
              <div className="text-sm font-bold text-white">What can’t be deleted</div>
              {list(KEPT, MUTED)}
            </div>
            <div
              className="rounded-2xl p-4 flex flex-col gap-2"
              style={{ background: PANEL, border: `1px solid ${GOLD}55` }}
            >
              <div className="text-sm font-bold" style={{ color: GOLD }}>
                Back up first
              </div>
              <p className="text-[13px] leading-snug text-white">
                Your funds are not deleted: they stay on the blockchain. Without your recovery phrase you will lose
                access to them. Settings › Wallet Backup.
              </p>
            </div>
            <label className="text-xs font-semibold" style={{ color: MUTED }} htmlFor="delete-confirm">
              {handle ? `Type $${handle} or DELETE to confirm` : 'Type DELETE to confirm'}
            </label>
            <input
              id="delete-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
              className="w-full rounded-xl px-3 py-2.5 text-sm text-white outline-none"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            />
            {error && (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs" style={{ color: RED }}>
                  {error}
                </p>
                <ErrorActions message={String(error)} />
              </div>
            )}
            <button
              onClick={() => void run()}
              disabled={!ok || busy}
              className="rounded-full py-3 text-sm font-bold disabled:opacity-40 flex items-center justify-center gap-2"
              style={{ background: RED, color: '#1a0000' }}
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {busy && step ? STEP_TEXT[step] : 'Delete my account'}
            </button>
            <p className="text-[11px]" style={{ color: MUTED }}>
              The request is signed with this account’s identity key. More detail:{' '}
              <button
                onClick={() => void openDappBrowser(DELETE_ACCOUNT_URL)}
                className="underline"
                style={{ color: GOLD }}
              >
                bitcoinchat.online/delete-account
              </button>
              . Questions: {SUPPORT_EMAIL}
            </p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};
