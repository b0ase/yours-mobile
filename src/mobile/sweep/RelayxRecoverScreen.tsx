import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, ShieldCheck, X } from 'lucide-react';
import relayxIcon from '../brand/restore/relayx.svg';
import relayxWordmark from '../../assets/relayx-logo.png';
import { createChainReader, createTxCache, type ChainReader } from '../../sweep/chainReads';
import {
  groupFound,
  retryUnread,
  scanRelayx,
  wordsProblem,
  type Found,
  type ScanResult,
  type ScanStep,
} from '../../sweep/relayxRecover';
import { loadNpgMaps, NPG_CUTOUT_INDEX, splitOutpoint, type NpgMap } from '../../sweep/runIdentify';
import { HdSweepScreen } from './HdSweepScreen';
import { NpgMelt } from './NpgMelt';

/**
 * Recover RelayX collections (owner, 17 Oct 2026: "it's SPECIFICALLY FOR FINDING RELAYX NFTS"). Its own screen:
 * RelayX words in, a gallery of the Run NFTs they hold out, each one meltable from its detail sheet. No coin
 * sweeping here; if the words also hold BSV, one quiet line points at the sweep screen. Chain reads go through
 * sweep/chainReads.ts (rate-limited, retried, batched, cached), so a big collection no longer dies on a 429.
 */

const BLUE = '#2669FF';
const INK = '#F2F4F7';
const MUTED = '#98A2B3';
const LINE = 'rgb(255 255 255 / 0.08)';
const SURFACE = 'rgb(255 255 255 / 0.03)';

type BBox = Record<string, [number, number, number, number]>;
type Phase =
  | { k: 'enter' }
  | { k: 'scanning'; step: ScanStep | null }
  | { k: 'done'; result: ScanResult }
  | { k: 'error'; message: string };

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const bsv = (sats: number) => (sats / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
const pad = (n: number) => String(n).padStart(4, '0');

/** Her cut-out cropped to her bounding box. SVG viewBox does the crop at any tile size. */
function Cutout({ url, box, className }: { url: string; box?: [number, number, number, number]; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  const [x0, y0, x1, y1] = box ?? [0, 0, 961, 1441];
  const m = 24;
  return (
    <div className={`relative ${className ?? ''}`}>
      {!loaded && (
        <div
          aria-hidden="true"
          className="absolute inset-0 rounded-[inherit] animate-pulse"
          style={{ background: SURFACE }}
        />
      )}
      <svg
        viewBox={`${x0 - m} ${y0 - m} ${x1 - x0 + 2 * m} ${y1 - y0 + 2 * m}`}
        preserveAspectRatio="xMidYMax meet"
        className="absolute inset-0 h-full w-full transition-opacity duration-200 ease-out"
        style={{ opacity: loaded ? 1 : 0 }}
        aria-hidden="true"
      >
        <image href={url} width={961} height={1441} onLoad={() => setLoaded(true)} />
      </svg>
    </div>
  );
}

/** Full intro before a scan; once scanning, a compact title row so progress and the gallery sit higher. */
function Header({ compact }: { compact: boolean }) {
  if (compact)
    return (
      <div className="flex items-center gap-3">
        <img src={relayxIcon} alt="" width={32} height={32} className="rounded-[8px]" />
        <h1 className="m-0 text-[18px] font-semibold tracking-[-0.01em]" style={{ color: INK }}>
          Recover RelayX collections
        </h1>
      </div>
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <img src={relayxIcon} alt="" width={40} height={40} className="rounded-[10px]" />
        <img src={relayxWordmark} alt="RelayX" height={22} style={{ height: 22, width: 'auto' }} />
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[24px] font-semibold leading-tight tracking-[-0.02em]" style={{ color: INK }}>
          Recover RelayX collections
        </h1>
        <p className="m-0 text-[14px] leading-relaxed" style={{ color: MUTED }}>
          Your RelayX NFTs are still on chain. Enter your RelayX words to find them. Nothing moves unless you melt one.
        </p>
      </div>
    </div>
  );
}

function Progress({ step }: { step: ScanStep | null }) {
  const found = step?.k === 'reading' ? step.found : 0;
  const pct = step?.k === 'reading' && step.total ? Math.round((step.done / step.total) * 100) : null;
  const line =
    !step || step.k === 'addresses'
      ? `Looking through your RelayX addresses${step ? ` · ${step.checked} checked` : ''}`
      : step.k === 'outputs'
        ? `Listing what ${step.addresses} address${step.addresses === 1 ? '' : 'es'} hold`
        : `Reading each NFT's history · ${step.done} of ${step.total}`;
  return (
    <div className="flex flex-col gap-3 pt-2" role="status" aria-live="polite">
      <div className="flex items-baseline gap-2">
        <span className="text-[44px] font-semibold leading-none tabular-nums tracking-[-0.03em]" style={{ color: INK }}>
          {found}
        </span>
        <span className="text-[15px]" style={{ color: MUTED }}>
          NFT{found === 1 ? '' : 's'} found
        </span>
      </div>
      <p className="m-0 text-[13px]" style={{ color: MUTED }}>
        {line}
      </p>
      <div className="h-[3px] w-full overflow-hidden rounded-full" style={{ background: LINE }}>
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
          style={{ background: BLUE, width: pct === null ? undefined : `${Math.max(pct, 3)}%` }}
        />
      </div>
      <p className="m-0 text-[12px]" style={{ color: MUTED }}>
        Big collections take a few minutes. A second look is instant: what we read is kept on this phone.
      </p>
    </div>
  );
}

function Tile({ f, box, onOpen }: { f: Found; box?: [number, number, number, number]; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-xl border-0 p-0 text-left cursor-pointer transition-[transform,background-color] duration-150 ease-out active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      style={{ background: SURFACE, boxShadow: `inset 0 0 0 1px ${LINE}`, outlineColor: BLUE }}
      aria-label={f.title}
    >
      {f.art ? (
        <Cutout url={f.art} box={box} className="aspect-[3/4] w-full rounded-t-xl" />
      ) : (
        <div className="aspect-[3/4] w-full" style={{ background: SURFACE }} />
      )}
      <span className="px-2 py-1.5 text-[12px] font-medium tabular-nums" style={{ color: INK }}>
        {f.n !== undefined ? `#${pad(f.n)}` : f.title}
      </span>
    </button>
  );
}

function Row({ f, onOpen }: { f: Found; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center justify-between gap-3 rounded-xl border-0 px-3 py-3 text-left cursor-pointer transition-colors duration-150 ease-out hover:brightness-110 focus-visible:outline focus-visible:outline-2"
      style={{ background: SURFACE, boxShadow: `inset 0 0 0 1px ${LINE}`, outlineColor: BLUE }}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[14px] font-medium" style={{ color: INK }}>
          {f.title}
        </span>
        <span className="truncate text-[12px]" style={{ color: MUTED }}>
          {f.unread ? `At ${short(f.address)}` : f.collection}
        </span>
      </span>
      <ArrowRight size={16} color={MUTED} className="shrink-0" />
    </button>
  );
}

function Detail({ f, box, onClose }: { f: Found; box?: [number, number, number, number]; onClose: () => void }) {
  const tx = f.origin ? splitOutpoint(f.origin).txid : '';
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-[180] flex items-end justify-center"
      style={{ background: 'rgb(0 0 0 / 0.6)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={f.title}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-[460px] flex-col gap-4 rounded-t-3xl p-5"
        style={{
          background: 'var(--bw-bg, #0B0C0E)',
          boxShadow: `inset 0 1px 0 ${LINE}, 0 -20px 60px rgb(0 0 0 / 0.5)`,
          paddingBottom: 'max(env(safe-area-inset-bottom), 20px)',
        }}
      >
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium" style={{ color: MUTED }}>
            {f.collection}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full border-0 bg-transparent p-1.5 cursor-pointer"
          >
            <X size={18} color={INK} />
          </button>
        </div>
        {f.art && (
          <div
            className="mx-auto w-full overflow-hidden rounded-2xl"
            style={{ background: `radial-gradient(120% 80% at 50% 100%, rgb(38 105 255 / 0.18), transparent 60%)` }}
          >
            <Cutout url={f.art} box={box} className="mx-auto h-[300px] w-full" />
          </div>
        )}
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[22px] font-semibold tracking-[-0.02em]" style={{ color: INK }}>
            {f.title}
          </h2>
          <span className="text-[13px]" style={{ color: MUTED }}>
            Held at {short(f.address)}
            {tx && (
              <>
                {' · '}
                <a
                  href={`https://whatsonchain.com/tx/${tx}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                  style={{ color: MUTED }}
                >
                  Minted at {tx.slice(0, 8)}… <ExternalLink size={12} />
                </a>
              </>
            )}
          </span>
        </div>
        {f.n !== undefined ? (
          <NpgMelt jig={f} wif={f.wif} art={f.art} size="lg" />
        ) : (
          <p
            className="m-0 rounded-xl px-3 py-3 text-[13px]"
            style={{ color: MUTED, boxShadow: `inset 0 0 0 1px ${LINE}` }}
          >
            This one is safe where it is. Melting is for Ninja Punk Girls the NPG site has identified.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function RelayxRecoverScreen({ onBack }: { onBack: () => void }) {
  const [words, setWords] = useState('');
  const [phase, setPhase] = useState<Phase>({ k: 'enter' });
  const [bbox, setBbox] = useState<BBox>({});
  const [open, setOpen] = useState<Found | null>(null);
  const [sweep, setSweep] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const cancel = useRef({ cancelled: false });
  const ctx = useRef<{ reader: ChainReader; maps: NpgMap[] } | null>(null);

  const problem = wordsProblem(words);
  const ready = !!words.trim() && !problem;

  const start = async () => {
    if (!ready) return;
    cancel.current = { cancelled: false };
    setPhase({ k: 'scanning', step: null });
    try {
      let store: Storage | null = null;
      try {
        store = window.localStorage;
      } catch {
        store = null;
      }
      const reader = createChainReader({ cache: createTxCache(store) });
      const [maps, index] = await Promise.all([
        loadNpgMaps(),
        fetch(NPG_CUTOUT_INDEX)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (index?.bbox) setBbox(index.bbox as BBox);
      ctx.current = { reader, maps };
      const result = await scanRelayx(words, reader, maps, (step) => setPhase({ k: 'scanning', step }), cancel.current);
      if (cancel.current.cancelled) return setPhase({ k: 'enter' });
      setPhase({ k: 'done', result });
    } catch (e) {
      if (!cancel.current.cancelled) setPhase({ k: 'error', message: (e as Error).message });
    }
  };

  const retry = async () => {
    if (phase.k !== 'done' || !ctx.current) return;
    setRetrying(true);
    const nfts = await retryUnread(phase.result.nfts, ctx.current.reader, ctx.current.maps);
    setPhase({ k: 'done', result: { ...phase.result, nfts } });
    setRetrying(false);
  };

  const groups = useMemo(() => (phase.k === 'done' ? groupFound(phase.result.nfts) : []), [phase]);
  const total = phase.k === 'done' ? phase.result.nfts.filter((n) => !n.unread).length : 0;
  const unread = phase.k === 'done' ? phase.result.nfts.filter((n) => n.unread).length : 0;
  const boxOf = (f: Found) => (f.n !== undefined ? bbox[pad(f.n)] : undefined);

  if (sweep) return <HdSweepScreen onBack={() => setSweep(false)} />;

  return createPortal(
    <div className="fixed inset-0 z-[150] flex flex-col" style={{ background: 'var(--bw-bg, #0B0C0E)' }}>
      <div
        className="flex items-center gap-1 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', boxShadow: `inset 0 -1px 0 ${LINE}` }}
      >
        <button
          type="button"
          onClick={() => {
            cancel.current.cancelled = true;
            onBack();
          }}
          aria-label="Back"
          className="rounded-full border-0 bg-transparent p-2 cursor-pointer focus-visible:outline focus-visible:outline-2"
          style={{ outlineColor: BLUE }}
        >
          <ArrowLeft size={20} color={INK} />
        </button>
        <span className="text-[15px] font-medium" style={{ color: INK }}>
          RelayX
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-7 px-4 pb-28 pt-6">
          <Header compact={phase.k === 'done' || phase.k === 'scanning'} />

          {(phase.k === 'enter' || phase.k === 'error') && (
            <div className="flex flex-col gap-3">
              <label htmlFor="relayx-words" className="text-[13px] font-medium" style={{ color: INK }}>
                Your RelayX 12 words
              </label>
              <textarea
                id="relayx-words"
                value={words}
                onChange={(e) => setWords(e.target.value)}
                rows={4}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                placeholder="word word word …"
                className="w-full resize-none rounded-xl border-0 px-3.5 py-3 text-[15px] leading-relaxed outline-none transition-shadow duration-150 ease-out"
                style={{
                  background: SURFACE,
                  color: INK,
                  boxShadow: `inset 0 0 0 1px ${problem ? 'rgb(249 112 102 / 0.6)' : LINE}`,
                }}
                onFocus={(e) => (e.currentTarget.style.boxShadow = `inset 0 0 0 1.5px ${BLUE}`)}
                onBlur={(e) =>
                  (e.currentTarget.style.boxShadow = `inset 0 0 0 1px ${problem ? 'rgb(249 112 102 / 0.6)' : LINE}`)
                }
              />
              {problem && (
                <p className="m-0 text-[13px]" style={{ color: '#F97066' }}>
                  {problem}
                </p>
              )}
              {phase.k === 'error' && (
                <p
                  className="m-0 rounded-xl px-3 py-2.5 text-[13px]"
                  style={{ color: '#FDA29B', background: 'rgb(249 112 102 / 0.08)' }}
                >
                  The search stopped: {phase.message}. Your words are fine; try again in a moment.
                </p>
              )}
              <button
                type="button"
                onClick={() => void start()}
                disabled={!ready}
                className="mt-1 h-12 w-full rounded-xl border-0 text-[15px] font-semibold cursor-pointer transition-[transform,filter,opacity] duration-150 ease-out active:scale-[0.98] hover:brightness-110 disabled:cursor-default disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                style={{ background: BLUE, color: '#fff' }}
              >
                {phase.k === 'error' ? 'Try again' : 'Find my NFTs'}
              </button>
              <p className="m-0 flex items-start gap-2 text-[12px] leading-relaxed" style={{ color: MUTED }}>
                <ShieldCheck size={14} className="mt-[2px] shrink-0" />
                Your words stay on this phone, in this screen only. They are never saved or sent anywhere. We read
                public chain data to find what they hold.
              </p>
            </div>
          )}

          {phase.k === 'scanning' && (
            <div className="flex flex-col gap-5">
              <Progress step={phase.step} />
              <button
                type="button"
                onClick={() => {
                  cancel.current.cancelled = true;
                  setPhase({ k: 'enter' });
                }}
                className="self-start rounded-lg border-0 bg-transparent px-0 py-1 text-[14px] font-medium cursor-pointer hover:underline"
                style={{ color: MUTED }}
              >
                Cancel
              </button>
            </div>
          )}

          {phase.k === 'done' && (
            <div className="flex flex-col gap-7">
              {total > 0 && (
                <div className="flex flex-col gap-1">
                  <span
                    className="text-[44px] font-semibold leading-none tabular-nums tracking-[-0.03em]"
                    style={{ color: INK }}
                  >
                    {total}
                  </span>
                  <span className="text-[14px]" style={{ color: MUTED }}>
                    RelayX NFT{total === 1 ? '' : 's'} at your words. Tap one to see it or melt it.
                  </span>
                </div>
              )}

              {!total && !unread && (
                <div
                  className="flex flex-col gap-3 rounded-2xl px-4 py-4"
                  style={{ boxShadow: `inset 0 0 0 1px ${LINE}` }}
                >
                  <p className="m-0 text-[14px]" style={{ color: INK }}>
                    No RelayX NFTs at these words
                  </p>
                  <p className="m-0 text-[13px] leading-relaxed" style={{ color: MUTED }}>
                    Check these are your RelayX words, not another wallet's. NFTs that were listed for sale on RelayX
                    when it closed sit at a market address and won't show here.
                  </p>
                  <button
                    type="button"
                    onClick={() => setPhase({ k: 'enter' })}
                    className="self-start rounded-lg border-0 bg-transparent px-0 text-[14px] font-medium cursor-pointer hover:underline"
                    style={{ color: BLUE }}
                  >
                    Enter different words
                  </button>
                </div>
              )}

              {unread > 0 && (
                <div
                  className="flex items-center justify-between gap-3 rounded-xl px-3.5 py-3"
                  style={{ background: SURFACE, boxShadow: `inset 0 0 0 1px ${LINE}` }}
                >
                  <span className="text-[13px]" style={{ color: MUTED }}>
                    {unread} couldn't be read just now
                  </span>
                  <button
                    type="button"
                    onClick={() => void retry()}
                    disabled={retrying}
                    className="inline-flex items-center gap-1.5 rounded-lg border-0 px-3 py-1.5 text-[13px] font-medium cursor-pointer disabled:opacity-60"
                    style={{ background: BLUE, color: '#fff' }}
                  >
                    <RotateCw size={13} className={retrying ? 'animate-spin' : ''} /> Retry
                  </button>
                </div>
              )}

              {groups
                .filter((g) => g.key !== 'unread')
                .map((g) => (
                  <section key={g.key} className="flex flex-col gap-3">
                    <h3
                      className="m-0 flex items-baseline justify-between text-[13px] font-medium"
                      style={{ color: INK }}
                    >
                      {g.title}
                      <span className="tabular-nums" style={{ color: MUTED }}>
                        {g.items.length}
                      </span>
                    </h3>
                    {g.key === 's2' || g.key === 's1' ? (
                      <div className="grid grid-cols-3 gap-2.5">
                        {g.items.map((f) => (
                          <Tile key={f.location} f={f} box={boxOf(f)} onOpen={() => setOpen(f)} />
                        ))}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {g.items.map((f) => (
                          <Row key={f.location} f={f} onOpen={() => setOpen(f)} />
                        ))}
                      </div>
                    )}
                  </section>
                ))}

              {phase.result.otherSats > 0 && (
                <button
                  type="button"
                  onClick={() => setSweep(true)}
                  className="flex items-center justify-between gap-3 rounded-xl border-0 bg-transparent px-3.5 py-3 text-left cursor-pointer hover:brightness-125"
                  style={{ boxShadow: `inset 0 0 0 1px ${LINE}` }}
                >
                  <span className="text-[13px]" style={{ color: MUTED }}>
                    These words also hold {bsv(phase.result.otherSats)} BSV
                  </span>
                  <span className="inline-flex items-center gap-1 text-[13px] font-medium" style={{ color: INK }}>
                    Bring it in <ArrowRight size={14} />
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {open && <Detail f={open} box={boxOf(open)} onClose={() => setOpen(null)} />}
    </div>,
    document.body,
  );
}
