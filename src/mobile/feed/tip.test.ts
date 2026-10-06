import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import { decodeScript, MAP_PREFIX } from './post';
import {
  BCHAT_CLIENT_FEE,
  buildPaidLikeScript,
  clientFeeAllowed,
  clientFeeFor,
  CLIENT_FEE_MAX_SATS,
  buildTipScript,
  PAID_LIKE_DEFAULT_SATS,
  parsePayment,
  payDestination,
  planPayment,
  TIP_MIN_SATS,
  tipTotals,
  TREECHAT_RELAY_ADDRESSES,
} from './tip';

/** Mirrors bit-sign feed-tip-selftest.mts (BCHAT-PROTOCOL-v2 §5). */
const TXID = 'b6006fca35b647f5a186f60987811871fbfda6eeffeee52be4fde287d8852cae';
const author = PrivateKey.fromRandom().toAddress();
const pushes = (s: Script) => s.chunks.slice(2).map((c) => Utils.toUTF8(c.data ?? []));
const bchat = { txid: TXID, source: 'bchat' as const, author: { address: author } };

describe('script layout', () => {
  test('tip: exact pushes after OP_FALSE OP_RETURN', () => {
    const s = buildTipScript(TXID.toUpperCase(), 5000);
    expect(s.chunks[0].op).toBe(0);
    expect(s.chunks[1].op).toBe(0x6a);
    expect(pushes(s)).toEqual([
      MAP_PREFIX,
      'SET',
      'app',
      'bChat',
      'type',
      'tip',
      'v',
      '2',
      'context',
      'tx',
      'tx',
      TXID,
      'amount',
      '5000',
    ]);
  });
  test('paid like: like + amount + paid 1', () => {
    expect(pushes(buildPaidLikeScript(TXID, 1000))).toEqual([
      MAP_PREFIX,
      'SET',
      'app',
      'bChat',
      'type',
      'like',
      'v',
      '2',
      'context',
      'tx',
      'tx',
      TXID,
      'amount',
      '1000',
      'paid',
      '1',
    ]);
    expect(decodeScript(Script.fromHex(buildPaidLikeScript(TXID, 1000).toHex()))!.MAP.paid).toBe('1');
    expect(PAID_LIKE_DEFAULT_SATS).toBe(1000);
  });
  test('refuses dust, fractions and bad ids', () => {
    expect(() => buildTipScript(TXID, TIP_MIN_SATS - 1)).toThrow();
    expect(() => buildTipScript(TXID, 1000.5)).toThrow();
    expect(() => buildTipScript('nope', 1000)).toThrow();
  });
});

describe('payment destination', () => {
  test('bChat pays the AIP address; the payment output matches the amount', () => {
    const plan = planPayment('tip', bchat, 2500);
    expect(plan.payment.address).toBe(author);
    expect(plan.payment.satoshis).toBe(2500);
    expect(plan.payment.lockingScript.toHex()).toBe(new P2PKH().lock(author).toHex());
    expect(decodeScript(plan.script)!.MAP.amount).toBe('2500');
  });
  test('Treechat and its relay address are never paid', () => {
    expect(payDestination({ source: 'treechat', author: { address: author } }).ok).toBe(false);
    for (const a of TREECHAT_RELAY_ADDRESSES) {
      expect(payDestination({ source: 'other', author: { address: a } }).ok).toBe(false);
      expect(() => planPayment('like', { ...bchat, author: { address: a } }, 1000)).toThrow();
    }
    expect(() => planPayment('tip', { ...bchat, source: 'treechat' }, 1000)).toThrow();
  });
  test('Twetch: key address yes, no key no', () => {
    expect(payDestination({ source: 'twetch', author: { address: author } }).ok).toBe(true);
    expect(payDestination({ source: 'twetch', author: { address: 'twetch:42' } }).ok).toBe(false);
  });
});

const txFor = (kind: 'tip' | 'like', sats: number, paid = sats, payTo = author) => {
  const plan = planPayment(kind, bchat, sats);
  const tx = new Transaction();
  tx.addOutput({ satoshis: 0, lockingScript: plan.script });
  tx.addOutput({ satoshis: paid, lockingScript: new P2PKH().lock(payTo) });
  tx.addOutput({ satoshis: 5, lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()) });
  return Transaction.fromHex(tx.toHex());
};

describe('parsing and totals', () => {
  test('parses a tip and a paid like', () => {
    expect(parsePayment(txFor('tip', 3000))).toEqual({
      kind: 'tip',
      target: TXID,
      amount: 3000,
      payTo: author,
      valid: true,
      from: null,
      fee: 0,
      feeTo: null,
      feeValid: true,
    });
    expect(parsePayment(txFor('like', 1000))!.kind).toBe('like');
    expect(parsePayment(txFor('tip', 3000, 2999))!.valid).toBe(false);
  });
  test('only valid payments to the author count', () => {
    const other = PrivateKey.fromRandom().toAddress();
    const ps = [txFor('tip', 3000), txFor('like', 1000), txFor('tip', 5000, 5000, other), txFor('tip', 3000, 1)].map(
      (t) => parsePayment(t)!,
    );
    expect(tipTotals(ps, () => author).get(TXID)).toEqual({ sats: 4000, count: 2 });
    expect(tipTotals(ps, () => TREECHAT_RELAY_ADDRESSES[0]).size).toBe(0);
  });
});

describe('indexer meta', () => {
  test('tipped total is read from the bChat indexer meta', async () => {
    const { parseBmapFeed } = await import('./post');
    const doc = {
      tx: { h: TXID },
      timestamp: 1_790_000_000_000,
      B: [{ content: 'hi', 'content-type': 'text/markdown', encoding: 'UTF-8' }],
      MAP: [{ app: 'bChat', type: 'post' }],
      AIP: [{ address: author }],
    };
    const [p] = parseBmapFeed({ results: [doc], meta: [{ tx: TXID, likes: 1, replies: 0, tipped: 4000, tips: 2 }] });
    expect(p.tipped).toBe(4000);
    const [q] = parseBmapFeed({ results: [doc], meta: [{ tx: TXID, likes: 1, replies: 0 }] });
    expect(q.tipped).toBeUndefined();
  });
});

describe('client fee (spec §6.1)', () => {
  const app = PrivateKey.fromRandom().toAddress();
  const policy = { pct: 5, address: app };
  test('bChat fee is 0: no fee output, no fee keys', () => {
    expect(BCHAT_CLIENT_FEE.pct).toBe(0);
    expect(planPayment('tip', bchat, 100_000).payment.fee).toBeUndefined();
    expect(pushes(buildTipScript(TXID, 100_000))).not.toContain('fee');
  });
  test('caps', () => {
    expect(clientFeeFor(10_000, policy)?.satoshis).toBe(500);
    expect(clientFeeFor(100_000_000, policy)?.satoshis).toBe(CLIENT_FEE_MAX_SATS);
    expect(clientFeeAllowed(500, 10_000)).toBe(true);
    expect(clientFeeAllowed(501, 10_000)).toBe(false);
    expect(() => buildTipScript(TXID, 10_000, 'bChat', { address: app, satoshis: 501 })).toThrow();
  });
  test('author output stays exactly the amount; fee is a separate output and does not invalidate the tip', () => {
    const plan = planPayment('tip', bchat, 10_000, policy);
    expect(plan.payment.satoshis).toBe(10_000);
    expect(plan.payment.fee?.satoshis).toBe(500);
    expect(decodeScript(plan.script)!.MAP).toMatchObject({ amount: '10000', fee: '500', feeTo: app });
    const build = (feeSats: number) => {
      const tx = new Transaction();
      tx.addOutput({ satoshis: 0, lockingScript: plan.script });
      tx.addOutput({ satoshis: 10_000, lockingScript: plan.payment.lockingScript });
      tx.addOutput({ satoshis: feeSats, lockingScript: plan.payment.fee!.lockingScript });
      return Transaction.fromHex(tx.toHex());
    };
    const ok = parsePayment(build(500))!;
    expect(ok.valid && ok.feeValid).toBe(true);
    const bad = parsePayment(build(499))!;
    expect(bad.valid).toBe(true);
    expect(bad.feeValid).toBe(false);
    expect(tipTotals([ok], () => author).get(TXID)).toEqual({ sats: 10_000, count: 1 });
  });
});
