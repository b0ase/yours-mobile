import type { Plugin } from 'vite';

/**
 * Theme packs, build side (owner, 15 Oct 2026: "restyle the WHOLE app"). Upstream screens hard-code neutral
 * colours inline (`style={{ color: '#98A2B3', background: '#17191E' }}`) and add alpha by string suffix
 * (`theme.color.global.gray + '40'`). This transform, run after mobile-text so its exact-match patches still
 * apply to the original source, rewrites them at build time:
 *
 *   - neutral inline colours → var(--bw-text | --bw-muted | --bw-card | --bw-card2 | --bw-pack-bg | --bw-line,
 *     <the original colour>), so Gold (which sets none of these) renders exactly as before;
 *   - `${theme.color.x}40` / `theme.color.x + '40'` → color-mix(), which works with a variable.
 *
 * Saturated colours (brand, accent, red/green states) are left alone; so are lines about video, overlays or
 * scrims, whose white text sits on pictures.
 */
const SKIP_LINE = /video|overlay|scrim|D92D20|F04438|ef4444|F97066|rgba\(0|bavatar|wcard/i;

const rgb = (hex: string): [number, number, number] => {
  let h = hex.slice(1);
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const lum = (c: [number, number, number]) => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const sat = (c: [number, number, number]) => {
  const mx = Math.max(...c);
  return mx ? (mx - Math.min(...c)) / mx : 0;
};

/** The variable for a neutral colour in a given property, or null to leave it alone. */
export function themeVarFor(prop: string, hex: string): string | null {
  const c = rgb(hex);
  if (sat(c) > 0.32) return null;
  const l = lum(c);
  if (prop === 'color') return l > 0.55 ? 'var(--bw-text, X)' : l > 0.12 ? 'var(--bw-muted, X)' : null;
  if (prop.startsWith('background'))
    return l < 0.0025
      ? 'var(--bw-pack-bg, X)'
      : l < 0.02
        ? 'var(--bw-card, X)'
        : l < 0.05
          ? 'var(--bw-card2, X)'
          : null;
  if (prop.startsWith('border')) return l < 0.1 ? 'var(--bw-line, X)' : null;
  return null;
}

// Card faces, art, media and the theme code itself keep their own colours.
const SKIP_FILE =
  /\.test\.|\/mobile\/theme\/|\/wallet\/(Card|WalletCard|card)|bmovies|bmint|three3d|bavatar|FeedMedia|VideoEmbed|\/media\//;

const PROP = /\b(color|background|backgroundColor|borderColor|border|borderTop|borderBottom): ?/g;

/** Where a style value expression ends: the first top-level , } or ) after `i`. */
function exprEnd(line: string, i: number): number {
  let depth = 0;
  let quote = '';
  for (let j = i; j < line.length; j++) {
    const c = line[j] as string;
    if (quote) {
      if (c === quote && line[j - 1] !== '\\') quote = '';
    } else if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return j;
      depth--;
    } else if (c === ',' && depth === 0) return j;
  }
  return line.length;
}

/** Rewrites neutral colours inside each style value on a line (plain values and ternaries alike). */
function themeLine(line: string): string {
  const fill = colouredFill(line);
  let out = '';
  let last = 0;
  for (const m of line.matchAll(PROP)) {
    const start = (m.index as number) + m[0].length;
    if (start < last) continue;
    const end = exprEnd(line, start);
    const prop = m[1] as string;
    const expr = line.slice(start, end);
    const next =
      prop === 'color' && fill
        ? expr
        : expr.replace(/'([^']*)'/g, (q, inner: string) =>
            inner.includes('var(') || inner.startsWith('text-') || inner.startsWith('bg-')
              ? q
              : `'${inner.replace(/(?<!\[)(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})(?![0-9a-fA-F])/g, (h: string) => {
                  const v = themeVarFor(prop, h);
                  return v ? v.replace('X', h) : h;
                })}'`,
          );
    out += line.slice(last, start) + next;
    last = end;
  }
  return out + line.slice(last);
}
const CONST =
  /^const (MUTED|GRAY|GREY|DIM|TEXT|INK|LINE|BORDER|PANEL|CARD|BG) = '(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})';/gm;
const ON_ACCENT = /color: '(#000|#000000|#010101|#0a0a0a|#1a1300|#1a1400)'/g;
/** A line that also sets a coloured (saturated) fill: its text colour belongs to that fill, leave it. */
const colouredFill = (line: string) =>
  /background(?:Color)?: ?'(?:rgba?\(|[^']*gradient)/.test(line) ||
  [...line.matchAll(/background(?:Color)?: ?'[^']*?(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})(?![0-9a-fA-F])/g)].some(
    (m) => sat(rgb(m[1] as string)) > 0.32,
  );
const pct = (hh: string) => Math.round(parseInt(hh, 16) / 2.55);

export function themeSource(code: string): string {
  let out = code
    // `${theme.color.global.gray}40` → color-mix(…)
    .replace(
      /\$\{([\w.]*color\.(?:global|component)\.\w+)\}([0-9a-fA-F]{2})(?![0-9a-fA-F])/g,
      (_m, ref: string, hh: string) => `color-mix(in srgb, \${${ref}} ${pct(hh)}%, transparent)`,
    )
    // theme.color.global.gray + '40' → `color-mix(…)`
    .replace(
      /([\w.]*color\.(?:global|component)\.\w+) ?\+ ?['`]([0-9a-fA-F]{2})['`]/g,
      (_m, ref: string, hh: string) => `\`color-mix(in srgb, \${${ref}} ${pct(hh)}%, transparent)\``,
    );
  // Module colour constants (const MUTED = '#98A2B3'; const PANEL = '#0b0c0f'; …), by role.
  out = out.replace(CONST, (m, name: string, hex: string) => {
    const prop = /^(MUTED|GRAY|GREY|DIM|TEXT|INK)$/.test(name)
      ? 'color'
      : /^(LINE|BORDER)$/.test(name)
        ? 'border'
        : 'background';
    const v = themeVarFor(prop, hex);
    return v ? `const ${name} = '${v.replace('X', hex)}';` : m;
  });
  out = out
    .split('\n')
    .map((line) => {
      // Dark text on an accent fill (Send, Buy …) becomes the pack's on-accent colour.
      if (line.includes('var(--bw-accent'))
        line = line.replace(ON_ACCENT, (_m, hex: string) => `color: 'var(--bw-on-accent, ${hex})'`);
      line = line.replace(/color: '(?:white|rgb\(255, ?255, ?255\))'/g, "color: 'var(--bw-text, #FFFFFF)'");
      if (SKIP_LINE.test(line) || !line.includes('#')) return line;
      return themeLine(line);
    })
    .join('\n');
  return out;
}

export const themeTokens = (): Plugin => ({
  name: 'theme-tokens',
  enforce: 'pre',
  transform: {
    order: 'pre',
    handler(code, id) {
      const file = id.split('?')[0] as string;
      if (!/\/src\/.*\.(tsx|ts)$/.test(file) || SKIP_FILE.test(file)) return null;
      const out = themeSource(code);
      return out === code ? null : { code: out, map: null };
    },
  },
});
