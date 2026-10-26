import { useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { saveBackupFile, saveRoute } from '../backup/backupFile';
import { openBMailDraft } from '../bmail/store';
import { NOTE_MAX_CHARS, noteFileName, signNote, type SignedNote } from './signedNote';

const btn = 'px-3 py-2 rounded-lg text-xs font-semibold border-0 cursor-pointer disabled:opacity-50';
const gold = { background: 'var(--bw-accent-hi)', color: '#000' };
const dark = { background: '#2b2f36', color: '#fff' };
const muted = { color: 'var(--bw-muted, #98a2b3)' };

/**
 * Settings › Sign a note: write a short note (an IOU, a promise, a receipt), sign it with your identity key, then send
 * it by bMail (the recipient's wallet checks the signature) or save the file (anyone can check it at
 * bwalletx.com/verify-note).
 */
export const SignNoteScreen = ({ onSent }: { onSent?: () => void }) => {
  const { apiContext } = useServiceContext();
  const [text, setText] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState<SignedNote | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const sign = async () => {
    if (!apiContext) return;
    setBusy(true);
    setMsg('');
    try {
      setNote(await signNote(apiContext.wallet, text));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Signing failed');
    } finally {
      setBusy(false);
    }
  };

  const bmail = () => {
    if (!note) return;
    openBMailDraft({ to: to.trim() || undefined, subject: 'Signed note', body: note.text, note });
    onSent?.();
  };

  const save = async () => {
    if (!note) return;
    try {
      const f = new File([JSON.stringify(note, null, 2)], noteFileName(note), { type: 'application/json' });
      await saveBackupFile(f, saveRoute(f, isNative));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Could not save the file');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] m-0" style={muted}>
        Write a note, like an IOU, and sign it with your identity key. Send it by bMail and their wallet shows it as
        signed by you. Anyone can check the file at bwalletx.com/verify-note.
      </p>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setNote(null);
        }}
        maxLength={NOTE_MAX_CHARS}
        disabled={!!note}
        placeholder="I owe … for …, payable by …"
        className="w-full min-h-[140px] rounded-lg p-2 text-sm"
        style={{ background: 'var(--bw-bg)', color: '#fff', border: '1px solid #2b2f36' }}
      />
      {!note ? (
        <button
          type="button"
          className={`${btn} self-start`}
          style={gold}
          disabled={busy || !text.trim()}
          onClick={sign}
        >
          {busy ? 'Signing…' : 'Sign'}
        </button>
      ) : (
        <>
          <div className="text-xs font-semibold" style={{ color: '#32D583' }}>
            ✓ Signed {new Date(note.date).toLocaleString()}
          </div>
          <label className="text-[11px]" style={muted}>
            Send to ($handle or paymail)
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              placeholder="name@bwalletx.com"
              className="w-full mt-1 rounded-lg p-2 text-xs"
              style={{ background: 'var(--bw-bg)', color: '#fff', border: '1px solid #2b2f36' }}
            />
          </label>
          <div className="flex gap-2 flex-wrap">
            <button type="button" className={btn} style={gold} onClick={bmail}>
              Send by bMail
            </button>
            <button type="button" className={btn} style={dark} onClick={() => void save()}>
              Save the file
            </button>
            <button type="button" className={btn} style={dark} onClick={() => setNote(null)}>
              Edit
            </button>
          </div>
        </>
      )}
      {msg && (
        <p className="text-[11px] m-0" style={{ color: '#F97066' }}>
          {msg}
        </p>
      )}
    </div>
  );
};
