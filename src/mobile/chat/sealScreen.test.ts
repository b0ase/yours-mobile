import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { P2PKH, PrivateKey, SatoshisPerKilobyte, Script, Transaction } from '@bsv/sdk';
import { NativeSealError, type PadPoint } from './nativeSeal';
import {
  BROADCASTING_LINE,
  DRAW_HINT,
  createPressGuard,
  estimateSealFee,
  primaryHandleFrom,
  sealTxBytes,
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
    expect(sealButtonLabel(estimateSealFee(['sig-1'], 'MIN-011', 100))).toBe('Sign & seal · ~73 sats');
    expect(sealButtonLabel(1)).toBe('Sign & seal · ~1 sat');
    expect(sealButtonLabel(null)).toBe('Sign & seal');
  });

  test("the wallet's own fee model: a minute-011-sized seal is about 75 sats (±30%), not bit-sign's ~715", () => {
    // Board minute 011 (3 Nov 2026) paid 75 sats at the default 100 sat/kB.
    for (const [ids, ref] of [
      [['sig-1'], 'MIN-011'],
      [['sig-chair'], 'BCORP-MINUTE-011'],
      [['sig-1', 'sig-2'], 'bcorp-board-minute-011-2026-11-03'],
    ] as const) {
      const fee = estimateSealFee([...ids], ref, 100);
      expect(fee).toBeGreaterThanOrEqual(75 * 0.7);
      expect(fee).toBeLessThanOrEqual(75 * 1.3);
    }
    // Scales with the wallet's rate; a bad rate falls back to the default 100 sat/kB.
    expect(estimateSealFee(['sig-1'], 'MIN-011', 50)).toBe(Math.ceil(sealTxBytes(['sig-1'], 'MIN-011') * 0.05));
    expect(estimateSealFee(['sig-1'], 'MIN-011', Number.NaN)).toBe(estimateSealFee(['sig-1'], 'MIN-011', 100));
  });

  test('the size matches a real signed seal transaction built at the same rate', async () => {
    const ids = ['sig-1'];
    const ref = 'MIN-011';
    const k = PrivateKey.fromRandom();
    const h = '0'.repeat(64);
    const payload = JSON.stringify({
      protocol: 'b0ase-bitsign',
      version: '2.0',
      type: 'nds_field_seal',
      docHash: h,
      origHash: h,
      recordHash: h,
      svgHash: h,
      fields: ids.join(','),
      key: `02${h}`,
      ref,
      ts: '2026-11-03T12:00:00.000Z',
    });
    const src = new Transaction();
    src.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
    src.addOutput({ satoshis: 10_000, lockingScript: new P2PKH().lock(k.toAddress()) });
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
    tx.addOutput({
      satoshis: 0,
      lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${Buffer.from(payload).toString('hex')}`),
    });
    tx.addOutput({ change: true, lockingScript: new P2PKH().lock(k.toAddress()) });
    await tx.fee(new SatoshisPerKilobyte(100));
    await tx.sign();
    expect(Math.abs(tx.toBinary().length - sealTxBytes(ids, ref))).toBeLessThanOrEqual(2);
    expect(Math.abs((tx.getFee() as number) - estimateSealFee(ids, ref, 100))).toBeLessThanOrEqual(1);
  });

  test("the paying name is the account's main name ($b0asex → $boase), else the session handle", () => {
    expect(primaryHandleFrom({ primary: { b0asex: 'boase' } }, '$b0asex')).toBe('boase');
    expect(primaryHandleFrom({ primary: {} }, 'b0asex')).toBe('b0asex');
    expect(primaryHandleFrom(null, 'B0aseX')).toBe('b0asex');
    expect(primaryHandleFrom({ primary: { b0asex: '<script>' } }, 'b0asex')).toBe('b0asex');
    expect(page).toContain('/api/public/handles/primary?h=');
    expect(page).toContain('handle: shownHandle,');
    expect(page.match(/handle: shownHandle,/g)?.length).toBe(2); // the sheet and the receipt
  });

  test("bit-sign's estFeeSats is logged, never shown", () => {
    const shown = page.split('\n').filter((l) => /prepared\.estFeeSats/.test(l) && !/console\.info/.test(l));
    expect(shown).toEqual([]);
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
    // Another party sealed first: the payment is recorded, there is nothing to retry.
    expect(retryAllowed(new NativeSealError('x', 'orphaned'), true)).toBe(false);
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
    expect(sealReceipt({ actualFeeSats: 75, estFeeSats: 72, handle: '$boase', txid, usdPerBsv: 50 })).toBe(
      "Paid 75 sats (~0.0038¢) from $boase's wallet · abcd…1234",
    );
  });
  test('the estimate when the transaction could not be read, labelled about; no price → no cents', () => {
    expect(sealReceipt({ actualFeeSats: undefined, estFeeSats: 72, handle: 'boase', txid, usdPerBsv: null })).toBe(
      "Paid about 72 sats from $boase's wallet · abcd…1234",
    );
  });
  test('the prompt names the document and the fee', () => {
    expect(sealReason({ title: 'Minute 011', feeSats: 72 })).toBe('Seal Minute 011 on Bitcoin and pay about 72 sats');
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
