/**
 * Regression (owner, 5.1.83): token buys paid from the BRC-100 wallet's derived keys showed 0 BSV / 0 sats,
 * the totals and Gains missed them. Modelled on his two buys: 89131856 $BLASTER for 15000 sats (29 Sep) and
 * 100000000000 $GO•F#CK•YOURSELF for 500001 sats (4 Oct).
 */
import { describe, expect, test } from 'bun:test';
import { balances, buildRows, missingParents, statedPriceSats, totals, type LocalInfo, type RawTx } from './txHistory';
import { assetText, classifyEvent, findListings, historyLooksIncomplete, tokenAmount } from './historyEvents';
import { ownOutputs } from './txHistory';
import { buildLedger } from './taxLedger';
import { computeGains } from './gains';

const h = (c: string) => c.repeat(64);
// The account's fixed addresses (what WhatsOnChain is asked about). None of the wallet's coins sit on them.
const own = new Set(['1PayAddrxxxxxxxxxxxxxxxxxxxxxxxxx', '1OrdAddrxxxxxxxxxxxxxxxxxxxxxxxxx']);
const BLASTER = `${h('b')}_0`;
const GOF = `${h('c')}_0`;

const fund: RawTx = {
  txid: h('1'),
  time: Date.parse('2026-09-20T12:00:00Z') / 1000,
  vin: [{ txid: h('e'), vout: 0 }],
  vout: [{ n: 0, sats: 6_000_000, addresses: ['1Derived1xxxxxxxxxxxxxxxxxxxxxxxx'] }],
};
const buy1: RawTx = {
  txid: h('2'),
  time: Date.parse('2026-09-29T15:40:00Z') / 1000,
  vin: [{ txid: fund.txid, vout: 0 }],
  vout: [
    { n: 0, sats: 1, addresses: ['1Derived2xxxxxxxxxxxxxxxxxxxxxxxx'] },
    { n: 1, sats: 15_000, addresses: ['1Sellerxxxxxxxxxxxxxxxxxxxxxxxxxx'] },
    { n: 2, sats: 5_984_899, addresses: ['1Derived3xxxxxxxxxxxxxxxxxxxxxxxx'] },
  ],
};
// Market buy: input 0 is the seller's 1-sat listing (a tx we never loaded), we add the payment.
const buy2: RawTx = {
  txid: h('3'),
  time: Date.parse('2026-10-04T18:15:00Z') / 1000,
  vin: [
    { txid: h('9'), vout: 0 },
    { txid: buy1.txid, vout: 2 },
  ],
  vout: [
    { n: 0, sats: 1, addresses: ['1Derived4xxxxxxxxxxxxxxxxxxxxxxxx'] },
    { n: 1, sats: 500_001, addresses: ['1Sellerxxxxxxxxxxxxxxxxxxxxxxxxxx'] },
    { n: 2, sats: 5_484_848, addresses: ['1Derived5xxxxxxxxxxxxxxxxxxxxxxxx'] },
  ],
};
const txs = [fund, buy1, buy2];
// listActions `satoshis`: the wallet's net change, fee included.
const local = new Map<string, LocalInfo>([
  [fund.txid, { description: 'Received payment', satoshis: 6_000_000 }],
  [buy1.txid, { description: 'Purchase 89131856 tokens for 15000 sats', labels: [`bsv21 ${BLASTER}`], satoshis: 1 + 5_984_899 - 6_000_000 }],
  [buy2.txid, { description: 'Purchase 100000000000 tokens for 500001 sats', labels: [`bsv21 ${GOF}`], satoshis: 1 + 5_484_848 - 5_984_899 }],
]);
const NOW = Date.parse('2026-10-08T12:00:00Z');

const load = () => {
  const extra = new Map([[`${h('9')}:0`, 1]]); // the listing output, fetched as a missing parent
  const rows = buildRows(txs, own, local, NOW, extra);
  const prev = ownOutputs(txs, own);
  const byId = new Map(txs.map((t) => [t.txid, t]));
  const ctx = { own, prev, listings: findListings(txs, prev), symbols: new Map([[BLASTER, 'BLASTER'], [GOF, 'GO•F#CK•YOURSELF']]) };
  return rows.map((r) => classifyEvent(r, byId.get(r.txid), local.get(r.txid), ctx));
};

describe('wallet-funded token buys', () => {
  test('missing parents: only the listing input of the market buy', () => {
    expect(missingParents(txs, local)).toEqual([h('9')]);
  });

  test('each buy shows what it cost, and its fee', () => {
    const rows = load();
    const b1 = rows.find((r) => r.txid === buy1.txid)!;
    const b2 = rows.find((r) => r.txid === buy2.txid)!;
    expect(b1).toMatchObject({ direction: 'out', amountSats: -15_000, feeSats: 100, type: 'buy', category: 'token' });
    expect(b2).toMatchObject({ direction: 'out', amountSats: -500_000, feeSats: 50, type: 'buy', category: 'token' });
    // Cross-check against the description (never the source): the 1-sat listing input is the seller's, so the
    // BSV that left is the stated price minus that sat.
    expect(Math.abs(-b1.amountSats - statedPriceSats(local.get(buy1.txid)!.description)!)).toBeLessThanOrEqual(1);
    expect(Math.abs(-b2.amountSats - statedPriceSats(local.get(buy2.txid)!.description)!)).toBeLessThanOrEqual(1);
    expect(b1.asset).toMatchObject({ kind: 'token', id: BLASTER, qty: '89131856' });
  });

  test('the incoming payment is in the history, totals and balances add up', () => {
    const rows = load();
    expect(rows.find((r) => r.txid === fund.txid)).toMatchObject({ direction: 'in', amountSats: 6_000_000 });
    const t = totals(rows);
    expect(t).toMatchObject({ inSats: 6_000_000, outSats: 515_000, feeSats: 150, count: 3 });
    const all = balances(rows, { from: null, to: null });
    expect(all.closing).toBe(6_000_000 - 515_150);
    const month = balances(rows, { from: Date.parse('2026-09-25T00:00:00Z'), to: NOW });
    expect(month.opening).toBe(6_000_000);
    expect(month.closing).not.toBe(month.opening);
  });

  test('Gains: each buy disposes of BSV (cost + fee) and acquires the token at that cost', () => {
    const rows = load();
    const price = () => 40; // £ per BSV
    const { events, warnings } = buildLedger(rows, price, (ms) => new Date(ms).toISOString().slice(0, 10));
    expect(warnings).toEqual([]);
    const tok = events.filter((e) => e.asset === `token:${BLASTER}`);
    expect(tok).toEqual([expect.objectContaining({ side: 'acquire', qty: 89131856, fiat: (15_100 * 40) / 1e8 })]);
    const bsvOut = events.filter((e) => e.asset === 'BSV' && e.side === 'dispose').map((e) => e.qty);
    expect(bsvOut).toEqual([15_100, 500_050]);
    expect(events.find((e) => e.asset === 'BSV' && e.side === 'acquire')).toMatchObject({ qty: 6_000_000, fiat: 2.4 });
    const d = computeGains(events, 'hmrc');
    expect(d.filter((x) => x.asset === 'BSV')).toHaveLength(2);
  });

  test('token decimals: the amount reads as in the token list', () => {
    expect(tokenAmount('89131856', 8)).toBe('0.89131856');
    expect(tokenAmount('100000000000', 8)).toBe('1000');
    expect(tokenAmount('204', 0)).toBe('204');
    expect(assetText({ kind: 'token', id: BLASTER, symbol: 'BLASTER', qty: '89131856', dec: 8 })).toBe('0.89131856 $BLASTER');
    const rows = load().map((r) => (r.asset ? { ...r, asset: { ...r.asset, dec: 8 } } : r));
    const { events } = buildLedger(rows, () => 40, (ms) => new Date(ms).toISOString().slice(0, 10));
    expect(events.find((e) => e.asset === `token:${BLASTER}`)?.qty).toBeCloseTo(0.89131856, 8);
  });

  test('before the fix the buys read 0: a list with rows but nothing moved is flagged', () => {
    expect(historyLooksIncomplete({ inSats: 0, outSats: 0, feeSats: 0, count: 2 }, null, null)).toBe(true);
    expect(historyLooksIncomplete({ inSats: 0, outSats: 515_000, feeSats: 150, count: 2 }, 5_449_588, 5_449_588)).toBe(false);
    expect(historyLooksIncomplete({ inSats: 0, outSats: 515_000, feeSats: 150, count: 2 }, 5_449_588, 4_934_438)).toBe(true);
  });
});

describe('Connections on the phone (in-wallet apps)', () => {
  test('in-wallet app actions are attributed and show in Connections', async () => {
    const { mergeConnections, deviceAppHosts, logInWalletApp, loadConnectionLog } = await import('./connectionLog');
    const { inWalletAppOf } = await import('./historyEvents');
    expect(inWalletAppOf(local.get(buy1.txid))).toBe('1sat.market');
    expect(inWalletAppOf({ description: 'Buy 1,000 $BLASTER on the TokenBlaster curve for 0.0001 BSV incl. curve fees, plus network fee' })).toBe(
      'tokenblaster',
    );
    const rows = load();
    expect(rows.find((r) => r.txid === buy1.txid)?.app).toBe('1sat.market');
    const seen = deviceAppHosts([
      ['bwallet.appLayout.https://games.bwalletx.com', '{}'],
      ['bwallet:recent-sites', JSON.stringify(['https://bitcoinchat.online/feed', 'javascript:alert(1)'])],
      ['other', 'x'],
    ]);
    expect(seen.sort()).toEqual(['bitcoinchat.online', 'games.bwalletx.com']);
    const list = mergeConnections({}, [], rows, seen);
    expect(list.find((r) => r.host === '1sat.market')).toMatchObject({ payments: 2, spentSats: 515_150 });
    expect(list.map((r) => r.host)).toContain('games.bwalletx.com');

    // The page-side logger writes through chrome.storage.local (the mobile shim's shared store).
    const store: Record<string, unknown> = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { local: { get: async (k: string) => ({ [k]: store[k] }), set: async (v: Record<string, unknown>) => void Object.assign(store, v) } },
    };
    logInWalletApp('tokenblaster', 'createAction', { txid: h('7'), sats: 15_000 });
    logInWalletApp('bitcoinchat.online', 'signIn');
    const { updateConnectionLog } = await import('./connectionLog');
    await updateConnectionLog((l) => l);
    const log = await loadConnectionLog();
    expect(log.tokenblaster).toMatchObject({ calls: { createAction: 1 }, spentSats: 15_000 });
    expect(log['bitcoinchat.online'].calls.signIn).toBe(1);
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  test('TokenBlaster curve buys are token buys in whole tokens', () => {
    const tbx: RawTx = { ...buy1, txid: h('8') };
    const loc = new Map(local);
    loc.set(tbx.txid, { description: 'Buy 0.89131856 $BLASTER on the TokenBlaster curve for 0.00015 BSV incl. curve fees, plus network fee', labels: ['tokenblaster', `bsv21 ${BLASTER}`], satoshis: -15_100 });
    const prev = ownOutputs([fund, tbx], own);
    const [r] = buildRows([fund, tbx], own, loc, NOW).filter((x) => x.txid === tbx.txid);
    const c = classifyEvent(r, tbx, loc.get(tbx.txid), { own, prev, listings: new Map() });
    expect(c).toMatchObject({ type: 'buy', amountSats: -15_000, app: 'tokenblaster', asset: { qty: '0.89131856', dec: 0 } });
  });
});
