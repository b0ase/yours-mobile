import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { HeldPaymentsView } from './HeldPayments';
import { heldLineItems, RESTORED_LABEL } from './heldPaymentLines';
import { unsentOutcomeText as outcomeText } from '../services/stuckSends';

const sats = (n: number) => `${n} sats`;
const view = (items: Parameters<typeof HeldPaymentsView>[0]['items'], o: { hidden?: boolean; note?: string } = {}) =>
  renderToStaticMarkup(
    createElement(HeldPaymentsView, { items, fmt: sats, onSend: () => undefined, onCancel: () => undefined, ...o }),
  );
const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

describe('held payments under the balance (task 54 review, rounds 2 and 3)', () => {
  const queued = {
    txid: 'a'.repeat(64),
    description: 'Rent',
    createdAt: 0,
    queuedHere: true,
    recipients: [{ to: ADDR, sats: 20_000 }],
    amountSats: 20_000,
  };
  test('one this device queued: its description, and the amount its own bytes pay; Send now and Cancel', () => {
    const html = view([queued]);
    expect(html).toContain('A payment was never sent from this device');
    expect(html).toContain('Rent · 20000 sats to 1BoatSLRHt…');
    expect(html).toContain('Send now');
    expect(html).toContain('Cancel');
    expect(html).toContain('won’t send it by itself');
  });
  test("one restored from a backup: labelled so, the backup's description never shown", () => {
    const html = view([{ ...queued, queuedHere: false, description: 'Totally your rent' }]);
    expect(html).toContain(`${RESTORED_LABEL} · 20000 sats`);
    expect(html).not.toContain('Totally your rent');
  });
  test("bytes that can't be read: amount unreadable and Send now disabled", () => {
    const html = view([{ ...queued, recipients: undefined, amountSats: undefined }]);
    expect(html).toContain('amount unreadable');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send now<\/button>/);
  });
  test('amounts hidden with the balance; nothing at all when there is nothing held', () => {
    expect(view([queued], { hidden: true })).not.toContain('sats');
    expect(view([])).toBe('');
  });
  test("the confirmation sheet's lines are the decoded recipients and amounts", () => {
    expect(heldLineItems(queued, sats)).toEqual([{ address: ADDR, amount: '20000 sats', sats: 20_000 }]);
    expect(heldLineItems({ recipients: undefined }, sats)).toEqual([]);
  });
  test('outcomes in plain words', () => {
    expect(outcomeText({ ok: true, txid: queued.txid, result: 'network-may-have-it' })).toBe('Sent.');
    expect(outcomeText({ ok: true, txid: queued.txid, result: 'cancelled' })).toContain('money is spendable again');
    expect(outcomeText({ ok: false, txid: queued.txid, error: 'Payments are paused for now' })).toBe(
      'Payments are paused for now',
    );
  });
  test('Send now only opens the confirmation sheet; the send (confirmed) happens on its Confirm alone', () => {
    const src = readFileSync(new URL('./HeldPayments.tsx', import.meta.url), 'utf8');
    expect(src).toContain('onSend={(t) => setConfirming(items.find((p) => p.txid === t))}');
    expect(src.match(/act\([^)]*'send'/g)).toEqual(["act(p.txid, 'send'"]);
    expect(src).toContain("if (p) void act(p.txid, 'send', true);");
    expect(src).toContain('<SendConfirmation');
  });
  test('shown on the phone card and the extension balance', () => {
    for (const f of ['../mobile/wallet/WalletCard.tsx', '../pages/BsvWallet.tsx'])
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).toContain('<HeldPayments');
  });
});
