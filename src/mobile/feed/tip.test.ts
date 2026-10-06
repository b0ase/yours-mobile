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
  HOME_SHARE_MAX_SATS,
  homePayToOf,
  homeShareAllowed,
  homeShareFor,
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
      home: 0,
      homeTo: null,
      homeValid: true,
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

describe('home app share (spec §6.2)', () => {
  const home = PrivateKey.fromRandom().toAddress();
  const twetch = { txid: TXID, source: 'twetch' as const, author: { address: author } };
  test('registry is empty: no share for any source', () => {
    for (const s of ['treechat', 'twetch', 'peck', 'fwetch', 'other', 'bchat'] as const)
      expect(homePayToOf(s)).toBeNull();
    expect(planPayment('tip', twetch, 10_000).payment.home).toBeUndefined();
    expect(pushes(planPayment('tip', twetch, 10_000).script)).not.toContain('home');
  });
  test('caps: 5% rounded down, at most 10,000 sats, never for bChat posts', () => {
    expect(homeShareFor('twetch', 10_019, home)?.satoshis).toBe(500);
    expect(homeShareFor('peck', 100_000_000, home)?.satoshis).toBe(HOME_SHARE_MAX_SATS);
    expect(homeShareFor('peck', 10_000, home, 50)?.satoshis).toBe(500);
    expect(homeShareFor('bchat', 10_000, home)).toBeNull();
    expect(homeShareAllowed(500, 10_000)).toBe(true);
    expect(homeShareAllowed(501, 10_000)).toBe(false);
    expect(() => buildTipScript(TXID, 10_000, 'bChat', null, { address: home, satoshis: 501 })).toThrow();
  });
  test('separate output on top; author still gets exactly amount; parser verifies it', () => {
    const plan = planPayment('tip', twetch, 10_000, BCHAT_CLIENT_FEE, { homeTo: home });
    expect(plan.payment.satoshis).toBe(10_000);
    expect(plan.payment.home?.satoshis).toBe(500);
    expect(decodeScript(plan.script)!.MAP).toMatchObject({ amount: '10000', home: '500', homeTo: home });
    const build = (homeSats: number) => {
      const tx = new Transaction();
      tx.addOutput({ satoshis: 0, lockingScript: plan.script });
      tx.addOutput({ satoshis: 10_000, lockingScript: plan.payment.lockingScript });
      tx.addOutput({ satoshis: homeSats, lockingScript: plan.payment.home!.lockingScript });
      return Transaction.fromHex(tx.toHex());
    };
    const ok = parsePayment(build(500))!;
    expect(ok.valid && ok.homeValid && ok.home === 500 && ok.homeTo === home).toBe(true);
    const bad = parsePayment(build(499))!;
    expect(bad.valid).toBe(true);
    expect(bad.homeValid).toBe(false);
    expect(tipTotals([ok], () => author).get(TXID)).toEqual({ sats: 10_000, count: 1 });
  });
  test('home after a fee; skipped when it equals the author or the fee address', () => {
    const app = PrivateKey.fromRandom().toAddress();
    const plan = planPayment('tip', twetch, 10_000, { pct: 5, address: app }, { homeTo: home });
    const tx = new Transaction();
    tx.addOutput({ satoshis: 0, lockingScript: plan.script });
    tx.addOutput({ satoshis: 10_000, lockingScript: plan.payment.lockingScript });
    tx.addOutput({ satoshis: 500, lockingScript: plan.payment.fee!.lockingScript });
    tx.addOutput({ satoshis: 500, lockingScript: plan.payment.home!.lockingScript });
    const p = parsePayment(Transaction.fromHex(tx.toHex()))!;
    expect(p.valid && p.feeValid && p.homeValid).toBe(true);
    expect(planPayment('tip', twetch, 10_000, BCHAT_CLIENT_FEE, { homeTo: author }).payment.home).toBeUndefined();
    expect(
      planPayment('tip', twetch, 10_000, { pct: 5, address: home }, { homeTo: home }).payment.home,
    ).toBeUndefined();
    expect(() =>
      planPayment('tip', { ...twetch, source: 'treechat' }, 10_000, BCHAT_CLIENT_FEE, { homeTo: home }),
    ).toThrow();
  });
  test('spec test vector (unsigned part)', () => {
    const unsigned = buildTipScript(TXID, 10_000, 'bChat', null, {
      address: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
      satoshis: 500,
    }).toHex();
    expect(
      '006a223150755161374b36324d694b43747373534c4b79316b683536575755374d7455523503534554036170700562436861740474797065037469700176013207636f6e74657874027478027478406236303036666361333562363437663561313836663630393837383131383731666266646136656566666565653532626534666465323837643838353263616506616d6f756e7405313030303004686f6d650335303006686f6d65546f22314267475a3974634e34726d394b427a446e374b7072517a3837535a323653414d48017c22313550636948473232534e4c514a584d6f53556157566937575371633768436676610d424954434f494e5f454344534122314267475a3974634e34726d394b427a446e374b7072517a3837535a323653414d48412049264c2ec5dd5abe1376096c1b022b8b949cf61f8da666034d2b9583dcacc4e73332a18448cd64b392f64241f51e80609833fbe72ff3deba6c3d29b4e5be94c9'.startsWith(
        unsigned,
      ),
    ).toBe(true);
  });
});
