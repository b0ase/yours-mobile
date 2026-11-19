import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { HeldPaymentsView } from './HeldPayments';
import { unsentOutcomeText as outcomeText } from '../services/stuckSends';

const sats = (n: number) => `${n} sats`;
const view = (items: Parameters<typeof HeldPaymentsView>[0]['items'], o: { hidden?: boolean; note?: string } = {}) =>
  renderToStaticMarkup(
    createElement(HeldPaymentsView, { items, fmt: sats, onSend: () => undefined, onCancel: () => undefined, ...o }),
  );

describe('task 54 round 2: held payments under the balance (Send now / Cancel)', () => {
  const rent = { txid: 'a'.repeat(64), description: 'Rent', satoshis: -20_000, createdAt: 0 };
  test('each held payment shows its own Send now and Cancel', () => {
    const html = view([rent]);
    expect(html).toContain('A payment was never sent from this device');
    expect(html).toContain('Rent · 20000 sats');
    expect(html).toContain('Send now');
    expect(html).toContain('Cancel');
    expect(html).toContain('won’t send it by itself');
  });
  test('amounts hidden with the balance; nothing at all when there is nothing held', () => {
    expect(view([rent], { hidden: true })).not.toContain('sats');
    expect(view([])).toBe('');
  });
  test('outcomes in plain words', () => {
    expect(outcomeText({ ok: true, txid: rent.txid, result: 'network-may-have-it' })).toBe('Sent.');
    expect(outcomeText({ ok: true, txid: rent.txid, result: 'cancelled' })).toContain('money is spendable again');
    expect(outcomeText({ ok: false, txid: rent.txid, error: 'Payments are paused for now' })).toBe(
      'Payments are paused for now',
    );
  });
  test('the component lists on its own and acts only on a click (no send/cancel outside act)', () => {
    const src = readFileSync(new URL('./HeldPayments.tsx', import.meta.url), 'utf8');
    expect(src.match(/how \}/g)?.length).toBe(1); // the one UNSENT_SENDS call carrying a choice, in act()
    expect(src).toContain("onSend={(t) => void act(t, 'send')}");
    expect(src).toContain("onCancel={(t) => void act(t, 'cancel')}");
  });
  test('shown on the phone card and the extension balance', () => {
    for (const f of ['../mobile/wallet/WalletCard.tsx', '../pages/BsvWallet.tsx'])
      expect(readFileSync(new URL(f, import.meta.url), 'utf8')).toContain('<HeldPayments');
  });
});
