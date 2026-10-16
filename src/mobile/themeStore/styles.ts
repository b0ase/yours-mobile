import type { CSSProperties } from 'react';

// Theme Store look: every colour is a theme variable, so light packs get light cards and black text.
export const S = {
  page: {
    minHeight: '100%',
    background: 'var(--bw-pack-bg, var(--bw-bg, #010101))',
    color: 'var(--bw-text, #f2f2f0)',
    padding: '20px 16px 96px',
  } as CSSProperties,
  h1: { margin: '0 0 4px', fontSize: 26, fontWeight: 'var(--bw-weight-head, 700)' as unknown as number },
  sub: { margin: '0 0 16px', color: 'var(--bw-muted, #98a2b3)', fontSize: 14 } as CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 } as CSSProperties,
  card: {
    background: 'var(--bw-card, #17191e)',
    border: '1px solid var(--bw-line, #2b2f36)',
    borderRadius: 'var(--bw-radius-card, 16px)',
    padding: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  } as CSSProperties,
  muted: { color: 'var(--bw-muted, #98a2b3)', fontSize: 13, margin: 0 } as CSSProperties,
  btn: {
    background: 'var(--bw-accent)',
    color: 'var(--bw-on-accent, #010101)',
    border: 0,
    borderRadius: 'var(--bw-radius-btn, 12px)',
    padding: '8px 12px',
    font: 'inherit',
    fontWeight: 600,
    cursor: 'pointer',
  } as CSSProperties,
  ghost: {
    background: 'transparent',
    color: 'var(--bw-muted, #98a2b3)',
    border: '1px solid var(--bw-line, #2b2f36)',
    borderRadius: 'var(--bw-radius-btn, 12px)',
    padding: '8px 12px',
    font: 'inherit',
  } as CSSProperties,
  empty: { padding: '24px 4px', color: 'var(--bw-muted, #98a2b3)', fontSize: 14 } as CSSProperties,
};
