import { useId } from 'react';
import { FileText, Lock } from 'lucide-react';
import type { ServiceStyle } from './serviceStyles';

/**
 * The Mint sheet's brand pieces (owner-approved mock, 1 Nov 2026): one lockup for every service, and a blank example
 * of the user's own item as each card's hero ("Your track", "Your name", today's date). Nothing of ours (titles,
 * posters, slogans) is shown.
 */

const TEXT = '#f2f2f0';
const MUT = '#9aa0aa';
const DASH = '1px dashed #3a3f4a';
const B_PATH = 'M45 12V44.5A33 33 0 1 1 27 72V30L45 12ZM60 57A15 15 0 1 0 60.01 57Z';

/** The gold b mark, 1em tall (the family's path and gradient). */
export const BMark = () => {
  const id = 'bm' + useId().replace(/:/g, '');
  return (
    <svg
      viewBox="23 8 74 100"
      width="0.74em"
      height="1em"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flex: 'none' }}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="12" x2="0" y2="105" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFE58A" />
          <stop offset=".55" stopColor="#FFD24D" />
          <stop offset="1" stopColor="#C98F00" />
        </linearGradient>
      </defs>
      <path fillRule="evenodd" fill={`url(#${id})`} d={B_PATH} />
    </svg>
  );
};

/** One lockup for every service: gold b mark, the name in white, the X in the service's accent. Inter 800. */
export const Lockup = ({ s, size }: { s: ServiceStyle; size: number }) => (
  <span
    className="inline-flex items-center whitespace-nowrap"
    style={{
      gap: '0.06em',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontWeight: 800,
      letterSpacing: '-0.01em',
      lineHeight: 1,
      fontSize: size,
    }}
  >
    <BMark />
    <span className="whitespace-nowrap">
      <span style={{ color: TEXT }}>{s.word}</span>
      <span style={{ color: s.accent }}>X</span>
    </span>
  </span>
);

const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const Ex = ({ children }: { children: string }) => (
  <div className="mb-2.5 text-[10px] font-bold uppercase" style={{ color: MUT, letterSpacing: '0.14em' }}>
    Example · {children}
  </div>
);

const Meta = ({ title, lines }: { title: string; lines: string[] }) => (
  <div className="min-w-0">
    <b className="block text-[16px]" style={{ color: TEXT }}>
      {title}
    </b>
    {lines.map((l) => (
      <span key={l} className="block text-[12px]" style={{ color: MUT }}>
        {l}
      </span>
    ))}
  </div>
);

const Play = ({ accent, size }: { accent: string; size: number }) => (
  <span className="grid place-items-center rounded-full" style={{ width: size, height: size, background: accent }}>
    <svg width={size * 0.4} height={size * 0.4} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5v14l11-7z" fill="#fff" />
    </svg>
  </span>
);

const Frame = ({ on, accent, ratio }: { on?: boolean; accent: string; ratio: string }) => (
  <i
    className="block flex-1 rounded-[4px]"
    style={{ aspectRatio: ratio, background: '#16181d', border: `1px solid ${on ? accent : '#2a2e36'}` }}
  />
);

const blankBox: React.CSSProperties = {
  background: 'linear-gradient(145deg, #1a1d24, #0f1116)',
  border: DASH,
  color: '#5a606c',
};

/** The waveform under "Your track" (the mock's shape, 44 bars in the accent). */
const WAVE = Array.from(
  { length: 44 },
  (_, i) => 20 + Math.round(80 * Math.abs(Math.sin(i * 0.55) * Math.cos(i * 0.21))),
);

const FileRow = ({ name, size }: { name: string; size: string }) => (
  <div
    className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2"
    style={{ background: '#0f1116', border: '1px solid #262a32' }}
  >
    <FileText size={16} color={MUT} />
    <span
      className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]"
      style={{ color: TEXT }}
    >
      {name}
    </span>
    <span className="text-[11px]" style={{ color: MUT }}>
      {size}
    </span>
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold" style={{ color: '#d8dbe0' }}>
      <Lock size={11} /> Private
    </span>
  </div>
);

/**
 * The hero of a branded card: a blank example of the user's own item for that service, in the hero frame with the
 * service's accent glow. `id` is the Mint card id.
 */
export const ServiceExample = ({ id, s }: { id: string; s: ServiceStyle }) => {
  const date = today();
  const by = `Your name · ${date}`;
  const a = s.accent;
  let body: React.ReactNode;
  if (id === 'music')
    body = (
      <>
        <Ex>your track</Ex>
        <div className="flex items-center gap-3">
          <div
            className="grid h-[84px] w-[84px] flex-none place-items-center rounded-[12px] text-center text-[11px]"
            style={blankBox}
          >
            Your
            <br />
            cover art
          </div>
          <Meta title="Your track" lines={[by, 'Private until you share it']} />
        </div>
        <div className="mt-3 flex h-[34px] items-end gap-[3px]">
          {WAVE.map((h, i) => (
            <i
              key={i}
              className="block flex-1 rounded-[2px]"
              style={{ height: `${h}%`, background: a, opacity: 0.85 }}
            />
          ))}
        </div>
      </>
    );
  else if (id === 'movies')
    body = (
      <>
        <Ex>your film</Ex>
        <div
          className="relative grid place-items-center rounded-[10px]"
          style={{ aspectRatio: '16 / 9', background: '#050506', border: DASH }}
        >
          <Play accent={a} size={46} />
          <div className="absolute bottom-2 left-2.5 text-[12px]" style={{ color: '#d8dbe0' }}>
            Your film <span style={{ color: MUT }}>· {by}</span>
          </div>
        </div>
        <div className="mt-2 flex gap-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <Frame key={i} on={i === 2} accent={a} ratio="16 / 9" />
          ))}
        </div>
      </>
    );
  else if (id === 'videos')
    body = (
      <>
        <Ex>your clip</Ex>
        <div className="flex items-center gap-3">
          <div
            className="relative grid w-[84px] flex-none place-items-center rounded-[10px]"
            style={{ aspectRatio: '9 / 16', background: '#050506', border: DASH }}
          >
            <Play accent={a} size={34} />
          </div>
          <div className="min-w-0 flex-1">
            <Meta title="Your clip" lines={[by, 'Private until you post it']} />
            <div className="mt-3 flex items-center gap-2">
              <span className="h-[22px] w-[22px] flex-none rounded-full" style={blankBox} />
              <span className="text-[12px] font-semibold" style={{ color: TEXT }}>
                Your channel
              </span>
            </div>
            <div className="mt-2 flex max-w-[150px] gap-1">
              {[0, 1, 2, 3].map((i) => (
                <Frame key={i} on={i === 0} accent={a} ratio="9 / 16" />
              ))}
            </div>
          </div>
        </div>
      </>
    );
  else if (id === 'books')
    body = (
      <>
        <Ex>your document</Ex>
        <div className="rounded-[8px] px-4 pb-4 pt-3.5 text-[12px]" style={{ background: '#f4f1e8', color: '#1b1b1b' }}>
          <b className="mb-2 block text-[15px]">Your document</b>
          {['92%', '86%', '95%', '60%'].map((w) => (
            <div key={w} className="my-1.5 h-1.5 rounded-[3px]" style={{ width: w, background: '#d9d4c6' }} />
          ))}
          <span
            className="mt-2.5 inline-block rounded-[6px] px-[7px] py-[3px] text-[10px] font-bold"
            style={{ color: '#7a5a00', border: '1px solid #c9a227' }}
          >
            Signed and dated by {by}
          </span>
        </div>
      </>
    );
  else if (id === 'art' || id === 'picture')
    body = (
      <>
        <Ex>{id === 'art' ? 'your picture' : 'your idea'}</Ex>
        {id === 'picture' && (
          <div className="mb-2.5 rounded-[10px] px-3 py-2.5 text-[13px] italic" style={{ ...blankBox, color: MUT }}>
            Your idea, in your words
          </div>
        )}
        <div className="grid grid-cols-3 gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="grid aspect-square place-items-center rounded-[8px] text-[11px]"
              style={{ ...blankBox, ...(i === 1 ? { border: `1px solid ${a}` } : {}) }}
            >
              {i === 1 ? (id === 'art' ? 'Your picture' : 'Yours') : ''}
            </div>
          ))}
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-2">
          <Meta title={id === 'art' ? 'Your picture' : 'Your picture, by b'} lines={[by]} />
          {id === 'art' && (
            <span
              className="flex-none rounded-[6px] px-[7px] py-[3px] text-[10px] font-bold"
              style={{ color: '#d8dbe0', border: '1px solid #3a3f4a' }}
            >
              No. 1 of 10
            </span>
          )}
        </div>
      </>
    );
  else if (id === '3d')
    body = (
      <>
        <Ex>your model</Ex>
        <div className="flex items-center gap-3">
          <svg viewBox="0 0 120 110" className="w-[120px] flex-none" aria-hidden="true">
            <ellipse cx="60" cy="96" rx="44" ry="8" fill="#1a1d24" />
            <g fill="none" stroke="#c9ccd2" strokeWidth="1.4" strokeLinejoin="round">
              <path d="M60 14 92 30v36L60 82 28 66V30z" />
              <path d="M28 30l32 16 32-16M60 46v36" />
            </g>
            <g fill="none" stroke="#5a606c" strokeWidth="1" strokeDasharray="3 3">
              <path d="M60 14v32M28 66l32-20 32 20" />
            </g>
          </svg>
          <Meta title="Your model" lines={[by, 'Private until you share it']} />
        </div>
      </>
    );
  else if (id === 'sell')
    body = (
      <>
        <Ex>your listing</Ex>
        <div className="flex items-center gap-3">
          <div className="h-[84px] w-[84px] flex-none rounded-[12px]" style={blankBox} />
          <Meta title="Your item" lines={['Your price', `Listed by ${by}`]} />
        </div>
      </>
    );
  else
    body = (
      <>
        <Ex>{id === 'keep' ? 'kept for you' : 'your files'}</Ex>
        <div className="grid gap-1.5">
          <FileRow name="your-photo.jpg" size="2.1 MB" />
          <FileRow name="your-chat.txt" size="84 KB" />
          <FileRow name="your-video.mp4" size="8.6 MB" />
        </div>
        <div className="mt-2.5 text-[12px]" style={{ color: MUT }}>
          {by}
        </div>
      </>
    );
  return (
    <div
      className="relative mb-4 overflow-hidden rounded-[18px] p-4"
      style={{ background: '#0d0f13', border: '1px solid #262a32' }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(120% 80% at 80% 0%, ${a}2e, transparent 60%)` }}
      />
      <div className="relative">{body}</div>
    </div>
  );
};
