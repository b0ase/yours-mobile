import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import type { ThemeLook, ThemePack } from '../theme/themePack';
import { patternUri } from '../wallet/cardPatterns';
import { isLightPattern } from '../wallet/cardPatternsLight';
import { S } from './styles';

/** The pack's card art, as its balance card would wear it (edition art for VexVoid / NPG / NPGX). */
const artOf = (p: ThemePack): string => {
  // Light packs never wear dark card art (as WalletCard): a white-design pattern or a plain card.
  if (p.look.scheme === 'light' && !isLightPattern(p.look.pattern)) return '';
  try {
    return patternUri(p.look.pattern, p.look.accent, p.id, p.look.paper ? p.look.surface : undefined);
  } catch {
    return '';
  }
};

/**
 * A mini wallet painted from the pack's own tokens (not the current theme): top bar, balance card with the pack's
 * card art, two rows, the accent button and the tab bar. `big` is the preview sheet size.
 */
export function MiniWallet({ p, big = false }: { p: ThemePack; big?: boolean }) {
  const l: ThemeLook = p.look;
  const art = useMemo(() => artOf(p), [p]);
  const k = big ? 1.7 : 1;
  const px = (n: number) => `${Math.round(n * k)}px`;
  const font: CSSProperties = l.fontNum === 'inherit' ? {} : { fontFamily: l.fontNum };
  const bar = (w: string, c: string, h = 4): CSSProperties => ({
    display: 'block',
    width: w,
    height: px(h),
    borderRadius: px(h),
    background: c,
  });
  const row = (wide: string, amt: string) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: px(6),
        padding: `${px(5)} ${px(6)}`,
        background: l.surface,
        border: `1px solid ${l.line}`,
        borderRadius: `min(${l.radiusCard}, ${px(8)})`,
      }}
    >
      <span style={{ width: px(12), height: px(12), borderRadius: '50%', background: l.surface2, flex: 'none' }} />
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: px(3) }}>
        <span style={bar(wide, l.text, 3)} />
        <span style={bar('40%', l.muted, 3)} />
      </span>
      <span style={{ ...font, fontSize: px(8), color: l.text, fontWeight: 600 }}>{amt}</span>
    </div>
  );
  return (
    <div
      aria-hidden="true"
      style={{
        overflow: 'hidden',
        height: px(176),
        borderRadius: big ? 20 : 12,
        background: l.bg,
        border: '1px solid var(--bw-line, #2b2f36)',
        display: 'flex',
        flexDirection: 'column',
        colorScheme: l.scheme,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `${px(7)} ${px(8)} ${px(5)}`,
          background: l.nav,
        }}
      >
        <span
          style={{
            fontFamily: l.fontHead === 'inherit' ? undefined : l.fontHead,
            fontSize: px(9),
            fontWeight: l.weightHead,
            color: l.text,
          }}
        >
          bWalletX
        </span>
        <span style={{ width: px(12), height: px(12), borderRadius: '50%', background: l.accent }} />
      </div>
      <div style={{ flex: 1, padding: `${px(4)} ${px(8)}`, display: 'flex', flexDirection: 'column', gap: px(5) }}>
        <div
          style={{
            height: px(58),
            flex: 'none',
            borderRadius: `min(${l.radiusCard}, ${px(10)})`,
            background: art ? `${l.surface} center / cover no-repeat url("${art}")` : l.surface,
            border: l.trim === 'transparent' ? `1px solid ${l.line}` : `1px solid ${l.trim}`,
            padding: `${px(6)} ${px(7)}`,
            display: 'flex',
            alignItems: 'flex-end',
            overflow: 'hidden',
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              ...font,
              fontSize: px(13),
              fontWeight: 700,
              color: l.text,
              textShadow: l.scheme === 'dark' ? '0 1px 4px rgb(0 0 0 / 0.8)' : '0 1px 3px rgb(255 255 255 / 0.9)',
            }}
          >
            {/* No sample balance: on a Store tile it read as the price (owner 17 Oct 2026). */}
            •••• 2026
          </span>
        </div>
        {row('62%', '+0.01')}
        {row('48%', '−0.002')}
        <span
          style={{
            textAlign: 'center',
            padding: `${px(4)} 0`,
            borderRadius: l.radius,
            background: l.accent,
            color: l.on,
            boxShadow: l.glow === 'none' ? undefined : l.glow,
            fontSize: px(8),
            fontWeight: 700,
          }}
        >
          Send
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-around',
          alignItems: 'center',
          padding: `${px(6)} ${px(6)}`,
          background: l.nav,
          borderTop: `1px solid ${l.line}`,
        }}
      >
        {[l.accent, l.muted, l.muted, l.muted].map((c, i) => (
          <span key={i} style={{ width: px(14), height: px(4), borderRadius: px(2), background: c }} />
        ))}
      </div>
    </div>
  );
}

const badge: CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  fontSize: 11,
  fontWeight: 700,
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--bw-accent)',
  color: 'var(--bw-on-accent, #010101)',
  boxShadow: '0 1px 4px rgb(0 0 0 / 0.25)',
};

const unset: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: 0,
  margin: 0,
  border: 0,
  background: 'none',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
};

/** One theme in the grid: the live mini wallet, name, maker, price and an action. Tapping the preview opens it big. */
export function PackCard({
  p,
  inUse = false,
  price,
  onOpen,
  children,
}: {
  p: ThemePack;
  inUse?: boolean;
  price?: string;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  return (
    <div style={{ ...S.card, padding: 8, gap: 8, boxShadow: inUse ? '0 0 0 2px var(--bw-accent)' : undefined }}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Preview ${p.label}`}
        style={{ ...unset, cursor: onOpen ? 'pointer' : 'default', position: 'relative' }}
      >
        <MiniWallet p={p} />
        {inUse && <span style={badge}>In use</span>}
      </button>
      <div style={{ padding: '0 4px', minWidth: 0 }}>
        <b
          style={{ display: 'block', fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {p.label}
        </b>
        <p style={{ ...S.muted, fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.creator}</span>
          {price && (
            <span
              style={{
                flex: 'none',
                fontWeight: 800,
                fontSize: 13,
                padding: '2px 8px',
                borderRadius: 999,
                background: price === 'Owned' ? 'transparent' : 'var(--bw-accent, #F5C542)',
                color: price === 'Owned' ? 'var(--bw-muted, #98A2B3)' : 'var(--bw-on, #0B0A08)',
                border: price === 'Owned' ? '1px solid var(--bw-line, #333)' : 'none',
              }}
            >
              {price}
            </span>
          )}
        </p>
      </div>
      {children && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 2px 2px' }}>{children}</div>
      )}
    </div>
  );
}

/** A bottom sheet with the big preview, the blurb and the pack's action. */
export function PreviewSheet({
  p,
  inUse,
  price,
  onClose,
  children,
}: {
  p: ThemePack;
  inUse: boolean;
  price?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" aria-label={`${p.label} theme`} style={S.scrim} onClick={onClose}>
      <div style={S.sheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.grab} />
        <div style={{ maxWidth: 300, margin: '0 auto 16px' }}>
          <MiniWallet p={p} big />
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>{p.label}</h2>
          {price && <b style={{ fontSize: 15 }}>{price}</b>}
        </div>
        <p style={{ ...S.muted, margin: '4px 0 0' }}>{p.creator}</p>
        {p.blurb && <p style={{ margin: '8px 0 0', fontSize: 14 }}>{p.blurb}</p>}
        {inUse && <p style={{ ...S.muted, margin: '8px 0 0' }}>This is your current theme.</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>{children}</div>
          <button type="button" style={S.ghost} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Empty section: a short framed line, no placeholder listings. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div style={S.emptyBox}>
      <b style={{ display: 'block', marginBottom: 4, color: 'var(--bw-text, #f2f2f0)' }}>{title}</b>
      {children}
    </div>
  );
}

/** Visible live / coming checklist (pages show status). */
export function StatusList({ items }: { items: readonly (readonly [string, boolean])[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: '24px 0 0', fontSize: 13 }} aria-label="Status">
      {items.map(([label, live]) => (
        <li
          key={label}
          style={{ color: live ? 'var(--bw-text, #f2f2f0)' : 'var(--bw-muted, #98a2b3)', padding: '2px 0' }}
        >
          {live ? '✓' : '○'} {label}
        </li>
      ))}
    </ul>
  );
}
