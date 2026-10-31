import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SendConfirmation } from '../../../components/SendConfirmation';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useTheme } from '../../../hooks/useTheme';
import { estimateCost, notifyMinted } from '../../mint/mint';
import { mintMedia } from '../../mint/mintMedia';
import { useChatHandle } from '../../tabs/useTabBadges';
import {
  buildNoteMap,
  listNotes,
  normHandle,
  registerNote,
  renderNote,
  svgBytes,
  svgDataUrl,
  svgToBase64,
  USER_NOTE_COLOURWAYS,
  USER_NOTE_FACES,
  USER_NOTE_TEMPLATES,
  validateRender,
  type UserNote,
} from './userNotes';

/**
 * /m/bmint/make: "Make your own note" (USER_NOTES_ENABLED). The user picks a template, colourway, serial, face value and
 * short text; bit-sign renders a safe SVG (shown only through <img src="data:image/svg+xml;base64,…">); the wallet
 * inscribes it with the user's own key after the normal single approval sheet; then bit-sign registers the origin.
 * These are NOT official Mint notes.
 */
export const MakeNotePage = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const handle = normHandle(useChatHandle());

  const [template, setTemplate] = useState<string>(USER_NOTE_TEMPLATES[0].id);
  const [colourway, setColourway] = useState<string>(USER_NOTE_COLOURWAYS[0].id);
  const [serial, setSerial] = useState('1');
  const [face, setFace] = useState<number>(USER_NOTE_FACES[0]);
  const [text, setText] = useState('');

  const [svg, setSvg] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issued, setIssued] = useState<{ origin: string; registered: string | null } | null>(null);
  const [notes, setNotes] = useState<UserNote[] | null>(null);
  const [notesError, setNotesError] = useState('');

  const req = { template, colourway, serial: Number(serial), face, text };
  const formError = validateRender(req);

  // Live preview: re-render (debounced) whenever the form is valid.
  const key = JSON.stringify(req);
  useEffect(() => {
    setSvg(null);
    if (formError) return setPreviewError(formError);
    setPreviewError('');
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      void renderNote(JSON.parse(key)).then((r) => {
        if (!live) return;
        setLoading(false);
        if (r.ok) setSvg(r.value);
        else setPreviewError(r.error);
      });
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, formError]);

  const loadNotes = useCallback(() => {
    if (!handle) return setNotes([]);
    void listNotes(handle).then((r) => {
      if (r.ok) {
        setNotes(r.value);
        setNotesError('');
      } else setNotesError(r.error);
    });
  }, [handle]);
  useEffect(loadNotes, [loadNotes]);

  const satsPerKb = chromeStorageService.getCustomFeeRate();
  const cost = svg ? estimateCost(svgBytes(svg), satsPerKb) : null;

  const mint = async () => {
    if (!svg || !cost || !handle) return;
    setBusy(true);
    setError('');
    try {
      const map = buildNoteMap({ issuer: handle, serial: req.serial, face });
      const res = await mintMedia(apiContext, {
        base64Content: svgToBase64(svg),
        contentType: 'image/svg+xml',
        title: `PoWNote #${req.serial}`,
        description: '',
        collection: { kind: 'none' },
        feeSats: cost.feeSats,
        map,
      });
      notifyMinted();
      const reg = await registerNote(res.origin);
      setIssued({ origin: res.origin, registered: reg.ok ? null : reg.error });
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

      {!handle && <p className="bm-msg">Claim a $handle first: your note says who issued it.</p>}

      <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
        <label>
          Template
          <select className={field} value={template} onChange={(e) => setTemplate(e.target.value)}>
            {USER_NOTE_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Colourway
          <select className={field} value={colourway} onChange={(e) => setColourway(e.target.value)}>
            {USER_NOTE_COLOURWAYS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
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
          Face value
          <select className={field} value={face} onChange={(e) => setFace(Number(e.target.value))}>
            {USER_NOTE_FACES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label>
          Short text (optional)
          <input className={field} maxLength={40} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
      </div>

      <section aria-label="Preview" style={{ marginTop: 16 }}>
        {svg ? (
          <img src={svgDataUrl(svg)} alt="Preview of your note" style={{ width: '100%', maxWidth: 520 }} />
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
          disabled={!svg || !handle || busy}
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
                <img src={`https://ordfs.network/${n.origin}`} alt={`Note ${n.serial ?? ''}`} loading="lazy" />
                <figcaption>
                  #{n.serial ?? '?'} · {n.face ?? '?'} · Issued by ${handle}
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
            { address: `Inscribe your note #${req.serial} (not an official Mint note)`, amount: '' },
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
