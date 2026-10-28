/**
 * Warm per-person bubble shades for bChatX rooms (owner, 28 Oct 2026: "no black bubbles on a black
 * background for either party. Telegram is the model. Warm yellow/orange shades, not colours of the
 * rainbow"). PURE, so `bubbleShades.test.ts` can hold the contrast and spread rules in place.
 *
 * Eight curated steps from amber through gold, orange and apricot to coral. Each step has:
 *   - `ink`   the sender name / avatar / quote-bar colour on DARK themes (bright warm tone),
 *   - `inkLight` the same role on the light (Daylight) theme (a deep, readable version),
 *   - `tint`  the hue mixed into the bubble surface (12% over a lifted warm grey in dark,
 *             7% over white in light), so the bubble separates from the page with a subtle warmth.
 *
 * Contrast (WCAG 2.x, checked by the selftest): message text on every tinted bubble is >= 12:1 in
 * dark and >= 15:1 in light; every name ink is >= 6:1 on its bubble in dark and >= 5.5:1 in light.
 *
 * The same palette is mirrored from bit-sign `src/lib/bubble-shades.ts` (bChatX rooms; keep the two in step).
 */
export type BubbleShade = { id: string; ink: string; inkLight: string; tint: string };

export const BUBBLE_SHADES: readonly BubbleShade[] = [
    { id: 'amber', ink: '#F5B84A', inkLight: '#8A5300', tint: '#F5B84A' },
    { id: 'honey', ink: '#E6C36A', inkLight: '#7A5A00', tint: '#E6C36A' },
    { id: 'tangerine', ink: '#FFA45B', inkLight: '#9A4A00', tint: '#FFA45B' },
    { id: 'apricot', ink: '#F9B98B', inkLight: '#8F4B1E', tint: '#F9B98B' },
    { id: 'orange', ink: '#FF8F5E', inkLight: '#A73F0F', tint: '#FF8F5E' },
    { id: 'peach', ink: '#F4A792', inkLight: '#9C4430', tint: '#F4A792' },
    { id: 'coral', ink: '#FF8A7E', inkLight: '#B0302C', tint: '#FF8A7E' },
    { id: 'sienna', ink: '#E3A078', inkLight: '#8A4422', tint: '#E3A078' },
] as const;

/** Lifted bubble bases the tint is mixed over (dark themes / Daylight). */
export const BUBBLE_BASE_DARK = '#211F1D';
export const BUBBLE_BASE_LIGHT = '#FFFFFF';
export const TINT_DARK = 0.12;
export const TINT_LIGHT = 0.07;

function norm(handle: string | null | undefined): string {
    return (handle || '?').replace(/^\$/, '').toLowerCase();
}

/** The person's home shade: a stable hash of the handle, so they keep it in every room. */
export function shadeIndex(handle: string | null | undefined): number {
    const h = norm(handle);
    let n = 0;
    for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) >>> 0;
    return n % BUBBLE_SHADES.length;
}

export function shadeFor(handle: string | null | undefined): BubbleShade {
    return BUBBLE_SHADES[shadeIndex(handle)];
}

/**
 * Shades for one room. Everyone starts on their home shade; when two people in the room share one,
 * the later arrival steps to the next free shade, so the palette spreads out as members join (until
 * all eight are in use, after which repeats are unavoidable). Order = first appearance, so the
 * earlier speaker keeps their home colour and the result is stable while the thread grows.
 */
export function assignShades(handlesInOrder: readonly (string | null | undefined)[]): Map<string, BubbleShade> {
    const out = new Map<string, BubbleShade>();
    const used = new Set<number>();
    for (const raw of handlesInOrder) {
        const h = norm(raw);
        if (out.has(h)) continue;
        let i = shadeIndex(h);
        if (used.has(i) && used.size < BUBBLE_SHADES.length) {
            for (let step = 1; step < BUBBLE_SHADES.length; step++) {
                const j = (i + step) % BUBBLE_SHADES.length;
                if (!used.has(j)) { i = j; break; }
            }
        }
        used.add(i);
        out.set(h, BUBBLE_SHADES[i]);
    }
    return out;
}

/** Inline CSS custom properties a room bubble (ChatPage) and its name / reply bar read their shade from. */
export function shadeVars(shade: BubbleShade): Record<string, string> {
    return { '--bw-ink': shade.ink, '--bw-ink-light': shade.inkLight, '--bw-tint': shade.tint };
}

// ── contrast maths (used by the selftest; tiny, so kept beside the palette) ──────────────────
export function mixHex(a: string, b: string, t: number): string {
    const p = (h: string, i: number) => parseInt(h.replace('#', '').slice(i, i + 2), 16);
    return '#' + [0, 2, 4].map((i) => Math.round(p(a, i) * t + p(b, i) * (1 - t)).toString(16).padStart(2, '0')).join('');
}
function lum(hex: string): number {
    const c = [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16) / 255)
        .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string): number {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
}

/** Agent accounts ($hwpebrief) and agent-key posts: one neutral warm grey (ChatPage agent bubbles). */
export const AGENT_ACCOUNT_SHADE: BubbleShade = { id: 'agent', ink: '#D2C8B8', inkLight: '#5F564A', tint: '#BFB3A3' };
