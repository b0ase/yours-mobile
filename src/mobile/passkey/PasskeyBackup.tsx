import { useEffect, useRef, useState } from 'react';
import { Check, Fingerprint, FileUp } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme';
import { createPasskeyWithPrf, getPrf } from './prf';
import { currentRpId, downloadBackupFile, usePasskeyBackupAvailable } from './passkeyUi';
import {
  loadLocalBackups,
  openSeed,
  parseSeedBackup,
  saveLocalBackup,
  sealSeed,
  type SeedBackupBlob,
} from './seedBackup';
import { takePasskeySession } from './session';
import { fetchBackup, uploadBackup } from './passkeyServer';
import { sendRestoredPing } from './openHere';
import { useServiceContext } from '../../hooks/useServiceContext';
import { markBackedUp } from '../backup/backupState';

const linkStyle = { background: 'none', border: 'none', cursor: 'pointer' } as const;

/** Create Account › "Your recovery phrase": "Save with a passkey" under the existing Copy / Download rows. */
export const PasskeyBackupButton = ({
  words,
  label,
  identityWif,
  onSaved,
  accountId,
}: {
  words: string[];
  label: string;
  /** The new account's identity key, to sign the server upload (passkeyServer.ts). */
  identityWif?: () => Promise<string | undefined>;
  onSaved?: (ok: boolean) => void;
  /** The account these words belong to: marked backed up ('passkey') so the backup prompt doesn't nag. */
  accountId?: string;
}) => {
  const { chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const available = usePasskeyBackupAvailable();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');
  const [blob, setBlob] = useState<SeedBackupBlob | null>(null);
  const [onServer, setOnServer] = useState<boolean | null>(null);
  const accent = theme.color.component.primaryButtonLeftGradient;

  const saved = (b: SeedBackupBlob) => {
    if (accountId) void markBackedUp(chromeStorageService, 'passkey', Date.now(), [accountId]).catch(() => undefined);
    toServer(b);
  };
  const toServer = (b: SeedBackupBlob) =>
    void identityWif?.()
      .then((wif) => (wif ? uploadBackup(b, wif) : false))
      .then(
        (ok) => setOnServer(ok),
        () => setOnServer(false),
      );

  // Made with "Continue with a passkey": seal the new words with that passkey now (no second prompt).
  const phrase = words.join(' ');
  useEffect(() => {
    if (!phrase) return;
    const s = takePasskeySession();
    if (!s) return;
    void sealSeed(phrase, s.prf, { rpId: s.rpId, credentialId: s.credentialId, label }).then(
      (b) => {
        s.prf.fill(0);
        saveLocalBackup(b);
        setBlob(b);
        downloadBackupFile(b);
        setState('done');
        onSaved?.(true);
        saved(b);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        onSaved?.(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per new phrase; callbacks are fresh each render
  }, [phrase, label]);

  if (!available || words.length === 0) return null;

  const run = async () => {
    setError('');
    setState('busy');
    try {
      const rpId = currentRpId();
      const { credentialId, prf } = await createPasskeyWithPrf(rpId, `bWalletX · ${label}`);
      const b = await sealSeed(words.join(' '), prf, { rpId, credentialId, label });
      saveLocalBackup(b);
      setBlob(b);
      downloadBackupFile(b);
      setState('done');
      onSaved?.(true);
      saved(b);
    } catch (e) {
      setState('idle');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex flex-col items-center mt-3" data-testid="passkey-backup">
      <button
        type="button"
        onClick={() => void run()}
        disabled={state !== 'idle'}
        className="flex items-center gap-2 mx-auto"
        style={linkStyle}
      >
        {state === 'done' ? (
          <Check size={14} style={{ color: accent }} />
        ) : (
          <Fingerprint size={14} style={{ color: accent }} />
        )}
        <span className="text-xs font-medium underline underline-offset-2" style={{ color: accent }}>
          {state === 'done'
            ? 'Saved with your passkey'
            : state === 'busy'
              ? 'Waiting for your passkey…'
              : 'Save with a passkey (Face ID / fingerprint)'}
        </span>
      </button>
      {state === 'done' && blob && (
        <button type="button" onClick={() => downloadBackupFile(blob)} className="mt-1" style={linkStyle}>
          <span className="text-[10px] underline" style={{ color: theme.color.global.gray }}>
            Download the recovery file again
          </span>
        </button>
      )}
      {state === 'done' && (
        <p className="text-[10px] mt-1 text-center px-6" style={{ color: theme.color.global.gray }}>
          Keep the recovery file somewhere safe (email it to yourself, cloud drive). It's locked: only your passkey
          opens it. Your 12 words still work too.
        </p>
      )}
      {state === 'done' && onServer !== null && (
        <p
          className="text-[10px] mt-1 text-center px-6"
          style={{ color: theme.color.global.gray }}
          data-testid="passkey-server-status"
        >
          {onServer
            ? 'Also stored (locked) in your bWalletX backup, so your passkey can restore it on a new device.'
            : 'Online copy not available right now; your file and this device still have it.'}
        </p>
      )}
      {error && (
        <p className="text-[10px] mt-1 text-center px-6" style={{ color: '#f87171' }}>
          {error}
        </p>
      )}
    </div>
  );
};

/** Restore a Wallet: "Restore with a passkey". Hands the 12 words to the normal restore form. */
/** The passkey that opened the backup: lets the restored wallet unlock with it straight away (no password). */
export type RestorePasskey = { rpId: string; credentialId: string; prf: Uint8Array };

export const PasskeyRestoreRow = ({ onPhrase }: { onPhrase: (mnemonic: string, passkey: RestorePasskey) => void }) => {
  const { theme } = useTheme();
  const available = usePasskeyBackupAvailable();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needFile, setNeedFile] = useState(false);
  if (!available) return null;
  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;

  const local = () => /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const opened = (words: string) => {
    void sendRestoredPing(words, local()); // "Your phone has it" on the computer, best effort
    return words;
  };
  const openWith = async (blob: SeedBackupBlob) => {
    if (blob.rpId !== currentRpId())
      throw new Error(`This backup was made on ${blob.rpId}. Open bWalletX there to restore it.`);
    const { prf } = await getPrf(blob.rpId, blob.credentialId);
    onPhrase(opened(await openSeed(blob, prf)), { rpId: blob.rpId, credentialId: blob.credentialId, prf });
  };

  const fromDevice = async () => {
    setError('');
    setBusy(true);
    try {
      // Discoverable passkey sign-in (no allow list): the chosen passkey's id finds the backup, on this device or
      // in the bWalletX backup store (ciphertext only; passkeyServer.ts).
      const { credentialId, prf } = await getPrf(currentRpId());
      const blob =
        loadLocalBackups().find((b) => b.credentialId === credentialId && b.rpId === currentRpId()) ??
        (await fetchBackup(credentialId));
      if (!blob) {
        setNeedFile(true);
        throw new Error('No backup found for that passkey. Choose your recovery file.');
      }
      onPhrase(opened(await openSeed(blob, prf)), { rpId: blob.rpId, credentialId, prf });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const fromFile = async (file?: File) => {
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      await openWith(parseSeedBackup(await file.text()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full flex flex-col gap-1 mb-3" data-testid="passkey-restore">
      <button
        type="button"
        disabled={busy}
        onClick={() => void fromDevice()}
        className="flex items-center gap-3 w-full rounded-xl px-4 py-3 border-0 cursor-pointer"
        style={{ backgroundColor: theme.color.global.row }}
      >
        <span
          className="flex items-center justify-center rounded-lg"
          style={{ backgroundColor: '#17191E', width: '2.25rem', height: '2.25rem' }}
        >
          <Fingerprint size={18} color="#FFFFFF" />
        </span>
        <span className="flex-1 flex flex-col text-left">
          <span className="text-sm font-semibold" style={{ color: contrast }}>
            {busy ? 'Waiting for your passkey…' : 'Restore with a passkey'}
          </span>
          <span className="text-xs" style={{ color: gray }}>
            Face ID, fingerprint or your device PIN
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        className="flex items-center gap-2 self-center mt-1"
        style={linkStyle}
      >
        <FileUp size={12} style={{ color: gray }} />
        <span className="text-[11px] underline" style={{ color: needFile ? contrast : gray }}>
          {needFile ? 'Choose your passkey recovery file' : 'Use a passkey recovery file'}
        </span>
      </button>
      <input
        type="file"
        ref={fileInput}
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => {
          void fromFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {error && (
        <p className="text-[11px] text-center px-4" style={{ color: '#f87171' }}>
          {error}
        </p>
      )}
    </div>
  );
};
