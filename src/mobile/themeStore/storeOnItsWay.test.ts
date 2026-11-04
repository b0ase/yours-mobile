/**
 * The 409 sheet (release click-through, 4 Nov 2026): a quote answered 409 payment_pending showed "Getting the price…"
 * and a disabled "Pay $1" beside "still on its way". It now has its own "Payment on its way" sheet with neither.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { isPaymentPending, ThemeOrderError } from '../themeOrder/api';

const root = resolve(import.meta.dir, '..', '..', '..');

describe('409 payment_pending: "Payment on its way", no price, no Pay', () => {
  test('409 payment_pending is recognised, and the sheet gives it its own state without price or Pay', () => {
    expect(isPaymentPending(new ThemeOrderError('x', 'payment_pending', 409))).toBe(true);
    expect(isPaymentPending(new ThemeOrderError('x', 'already_owned', 409))).toBe(false);
    expect(isPaymentPending(new Error('payment_pending'))).toBe(false);
    const sheet = readFileSync(join(root, 'src/mobile/themeStore/StoreBuy.tsx'), 'utf8');
    expect(sheet).toContain("if (isPaymentPending(e)) setStep({ k: 'onItsWay' });");
    // The on-its-way state renders in the same early-return sheet as "Payment sent": before the priced pay sheet.
    expect(sheet.indexOf("step.k === 'onItsWay'")).toBeLessThan(sheet.indexOf('Getting the price…'));
  });

  test('the on-its-way sheet carries neither the price line nor a Pay button', () => {
    const sheet = readFileSync(join(root, 'src/mobile/themeStore/StoreBuy.tsx'), 'utf8');
    const start = sheet.indexOf("if (step.k === 'pending' || step.k === 'onItsWay')");
    const block = sheet.slice(start, sheet.indexOf('document.body,', start));
    expect(start).toBeGreaterThan(0);
    expect(block).toContain('Payment on its way');
    expect(block).not.toContain('Getting the price');
    expect(block).not.toMatch(/Pay \$/);
  });
});
