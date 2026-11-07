/**
 * b-Aware 6 Nov 2026, 0xrard #2: the payment sheet listed 12 outputs and then "and N more outputs". The site picks
 * the output order, so 12 dust outputs pushed the real payee off the sheet. Every paying output is shown, largest
 * first.
 */
import { describe, expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Utils } from '@bsv/sdk';
import { PaymentRecipients } from './PaymentRecipients';
import { buildSheetModel, type BundleRequest } from '../../services/permissionBundle';

const addr = (byte: string) => Utils.toBase58Check(Utils.toArray(byte.repeat(20), 'hex'), [0]);
const DUST = Array.from({ length: 12 }, (_, i) => ({ to: addr((i + 16).toString(16)), satoshis: 1 }));
const REAL = { to: addr('ee'), satoshis: 250_000 };

describe('0xrard #2: no paying output is hidden', () => {
  test('13 outputs, the 13th the real payee: it is on the sheet, first', () => {
    const html = renderToStaticMarkup(h(PaymentRecipients, { recipients: [...DUST, REAL] }));
    expect(html).toContain(`to ${REAL.to}: 250,000 sats`);
    for (const d of DUST) expect(html).toContain(`to ${d.to}: 1 sats`);
    expect(html.indexOf(REAL.to)).toBeLessThan(html.indexOf(DUST[0].to));
    expect(html).not.toContain('more outputs');
    // A long list says how many and how much, so a scroll never hides a total.
    expect(html).toContain('13 outputs, 250,012 sats in all');
  });

  test('a second payment on the same sheet names its payees too', () => {
    const model = buildSheetModel({
      originator: 'shop.example',
      items: [
        { requestID: 'p1', type: 'spending', originator: 'shop.example', spending: { satoshis: 10 } },
        {
          requestID: 'p2',
          type: 'spending',
          originator: 'shop.example',
          spending: { satoshis: 250_012 },
          recipients: [...DUST, REAL],
        },
      ] as BundleRequest[],
    });
    const also = model.lines.find((l) => l.requestID === 'p2')!;
    expect(also.detail).toContain(`to ${REAL.to}: 250000 sats`);
    expect(also.detail.indexOf(REAL.to)).toBeLessThan(also.detail.indexOf(DUST[0].to));
  });

  test('an action with no outputs says it pays only the network fee; an unknown list draws nothing', () => {
    expect(renderToStaticMarkup(h(PaymentRecipients, { recipients: [] }))).toContain('only the network fee');
    expect(renderToStaticMarkup(h(PaymentRecipients, {}))).toBe('');
  });
});
