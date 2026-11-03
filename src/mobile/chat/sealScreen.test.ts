import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NativeSealError, type PadPoint } from './nativeSeal';
import {
  BROADCASTING_LINE,
  DRAW_HINT,
  createPressGuard,
  estimateSealFee,
  feeForPrompt,
  padHasSignature,
  retryAllowed,
  sealButtonLabel,
  sealProgress,
  sealReason,
  sealReceipt,
} from './sealScreen';

const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
const page = src('./NativeSealPage.tsx');
const line = (y: number, x0: number, x1: number): PadPoint[] =>
  Array.from({ length: 11 }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / 10, y, pressure: 0.5 }));

describe('one press: "Sign & seal · ~N sats"', () => {
  test('the cost in the label, as the Face ID prompt rounds it', () => {
    expect(feeForPrompt(75.4)).toBe(75);
    expect(feeForPrompt(0.2)).toBe(1);
    expect(feeForPrompt(undefined)).toBeNull();
    expect(feeForPrompt(Number.NaN)).toBeNull();
    expect(sealButtonLabel(feeForPrompt(715.2))).toBe('Sign & seal · ~715 sats');
    expect(sealButtonLabel(1)).toBe('Sign & seal · ~1 sat');
    expect(sealButtonLabel(null)).toBe('Sign & seal');
  });

  test("the pre-tap estimate is bit-sign's own formula over the v2 payload (prepare answers the same)", () => {
    expect(estimateSealFee(['f1'], 'R')).toBe(715);
    expect(estimateSealFee(['sig-1', 'sig-2'], 'MIN-011')).toBe(730);
  });

  test('an empty or near-empty pad keeps the button disabled', () => {
    expect(padHasSignature([])).toBe(false);
    expect(padHasSignature([[{ x: 5, y: 5, pressure: 0.5 }]])).toBe(false); // a tap
    expect(padHasSignature([line(10, 0, 20)])).toBe(false); // a 20px flick
    expect(padHasSignature([line(10, 0, 120)])).toBe(true);
    expect(padHasSignature([line(10, 0, 25), line(30, 0, 25)])).toBe(true); // two short strokes add up
  });

  test('the page: exactly one button after drawing, with the cost; no Done / Confirm / Seal step', () => {
    expect(page.match(/data-testid="sign-and-seal"/g)?.length).toBe(1);
    expect(page).toContain('{sealButtonLabel(namedFee ?? estFee)}');
    expect(page).toContain('disabled={!buttonOn}');
    expect(page).toContain("const buttonOn = phase.k === 'ready' && inked;");
    expect(page).toContain('{DRAW_HINT}');
    expect(DRAW_HINT).toBe('Draw your signature');
    for (const gone of ['Done · next', 'Seal &amp; pay', 'onDone', 'Use this signature', 'Redraw'])
      expect(page).not.toContain(gone);
  });
});

describe('double press, double pay', () => {
  test('the first press takes the guard; later presses are ignored until released', () => {
    const g = createPressGuard();
    expect(g.take()).toBe(true);
    expect(g.take()).toBe(false);
    expect(g.take()).toBe(false);
    g.release();
    expect(g.take()).toBe(true);
  });

  test('the button comes back only after a failure that KNOWS nothing was paid', () => {
    expect(retryAllowed(new NativeSealError('x', 'cancelled'), false)).toBe(true);
    expect(retryAllowed(new NativeSealError('x', 'refused', 409), false)).toBe(true);
    expect(retryAllowed(new Error('network down at prepare'), false)).toBe(true);
    // Refused at the payment because a coin was already spent: nothing broadcast, nothing saved.
    expect(retryAllowed(new NativeSealError('x', 'spent_elsewhere'), true)).toBe(true);
    // During or after the payment: may have paid.
    expect(retryAllowed(new Error('socket hang up'), true)).toBe(false);
    expect(retryAllowed(new NativeSealError('x', 'pending_recovery'), true)).toBe(false);
    expect(retryAllowed(new NativeSealError('x', 'failed'), true)).toBe(false);
    expect(retryAllowed(new NativeSealError('x', 'failed'), false)).toBe(false);
  });

  test('the page takes the guard before any await and releases it only through retryAllowed', () => {
    const body = page.slice(page.indexOf('const signAndSeal = async'), page.indexOf('const tellRoom = async'));
    expect(body.indexOf('press.take()')).toBeGreaterThan(-1);
    expect(body.indexOf('press.take()')).toBeLessThan(body.indexOf('await'));
    expect(body.match(/press\.release\(\)/g)?.length).toBe(1);
    expect(body.indexOf('press.release()')).toBeGreaterThan(body.indexOf('if (retryAllowed(e, reachedPay.current))'));
    expect(body).toContain("if (s === 'paying') reachedPay.current = true;");
  });
});

describe('progress, inline under the button', () => {
  const texts = (s: Parameters<typeof sealProgress>[0], slow = false) => sealProgress(s, slow).map((l) => l.text);
  test('Signed ✓ → Broadcasting… (can take a minute) → On chain ✓', () => {
    expect(texts('signing')).toEqual(['Signing…']);
    expect(texts('paying')).toEqual(['Signed ✓', 'Broadcasting… (can take a minute)']);
    expect(BROADCASTING_LINE).toBe('Broadcasting… (can take a minute)');
    expect(texts('committing')).toEqual(['Signed ✓', 'On chain ✓', 'Recording the seal…']);
    expect(texts('done')).toEqual(['Signed ✓', 'On chain ✓']);
  });
  test('long waits say what is happening, never a frozen line', () => {
    expect(texts('healing')).toEqual(['Finding a fresh coin…']);
    expect(texts('committing', true)).toEqual(['Signed ✓', 'On chain ✓', 'Waiting for the network…']);
    expect(texts('recovering')).toEqual(['Signed ✓', 'On chain ✓', 'Waiting for the network…']);
    expect(page).toContain('SLOW_COMMIT_MS');
    expect(page).not.toContain('Sealing on chain');
  });
  test('done ticks are marked done; the active line is not', () => {
    expect(sealProgress('paying').map((l) => l.done)).toEqual([true, false]);
    expect(sealProgress('done').every((l) => l.done)).toBe(true);
  });
});

describe('receipt and reason', () => {
  const txid = `abcd${'0'.repeat(56)}1234`;
  test('actual fee from the transaction', () => {
    expect(sealReceipt({ actualFeeSats: 75, estFeeSats: 715, handle: '$b0asex', txid, usdPerBsv: 50 })).toBe(
      "Paid 75 sats (~0.0038¢) from $b0asex's wallet · abcd…1234",
    );
  });
  test('the estimate when the transaction could not be read, labelled about; no price → no cents', () => {
    expect(sealReceipt({ actualFeeSats: undefined, estFeeSats: 715, handle: 'b0asex', txid, usdPerBsv: null })).toBe(
      "Paid about 715 sats from $b0asex's wallet · abcd…1234",
    );
  });
  test('the prompt names the document and the fee', () => {
    expect(sealReason({ title: 'Minute 011', feeSats: 715 })).toBe('Seal Minute 011 on Bitcoin and pay about 715 sats');
  });
});

describe('nothing may interrupt drawing', () => {
  const css = src('../mobile.css');
  test('the whole page and the pad: no selection, no callout; the canvas: touch-action none', () => {
    expect(page).toContain('className="bw-seal-noselect fixed inset-0');
    expect(page).toMatch(/userSelect: 'none',\s*WebkitUserSelect: 'none',\s*WebkitTouchCallout: 'none'/);
    expect(page).toContain("style={{ background: '#0b0b0d', color: '#e4e4e7', ...NO_SELECT }}");
    expect(page).toContain('className="bw-seal-pad" data-testid="seal-pad" style={NO_SELECT}');
    expect(page).toMatch(/touchAction: 'none', \.\.\.NO_SELECT/);
    expect(css).toMatch(
      /\.bw-seal-noselect,\s*\.bw-seal-noselect \* \{[^}]*-webkit-user-select: none;[^}]*user-select: none;[^}]*-webkit-touch-callout: none;/,
    );
    expect(css).toMatch(/\.bw-seal-pad canvas \{\s*touch-action: none;/);
  });
  test('touchstart / touchmove prevented (passive: false); contextmenu and selectstart within the pad', () => {
    expect(page).toContain('const opts: AddEventListenerOptions = { passive: false };');
    expect(page).toContain("c.addEventListener('touchstart', stop, opts);");
    expect(page).toContain("c.addEventListener('touchmove', stop, opts);");
    expect(page).toContain("w.addEventListener('contextmenu', stop);");
    expect(page).toContain("w.addEventListener('selectstart', stop);");
    expect(page).toContain('const stop = (e: Event) => e.preventDefault();');
  });
  test('text fields stay selectable; the document scrolls in its own frame', () => {
    expect(css).toMatch(
      /\.bw-seal-noselect input,\s*\.bw-seal-noselect textarea[^{]*\{\s*-webkit-user-select: text;\s*user-select: text;/,
    );
    expect(page).toContain('sandbox=""');
    expect(page).not.toMatch(/iframe[^>]*touchAction/);
  });
});
