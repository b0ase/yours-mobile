import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { ErrorActions } from '../errors/ErrorActions';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

/** Rear camera + jsQR. Stops the camera as soon as it reads a code, or when it unmounts. */
export function Scanner({ onCode }: { onCode: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  // Latest callback without restarting the camera on every parent render.
  const cb = useRef(onCode);
  cb.current = onCode;
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
          return cb.current(hit.data);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    if (!navigator.mediaDevices?.getUserMedia) setErr('Camera not available here. Paste it below instead.');
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
        .catch(() => setErr('Camera not available. Allow camera access for bWallet, or paste it below.'));
    return () => {
      done = true;
      cancelAnimationFrame(raf);
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
<div className="flex flex-col gap-1.5"><p className="absolute inset-x-4 bottom-4 text-center text-xs" style={{ color: MUTED }}>
          {err}
        </p><ErrorActions message={String(err)} /></div>
)}
    </div>
  );
}
