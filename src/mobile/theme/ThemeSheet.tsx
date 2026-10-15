import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Dices, Moon, Palette, Shuffle, SlidersHorizontal, Sun, X } from 'lucide-react';
import { DEFAULT_ACCENT, MORE_COLOURS, THEMES, accentById, type Accent, type AccentId } from './accents';
import { loadAccent, loadMix, previewMix, saveAccent, saveMix } from './accent';
import { deriveMix, mixFromPack, type MixSpec } from './mixer';

type ThemeTab = 'colours' | 'card';

// Corners for a mix (owner, 15 Oct 2026: fill the Theme page with real options). Buttons · cards.
const CORNERS = [
  { id: 'sharp', label: 'Sharp', radius: '3px', radiusCard: '6px' },
  { id: 'soft', label: 'Soft', radius: '12px', radiusCard: '16px' },
  { id: 'round', label: 'Round', radius: '999px', radiusCard: '22px' },
] as const;
const rnd = (lo: number, hi: number) => Math.round(lo + Math.random() * (hi - lo));
/** A random mix: any hues, colour and depth kept in ranges that look designed. Contrast is still enforced by deriveMix. */
const surpriseMix = (prev: MixSpec): MixSpec => ({
  ...prev,
  base: Math.random() < 0.7 ? 'dark' : 'light',
  sh: rnd(0, 360),
  ss: rnd(0, 45),
  sd: rnd(0, 60),
  ah: rnd(0, 360),
  as: rnd(55, 100),
  al: rnd(35, 75),
});

/**
 * Theme (owner, 14 Oct 2026): the page behind the sliders icon on the card back, which was "Design your card".
 * Two tabs: App colours (the accent, below) and Design your card (the existing CardDesigner, unchanged apart from
 * its title and these tabs). Where the card has no designer (bWallet's yellow card), only App colours shows.
 */
export function ThemeSheet({
  account,
  onClose,
  card,
  initialTab = 'card',
}: {
  /** The account's identity key: the accent is kept per account on this device. */
  account: string;
  onClose: () => void;
  /** Renders the card designer with the shared tab bar; absent where the card can't be designed. */
  card?: (tabs: ReactNode) => ReactNode;
  initialTab?: ThemeTab;
}) {
  const [tab, setTab] = useState<ThemeTab>(card ? initialTab : 'colours');
  const tabs = card ? (
    <div className="bw-cdes-seg bw-theme-tabs" role="tablist" aria-label="Theme">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'colours'}
        className={tab === 'colours' ? 'on' : ''}
        onClick={() => setTab('colours')}
      >
        App colours
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'card'}
        className={tab === 'card' ? 'on' : ''}
        onClick={() => setTab('card')}
      >
        Design your card
      </button>
    </div>
  ) : null;
  if (card && tab === 'card') return <>{card(tabs)}</>;
  return <AppColours account={account} tabs={tabs} onClose={onClose} />;
}

function AppColours({ account, tabs, onClose }: { account: string; tabs: ReactNode; onClose: () => void }) {
  const [current, setCurrent] = useState<AccentId>(() => loadAccent(account));
  const [mix, setMix] = useState<MixSpec>(() => loadMix(account) ?? mixFromPack(accentById(loadAccent(account))));
  const [mixing, setMixing] = useState(() => loadAccent(account) === 'custom');
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pick = (id: AccentId) => {
    saveAccent(account, id);
    setCurrent(id);
    setMixing(false);
    if (id !== 'custom') setMix(mixFromPack(accentById(id)));
  };
  // Sliders paint live; the mix is saved when the finger lifts (and on Done), not on every frame.
  const slide = (next: MixSpec, commit: boolean) => {
    setMix(next);
    setCurrent('custom');
    if (commit) saveMix(account, next);
    else previewMix(next);
  };
  const derived = useMemo(() => deriveMix(mix), [mix]);
  // Shuffle: another pack at random (never the one on). Surprise: a random mix, opened so it can be tuned.
  const shuffle = () => {
    const others = THEMES.filter((a) => a.id !== current);
    pick(others[Math.floor(Math.random() * others.length)].id);
  };
  const surprise = () => {
    setMixing(true);
    slide(surpriseMix(mix), true);
  };
  const corner = CORNERS.find((c) => c.radiusCard === derived.radiusCard)?.id;

  return createPortal(
    <div className="bw-cdes bw-theme" role="dialog" aria-modal="true" aria-label="Theme">
      <div className="bw-cdes-top">
        <b>Theme</b>
        <button ref={closeRef} type="button" className="bw-cdes-x" aria-label="Close theme" onClick={onClose}>
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {tabs}
      <div className="bw-theme-head">
        <p className="bw-theme-more">Theme packs</p>
        <button type="button" className="bw-theme-chip" onClick={shuffle}>
          <Shuffle size={14} aria-hidden="true" />
          Shuffle
        </button>
        <button type="button" className="bw-theme-chip" onClick={surprise}>
          <Dices size={14} aria-hidden="true" />
          Surprise me
        </button>
      </div>
      <div className="bw-pack-grid" role="radiogroup" aria-label="Theme packs">
        {THEMES.map((a) => (
          <PackTile key={a.id} a={a} on={current === a.id} onPick={() => pick(a.id)} />
        ))}
        <PackTile
          a={derived}
          on={current === 'custom'}
          onPick={() => {
            setMixing(true);
            slide(mix, true);
          }}
        />
      </div>
      <div className="bw-mixer" data-open={mixing ? '' : undefined}>
        <button type="button" className="bw-mixer-head" aria-expanded={mixing} onClick={() => setMixing((m) => !m)}>
          <SlidersHorizontal size={18} aria-hidden="true" />
          <span>
            <b>Mix your own</b>
            <small>Starts from the pack you have on; every colour stays readable</small>
          </span>
        </button>
        {mixing && (
          <div className="bw-mixer-body">
            <div className="bw-mixer-base" role="radiogroup" aria-label="Base">
              {(['dark', 'light'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  role="radio"
                  aria-checked={mix.base === b}
                  className={mix.base === b ? 'on' : ''}
                  onClick={() => slide({ ...mix, base: b }, true)}
                >
                  {b === 'dark' ? <Moon size={16} aria-hidden="true" /> : <Sun size={16} aria-hidden="true" />}
                  {b === 'dark' ? 'Dark' : 'Light'}
                </button>
              ))}
            </div>
            <div className="bw-mixer-base bw-mixer-corners" role="radiogroup" aria-label="Corners">
              {CORNERS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={corner === c.id}
                  className={corner === c.id ? 'on' : ''}
                  onClick={() => slide({ ...mix, radius: c.radius, radiusCard: c.radiusCard }, true)}
                >
                  <i aria-hidden="true" style={{ borderRadius: c.id === 'round' ? 9 : c.id === 'soft' ? 5 : 1 }} />
                  {c.label}
                </button>
              ))}
            </div>
            <MixGroup
              title="Surfaces"
              hint="Page, cards, fills, text"
              swatch={[derived.bg, derived.surface, derived.surface2]}
              rows={[
                { k: 'sh', label: 'Hue', max: 360, kind: 'hue' },
                { k: 'ss', label: 'Colour', max: 100, kind: 'sat' },
                { k: 'sd', label: 'Depth', max: 100, kind: 'depth' },
              ]}
              mix={mix}
              hue={mix.sh}
              slide={slide}
            />
            <MixGroup
              title="Lines & actions"
              hint="Buttons, accent, outlines"
              swatch={[derived.lo, derived.accent, derived.hi]}
              rows={[
                { k: 'ah', label: 'Hue', max: 360, kind: 'hue' },
                { k: 'as', label: 'Colour', max: 100, kind: 'sat' },
                { k: 'al', label: 'Brightness', max: 100, kind: 'depth' },
              ]}
              mix={mix}
              hue={mix.ah}
              slide={slide}
            />
            <p className="bw-mixer-note">
              Text and buttons are checked as you slide and nudged lighter or darker until they read clearly (WCAG AA).
            </p>
          </div>
        )}
      </div>
      <p className="bw-theme-more">Accent only</p>
      <div className="bw-theme-swatches" role="radiogroup" aria-label="Accent colours">
        {MORE_COLOURS.map((a) => (
          <Swatch key={a.id} a={a} on={current === a.id} pick={pick} />
        ))}
      </div>
      <p className="bw-cdes-note">
        Packs restyle the whole app; Accent only keeps Gold&apos;s black. Kept for this account on this device.
      </p>
      <div className="bw-cdes-actions">
        <button
          type="button"
          className="bw-cdes-reset"
          onClick={() => pick(DEFAULT_ACCENT)}
          disabled={current === DEFAULT_ACCENT}
        >
          Reset to Gold
        </button>
        <button type="button" className="bw-cdes-done bw-theme-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>,
    document.body,
  );
}

type MixKey = 'sh' | 'ss' | 'sd' | 'ah' | 'as' | 'al';
function MixGroup({
  title,
  hint,
  swatch,
  rows,
  mix,
  hue,
  slide,
}: {
  title: string;
  hint: string;
  swatch: string[];
  rows: { k: MixKey; label: string; max: number; kind: 'hue' | 'sat' | 'depth' }[];
  mix: MixSpec;
  hue: number;
  slide: (m: MixSpec, commit: boolean) => void;
}) {
  const track = (kind: 'hue' | 'sat' | 'depth') =>
    kind === 'hue'
      ? 'linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)'
      : kind === 'sat'
        ? `linear-gradient(90deg,hsl(${hue} 0% 50%),hsl(${hue} 100% 50%))`
        : `linear-gradient(90deg,hsl(${hue} 60% 8%),hsl(${hue} 60% 50%),hsl(${hue} 60% 92%))`;
  return (
    <fieldset className="bw-mixer-group">
      <legend>
        <span className="bw-mixer-sw" aria-hidden="true">
          {swatch.map((c, i) => (
            <i key={i} style={{ background: c }} />
          ))}
        </span>
        <b>{title}</b>
        <small>{hint}</small>
      </legend>
      {rows.map((r) => (
        <label key={r.k} className="bw-mixer-row">
          <span>{r.label}</span>
          <input
            type="range"
            min={0}
            max={r.max}
            value={Math.round(mix[r.k])}
            style={{ background: track(r.kind) }}
            onChange={(e) => slide({ ...mix, [r.k]: Number(e.target.value) }, false)}
            onPointerUp={(e) => slide({ ...mix, [r.k]: Number((e.target as HTMLInputElement).value) }, true)}
            onKeyUp={(e) => slide({ ...mix, [r.k]: Number((e.target as HTMLInputElement).value) }, true)}
          />
        </label>
      ))}
    </fieldset>
  );
}

/** A tappable pack preview: a mini wallet screen drawn in that pack's own colours. */
function PackTile({ a, on, onPick }: { a: Accent; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={`${a.label}: ${a.blurb ?? ''}`}
      className={`bw-pack${on ? ' is-on' : ''}`}
      style={{
        background: a.bg,
        color: a.text,
        borderColor: on ? a.accent : a.line,
        borderRadius: Math.min(parseInt(a.radiusCard) || 16, 18),
        boxShadow: on ? `0 0 0 2px ${a.accent}` : undefined,
      }}
      onClick={onPick}
    >
      <span className="bw-pack-screen" aria-hidden="true">
        <span className="bw-pack-bar">
          <i style={{ background: a.accent }} />
          <i style={{ background: a.muted, opacity: 0.6 }} />
        </span>
        <span
          className="bw-pack-card"
          style={{
            background: `linear-gradient(135deg, ${a.hi}, ${a.accent} 50%, ${a.lo})`,
            color: a.on,
            borderRadius: Math.min(parseInt(a.radiusCard) || 12, 10),
            boxShadow: a.glow !== 'none' ? a.glow : undefined,
          }}
        >
          <b style={{ fontFamily: a.fontNum }}>$128.40</b>
        </span>
        <span className="bw-pack-row" style={{ background: a.surface, borderColor: a.line }}>
          <i style={{ background: a.accent }} />
          <span>
            <em style={{ background: a.text }} />
            <em style={{ background: a.muted, width: '55%' }} />
          </span>
          <small style={{ color: a.success }}>+2.4%</small>
        </span>
        <span className="bw-pack-btns">
          <span style={{ background: a.accent, color: a.on, borderRadius: a.radius }}>Send</span>
          <span style={{ borderColor: a.line, color: a.text, borderRadius: a.radius, background: a.surface2 }}>
            Receive
          </span>
        </span>
        <span className="bw-pack-nav" style={{ background: a.nav, borderColor: a.line }}>
          {[0, 1, 2, 3].map((n) => (
            <i key={n} style={{ background: n === 0 ? a.accent : a.muted }} />
          ))}
        </span>
      </span>
      <span className="bw-pack-name" style={{ fontFamily: a.fontHead, fontWeight: a.weightHead }}>
        {a.kind === 'custom' && <Palette size={13} aria-hidden="true" />}
        {a.label}
        {on && <Check size={14} aria-hidden="true" />}
      </span>
      <small className="bw-pack-blurb" style={{ color: a.muted }}>
        {a.blurb}
      </small>
    </button>
  );
}
function Swatch({ a, on, pick }: { a: Accent; on: boolean; pick: (id: AccentId) => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      className={`bw-theme-swatch${on ? ' is-on' : ''}`}
      onClick={() => pick(a.id)}
    >
      <span
        className="bw-theme-dot"
        style={{ background: `linear-gradient(135deg, ${a.hi}, ${a.accent} 55%, ${a.lo})`, color: a.on }}
      >
        {on && <Check size={16} aria-hidden="true" />}
      </span>
      <span className="bw-theme-name">{a.label}</span>
    </button>
  );
}
