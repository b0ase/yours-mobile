import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Hash, Utils } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isNative } from '../native';
import { BchatClient, ChatApiError, defaultHttp, loadSession, saveSession } from './api';
import { walletSigner } from './signer';
import { nativeAuth } from '../siteGateNative';
import {
  NativeSealError,
  inertHtml,
  myFields,
  nativeRoomSteps,
  nativeSignAndSeal,
  recoverNativeSeals,
  signedFieldIds,
  strokesToSvg,
  type PadPoint,
  type PendingSeal,
  type PendingSealStore,
  type NativeSealOutcome,
  type SealApi,
  type SealKeys,
  type SigField,
} from './nativeSeal';
import { openPendingForLink, type RoomReq } from './nativeSealSource';
import { docHashFor } from './signLink';

/**
 * Review, sign and seal a room document NATIVELY (chat/nativeSeal.ts has the why and the protocol). Route:
 * /m/seal/:ticker/:doc. The document is shown inert (no scripts, sandboxed frame), the person draws in the wallet's
 * own pad, and ONE approval (this sheet + Face ID) seals it with the wallet's own keys.
 */

const STORE_KEY = 'bwx.nativeSeal.pending';
const localStore = (): PendingSealStore => {
  const read = (): PendingSeal[] => {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (l: PendingSeal[]) => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(l));
    } catch {
      /* storage blocked */
    }
  };
  return {
    list: read,
    save: (p) => write([...read().filter((x) => x.nonce !== p.nonce), p]),
    remove: (n) => write(read().filter((x) => x.nonce !== n)),
  };
};

type Doc = {
  documentId: string;
  html: string;
  fields: SigField[];
  title: string;
  manifest: Record<string, unknown> | null;
};
type Phase =
  | { k: 'loading' }
  | { k: 'error'; text: string }
  | { k: 'ready' }
  | { k: 'working'; text: string }
  | { k: 'done'; out: NativeSealOutcome; roomError: string | null };

const STEP_TEXT: Record<string, string> = {
  preparing: 'Preparing the seal…',
  composing: 'Composing the signed document…',
  signing: 'Signing with your key…',
  paying: 'Sealing on chain…',
  committing: 'Recording the seal…',
  recovering: 'Finishing the seal…',
};

export const NativeSealPage = () => {
  const { ticker = '', doc: docId = '' } = useParams();
  const navigate = useNavigate();
  const { apiContext } = useServiceContext();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [svg, setSvg] = useState<string | null>(null);

  /** The wallet's silent bChatX session (Bearer); signs in with the wallet key when there is none. */
  const client = async (): Promise<BchatClient> => {
    let s = loadSession();
    if (!s) {
      s = await new BchatClient(defaultHttp(isNative)).signIn(walletSigner(apiContext));
      saveSession(s);
    }
    return new BchatClient(defaultHttp(isNative), s);
  };

  const api: SealApi = async (path, body) => {
    const c = await client();
    try {
      const data = (await c.request('POST', `/api/bitsign/nds/seal/${path}`, body)) as Record<string, unknown>;
      return { ok: true, status: 200, body: data ?? {} };
    } catch (e) {
      if (e instanceof ChatApiError)
        return { ok: false, status: e.status, body: (e.data as Record<string, unknown>) ?? { error: e.message } };
      throw e;
    }
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const c = await client();
        // The room's pending contract, or the contract built from the upload a QR names (chat/nativeSealSource.ts):
        // the owner signs only on his phone, so scanning the card is the whole flow (CEO, 3 Nov 2026).
        const req: RoomReq = async (method, path, body) => {
          try {
            return {
              ok: true,
              status: 200,
              body: ((await c.request(method, path, body)) as Record<string, unknown>) ?? {},
            };
          } catch (e) {
            if (e instanceof ChatApiError)
              return { ok: false, status: e.status, body: (e.data as Record<string, unknown>) ?? { error: e.message } };
            throw e;
          }
        };
        const out = await openPendingForLink(req, ticker, docId, docHashFor(ticker, docId));
        if (!live) return;
        if (!out.ok) {
          setPhase({ k: 'error', text: out.text });
          return;
        }
        const p = out.pending;
        setDoc({
          documentId: p.documentId,
          html: p.html,
          fields: (p.manifest?.signatureFields as SigField[] | undefined) ?? [],
          title: p.manifest?.documentTitle || 'Document',
          manifest: p.manifest ?? null,
        });
        setPhase({ k: 'ready' });
        void recoverNativeSeals(api, localStore(), p.documentId);
      } catch (e) {
        if (live) setPhase({ k: 'error', text: e instanceof Error ? e.message : 'Could not open the document.' });
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, docId]);

  const me = loadSession()?.handle ?? '';
  const mine = useMemo(() => (doc ? myFields(doc.fields, [me], signedFieldIds(doc.html)) : []), [doc, me]);
  const fingerprint = useMemo(
    () => (doc ? Utils.toHex(Hash.sha256(Utils.toArray(doc.html, 'utf8'))).slice(0, 8) : ''),
    [doc],
  );

  const seal = async () => {
    if (!doc || !svg || !mine.length) return;
    const keys: SealKeys = {
      createSignature: (a) => apiContext.wallet.createSignature(a as never) as Promise<{ signature: number[] }>,
      createAction: (a) => apiContext.wallet.createAction(a as never) as Promise<{ txid?: string; tx?: number[] }>,
    };
    try {
      const out = await nativeSignAndSeal({
        documentId: doc.documentId,
        fieldIds: mine.map((f) => f.id),
        svg,
        api,
        keys,
        store: localStore(),
        onStep: (s) => s !== 'approving' && setPhase({ k: 'working', text: STEP_TEXT[s] ?? 'Sealing…' }),
        // The ONE approval: the Seal tap (who, which document, fee shown beside it), then Face ID / passcode. No second
        // Seal sheet (owner's iPhone, 3 Nov 2026: "it may have asked me to seal twice").
        approve: async () => {
          const auth = await nativeAuth('Seal this document', 'bChatX');
          return auth.status === 'ok' || auth.status === 'unavailable';
        },
      });
      setPhase({ k: 'done', out, roomError: null });
      await tellRoom(out);
    } catch (e) {
      const text = e instanceof NativeSealError || e instanceof Error ? e.message : 'The seal did not finish.';
      setPhase({ k: 'error', text });
    }
  };

  /** The room's "signed and sealed" steps (nativeSeal.nativeRoomSteps). Safe to retry: the seal is already on chain. */
  const tellRoom = async (out: NativeSealOutcome) => {
    if (!doc) return;
    try {
      const c = await client();
      await nativeRoomSteps((path, body) => c.request('POST', path, body), ticker, doc.manifest, out);
      setPhase({ k: 'done', out, roomError: null });
    } catch (e) {
      setPhase({ k: 'done', out, roomError: e instanceof Error ? e.message : 'The room did not update.' });
    }
  };

  return (
    // Full screen above the Dock / tab bar (z-[100]): the pad's buttons sat under the bottom bar (iPhone, 3 Nov 2026).
    <div
      className="fixed inset-0 z-[500] flex min-h-0 flex-col pt-[env(safe-area-inset-top)]"
      style={{ background: '#0b0b0d', color: '#e4e4e7' }}
    >
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid rgba(245,184,0,0.35)' }}>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-lg px-2 py-1 text-[14px]"
          style={{ color: '#a1a1aa' }}
        >
          ‹ Back
        </button>
        <div className="min-w-0 flex-1" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: '#F5B800' }}>
            Review &amp; sign
          </div>
          <div className="text-[14px] font-semibold" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {doc?.title ?? 'Document'}
          </div>
        </div>
        {fingerprint && (
          <span className="font-mono text-[11px]" style={{ color: '#71717a' }}>
            #{fingerprint}
          </span>
        )}
      </div>
      {doc && (
        <iframe
          title="Document"
          sandbox=""
          srcDoc={inertHtml(doc.html)}
          className="min-h-0 w-full flex-1"
          style={{ background: '#fff', border: 0 }}
        />
      )}
      <div
        className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3"
        style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}
      >
        {phase.k === 'loading' && <p className="text-[14px]">Opening the document…</p>}
        {phase.k === 'error' && (
          <p role="alert" className="text-[14px]" style={{ color: '#fca5a5' }}>
            {phase.text}
          </p>
        )}
        {phase.k === 'done' && (
          <div>
            <p role="status" className="text-[15px] font-medium" style={{ color: '#6ee7b7' }}>
              ✓ Signed and sealed · tx {phase.out.txid.slice(0, 8)}…{phase.out.txid.slice(-4)}
            </p>
            {phase.roomError && (
              <div className="mt-2 flex items-center gap-2">
                <p role="alert" className="min-w-0 flex-1 text-[13px]" style={{ color: '#fca5a5' }}>
                  Sealed on chain, but the room did not update ({phase.roomError}).
                </p>
                <button
                  type="button"
                  onClick={() => void tellRoom(phase.out)}
                  className="min-h-11 rounded-lg px-4 text-[14px]"
                  style={{ border: '1px solid rgba(245,184,0,0.5)', color: '#F5B800' }}
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
        {phase.k === 'working' && (
          <p role="status" className="text-[14px]">
            {phase.text}
          </p>
        )}
        {phase.k === 'ready' &&
          doc &&
          (mine.length === 0 ? (
            <p className="text-[14px]">This document has no signature block for ${me}.</p>
          ) : svg ? (
            <div>
              <div className="mb-2 text-[13px]" style={{ color: '#a1a1aa' }}>
                Signed as ${me} · #{fingerprint} · a tiny network fee
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSvg(null)}
                  className="min-h-11 rounded-lg px-4 text-[14px]"
                  style={{ border: '1px solid rgba(255,255,255,0.15)' }}
                >
                  Redraw
                </button>
                <button
                  type="button"
                  onClick={() => void seal()}
                  className="min-h-12 flex-1 rounded-lg text-[15px] font-semibold"
                  style={{ background: '#F5B800', color: '#0b0b0d' }}
                >
                  Seal
                </button>
              </div>
            </div>
          ) : (
            <SignaturePad
              label={`Sign as ${mine[0].name || `$${me}`}${mine.length > 1 ? ` (fills ${mine.length} blocks)` : ''}`}
              onDone={setSvg}
            />
          ))}
      </div>
    </div>
  );
};

/** The wallet's own finger pad: strokes → the web pad's exact SVG (nativeSeal.strokesToSvg). */
const SignaturePad = ({ label, onDone }: { label: string; onDone: (svg: string) => void }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const strokes = useRef<PadPoint[][]>([]);
  const cur = useRef<PadPoint[] | null>(null);
  const pt = (e: React.PointerEvent<HTMLCanvasElement>): PadPoint => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, pressure: e.pressure || 0.5 };
  };
  const draw = () => {
    const c = ref.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = '#111';
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    for (const s of [...strokes.current, ...(cur.current ? [cur.current] : [])]) {
      g.beginPath();
      s.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
    }
  };
  const done = () => {
    const c = ref.current;
    if (!c) return;
    const out = strokesToSvg(strokes.current, c.clientWidth, c.clientHeight);
    if (out) onDone(out);
  };
  return (
    <div>
      <div className="mb-1 text-[13px]" style={{ color: '#a1a1aa' }}>
        {label}
      </div>
      <canvas
        ref={(el) => {
          ref.current = el;
          if (el && el.width !== el.clientWidth) {
            el.width = el.clientWidth;
            el.height = el.clientHeight;
          }
        }}
        className="h-40 w-full rounded-lg"
        style={{ background: '#fff', touchAction: 'none' }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          cur.current = [pt(e)];
          draw();
        }}
        onPointerMove={(e) => {
          if (!cur.current) return;
          cur.current.push(pt(e));
          draw();
        }}
        onPointerUp={() => {
          if (cur.current && cur.current.length > 1) strokes.current.push(cur.current);
          cur.current = null;
          draw();
        }}
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => ((strokes.current = []), draw())}
          className="min-h-11 rounded-lg px-4 text-[14px]"
          style={{ border: '1px solid rgba(255,255,255,0.15)' }}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={done}
          className="min-h-11 flex-1 rounded-lg text-[15px] font-semibold"
          style={{ background: '#F5B800', color: '#0b0b0d' }}
        >
          Done · next: Seal
        </button>
      </div>
    </div>
  );
};

export default NativeSealPage;
