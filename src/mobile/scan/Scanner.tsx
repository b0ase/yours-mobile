import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { ErrorActions } from '../errors/ErrorActions';

const GOLD = 'var(--bw-accent)';
const MUTED = '#98A2B3';

/**
 * Rear camera + the platform's own QR detector where there is one (BarcodeDetector), else jsQR. Stops the camera as
 * soon as it reads a code, or when it unmounts.
 *
 * Owner, 13 Nov 2026: it couldn't read the CLI's pairing QR off a monitor. Every frame was shrunk to 640 px wide
 * before jsQR, so a dense code's modules were a few pixels each. Now the camera asks for HD, and jsQR alternates the
 * centre square (where the gold frame points you) at full resolution with the whole frame at up to 960 px.
 */
type Detector = { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> };
export function Scanner({ onCode }: { onCode: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  // Latest callback without restarting the camera on every parent render.
  const cb = useRef(onCode);
  cb.current = onCode;
  useEffect(() => {
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const BD = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    let native: Detector | null = null;
    try {
      native = BD ? new BD({ formats: ['qr_code'] }) : null;
    } catch {
      native = null;
    }
    let frame = 0;
    const found = (text: string) => {
      if (done) return;
      done = true;
      stream?.getTracks().forEach((t) => t.stop());
      cb.current(text);
    };
    // jsQR on one region of the current frame, drawn at up to `max` px on its longer side.
    const read = (v: HTMLVideoElement, sx: number, sy: number, sw: number, sh: number, max: number) => {
      if (!ctx) return null;
      const k = Math.min(1, max / Math.max(sw, sh));
      const w = Math.round(sw * k);
      const h = Math.round(sh * k);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      // jsQR can throw on its inverted pass (seen on real frames): one bad frame must not stop the scanner.
      try {
        return jsQR(px, w, h, { inversionAttempts: 'attemptBoth' })?.data || null;
      } catch {
        try {
          return jsQR(px, w, h, { inversionAttempts: 'dontInvert' })?.data || null;
        } catch {
          return null;
        }
      }
    };
    const tick = async () => {
      const v = video.current;
      if (done || !v) return;
      try {
        await look(v);
      } catch {
        /* a frame that failed to read: try the next one */
      }
      if (!done) timer = setTimeout(() => void tick(), 60);
    };
    const look = async (v: HTMLVideoElement) => {
      if (v.readyState >= 2 && v.videoWidth) {
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        let hit: string | null = null;
        if (native) {
          try {
            hit = (await native.detect(v))[0]?.rawValue || null;
          } catch {
            native = null; // not usable here: jsQR from now on
          }
        }
        if (!hit) {
          if (frame++ % 2 === 0) {
            const side = Math.round(Math.min(vw, vh) * 0.8);
            hit = read(v, (vw - side) / 2, (vh - side) / 2, side, side, 1080);
          } else hit = read(v, 0, 0, vw, vh, 960);
        }
        if (hit) found(hit);
      }
    };
    if (!navigator.mediaDevices?.getUserMedia) setErr('Camera not available here. Paste it below instead.');
    else
      navigator.mediaDevices
        .getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        .then((s) => {
          stream = s;
          if (done) return s.getTracks().forEach((t) => t.stop());
          if (video.current) {
            video.current.srcObject = s;
            void video.current.play();
            void tick();
          }
        })
        .catch(() => setErr('Camera not available. Allow camera access for bWallet, or paste it below.'));
    return () => {
      done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return (
    <div className="relative mt-4 aspect-square w-full overflow-hidden rounded-2xl" style={{ background: '#0b0c0f' }}>
      <video ref={video} playsInline muted className="h-full w-full object-cover" />
      <div
        className="pointer-events-none absolute inset-[18%] rounded-2xl"
        style={{ border: `3px solid ${GOLD}`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)' }}
      />
      {err && (
        <div className="flex flex-col gap-1.5">
          <p className="absolute inset-x-4 bottom-4 text-center text-xs" style={{ color: MUTED }}>
            {err}
          </p>
          <ErrorActions message={String(err)} />
        </div>
      )}
    </div>
  );
}
