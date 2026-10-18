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

const linkStyle = { background: 'none', border: 'none', cursor: 'pointer' } as const;

/** Create Account › "Your recovery phrase": "Save with a passkey" under the existing Copy / Download rows. */
export const PasskeyBackupButton = ({ words, label }: { words: string[]; label: string }) => {
  const { theme } = useTheme();
  const available = usePasskeyBackupAvailable();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');
  const [blob, setBlob] = useState<SeedBackupBlob | null>(null);
  const accent = theme.color.component.primaryButtonLeftGradient;

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
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
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
      {error && (
        <p className="text-[10px] mt-1 text-center px-6" style={{ color: '#f87171' }}>
          {error}
        </p>
      )}
    </div>
  );
};

/** Restore a Wallet: "Restore with a passkey". Hands the 12 words to the normal restore form. */
export const PasskeyRestoreRow = ({ onPhrase }: { onPhrase: (mnemonic: string) => void }) => {
  const { theme } = useTheme();
  const available = usePasskeyBackupAvailable();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needFile, setNeedFile] = useState(false);
  if (!available) return null;
  const contrast = theme.color.global.contrast;
  const gray = theme.color.global.gray;

  const openWith = async (blob: SeedBackupBlob) => {
    if (blob.rpId !== currentRpId())
      throw new Error(`This backup was made on ${blob.rpId}. Open bWalletX there to restore it.`);
    const { prf } = await getPrf(blob.rpId, blob.credentialId);
    onPhrase(await openSeed(blob, prf));
  };

  const fromDevice = async () => {
    setError('');
    setBusy(true);
    try {
      const local = loadLocalBackups().filter((b) => b.rpId === currentRpId());
      if (local.length === 0) {
        setNeedFile(true);
        return;
      }
      // Let the browser list this site's passkeys; the one chosen picks the matching backup.
      const { credentialId, prf } = await getPrf(currentRpId());
      const blob = local.find((b) => b.credentialId === credentialId);
      if (!blob) {
        setNeedFile(true);
        throw new Error('No backup on this device for that passkey. Choose your recovery file.');
      }
      onPhrase(await openSeed(blob, prf));
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
