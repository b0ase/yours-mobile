import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import { buildInscriptionScript } from '@1sat/templates';
// The server's signer, so the wallet checks exactly what the Store signs.
import sr from '../../../site/lib/storeReceipt.js';
import tb from '../../../site/lib/themeBuys.js';
import {
  artOk,
  canonical,
  checkStoreReceipt,
  parseStoreReceiptSvg,
  signatureValid,
  storeReceiptMap,
  storeReceiptSvg,
  type StoreReceipt,
} from './receipt';

const STORE = new PrivateKey(99);
const PAY = new PrivateKey(7).toPublicKey().toAddress();
const ORDER = 'ab'.repeat(16);
const ENV = { STORE_RECEIPT_WIF: STORE.toWif() };

const fields = {
  app: 'bwalletx',
  type: 'store-receipt',
  v: 1,
  order: ORDER,
  item: { kind: 'theme', id: 'npg', label: 'NPG' },
  usd: 1,
  sats: 5_400_000,
  seller: PAY,
  buyer: new PrivateKey(42).toPublicKey().toString(),
  issuedAt: '2026-10-17T10:00:00.000Z',
};
const signed = () => sr.signReceipt(fields, ENV) as StoreReceipt;
// 1x1 transparent PNG.
const ART =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const purchaseTx = (r: StoreReceipt, { sats = r.sats, memo = true, art = ART as string | null } = {}) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(r.seller), satoshis: sats });
  if (memo) tx.addOutput({ lockingScript: tb.memoScript(r.order), satoshis: 0 });
  const dest = new P2PKH().lock(new PrivateKey(3).toPublicKey().toAddress());
  const svg = new TextEncoder().encode(storeReceiptSvg(r, art));
  tx.addOutput({ lockingScript: buildInscriptionScript(dest, svg, 'image/svg+xml', storeReceiptMap(r)), satoshis: 1 });
  return tx;
};

describe('store receipts (wallet)', () => {
  test('canonical JSON is byte-identical to the server (the signed bytes)', () => {
    const v = { b: 1, a: { d: [2, { z: 1, y: 'é' }], c: undefined } };
    expect(canonical(v)).toBe(sr.canonical(v));
  });

  test('the wallet accepts the Store signature and rejects any edit', () => {
    const r = signed();
    expect(signatureValid(r)).toBe(true);
    expect(signatureValid({ ...r, usd: 2 })).toBe(false);
    expect(signatureValid({ ...r, item: { ...r.item, label: 'NPGX' } })).toBe(false);
    const { sig: _s, ...unsigned } = r;
    expect(signatureValid(unsigned as StoreReceipt)).toBe(false);
  });

  test('the SVG card round-trips its receipt, with or without art (art is presentation only)', () => {
    const r = signed();
    for (const art of [ART, null, 'data:image/svg+xml;base64,PHN2Zy8+']) {
      const svg = storeReceiptSvg(r, art);
      expect(parseStoreReceiptSvg(svg)).toEqual(r);
      expect(svg.includes('<image')).toBe(art === ART);
    }
    expect(storeReceiptSvg(r)).toContain('NPG theme');
    expect(storeReceiptSvg(r)).toContain('$1');
  });

  test('a real purchase tx verifies: signed, published key, pays the Store, carries the order', () => {
    const r = signed();
    const res = checkStoreReceipt(purchaseTx(r), STORE.toPublicKey().toString());
    expect(res.receipt).toEqual(r);
    expect(res.checks.map((c) => c.ok)).toEqual([true, true, true, true]);
    expect(res.verified).toBe(true);
  });

  test('not verified when the key is unpublished or different, underpaid, or without the order memo', () => {
    const r = signed();
    expect(checkStoreReceipt(purchaseTx(r), null).verified).toBe(false);
    expect(checkStoreReceipt(purchaseTx(r), new PrivateKey(5).toPublicKey().toString()).verified).toBe(false);
    expect(checkStoreReceipt(purchaseTx(r, { sats: r.sats - 1 }), STORE.toPublicKey().toString()).verified).toBe(false);
    expect(checkStoreReceipt(purchaseTx(r, { memo: false }), STORE.toPublicKey().toString()).verified).toBe(false);
  });

  test('an unsigned receipt (Store key not set yet) is shown but never verified', () => {
    const r = sr.signReceipt(fields, {}) as StoreReceipt;
    const res = checkStoreReceipt(purchaseTx(r), STORE.toPublicKey().toString());
    expect(res.receipt?.order).toBe(ORDER);
    expect(res.verified).toBe(false);
    expect(storeReceiptSvg(r)).toContain('Not signed by the Store');
  });

  test('art must be a small inline PNG, JPEG or WebP', () => {
    expect(artOk(ART)).toBe(true);
    expect(artOk('data:image/svg+xml;base64,PHN2Zy8+')).toBe(false);
    expect(artOk('https://example.com/a.png')).toBe(false);
    expect(artOk(`data:image/png;base64,${'A'.repeat(90_000)}`)).toBe(false);
    expect(artOk(undefined)).toBe(false);
  });
});
