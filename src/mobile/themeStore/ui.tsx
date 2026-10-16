import type { ReactNode } from 'react';
import type { ThemePack } from '../theme/themePack';
import { S } from './styles';

/** A pack's swatch: its own page, card and accent, as the pack would paint them. */
export function Swatch({ p }: { p: ThemePack }) {
  const [bg, surface, accent] = p.preview;
  return (
    <div
      aria-hidden="true"
      style={{
        height: 72,
        borderRadius: 10,
        background: bg,
        border: '1px solid var(--bw-line, #2b2f36)',
        padding: 10,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 6,
      }}
    >
      <span style={{ flex: 1, height: 34, borderRadius: 6, background: surface }} />
      <span style={{ width: 22, height: 22, borderRadius: 11, background: accent }} />
    </div>
  );
}

export function PackCard({ p, children }: { p: ThemePack; children: ReactNode }) {
  return (
    <div style={S.card}>
      <Swatch p={p} />
      <div>
        <b style={{ display: 'block' }}>{p.label}</b>
        <p style={S.muted}>{p.creator}</p>
      </div>
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
