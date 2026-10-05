import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isIosWebApp, isWebApp } from '../webApp';
import { BackupStep } from './BackupStep';
import {
  backupExit,
  balancePromptShown,
  clearBackupPrompt,
  currentBackupSettings,
  isBackedUp,
  markBackupChecked,
  onBackupChange,
  pendingBackupPrompt,
  registerBackupOpener,
  reminderDue,
  reminderShownThisSession,
  setBalancePromptShown,
  setReminderShown,
  shouldOpenForBalance,
  type BackupRequest,
} from './backupState';

/**
 * Wallet tab (build-time insert into BsvWallet.tsx, above the balance card):
 *  - opens the Backup step after create / restore (flag from markHandlePrompt → markBackupPrompt);
 *  - a red, non-dismissable "Not backed up" banner until the account has a backup;
 *  - the Receive gate (requestBackupThen) and, on the web app, once per session when money arrives;
 *  - iPhone web app: "Still have your backup?" every 30 days.
 */
export const BackupGate = ({ sats }: { sats: number }) => {
  const { chromeStorageService } = useServiceContext();
  const web = isWebApp();
  const [settings, setSettings] = useState(() => currentBackupSettings(chromeStorageService));
  const [request, setRequest] = useState<BackupRequest | null>(null);
  const [reminder, setReminder] = useState(false);
  const backedUp = isBackedUp(settings);

  useEffect(() => {
    const update = () => setSettings(currentBackupSettings(chromeStorageService));
    update();
    return onBackupChange(update);
  }, [chromeStorageService]);

  useEffect(() => registerBackupOpener((r) => setRequest(r)), []);

  // After create / restore: once, for the account it was set for.
  useEffect(() => {
    const pending = pendingBackupPrompt();
    if (!pending || pending !== settings.id) return;
    if (backedUp) clearBackupPrompt();
    else setRequest((r) => r ?? { reason: 'onboarding' });
  }, [settings.id, backedUp]);

  // Web app: money showed up on a wallet with no backup → ask once per session (closable).
  useEffect(() => {
    if (!shouldOpenForBalance(web, backedUp, sats, balancePromptShown())) return;
    setBalancePromptShown();
    setRequest((r) => r ?? { reason: 'balance' });
  }, [web, backedUp, sats]);

  // iPhone web app: monthly "Still have your backup?".
  useEffect(() => {
    if (!backedUp || reminderShownThisSession() || !isIosWebApp()) return;
    if (reminderDue(settings, Date.now())) {
      setReminderShown();
      setReminder(true);
    }
  }, [backedUp, settings]);

  const close = useCallback(
    (completed: boolean) => {
      const r = request;
      setRequest(null);
      if (r?.reason === 'onboarding') clearBackupPrompt();
      setSettings(currentBackupSettings(chromeStorageService));
      // Receive carries on after a backup, or after Skip outside the web app.
      if (r?.onDone && (completed || !web)) r.onDone();
    },
    [request, chromeStorageService, web],
  );

  return (
    <>
      {!backedUp && (
        <button
          onClick={() => setRequest({ reason: 'banner' })}
          className="w-[88%] mt-3 flex items-center gap-2 rounded-xl px-3 py-2.5 text-left border-0"
          style={{ background: '#7A1A16', color: '#FFE4E1' }}
          role="alert"
        >
          <AlertTriangle size={18} className="shrink-0" />
          <span className="text-[13px] leading-snug">
            <b>Not backed up:</b> this wallet lives only {web ? 'in this browser' : 'on this device'}.{' '}
            <u className="font-bold">Back up now</u>
          </span>
        </button>
      )}
      {reminder && !request && (
        <div className="w-[88%] mt-3 rounded-xl px-3 py-3" style={{ background: '#16181D' }} role="status">
          <p className="text-[13px] m-0 text-white">
            Still have your backup? iPhone can clear web-app data.
          </p>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => {
                setReminder(false);
                void markBackupChecked(chromeStorageService);
              }}
              className="flex-1 rounded-lg py-2 text-sm font-bold border-0"
              style={{ background: '#F5B800', color: '#000' }}
            >
              Yes, I have it
            </button>
            <button
              onClick={() => {
                setReminder(false);
                setRequest({ reason: 'banner' });
              }}
              className="flex-1 rounded-lg py-2 text-sm font-bold border-0"
              style={{ background: '#2A2E36', color: 'white' }}
            >
              Back up again
            </button>
          </div>
        </div>
      )}
      {request && (
        <BackupStep
          web={web}
          exit={backupExit(request.reason, web, sats === 0)}
          onComplete={() => close(true)}
          onExit={() => close(false)}
        />
      )}
    </>
  );
};

/** Has the current account completed a backup? Updates when it does. */
export const useBackedUp = () => {
  const { chromeStorageService } = useServiceContext();
  const [backedUp, setBackedUp] = useState(() => isBackedUp(currentBackupSettings(chromeStorageService)));
  useEffect(() => {
    const update = () => setBackedUp(isBackedUp(currentBackupSettings(chromeStorageService)));
    update();
    return onBackupChange(update);
  }, [chromeStorageService]);
  return backedUp;
};
