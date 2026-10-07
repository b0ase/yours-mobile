import { describe, expect, test } from 'bun:test';
import fixtures from './fixtures/marketTxs.json';
import { Lock } from '@1sat/templates';
import { PrivateKey } from '@bsv/sdk';
import { assetText, classifyEvent, filterCategory, findListings, isOrdLock, isTimeLock, parseBsv20, parseInscription, trailingP2pkh } from './historyEvents';
import { buildRows, ownOutputs, toCsv, type LocalInfo, type RawTx } from './txHistory';
import { toRawTx, type WocTx } from './txHistoryFetch';
import { appsByTxid, isGameHost, mergeConnections, recordCall, recordPayment, requestedSats } from './connectionLog';

// Real mainnet txs (WhatsOnChain JSON, scripts cut to 1,200 hex; the 202-output bulk listing cut to 10 outputs):
//  f49e09fa… lists 204 $NINJAPUNKGIRLS (BSV-21) in an OrdLock; 7cac90cb… buys them.
//  04caf459… bulk-lists NFTs; 3beb3328… buys output 8 for 21,800 sats.
const F = fixtures as unknown as Record<string, WocTx>;
const tx = (p: string) => toRawTx(Object.values(F).find((t) => t.txid.startsWith(p)) as WocTx);
const TOKEN_LIST = tx('f49e09fa');
const TOKEN_BUY = tx('7cac90cb');
const NFT_LIST = tx('04caf459');
const NFT_BUY = tx('3beb3328');
const NPG = 'b8747a4b356875cc90842c733ad2770b12bf50c17cf204afd0605f9dcba67d31_1';

/** A made-up earlier tx paying `sats` to `address`, so the account's funding inputs are known (as in real history). */
const funding = (inputs: RawTx['vin'], address: string, sats = 50_000): RawTx[] => {
  const byTx = new Map<string, number[]>();
  for (const i of inputs) byTx.set(i.txid as string, [...(byTx.get(i.txid as string) ?? []), i.vout ?? 0]);
  return [...byTx].map(([txid, vouts]) => ({
    txid,
    time: 1_700_000_000,
    confirmations: 100,
    vin: [{ txid: '0'.repeat(64), vout: 0 }],
    vout: Array.from({ length: Math.max(...vouts) + 1 }, (_, n) => ({ n, sats: vouts.includes(n) ? sats : 0, addresses: vouts.includes(n) ? [address] : [] })),
  }));
};

const run = (txs: RawTx[], own: string[], local = new Map<string, LocalInfo>(), appByTxid?: Map<string, { app: string; game?: boolean }>) => {
  const ownSet = new Set(own);
  const rows = buildRows(txs, ownSet, local, 0);
  const byId = new Map(txs.map((t) => [t.txid, t]));
  const prev = ownOutputs([...byId.values()], ownSet);
  const ctx = { own: ownSet, prev, listings: findListings([...byId.values()], prev), appByTxid };
  return rows.map((r) => classifyEvent(r, byId.get(r.txid), local.get(r.txid), ctx));
};

describe('script parsing on real txs', () => {
  test('BSV-21 transfer inscription inside an OrdLock', () => {
    const s = TOKEN_LIST.vout[0].script;
    expect(isOrdLock(s)).toBe(true);
    expect(parseBsv20(parseInscription(s))).toMatchObject({ op: 'transfer', id: NPG, amt: '204' });
  });
  test('inscription wrapped round a P2PKH: the address WhatsOnChain leaves out', () => {
    expect(F[TOKEN_BUY.txid].vout[0].scriptPubKey?.addresses ?? []).toEqual([]);
    expect(TOKEN_BUY.vout[0].addresses).toHaveLength(1);
    expect(trailingP2pkh(TOKEN_BUY.vout[0].script)).toBe(TOKEN_BUY.vout[0].addresses[0]);
  });
  test('plain P2PKH and OP_RETURN are not inscriptions', () => {
    expect(parseInscription(NFT_BUY.vout[1].script)).toBeNull();
    expect(parseInscription(NFT_BUY.vout[3].script)).toBeNull();
  });
});

describe('token buy and sell (BSV-21 market)', () => {
  test('buyer: token bought, qty, price paid', () => {
    const buyerOrd = TOKEN_BUY.vout[0].addresses[0];
    const buyerPay = TOKEN_BUY.vout[4].addresses[0];
    // Funding sized so the inputs cover the outputs plus a 100-sat fee (the real prevouts aren't in the fixture).
    const outs = TOKEN_BUY.vout.reduce((s, o) => s + o.sats, 0);
    const n = TOKEN_BUY.vin.length - 1;
    const fund = funding(TOKEN_BUY.vin.slice(1), buyerPay, Math.ceil((outs + 100 - 1) / n));
    const row = run([TOKEN_BUY, ...fund], [buyerOrd, buyerPay]).find((r) => r.txid === TOKEN_BUY.txid)!;
    expect(row).toMatchObject({ category: 'token', type: 'buy', direction: 'out', asset: { kind: 'token', id: NPG, qty: '204' } });
    // Paid at least the 20,400,000 sat price (plus market fee) out of the account.
    expect(-row.amountSats).toBeGreaterThanOrEqual(20_400_000);
    expect(-row.amountSats).toBeLessThan(20_700_000);
  });
  test('seller: listing then sale, proceeds in', () => {
    const seller = TOKEN_LIST.vout[3].addresses[0];
    const fund = funding(TOKEN_LIST.vin, seller, 33_000_000);
    const rows = run([TOKEN_LIST, TOKEN_BUY, ...fund], [seller]);
    const list = rows.find((r) => r.txid === TOKEN_LIST.txid)!;
    const sale = rows.find((r) => r.txid === TOKEN_BUY.txid)!;
    expect(list).toMatchObject({ category: 'token', type: 'list', asset: { id: NPG, qty: '204' } });
    expect(sale).toMatchObject({ category: 'token', type: 'sell', direction: 'in', amountSats: 20_400_000, asset: { id: NPG, qty: '204' } });
  });
});

describe('NFT buy and sell (OrdLock market)', () => {
  test('buyer', () => {
    const buyer = NFT_BUY.vout[0].addresses[0];
    const fund = funding([NFT_BUY.vin[1]], buyer, 2_700_000);
    const row = run([NFT_BUY, ...fund], [buyer]).find((r) => r.txid === NFT_BUY.txid)!;
    expect(row).toMatchObject({ category: 'nft', type: 'buy', direction: 'out', asset: { kind: 'nft' } });
    expect(-row.amountSats).toBeGreaterThanOrEqual(21_800);
  });
  test('seller: bulk listing, then the one that sold', () => {
    const payout = NFT_BUY.vout[1].addresses[0];
    const fund = funding(NFT_LIST.vin, 'ord-holder', 1);
    const rows = run([NFT_LIST, NFT_BUY, ...fund], ['ord-holder', payout]);
    expect(rows.find((r) => r.txid === NFT_LIST.txid)).toMatchObject({ category: 'nft', type: 'list' });
    expect(rows.find((r) => r.txid === NFT_BUY.txid)).toMatchObject({ category: 'nft', type: 'sell', amountSats: 21_800, asset: { id: `${NFT_LIST.vin[8].txid}_${NFT_LIST.vin[8].vout}` } });
    // 1Sat ordinal theory: output 8 of the bulk listing carries the sat of input 8, so the sale keeps the id the NFT was bought under.
  });
});

describe('local records, apps, games, pots', () => {
  const pay = (txid: string, to: string, sats: number): RawTx[] => [
    { txid: 'f'.repeat(64), time: 1, confirmations: 9, vin: [{ txid: '1'.repeat(64), vout: 0 }], vout: [{ n: 0, sats: 100_000, addresses: ['1Me'] }] },
    { txid, time: 2, confirmations: 9, vin: [{ txid: 'f'.repeat(64), vout: 0 }], vout: [{ n: 0, sats, addresses: [to] }, { n: 1, sats: 100_000 - sats - 50, addresses: ['1Me'] }] },
  ];
  test('a payment a game asked for is a game payment', () => {
    const id = 'a'.repeat(64);
    const apps = appsByTxid(recordPayment({}, 'bitcoin-gaming.vercel.app', { at: 1, txid: id, sats: 500 }));
    const row = run(pay(id, '1Game', 500), ['1Me'], new Map(), apps).find((r) => r.txid === id)!;
    expect(row).toMatchObject({ category: 'game', type: 'payment', app: 'bitcoin-gaming.vercel.app', label: 'game payment' });
  });
  test('other apps are app payments', () => {
    const id = 'b'.repeat(64);
    const apps = appsByTxid(recordPayment({}, 'shop.example', { at: 1, txid: id, sats: 900 }));
    expect(run(pay(id, '1Shop', 900), ['1Me'], new Map(), apps).find((r) => r.txid === id)).toMatchObject({ category: 'app', app: 'shop.example' });
  });
  test('wallet description "Purchase N tokens" with a token label', () => {
    const id = 'c'.repeat(64);
    const local = new Map([[id, { description: 'Purchase 50 tokens for 1000 sats', labels: [`p bsv21 token ${NPG}`] }]]);
    expect(run(pay(id, '1Seller', 1000), ['1Me'], local).find((r) => r.txid === id)).toMatchObject({ category: 'token', type: 'buy', asset: { id: NPG, qty: '50' } });
  });
  test('pot payments are subscriptions; bChat tips are social; plain sends are payments', () => {
    const p = 'd'.repeat(64);
    expect(run(pay(p, '1X', 10), ['1Me'], new Map([[p, { description: 'Pot: bChat subscription' }]])).find((r) => r.txid === p)?.category).toBe('subscription');
    const q = 'e'.repeat(64);
    expect(run(pay(q, '1X', 10), ['1Me']).find((r) => r.txid === q)).toMatchObject({ category: 'payment', type: 'send' });
  });
  test('category filter and CSV columns', () => {
    const id = 'a'.repeat(64);
    const apps = appsByTxid(recordPayment({}, 'bitcoin-gaming.vercel.app', { at: 1, txid: id, sats: 500 }));
    const rows = run(pay(id, '1Game', 500), ['1Me'], new Map(), apps);
    expect(filterCategory(rows, 'game').map((r) => r.txid)).toEqual([id]);
    const csv = toCsv(rows, 'acct');
    expect(csv.split('\r\n')[0]).toContain('category,type,asset_kind,asset_id,asset_symbol,asset_qty,app,app_note');
    expect(csv).toContain(',game,payment,,,,,bitcoin-gaming.vercel.app,');
  });
  test('asset text', () => {
    expect(assetText({ kind: 'token', id: NPG, symbol: '$NINJAPUNKGIRLS', qty: '204' })).toBe('204 $NINJAPUNKGIRLS');
    expect(assetText({ kind: 'nft', id: `${NFT_LIST.txid}_8` })).toBe('NFT 04caf459…d5_8');
  });
});

describe('app labels', () => {
  test('"game: round 12 won" files a payment under Games and shows the note', () => {
    const id = '9'.repeat(64);
    const txs: RawTx[] = [
      { txid: 'f'.repeat(64), time: 1, confirmations: 9, vin: [{ txid: '1'.repeat(64), vout: 0 }], vout: [{ n: 0, sats: 10_000, addresses: ['1Me'] }] },
      { txid: id, time: 2, confirmations: 9, vin: [{ txid: 'f'.repeat(64), vout: 0 }], vout: [{ n: 0, sats: 500, addresses: ['1G'] }, { n: 1, sats: 9_450, addresses: ['1Me'] }] },
    ];
    const local = new Map([[id, { description: 'game: round 12 won' }]]);
    expect(run(txs, ['1Me'], local).find((r) => r.txid === id)).toMatchObject({ category: 'game', appNote: 'round 12 won' });
  });
});

describe('connections log', () => {
  test('records calls and payments per host, no double count', () => {
    let l = recordCall({}, 'https://bitcoin-gaming.vercel.app/play', 'createAction', 10);
    l = recordCall(l, 'bitcoin-gaming.vercel.app', 'getPublicKey', 20);
    l = recordPayment(l, 'bitcoin-gaming.vercel.app', { at: 30, txid: 't1', sats: 700 });
    l = recordPayment(l, 'bitcoin-gaming.vercel.app', { at: 31, txid: 't1', sats: 700 });
    const e = l['bitcoin-gaming.vercel.app'];
    expect(e).toMatchObject({ firstSeen: 10, lastSeen: 30, spentSats: 700, calls: { createAction: 1, getPublicKey: 1 } });
    expect(e.payments).toHaveLength(1);
  });
  test('requested sats ignore the send-all sentinel', () => {
    expect(requestedSats([{ satoshis: 100 }, { satoshis: 1 }, { satoshis: 2_099_999_999_999_999 }])).toBe(101);
  });
  test('game hosts', () => {
    expect(isGameHost('bitcoin-gaming.vercel.app')).toBe(true);
    expect(isGameHost('play.hastearcade.com')).toBe(true);
    expect(isGameHost('zerodice.games')).toBe(false);
    expect(isGameHost('shop.example')).toBe(false);
  });
  test('merge log + BRC-100 grants + history spend', () => {
    const l = recordPayment(recordCall({}, 'app.example', 'createAction', 5), 'app.example', { at: 6, txid: 'x', sats: 1 });
    const rows = mergeConnections(
      l,
      [
        { originator: 'app.example', permissions: [{ type: 'spending', authorizedAmount: 10_000 }, { type: 'protocol' }] },
        { originator: 'old.example', permissions: [{ type: 'basket' }] },
      ],
      [{ txid: 'x', time: 6, direction: 'out', amountSats: -1000, feeSats: 20, counterparty: '', label: '', note: '', confirmations: 1, app: 'app.example' }],
    );
    expect(rows[0]).toMatchObject({ host: 'app.example', calls: 1, payments: 1, spentSats: 1020, spendLimitSats: 10_000, grants: { spending: 1, protocol: 1 } });
    expect(rows[1]).toMatchObject({ host: 'old.example', calls: 0, grants: { basket: 1 } });
  });
});

describe('Locks category (time-locks)', () => {
  const lockHex = Lock.lock(PrivateKey.fromRandom().toAddress(), 970_500).toHex();
  test('a time-lock is not an OrdLock listing, though they share a prefix', () => {
    expect(isTimeLock(lockHex)).toBe(true);
    expect(isOrdLock(lockHex)).toBe(false);
    expect(isOrdLock(TOKEN_LIST.vout[0].script)).toBe(true);
    expect(isTimeLock(TOKEN_LIST.vout[0].script)).toBe(false);
  });
  test('lock and claim rows land in Locks', () => {
    const me = PrivateKey.fromRandom().toAddress();
    const lockTx: RawTx = { txid: 'a'.repeat(64), time: 1_700_000_100, confirmations: 1, vin: [{ txid: 'f'.repeat(64), vout: 0 }], vout: [{ n: 0, sats: 10_000, addresses: [], script: lockHex }, { n: 1, sats: 39_000, addresses: [me] }] };
    const claimTx: RawTx = { txid: 'b'.repeat(64), time: 1_700_000_200, confirmations: 1, vin: [{ txid: 'a'.repeat(64), vout: 0 }], vout: [{ n: 0, sats: 9_800, addresses: [me] }] };
    const local = new Map<string, LocalInfo>([
      ['a'.repeat(64), { description: 'Lock BSV in 1 output(s)' } as LocalInfo],
      ['b'.repeat(64), { description: 'Unlock 1 lock(s)' } as LocalInfo],
    ]);
    const rows = run([...funding(lockTx.vin, me), lockTx, claimTx], [me], local);
    const byId = new Map(rows.map((r) => [r.txid, r]));
    expect(byId.get('a'.repeat(64))?.category).toBe('lock');
    expect(byId.get('b'.repeat(64))?.category).toBe('lock');
    expect(filterCategory(rows, 'lock')).toHaveLength(2);
  });
});
