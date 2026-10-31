import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SendConfirmation } from '../../../components/SendConfirmation';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useTheme } from '../../../hooks/useTheme';
import { estimateCost, notifyMinted } from '../../mint/mint';
import { useChatHandle } from '../../tabs/useTabBadges';
import { loadSession, SESSION_EVENT } from '../../chat/api';
import { inscribeUserNote, proveSigningKey } from './mintUserNote';
import {
  cleanTitleInput,
  listNotes,
  normHandle,
  registerNote,
  renderNote,
  svgBytes,
  svgDataUrl,
  USER_NOTE_FACES,
  validateRender,
  type Rendered,
  type UserNote,
} from './userNotes';

const faceLabel = (f: number) => f.toLocaleString('en-GB');

/** The bChatX session bearer (render + register need sign-in); follows sign-in/out. */
const useChatToken = () => {
  const [token, setToken] = useState<string | null>(() => loadSession()?.token ?? null);
  useEffect(() => {
    const on = () => setToken(loadSession()?.token ?? null);
    window.addEventListener(SESSION_EVENT, on);
    return () => window.removeEventListener(SESSION_EVENT, on);
  }, []);
  return token;
};

/**
 * /m/bmint/make: "Make your own note" (USER_NOTES_ENABLED). The user picks a face value (which also sets the colourway),
 * a serial and an 18-character title; bit-sign renders the SVG and its MAP (the SVG is shown only through
 * <img src="data:image/svg+xml;base64,…">); after the single approval sheet the wallet inscribes exactly that SVG +
 * MAP, signed with SIGMA by the user's BAP signing key (mintUserNote.ts); then bit-sign registers the origin.
 * These are NOT official Mint notes.
 */
export const MakeNotePage = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const handle = normHandle(useChatHandle());
  const token = useChatToken();

  const [serial, setSerial] = useState('1');
  const [face, setFace] = useState<number>(USER_NOTE_FACES[0]);
  const [title, setTitle] = useState('');

  const [note, setNote] = useState<Rendered | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<{ origin: string; registered: string | null } | null>(null);
  const [notes, setNotes] = useState<UserNote[] | null>(null);
  const [notesError, setNotesError] = useState('');

  const req = { serial: Number(serial), face, title };
  const formError = validateRender(req);

  // Live preview: re-render (debounced) whenever the form is valid.
  const key = JSON.stringify(req);
  useEffect(() => {
    setNote(null);
    if (formError) return setPreviewError(formError);
    setPreviewError('');
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      void renderNote(JSON.parse(key), { token, issuer: handle }).then((r) => {
        if (!live) return;
        setLoading(false);
        if (r.ok) setNote(r.value);
        else setPreviewError(r.error);
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, formError, token, handle]);

  const loadNotes = useCallback(() => {
    if (!handle) return setNotes([]);
    void listNotes({ issuer: handle }).then((r) => {
      if (r.ok) {
        setNotes(r.value);
        setNotesError('');
      } else setNotesError(r.error);
    });
  }, [handle]);
  useEffect(loadNotes, [loadNotes]);

  const satsPerKb = chromeStorageService.getCustomFeeRate();
  const cost = note ? estimateCost(svgBytes(note.svg), satsPerKb) : null;

  const mint = async () => {
    if (!note || !cost || !handle || !token) return;
    setBusy(true);
    setError('');
    try {
      const res = await inscribeUserNote(apiContext, note, cost.feeSats);
      notifyMinted();
      let registered: string | null = null;
      try {
        await proveSigningKey(apiContext.wallet, handle, token);
        const reg = await registerNote(res.origin, token);
        registered = reg.ok ? null : reg.error;
      } catch (e) {
        registered = e instanceof Error ? e.message : 'Could not register it';
      }
      setIssued({ origin: res.origin, registered });
      setConfirming(false);
      loadNotes();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Mint failed');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-lg px-3 py-2 bg-transparent border';
  return (
    <div className="bm-body bwx-bmint-make">
      <div className="bm-hero">
        <span className="bm-chip">Your notes</span>
        <h1>
          Make your own <span>note</span>
        </h1>
        <p>
          <b>These are NOT official Mint notes.</b> A note you make is your own design, issued by you and signed with
          your key. It is collectible art, not money, and The Bitcoin Corporation Mint does not issue or back it.
        </p>
      </div>

      {!token ? (
        <p className="bm-msg">Sign in to bChatX first: your note says who issued it.</p>
      ) : (
        !handle && <p className="bm-msg">Claim a $handle first: your note says who issued it.</p>
      )}

      <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
        <label>
          Face value (sets the colours)
          <select className={field} value={face} onChange={(e) => setFace(Number(e.target.value))}>
            {USER_NOTE_FACES.map((f) => (
              <option key={f} value={f}>
                {faceLabel(f)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Serial
          <input
            className={field}
            inputMode="numeric"
            value={serial}
            onChange={(e) => setSerial(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </label>
        <label>
          Title (up to 18: A-Z, 0-9, space . &apos; ! -)
          <input
            className={field}
            maxLength={18}
            autoCapitalize="characters"
            value={title}
            onChange={(e) => setTitle(cleanTitleInput(e.target.value))}
          />
        </label>
      </div>

      <section aria-label="Preview" style={{ marginTop: 16 }}>
        {note ? (
          <img src={svgDataUrl(note.svg)} alt="Preview of your note" style={{ width: '100%', maxWidth: 520 }} />
        ) : (
          <p className="bm-msg">{loading ? 'Drawing your note…' : previewError}</p>
        )}
        {cost && (
          <p className="bm-fine">
            Inscription fee (est.): {cost.totalSats.toLocaleString()} sats
            {cost.feeSats > 0 && ` (includes ${cost.feeSats} sats bWallet mint fee)`}
          </p>
        )}
      </section>

      {error && <p className="bm-msg">{error}</p>}
      {issued ? (
        <p className="bm-msg">
          Issued by ${handle}. {issued.registered ? `Inscribed, but not registered yet: ${issued.registered}` : ''}
        </p>
      ) : (
        <button
          type="button"
          className="bw-pill bw-pill-gold py-3 px-6 font-semibold"
          disabled={!note || !handle || !token || busy}
          onClick={() => setConfirming(true)}
        >
          Mint this note
        </button>
      )}

      <section className="bm-group" aria-label="Your notes" style={{ marginTop: 24 }}>
        <h2 className="bm-group-title">Your notes</h2>
        {notesError ? (
          <p className="bm-msg">{notesError}</p>
        ) : notes === null ? (
          <p className="bm-msg">Loading…</p>
        ) : notes.length === 0 ? (
          <p className="bm-msg">No notes yet.</p>
        ) : (
          <div className="bm-show-grid">
            {notes.map((n) => (
              <figure key={n.origin} className="bm-show">
                <img
                  src={`https://ordfs.network/${n.origin}`}
                  alt={`Note ${n.title ?? n.serial ?? ''}`}
                  loading="lazy"
                />
                <figcaption>
                  {n.title ?? 'PoWNote'} · #{n.serial ?? '?'} · {n.face ? faceLabel(n.face) : '?'} · Issued by $
                  {n.issuer}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>

      {createPortal(
        <SendConfirmation
          show={confirming}
          theme={theme}
          lineItems={[
            { address: `Inscribe your note "${title}" #${req.serial} (not an official Mint note)`, amount: '' },
            { address: 'Signed with your published identity (Sigma); key stays in your wallet', amount: '' },
            { address: 'Sigma anchor output (2 sats, spent back to your wallet)', amount: '' },
            ...(cost ? [{ address: 'Network fee (est.)', amount: '', sats: cost.networkSats }] : []),
            ...(cost && cost.feeSats > 0 ? [{ address: 'bWallet mint fee (1%)', amount: '', sats: cost.feeSats }] : []),
          ]}
          totalSats={cost?.totalSats}
          isProcessing={busy}
          onConfirm={() => void mint()}
          onCancel={() => !busy && setConfirming(false)}
        />,
        document.body,
      )}
    </div>
  );
};

export default MakeNotePage;
