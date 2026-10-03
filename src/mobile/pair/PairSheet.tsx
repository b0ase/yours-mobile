import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import jsQR from 'jsqr';
import { ArrowLeft, Check, Link2, Loader2, ShieldCheck } from 'lucide-react';
import { useBackClose } from '../backStack';
import { beginPairing, type PendingPair } from './sessions';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const PANEL = '#17191E';

type Stage =
  | { k: 'scan' }
  | { k: 'joining' }
  | { k: 'confirm'; p: PendingPair }
  | { k: 'done'; origin: string }
  | { k: 'error'; m: string };

/**
 * "Scan to connect": point the camera at a site's bWallet QR, check the site, compare the 4-digit
 * code, Connect. After that the site's requests appear as normal bWallet approval prompts.
 */
export default function PairSheet({ onClose, initial }: { onClose: () => void; initial?: string }) {
  const [stage, setStage] = useState<Stage>(initial ? { k: 'joining' } : { k: 'scan' });
  const [paste, setPaste] = useState('');

  const close = () => {
    if (stage.k === 'confirm') stage.p.cancel();
    onClose();
  };
  useBackClose(true, close);

  const start = (text: string) => {
    setStage({ k: 'joining' });
    beginPairing(text)
      .then((p) => setStage({ k: 'confirm', p }))
      .catch((e: unknown) => setStage({ k: 'error', m: e instanceof Error ? e.message : String(e) }));
  };
  useEffect(() => {
    if (initial) start(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[400] flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center gap-2 px-2 pb-2" style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)' }}>
        <button onClick={close} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Connect to a website</span>
      </div>
      <div className="flex flex-1 flex-col overflow-y-auto px-5 pb-10">
        {stage.k === 'scan' && (
          <>
            <Scanner onCode={start} />
            <p className="mt-4 text-center text-sm" style={{ color: MUTED }}>
              On your computer, choose <b className="text-white">Use bWallet on your phone</b> and point the camera at
              the code.
            </p>
            <div className="mt-6 flex gap-2">
              <input
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                placeholder="Or paste a pairing link"
                className="flex-1 rounded-xl px-3 py-2.5 text-sm text-white outline-none"
                style={{ background: PANEL, border: '1px solid #2A2A2C' }}
              />
              <button
                disabled={!paste.trim()}
                onClick={() => start(paste)}
                aria-label="Use pasted link"
                className="rounded-xl px-3"
                style={{ background: GOLD, color: '#000', opacity: paste.trim() ? 1 : 0.4 }}
              >
                <Link2 size={16} />
              </button>
            </div>
          </>
        )}

        {stage.k === 'joining' && (
          <div className="mt-24 flex flex-col items-center gap-3" style={{ color: MUTED }}>
            <Loader2 className="animate-spin" size={28} color={GOLD} />
            Checking the website…
          </div>
        )}

        {stage.k === 'confirm' && (
          <div className="mt-8 flex flex-col items-center text-center">
            <span
              className="grid h-14 w-14 place-items-center rounded-2xl"
              style={{ background: 'rgba(245,184,0,0.12)' }}
            >
              <ShieldCheck size={28} color={GOLD} />
            </span>
            <p className="mt-5 text-sm" style={{ color: MUTED }}>
              Connect your wallet to
            </p>
            <p className="mt-1 break-all text-xl font-bold text-white">{new URL(stage.p.origin).host}</p>
            <p className="mt-6 text-sm" style={{ color: MUTED }}>
              Check the website shows the same code:
            </p>
            <p className="mt-2 font-mono text-4xl font-bold tracking-[0.3em]" style={{ color: GOLD }}>
              {stage.p.code}
            </p>
            <p className="mt-6 text-xs" style={{ color: MUTED }}>
              The site can ask for approvals, which you&apos;ll see here as usual. It can&apos;t move anything without
              your OK.
            </p>
            <div className="mt-8 flex w-full gap-3">
              <button
                onClick={close}
                className="flex-1 rounded-xl py-3 font-semibold text-white"
                style={{ background: PANEL }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  stage.p.confirm();
                  setStage({ k: 'done', origin: stage.p.origin });
                }}
                className="flex-1 rounded-xl py-3 font-bold"
                style={{ background: GOLD, color: '#000' }}
              >
                Connect
              </button>
            </div>
          </div>
        )}

        {stage.k === 'done' && (
          <div className="mt-20 flex flex-col items-center text-center">
            <span
              className="grid h-14 w-14 place-items-center rounded-full"
              style={{ background: 'rgba(46,204,113,0.15)' }}
            >
              <Check size={28} color="#2ecc71" />
            </span>
            <p className="mt-4 text-lg font-bold text-white">Connected to {new URL(stage.origin).host}</p>
            <p className="mt-2 text-sm" style={{ color: MUTED }}>
              Keep bWallet open while you use the site. Disconnect any time in Settings › Paired websites.
            </p>
            <button
              onClick={onClose}
              className="mt-8 w-full rounded-xl py-3 font-bold"
              style={{ background: GOLD, color: '#000' }}
            >
              Done
            </button>
          </div>
        )}

        {stage.k === 'error' && (
          <div className="mt-20 flex flex-col items-center text-center">
            <p className="text-base font-semibold text-white">Couldn&apos;t connect</p>
            <p className="mt-2 text-sm" style={{ color: MUTED }}>
              {stage.m}
            </p>
            <button
              onClick={() => setStage({ k: 'scan' })}
              className="mt-8 w-full rounded-xl py-3 font-bold"
              style={{ background: GOLD, color: '#000' }}
            >
              Scan again
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Rear camera + jsQR. Stops the camera as soon as it reads a code, or when it unmounts. */
function Scanner({ onCode }: { onCode: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stream: MediaStream | undefined;
    let raf = 0;
    let done = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      const v = video.current;
      if (done || !v || !ctx) return;
      if (v.readyState >= 2 && v.videoWidth) {
        const w = Math.min(640, v.videoWidth);
        const h = Math.round((v.videoHeight / v.videoWidth) * w);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const hit = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (hit?.data) {
          done = true;
          stream?.getTracks().forEach((t) => t.stop());
          return onCode(hit.data);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    if (!navigator.mediaDevices?.getUserMedia) setErr('Camera not available here. Paste the link below.');
    else
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        .then((s) => {
          stream = s;
          if (done) return s.getTracks().forEach((t) => t.stop());
          if (video.current) {
            video.current.srcObject = s;
            void video.current.play();
            raf = requestAnimationFrame(tick);
          }
        })
        .catch(() => setErr('Camera not available. Allow camera access for bWallet, or paste the link below.'));
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode]);
  return (
    <div className="relative mt-4 aspect-square w-full overflow-hidden rounded-2xl" style={{ background: '#0b0c0f' }}>
      <video ref={video} playsInline muted className="h-full w-full object-cover" />
      <div
        className="pointer-events-none absolute inset-[18%] rounded-2xl"
        style={{ border: `3px solid ${GOLD}`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)' }}
      />
      {err && (
        <p className="absolute inset-x-4 bottom-4 text-center text-xs" style={{ color: MUTED }}>
          {err}
        </p>
      )}
    </div>
  );
}
