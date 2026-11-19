import { describe, expect, test } from 'bun:test';
import {
  Hash,
  LockingScript,
  PrivateKey,
  ProtoWallet,
  Spend,
  UnlockingScript,
  Utils,
  type WalletInterface,
} from '@bsv/sdk';
import { CurveError, buyTokens, feeSplit, parseCurve, sellSats } from './curve';
import { proofVerdict } from './proof';
import { configProblem } from './api';
import { signOurInputs } from './sign';
import { PLATFORM_ADDRESS } from './constants';
import {
  cancelPrepared,
  executeTrade,
  loadMarket,
  prepareBuy,
  prepareSell,
  closeUnsure,
  sweepFundings,
  UNSURE_MARGIN_MS,
  type Deps,
  type TradeWallet,
} from './trade';
import { legacyPendingStore, localPendingStore, type PendingRecord, type PendingStore } from './pending';
import { memepoolWallet } from './wallet';
import { PARAMS, STATE, TOKEN, POOL_ORD, POOL_PAY, INDEXER, honestBuy, honestSell, pay, tok } from './testkit';
import { addressPkh, bsv21TransferScript, parseBsv21Transfer } from './script';
import type { Template } from './validate';

describe('our curve maths matches Memepool’s live quotes (25 Oct 2026)', () => {
  test('stage 1 (virtual reserves)', () => {
    expect(buyTokens(PARAMS, STATE, BigInt(1_000_000))).toBe(BigInt(1_900_410));
    expect(sellSats(PARAMS, STATE, BigInt(5_000_000))).toEqual({
      gross: BigInt(2_580_581),
      fee: BigInt(32_258),
      net: BigInt(2_548_323),
    });
    expect(feeSplit(BigInt(2_580_581))).toEqual({
      fee: BigInt(32_258),
      creator: BigInt(7_741),
      platform: BigInt(24_517),
    });
  });
  test('stage 2 (tail: real reserves)', () => {
    const p = { ...PARAMS, vSats0: BigInt(100_000_000) };
    const s = {
      vSats: BigInt(2_061_425_681),
      vTokens: BigInt(102_890_889),
      realSats: BigInt(1_961_425_681),
      realTokens: BigInt(29_890_889),
      tail: true,
    };
    expect(buyTokens(p, s, BigInt(100_000))).toBe(BigInt(1_504));
    expect(sellSats(p, s, BigInt(1_000))).toEqual({ gross: BigInt(65_617), fee: BigInt(821), net: BigInt(64_796) });
  });
  test('a buy that would finish the curve is refused', () => {
    const s = {
      ...STATE,
      realTokens: PARAMS.tailAt + BigInt(1000),
      vTokens: PARAMS.tailAt + BigInt(1000) + BigInt(73_000_000),
    };
    expect(() => buyTokens(PARAMS, s, BigInt(50_000_000))).toThrow(CurveError);
  });
  test('parseCurve refuses a made-up state or other fees', () => {
    const detail = {
      params: {
        totalSupply: '1000000000',
        curveSupply: '793100000',
        vTokens0: '1073000000',
        vSats0: '500000000',
        feeBps: '125',
        creatorBps: '30',
        tailAt: '206900000',
      },
      state: {
        vSats: '527501346',
        vTokens: '1017059099',
        realSats: '27501346',
        realTokens: '944059099',
        sold: '55940901',
        tail: false,
      },
    };
    expect(parseCurve(detail)).not.toBeNull();
    expect(parseCurve({ ...detail, state: { ...detail.state, vSats: '600000000' } })).toBeNull();
    expect(parseCurve({ ...detail, params: { ...detail.params, feeBps: '200' } })).toBeNull();
    expect(parseCurve({ ...detail, state: { ...detail.state, tail: true } })).toBeNull();
  });
});

describe('proof of reserves', () => {
  const row = { id: TOKEN, status: 'live', ok: true, poolPay: POOL_PAY, poolOrd: POOL_ORD, chain: { verdict: 'ok' } };
  test('healthy row', () => expect(proofVerdict({ coins: [row] }, TOKEN).healthy).toBe(true));
  test('every unhealthy state refuses with plain English', () => {
    const v = (r: object) => proofVerdict({ coins: [{ ...row, ...r }] }, TOKEN);
    expect(v({ chain: { verdict: 'short' } })).toEqual({
      healthy: false,
      why: expect.stringMatching(/less than it should/),
    });
    expect(v({ chain: { verdict: 'watch' } }).healthy).toBe(false);
    expect(v({ status: 'awaiting' }).healthy).toBe(false);
    expect(v({ status: 'halted' }).healthy).toBe(false);
    expect(v({ ok: false }).healthy).toBe(false);
    expect(v({ poolPay: 'nope' }).healthy).toBe(false);
    expect(proofVerdict({ coins: [] }, TOKEN).healthy).toBe(false);
    expect(proofVerdict(null, TOKEN).healthy).toBe(false);
  });
});

test('config: refuse when Memepool moves its fee or fee address', () => {
  const cfg = {
    network: 'main',
    demo: false,
    trading: true,
    platformAddress: PLATFORM_ADDRESS,
    feeBps: 125,
    creatorBps: 30,
  };
  expect(configProblem(cfg)).toBeNull();
  expect(configProblem({ ...cfg, platformAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' })).toMatch(/fee address/);
  expect(configProblem({ ...cfg, feeBps: 150 })).toMatch(/fees/);
  expect(configProblem({ ...cfg, trading: false })).toMatch(/paused/);
});

test('signing: only our inputs, SIGHASH_ALL|FORKID, and the signature verifies in the script interpreter', async () => {
  const root = PrivateKey.fromRandom();
  const w = new ProtoWallet(root) as unknown as WalletInterface;
  const key = { protocolID: [2, '3241645161d8'] as [2, string], keyID: 'a b' };
  const { publicKey } = await w.getPublicKey({ ...key, counterparty: 'self', forSelf: true });
  const me = {
    ord: PrivateKey.fromRandom().toAddress(),
    pay: (await import('@bsv/sdk')).PublicKey.fromString(publicKey).toAddress(),
  };
  const f = honestBuy(undefined, me);
  const unlocks = await signOurInputs(w, f.t, [1], () => key);
  expect(Object.keys(unlocks)).toEqual(['1']);
  const u = UnlockingScript.fromHex(unlocks['1']);
  const sig = u.chunks[0].data!;
  expect(sig[sig.length - 1]).toBe(0x41);
  const t = f.t;
  const spend = new Spend({
    sourceTXID: t.inputs[1].txid,
    sourceOutputIndex: t.inputs[1].vout,
    sourceSatoshis: t.inputs[1].satoshis,
    lockingScript: LockingScript.fromHex(t.inputs[1].script),
    transactionVersion: 1,
    otherInputs: [{ sourceTXID: t.inputs[0].txid, sourceOutputIndex: t.inputs[0].vout, sequence: 0xffffffff }] as never,
    outputs: t.outputs.map((o) => ({ lockingScript: LockingScript.fromHex(o.script), satoshis: o.satoshis })) as never,
    inputIndex: 1,
    unlockingScript: u,
    inputSequence: 0xffffffff,
    lockTime: 0,
  });
  expect(spend.validate()).toBe(true);
  // A pool input, or a coin under a key that isn't ours, is never signed.
  await expect(signOurInputs(w, t, [0], () => key)).rejects.toThrow(/not ours/);
  await expect(signOurInputs(w, t, [1], () => ({ ...key, keyID: 'other key' }))).rejects.toThrow(/not locked/);
});

// ── the flow, against a fake Memepool and a fake wallet ─────────────────────────────────────────────────────────
type Reply = { status: number; body: unknown };
function fakeMemepool(opts: {
  build: (body: Record<string, unknown>) => Template;
  prepare?: Reply[];
  submit?: Reply[];
  proof?: unknown;
  config?: Record<string, unknown>;
  /** How long Memepool says its quote lives (default 30 s). */
  expiresIn?: number;
}) {
  const calls: string[] = [];
  const prepares = [...(opts.prepare ?? [])];
  const submits = [...(opts.submit ?? [])];
  const detail = {
    id: TOKEN,
    sym: 'FROG',
    status: 'live',
    poolPay: POOL_PAY,
    poolOrd: POOL_ORD,
    indexer: { fundAddress: INDEXER },
    params: {
      totalSupply: '1000000000',
      curveSupply: '793100000',
      vTokens0: '1073000000',
      vSats0: '500000000',
      feeBps: '125',
      creatorBps: '30',
      tailAt: '206900000',
    },
    state: { vSats: '527501346', vTokens: '1017059099', realSats: '27501346', realTokens: '944059099', tail: false },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = async (url: string, init?: RequestInit) => {
    const path = url.replace(/^https:\/\/txblaster\.xyz\/memepool\/api/, '');
    calls.push(path.split('?')[0]);
    if (path === '/config')
      return json(
        200,
        opts.config ?? {
          network: 'main',
          trading: true,
          platformAddress: PLATFORM_ADDRESS,
          feeBps: 125,
          creatorBps: 30,
        },
      );
    if (path === `/tokens/${TOKEN}`) return json(200, detail);
    if (path === '/proof')
      return json(
        200,
        opts.proof ?? {
          coins: [
            { id: TOKEN, status: 'live', ok: true, poolPay: POOL_PAY, poolOrd: POOL_ORD, chain: { verdict: 'ok' } },
          ],
        },
      );
    if (path.startsWith('/quote')) {
      const side = /side=(\w+)/.exec(path)![1];
      return json(
        200,
        side === 'buy'
          ? { tokens: '1900410', grossSats: 1000000, netSats: 987500, fee: 12500, indexFeeSats: 2000 }
          : { tokens: '5000000', grossSats: 2580581, netSats: 2548323, fee: 32258, indexFeeSats: 2000 },
      );
    }
    if (path === '/trade/prepare') {
      const r = prepares.shift();
      if (r && r.status !== 200) return json(r.status, r.body);
      const body = JSON.parse(String(init?.body));
      return json(200, {
        quoteId: `q${calls.length}`,
        template: opts.build(body),
        expiresAt: Date.now() + (opts.expiresIn ?? 30_000),
      });
    }
    if (path === '/trade/submit') {
      const r = submits.shift() ?? { status: 202, body: { txid: 'ab'.repeat(32) } };
      return json(r.status, r.body);
    }
    return json(404, {});
  };
  return { fetch: fetch as Deps['fetch'], calls };
}

/** `account` stands for the wallet's root key: a nonce re-derives the same pay key only in the same account. */
function fakeWallet(side: 'buy' | 'sell', account = 'A') {
  const log = {
    signed: 0,
    funded: 0,
    returned: 0,
    signedIndexes: [] as number[][],
    back: [] as Parameters<TradeWallet['returnFunding']>[0][],
  };
  let ordAddr = '';
  let payAddr = '';
  const w: TradeWallet = {
    newOrdKey: async () => ({
      address: (ordAddr = PrivateKey.fromRandom().toAddress()),
      key: { protocolID: [0, 'onesat'], keyID: 'o' },
    }),
    newPayKey: async (n) => ({
      address: (payAddr = n
        ? new PrivateKey(Utils.toHex(Hash.sha256(`${account} ${n.prefix} ${n.suffix}`, 'utf8')), 16).toAddress()
        : PrivateKey.fromRandom().toAddress()),
      key: { protocolID: [2, '3241645161d8'], keyID: `${n?.prefix ?? 'p'} ${n?.suffix ?? 's'}` },
      derivationPrefix: n?.prefix ?? 'p',
      derivationSuffix: n?.suffix ?? 's',
    }),
    fund: async (p, sats) => {
      log.funded++;
      return {
        coin: { txid: '02'.padStart(64, '0'), vout: 0, satoshis: sats + 50_000, script: pay(p.address), key: p.key },
        beef: [],
        pay: p,
      };
    },
    returnFunding: async (f) => {
      log.returned++;
      log.back.push(f);
    },
    tokenCoins: async () =>
      side === 'sell'
        ? [
            {
              txid: '03'.padStart(64, '0'),
              vout: 1,
              satoshis: 1,
              script: tok(ordFor(), BigInt(6_000_000)),
              amt: BigInt(6_000_000),
              key: { protocolID: [0, 'onesat'], keyID: 'k' },
            },
          ]
        : [],
    sign: async (_t, idx) => {
      log.signed++;
      log.signedIndexes.push(idx);
      return Object.fromEntries(idx.map((i) => [String(i), '00']));
    },
    receive: async () => undefined,
  };
  // The sell's token coin lives at an older ord address of ours.
  const old = PrivateKey.fromRandom().toAddress();
  const ordFor = () => old;
  return { w, log, me: () => ({ ord: ordAddr, pay: payAddr }), oldOrd: old };
}

/** Build the honest template the fake server would, for the trader in the prepare body. */
const buildBuy = (tweak?: (t: Template) => void) => (body: Record<string, unknown>) => {
  const trader = body.trader as { ord: string; pay: string };
  const f = honestBuy(undefined, trader);
  const coin = (body.coins as { txid: string; vout: number }[])[0];
  const userIn = f.t.inputs.find((i) => i.owner === 'user')!;
  Object.assign(userIn, { txid: coin.txid, vout: coin.vout });
  tweak?.(f.t);
  return f.t;
};

// ── the network as WhatsOnChain answers it (/spent, /tx/hash, /address/../unspent/all) ─────────────────────────────
type Net = {
  /** `${txid}_${vout}` → the txid that spent it. */
  spent: Map<string, string>;
  txs: Map<string, { confirmed: boolean; inputs: { txid: string; vout: number }[] }>;
  utxos: Map<string, { tx_hash: string; tx_pos: number; value: number; isSpentInMempoolTx?: boolean }[]>;
};
const newNet = (): Net => ({ spent: new Map(), txs: new Map(), utxos: new Map() });
const onNet = (inner: Deps['fetch'], net: Net): Deps['fetch'] =>
  (async (url: string, init?: RequestInit) => {
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    let m = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(url);
    if (m) {
      const by = net.spent.get(`${m[1]}_${m[2]}`);
      return by ? ok({ txid: by, vin: 0, status: 'confirmed' }) : new Response('', { status: 404 });
    }
    m = /\/tx\/hash\/([0-9a-f]{64})$/.exec(url);
    if (m) {
      const t = net.txs.get(m[1]);
      if (!t) return new Response('', { status: 404 });
      return ok({
        txid: m[1],
        vin: t.inputs,
        ...(t.confirmed ? { blockhash: '00'.repeat(32), confirmations: 1 } : {}),
      });
    }
    m = /\/address\/(\w+)\/unspent\/all$/.exec(url);
    if (m) return ok({ address: m[1], result: net.utxos.get(m[1]) ?? [], error: '' });
    return inner(url, init);
  }) as Deps['fetch'];
/** Another trader's transaction takes the first pool coin of `p`'s template (confirmed unless said otherwise). */
const killPool = (net: Net, p: { template: Template }, confirmed = true, spender = 'ee'.repeat(32)) => {
  const pool = p.template.inputs.find((i) => i.owner !== 'user')!;
  net.spent.set(`${pool.txid}_${pool.vout}`, spender);
  net.txs.set(spender, { confirmed, inputs: [{ txid: pool.txid, vout: pool.vout }] });
};

describe('flow', () => {
  const deps = (fetch: Deps['fetch'], w: TradeWallet): Deps => ({ fetch, wallet: w, sleep: async () => undefined });

  test('buy: quote → fund → prepare → verify → (sheet) → sign our input once → submit', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    const d = deps(mp.fetch, fw.w);
    const m = await loadMarket(d, TOKEN);
    const p = await prepareBuy(d, m, BigInt(1_000_000), 300);
    expect(fw.log.signed).toBe(0); // nothing signed before the sheet
    expect(p.checked.tokens).toBe(BigInt(1_900_410));
    expect(p.maxSpend).toBe(BigInt(1_006_000));
    const r = await executeTrade(d, p);
    expect(r).toEqual({ kind: 'sent', txid: 'ab'.repeat(32) });
    expect(fw.log.signedIndexes).toEqual([[1]]);
    expect(fw.log.returned).toBe(0);
  });

  test('buy over the 1 BSV cap is refused before anything is set aside', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    const d = deps(mp.fetch, fw.w);
    const m = await loadMarket(d, TOKEN);
    await expect(prepareBuy(d, m, BigInt(100_000_001), 300)).rejects.toThrow(/1 BSV/);
    expect(fw.log.funded).toBe(0);
  });

  test('a malicious template is refused, nothing is signed, the BSV goes back', async () => {
    const mp = fakeMemepool({
      build: buildBuy((t) => t.outputs.push({ script: pay(PrivateKey.fromRandom().toAddress()), satoshis: 1 })),
    });
    const fw = fakeWallet('buy');
    const d = deps(mp.fetch, fw.w);
    await expect(prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300)).rejects.toThrow(/does not expect/);
    expect(fw.log.signed).toBe(0);
    expect(fw.log.returned).toBe(1);
  });

  test('409 on prepare: re-prepared once automatically', async () => {
    const mp = fakeMemepool({ build: buildBuy(), prepare: [{ status: 409, body: { code: 'stale' } }] });
    const fw = fakeWallet('buy');
    const d = deps(mp.fetch, fw.w);
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    expect(p.quoteId).toBeTruthy();
    expect(mp.calls.filter((c) => c === '/trade/prepare').length).toBe(2);
  });

  test('409 twice on prepare: stops (no loop)', async () => {
    const stale = { status: 409, body: { code: 'stale' } };
    const mp = fakeMemepool({ build: buildBuy(), prepare: [stale, stale] });
    const fw = fakeWallet('buy');
    const d = deps(mp.fetch, fw.w);
    await expect(prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300)).rejects.toThrow(/traded first/);
    expect(fw.log.returned).toBe(1);
  });

  test('409 on submit: re-prepared once and handed back for a NEW sheet, never re-signed silently', async () => {
    const mp = fakeMemepool({ build: buildBuy(), submit: [{ status: 409, body: { code: 'stale' } }] });
    const fw = fakeWallet('buy');
    const d = deps(mp.fetch, fw.w);
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    const r = await executeTrade(d, p);
    expect(r.kind).toBe('new-sheet');
    expect(fw.log.signed).toBe(1);
    expect(mp.calls.filter((c) => c === '/trade/submit').length).toBe(1);
    if (r.kind === 'new-sheet') {
      expect(r.brokeMinimum).toBe(false);
      expect(r.prepared.quoteId).not.toBe(p.quoteId);
      // The user says no on the fresh sheet. The first signature may still be live, so nothing goes back yet.
      await cancelPrepared(d, r.prepared);
      expect(fw.log.returned).toBe(0);
    }
  });

  test('submit times out (5xx): never re-signed, coin kept for watching', async () => {
    const mp = fakeMemepool({ build: buildBuy(), submit: [{ status: 502, body: {} }] });
    const fw = fakeWallet('buy');
    const d = deps(mp.fetch, fw.w);
    const r = await executeTrade(d, await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300));
    expect(r.kind).toBe('unsure');
    expect(fw.log.signed).toBe(1);
    expect(fw.log.returned).toBe(0);
  });

  test('submit refused (400): the set-aside BSV goes back', async () => {
    const mp = fakeMemepool({ build: buildBuy(), submit: [{ status: 400, body: { code: 'expired' } }] });
    const fw = fakeWallet('buy');
    const d = deps(mp.fetch, fw.w);
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    await expect(executeTrade(d, p)).rejects.toThrow(/expired/);
    expect(fw.log.returned).toBe(1);
  });

  test('quote expired while the sheet was open: refused before signing', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    let now = Date.now();
    const d: Deps = { fetch: mp.fetch, wallet: fw.w, now: () => now, sleep: async () => undefined };
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    now += 120_000;
    await expect(executeTrade(d, p)).rejects.toThrow(/expired/);
    expect(fw.log.signed).toBe(0);
  });

  test('unhealthy proof of reserves: refused before any quote', async () => {
    const mp = fakeMemepool({
      build: buildBuy(),
      proof: {
        coins: [
          { id: TOKEN, status: 'live', ok: false, poolPay: POOL_PAY, poolOrd: POOL_ORD, chain: { verdict: 'short' } },
        ],
      },
    });
    const fw = fakeWallet('buy');
    await expect(loadMarket(deps(mp.fetch, fw.w), TOKEN)).rejects.toThrow(/less than it should/);
  });

  test('sell: our token coin offered, exactly the tokens asked, signed once', async () => {
    const fw = fakeWallet('sell');
    const mp = fakeMemepool({
      build: (body) => {
        const trader = body.trader as { ord: string; pay: string };
        const f = honestSell(undefined, undefined, trader);
        // The coin we offered lives at our older ord address.
        const userIn = f.t.inputs[0];
        Object.assign(userIn, { txid: '03'.padStart(64, '0'), vout: 1, script: tok(fw.oldOrd, BigInt(6_000_000)) });
        return f.t;
      },
    });
    const d = deps(mp.fetch, fw.w);
    const p = await prepareSell(d, await loadMarket(d, TOKEN), BigInt(5_000_000), 300);
    expect(p.checked.tokens).toBe(BigInt(5_000_000));
    expect((await executeTrade(d, p)).kind).toBe('sent');
    expect(fw.log.signedIndexes).toEqual([[0]]);
  });
});

test('script helpers round-trip canonically', () => {
  const a = PrivateKey.fromRandom().toAddress();
  const s = bsv21TransferScript(addressPkh(a)!, TOKEN, BigInt(42));
  expect(parseBsv21Transfer(s)).toEqual({ id: TOKEN, amt: BigInt(42), pkh: addressPkh(a)! });
  expect(parseBsv21Transfer(s + '00')).toBeNull();
  expect(parseBsv21Transfer(s.replace('0063', '0163'))).toBeNull();
});

describe('buy funding recovery (b-Aware 511)', () => {
  const memStore = (): PendingStore & { rows: Map<string, PendingRecord> } => {
    const rows = new Map<string, PendingRecord>();
    return {
      rows,
      list: () => [...rows.values()],
      put: (r) => void rows.set(r.id, r),
      remove: (id) => void rows.delete(id),
    };
  };
  /** The chain, as WhatsOnChain answers it: `spent` coins 200 with a txid, others 404. */
  const withChain = (inner: Deps['fetch'], spent: Set<string>): Deps['fetch'] =>
    (async (url: string, init?: RequestInit) => {
      const m = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(url);
      if (m)
        return spent.has(`${m[1]}_${m[2]}`)
          ? new Response(JSON.stringify({ txid: 'cd'.repeat(32) }), { status: 200 })
          : new Response('', { status: 404 });
      return inner(url, init);
    }) as Deps['fetch'];
  const setup = (spent = new Set<string>(), submit?: { status: number; body: unknown }[]) => {
    const mp = fakeMemepool({ build: buildBuy(), submit });
    const fw = fakeWallet('buy');
    const store = memStore();
    const d: Deps = { fetch: withChain(mp.fetch, spent), wallet: fw.w, sleep: async () => undefined, pending: store };
    return { fw, store, d };
  };
  const FUND = `${'02'.padStart(64, '0')}_0`;
  const OLD = 20 * 60 * 1000;

  test('the key nonce is written down before any BSV moves, the funding after', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    const store = memStore();
    const seen: number[] = [];
    const w = { ...fw.w, fund: async (p: never, s: number) => (seen.push(store.rows.size), fw.w.fund(p, s)) };
    const d: Deps = { fetch: mp.fetch, wallet: w, sleep: async () => undefined, pending: store };
    await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    expect(seen).toEqual([1]);
    const r = store.list()[0];
    expect(r.funding?.txid).toBe('02'.padStart(64, '0'));
    expect(r.prefix).not.toBe('');
  });

  test('unsure submit, then the sheet closes: the funding goes back and the record clears', async () => {
    const { fw, store, d } = setup(new Set(), [{ status: 502, body: {} }]);
    const net = newNet();
    let t = Date.now();
    const timed: Deps = { ...d, fetch: onNet(d.fetch, net), now: () => t };
    const p = await prepareBuy(timed, await loadMarket(timed, TOKEN), BigInt(1_000_000), 300);
    expect((await executeTrade(timed, p)).kind).toBe('unsure');
    expect(store.list()[0].state).toBe('unsure');
    killPool(net, p); // someone else's confirmed trade took the pool coin our signature needs
    t = p.quoteExpiresAt + UNSURE_MARGIN_MS + 1; // and the quote is well past use
    expect(await closeUnsure(timed, p)).toBe(true);
    expect(fw.log.returned).toBe(1);
    expect(store.list()).toEqual([]);
  });

  test('unsure submit, closed, but the coin was spent: nothing is returned (the buy happened)', async () => {
    const { fw, store, d } = setup(new Set([FUND]), [{ status: 502, body: {} }]);
    let t = Date.now();
    const timed: Deps = { ...d, now: () => t };
    const p = await prepareBuy(timed, await loadMarket(timed, TOKEN), BigInt(1_000_000), 300);
    await executeTrade(timed, p);
    t = p.expiresAt + UNSURE_MARGIN_MS + 1;
    expect(await closeUnsure(timed, p)).toBe(false);
    expect(fw.log.returned).toBe(0);
    expect(store.list().length).toBe(1);
  });

  test('a restart with a pending record puts the unspent funding back', async () => {
    const { fw, store, d } = setup();
    await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300); // page then dies on the sheet
    const r = store.list()[0];
    store.put({ ...r, createdAt: r.createdAt - OLD });
    const res = await sweepFundings(d);
    expect(res).toEqual({ returned: 1, spent: 0, kept: 0 });
    expect(fw.log.returned).toBe(1);
    expect(store.list()).toEqual([]);
  });

  test('a restart never sweeps a confirmed buy', async () => {
    const { fw, store, d } = setup(new Set([FUND]));
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    expect((await executeTrade(d, p)).kind).toBe('sent');
    const r = store.list()[0];
    expect(r.state).toBe('sent');
    store.put({ ...r, createdAt: r.createdAt - OLD });
    expect(await sweepFundings(d)).toEqual({ returned: 0, spent: 1, kept: 0 });
    expect(fw.log.returned).toBe(0);
  });

  test('a sent buy whose coin still shows unspent is kept, not swept', async () => {
    const { fw, store, d } = setup();
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    await executeTrade(d, p);
    store.put({ ...store.list()[0], createdAt: 0 });
    expect(await sweepFundings(d)).toEqual({ returned: 0, spent: 0, kept: 1 });
    expect(fw.log.returned).toBe(0);
  });

  test("if the chain can't be read, nothing is swept; a young record is left alone", async () => {
    const { fw, store, d } = setup();
    await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    expect(await sweepFundings(d)).toEqual({ returned: 0, spent: 0, kept: 1 }); // young
    const r = store.list()[0];
    store.put({ ...r, createdAt: 0 });
    const broken: Deps = { ...d, fetch: (async () => new Response('', { status: 429 })) as Deps['fetch'] };
    expect(await sweepFundings(broken)).toEqual({ returned: 0, spent: 0, kept: 1 });
    expect(fw.log.returned).toBe(0);
  });

  test('a failed give-back keeps the record so the next start retries', async () => {
    const { fw, store, d } = setup();
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    const flaky: Deps = {
      ...d,
      wallet: {
        ...fw.w,
        returnFunding: async () => {
          throw new Error('offline');
        },
      },
    };
    await expect(cancelPrepared(flaky, p)).rejects.toThrow();
    expect(store.list().length).toBe(1);
  });
});

// Review fixes (task 58 review, 19 Nov 2026). Each test here fails on the branch before the fix it names.
describe('funding recovery: review fixes', () => {
  const memStore = (failOn?: (n: number) => boolean): PendingStore & { rows: Map<string, PendingRecord> } => {
    const rows = new Map<string, PendingRecord>();
    let n = 0;
    return {
      rows,
      list: () => [...rows.values()],
      put: (r) => {
        if (failOn?.(++n)) throw new Error('QuotaExceededError');
        rows.set(r.id, r);
      },
      remove: (id) => void rows.delete(id),
    };
  };
  /** localStorage stand-in; `full` makes every write throw like a full quota / Safari private mode. */
  const memStorage = () => {
    const m = new Map<string, string>();
    const s = {
      full: false,
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (s.full) throw new Error('QuotaExceededError');
        m.set(k, v);
      },
    };
    return s;
  };
  /** WhatsOnChain that has not seen any spend yet (404 for every coin). */
  const chain404 = (inner: Deps['fetch']): Deps['fetch'] =>
    (async (url: string, init?: RequestInit) =>
      /\/spent$/.test(url) ? new Response('', { status: 404 }) : inner(url, init)) as Deps['fetch'];

  test('fix 1: localPendingStore never throws on a failed write; it says false', () => {
    const st = memStorage();
    const store = localPendingStore('acct', st);
    st.full = true;
    const r = { id: 'a.b', prefix: 'a', suffix: 'b', sats: 1, state: 'pending' as const, createdAt: 0 };
    expect(store.put(r)).toBe(false);
    expect(store.remove('a.b')).toBe(false);
  });

  test('fix 1: storage full before funding: the buy is refused and no BSV moves', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    const st = memStorage();
    st.full = true;
    const d: Deps = {
      fetch: mp.fetch,
      wallet: fw.w,
      sleep: async () => undefined,
      pending: localPendingStore('A', st),
    };
    await expect(prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300)).rejects.toThrow(
      /Nothing was spent/,
    );
    expect(fw.log.funded).toBe(0);
  });

  test('fix 1: the write after fund() throws: the funding goes straight back', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    const store = memStore((n) => n === 2); // the nonce write works, the funding write throws
    const d: Deps = { fetch: mp.fetch, wallet: fw.w, sleep: async () => undefined, pending: store };
    await expect(prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300)).rejects.toThrow(/put back/);
    expect(fw.log.funded).toBe(1);
    expect(fw.log.returned).toBe(1);
    expect(fw.log.signed).toBe(0);
    expect(store.list()).toEqual([]);
  });

  test('fix 1: storage throws after a successful submit: still reported as sent, not as a failure', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    let fail = false;
    const store = memStore((n) => fail && n >= 4); // nonce, funding, signed are written; 'sent' throws
    const d: Deps = { fetch: mp.fetch, wallet: fw.w, sleep: async () => undefined, pending: store };
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    fail = true;
    expect(await executeTrade(d, p)).toEqual({ kind: 'sent', txid: 'ab'.repeat(32) });
    expect(fw.log.signed).toBe(1);
    expect(fw.log.returned).toBe(0);
    expect(store.list().map((r) => r.state)).toEqual(['signed']); // never swept while the signature may be live
  });

  test('fix 1: storage throws after an unsure submit: still unsure, record left for the sweep', async () => {
    const mp = fakeMemepool({ build: buildBuy(), submit: [{ status: 502, body: {} }] });
    const fw = fakeWallet('buy');
    let fail = false;
    const store = memStore((n) => fail && n >= 4);
    const d: Deps = { fetch: mp.fetch, wallet: fw.w, sleep: async () => undefined, pending: store };
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    fail = true;
    expect((await executeTrade(d, p)).kind).toBe('unsure');
    expect(store.list().map((r) => r.state)).toEqual(['signed']);
  });

  test('fix 2: quote expired at Allow: refused before signing and the funding goes back at once', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    const store = memStore();
    let t = Date.now();
    const d: Deps = { fetch: mp.fetch, wallet: fw.w, sleep: async () => undefined, pending: store, now: () => t };
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    t += 10 * 60_000;
    await expect(executeTrade(d, p)).rejects.toThrow(/expired/);
    expect(fw.log.signed).toBe(0);
    expect(fw.log.returned).toBe(1);
    expect(store.list()).toEqual([]);
  });

  test('fix 2: the wallet fails to sign: nothing submitted, the funding goes back', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    const store = memStore();
    const w: TradeWallet = {
      ...fw.w,
      sign: async () => {
        throw new Error('locked');
      },
    };
    const d: Deps = { fetch: mp.fetch, wallet: w, sleep: async () => undefined, pending: store };
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    await expect(executeTrade(d, p)).rejects.toThrow(/locked/);
    expect(mp.calls).not.toContain('/trade/submit');
    expect(fw.log.returned).toBe(1);
  });

  test('fix 3: closed right after an unsure submit while the chain lags (404): nothing goes back yet', async () => {
    const mp = fakeMemepool({ build: buildBuy(), submit: [{ status: 502, body: {} }] });
    const fw = fakeWallet('buy');
    const store = memStore();
    let t = Date.now();
    const net = newNet();
    const d: Deps = {
      fetch: onNet(mp.fetch, net),
      wallet: fw.w,
      sleep: async () => undefined,
      pending: store,
      now: () => t,
    };
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    expect((await executeTrade(d, p)).kind).toBe('unsure');
    t += 5_000;
    expect(await closeUnsure(d, p)).toBe(false); // Memepool may still hold a valid signed spend
    t = p.expiresAt + UNSURE_MARGIN_MS; // still inside the margin
    expect(await closeUnsure(d, p)).toBe(false);
    expect(fw.log.returned).toBe(0);
    expect(store.list().map((r) => r.state)).toEqual(['unsure']); // left for the sweep
    t = p.expiresAt + UNSURE_MARGIN_MS + 1;
    expect(await closeUnsure(d, p)).toBe(false); // past the time, but the pool coin is unspent: still maybe live
    killPool(net, p);
    expect(await closeUnsure(d, p)).toBe(true);
    expect(fw.log.returned).toBe(1);
  });

  test('fix 4: records are kept per account', async () => {
    const st = memStorage();
    const r = { id: 'a.b', prefix: 'a', suffix: 'b', sats: 1, state: 'pending' as const, createdAt: 0 };
    expect(localPendingStore('A', st).put(r)).toBe(true);
    expect(localPendingStore('A', st).list()).toEqual([r]);
    expect(localPendingStore('B', st).list()).toEqual([]);
    expect(legacyPendingStore(st).list()).toEqual([]);
  });

  test('fix 4: a legacy shared record is only swept by the account whose key the coin is locked to', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const st = memStorage();
    const a = fakeWallet('buy', 'A');
    const legacy = legacyPendingStore(st);
    const dA: Deps = { fetch: chain404(mp.fetch), wallet: a.w, sleep: async () => undefined, pending: legacy };
    await prepareBuy(dA, await loadMarket(dA, TOKEN), BigInt(1_000_000), 300); // account A's page dies on the sheet
    const r = legacy.list()[0];
    legacy.put({ ...r, createdAt: 0 });
    // Account B opens Memepool: the record is not B's, so B never internalizes A's coin.
    const b = fakeWallet('buy', 'B');
    expect(await sweepFundings({ ...dA, wallet: b.w })).toEqual({ returned: 0, spent: 0, kept: 1 });
    expect(b.log.returned).toBe(0);
    expect(legacy.list().length).toBe(1);
    // Account A can prove it (its nonce re-derives the key the coin is locked to): it goes back to A.
    expect(await sweepFundings(dA)).toEqual({ returned: 1, spent: 0, kept: 0 });
    expect(a.log.returned).toBe(1);
    expect(legacy.list()).toEqual([]);
  });
});

// Re-review fixes (task 58 re-review of d4061a24, 19 Nov 2026). Each test fails against d4061a24's source.
describe('funding recovery: re-review fixes', () => {
  const memStore = (failOn?: (n: number) => boolean): PendingStore & { rows: Map<string, PendingRecord> } => {
    const rows = new Map<string, PendingRecord>();
    let n = 0;
    return {
      rows,
      list: () => [...rows.values()],
      put: (r) => {
        if (failOn?.(++n)) throw new Error('QuotaExceededError');
        rows.set(r.id, structuredClone(r));
      },
      remove: (id) => void rows.delete(id),
    };
  };
  const OLD = 20 * 60 * 1000;
  const age = (store: PendingStore, by = OLD) =>
    store.list().forEach((r) => store.put({ ...r, createdAt: r.createdAt - by }));
  const rig = (opts: { expiresIn?: number; submit?: { status: number; body: unknown }[] } = {}) => {
    const mp = fakeMemepool({ build: buildBuy(), ...opts });
    const fw = fakeWallet('buy');
    const store = memStore();
    const net = newNet();
    let t = Date.now();
    const clock = { set: (v: number) => (t = v), get: () => t };
    const d: Deps = {
      fetch: onNet(mp.fetch, net),
      wallet: fw.w,
      sleep: async () => undefined,
      pending: store,
      now: () => t,
    };
    return { mp, fw, store, net, clock, d };
  };

  test('1: the funding record is slim (no BEEF), so a big funding transaction still fits the storage quota', async () => {
    const mp = fakeMemepool({ build: buildBuy() });
    const fw = fakeWallet('buy');
    const m = new Map<string, string>();
    const storage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > 4_000) throw new Error('QuotaExceededError');
        m.set(k, v);
      },
    };
    const w: TradeWallet = {
      ...fw.w,
      fund: async (p, sats) => ({ ...(await fw.w.fund(p, sats)), beef: new Array(20_000).fill(7) }),
    };
    const d: Deps = {
      fetch: mp.fetch,
      wallet: w,
      sleep: async () => undefined,
      pending: localPendingStore('A', storage),
    };
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    expect(p.funding?.beef.length).toBe(20_000); // kept in memory for this session
    const rec = d.pending!.list()[0];
    expect(rec.funding?.txid).toBe('02'.padStart(64, '0'));
    expect('beef' in (rec.funding ?? {})).toBe(false);
    expect(fw.log.returned).toBe(0);
  });

  test('1: funding note AND give-back both fail: never told "put back"; the sweep recovers it by address', async () => {
    const { fw, net, clock, d } = rig();
    const store = memStore((n) => n === 2); // the nonce is written; the funding record throws
    const failing: TradeWallet = {
      ...fw.w,
      returnFunding: async () => {
        throw new Error('offline');
      },
    };
    const dd: Deps = { ...d, wallet: failing, pending: store };
    const err = await prepareBuy(dd, await loadMarket(dd, TOKEN), BigInt(1_000_000), 300).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toMatch(/put back/);
    expect(String((err as Error).message)).toMatch(/by itself/);
    expect(fw.log.funded).toBe(1);
    const rec = store.list()[0];
    expect(rec.funding).toBeUndefined(); // only the nonce is known
    const key = await fw.w.newPayKey({ prefix: rec.prefix, suffix: rec.suffix });
    net.utxos.set(key.address, [{ tx_hash: '02'.padStart(64, '0'), tx_pos: 0, value: rec.sats + 50_000 }]);
    age(store);
    clock.set(Date.now());
    expect(await sweepFundings({ ...d, pending: store })).toEqual({ returned: 1, spent: 0, kept: 0 });
    expect(fw.log.back[0].coin).toMatchObject({ txid: '02'.padStart(64, '0'), vout: 0, script: pay(key.address) });
    expect(fw.log.back[0].beef).toEqual([]); // fetched again by the wallet (memepoolWallet.returnFunding)
    expect(store.list()).toEqual([]);
  });

  test('1: memepoolWallet fetches the BEEF again when a swept funding has none', async () => {
    const internalized: unknown[] = [];
    const wallet = {
      getPublicKey: async () => ({ publicKey: PrivateKey.fromRandom().toPublicKey().toString() }),
      internalizeAction: async (a: { tx: number[] }) => {
        internalized.push(a.tx);
        return { accepted: true };
      },
    } as unknown as WalletInterface;
    const fetched: string[] = [];
    const services = {
      getBeefForTxid: async (txid: string) => {
        fetched.push(txid);
        return { toBinaryAtomic: () => [1, 2, 3] };
      },
    };
    const w = memepoolWallet(wallet, services);
    const pay = {
      address: '',
      key: { protocolID: [2, 'x'] as [2, string], keyID: 'a b' },
      derivationPrefix: 'a',
      derivationSuffix: 'b',
    };
    await w.returnFunding({
      coin: { txid: '02'.padStart(64, '0'), vout: 0, satoshis: 5, script: '', key: pay.key },
      beef: [],
      pay,
    });
    expect(fetched).toEqual(['02'.padStart(64, '0')]);
    expect(internalized).toEqual([[1, 2, 3]]);
  });

  test("2: Memepool's quote outlives ours: no give-back before ITS expiry, nor while the pool coin is unspent", async () => {
    const { fw, store, net, clock, d } = rig({ expiresIn: 10 * 60_000, submit: [{ status: 502, body: {} }] });
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    expect((await executeTrade(d, p)).kind).toBe('unsure');
    clock.set(p.expiresAt + UNSURE_MARGIN_MS + 1); // past OUR (60 s) quote, but Memepool's still runs
    expect(await closeUnsure(d, p)).toBe(false);
    killPool(net, p);
    expect(await closeUnsure(d, p)).toBe(false); // pool dead, but Memepool's own expiry + margin not yet passed
    expect(fw.log.returned).toBe(0);
    expect(store.list().length).toBe(1);
    clock.set(Date.now() + 10 * 60_000 + UNSURE_MARGIN_MS + 5_000);
    expect(await closeUnsure(d, p)).toBe(true);
    expect(fw.log.returned).toBe(1);
  });

  test('2: a pool coin spent only by an unconfirmed transaction does not count; nor does ours', async () => {
    const { fw, net, clock, d } = rig({ submit: [{ status: 502, body: {} }] });
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    await executeTrade(d, p);
    clock.set(Date.now() + 60 * 60_000);
    killPool(net, p, false); // in the mempool only
    expect(await closeUnsure(d, p)).toBe(false);
    // Our own trade spent it (it also spends our coin): the buy happened, nothing goes back.
    const ours = 'ab'.repeat(32);
    killPool(net, p, true, ours);
    net.txs.get(ours)!.inputs.push({ txid: p.funding!.coin.txid, vout: p.funding!.coin.vout });
    net.spent.set(`${p.funding!.coin.txid}_${p.funding!.coin.vout}`, ours);
    expect(await closeUnsure(d, p)).toBe(false);
    expect(fw.log.returned).toBe(0);
  });

  test("3: a 'sent' record whose coin is unspent while the pool coin went to another confirmed trade is swept back", async () => {
    const { fw, store, net, clock, d } = rig();
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    expect((await executeTrade(d, p)).kind).toBe('sent');
    expect(store.list()[0].state).toBe('sent');
    clock.set(Date.now() + 60 * 60_000);
    expect(await sweepFundings(d)).toEqual({ returned: 0, spent: 0, kept: 1 }); // pool coin still unspent
    killPool(net, p);
    expect(await sweepFundings(d)).toEqual({ returned: 1, spent: 0, kept: 0 });
    expect(fw.log.returned).toBe(1);
  });

  test('4: two sweeps at once share one run (one give-back)', async () => {
    const { fw, store, clock, d } = rig();
    await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    clock.set(Date.now() + 60 * 60_000);
    const [a, b] = await Promise.all([sweepFundings(d), sweepFundings(d)]);
    expect(a).toEqual({ returned: 1, spent: 0, kept: 0 });
    expect(b).toEqual(a);
    expect(fw.log.returned).toBe(1);
    expect(store.list()).toEqual([]);
  });

  test('5: 409 then the reload fails: the signature is recorded (unsure) and the sweep waits for it', async () => {
    const { mp, fw, store, clock, d } = rig({ submit: [{ status: 409, body: { code: 'stale' } }] });
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    let down = false;
    const dd: Deps = {
      ...d,
      fetch: (async (u: string, i?: RequestInit) => {
        if (down && /txblaster/.test(u)) throw new Error('offline');
        const r = await d.fetch(u, i);
        if (/trade\/submit/.test(u)) down = true;
        return r;
      }) as Deps['fetch'],
    };
    await expect(executeTrade(dd, p)).rejects.toThrow();
    expect(mp.calls.filter((c) => c === '/trade/submit').length).toBe(1);
    const rec = store.list()[0];
    expect(rec.state).toBe('unsure');
    expect(rec.signed?.length).toBe(1);
    clock.set(Date.now() + 60 * 60_000);
    expect(await sweepFundings(d)).toEqual({ returned: 0, spent: 0, kept: 1 }); // pool coin unspent: maybe live
    expect(fw.log.returned).toBe(0);
  });

  test('5: Cancel on the fresh sheet after a 409 follows the close rule', async () => {
    const { fw, store, net, clock, d } = rig({ submit: [{ status: 409, body: { code: 'stale' } }] });
    const p = await prepareBuy(d, await loadMarket(d, TOKEN), BigInt(1_000_000), 300);
    const r = await executeTrade(d, p);
    expect(r.kind).toBe('new-sheet');
    if (r.kind !== 'new-sheet') return;
    await cancelPrepared(d, r.prepared);
    expect(fw.log.returned).toBe(0);
    expect(store.list()[0].signed?.length).toBe(1);
    killPool(net, p); // the signed (first) template's pool coin went to someone else's confirmed trade
    clock.set(Date.now() + 60 * 60_000);
    await cancelPrepared(d, r.prepared);
    expect(fw.log.returned).toBe(1);
  });

  test('6a: fund() broadcast then threw: the nonce-only record is recovered from its address', async () => {
    const { fw, store, net, clock, d } = rig();
    const w: TradeWallet = {
      ...fw.w,
      fund: async (p, sats) => {
        await fw.w.fund(p, sats);
        throw new Error('timed out after broadcasting');
      },
    };
    const dd: Deps = { ...d, wallet: w };
    await expect(prepareBuy(dd, await loadMarket(dd, TOKEN), BigInt(1_000_000), 300)).rejects.toThrow(/timed out/);
    const rec = store.list()[0];
    expect(rec.funding).toBeUndefined();
    const pay = await fw.w.newPayKey({ prefix: rec.prefix, suffix: rec.suffix });
    net.utxos.set(pay.address, [
      { tx_hash: '02'.padStart(64, '0'), tx_pos: 0, value: rec.sats },
      { tx_hash: '05'.padStart(64, '0'), tx_pos: 1, value: 9, isSpentInMempoolTx: true }, // already going: left out
    ]);
    expect(await sweepFundings(d)).toEqual({ returned: 0, spent: 0, kept: 1 }); // young: left alone
    clock.set(Date.now() + 60 * 60_000);
    expect(await sweepFundings(d)).toEqual({ returned: 1, spent: 0, kept: 0 });
    expect(fw.log.back.map((f) => [f.coin.txid, f.coin.vout, f.coin.satoshis])).toEqual([
      ['02'.padStart(64, '0'), 0, rec.sats],
    ]);
    expect(store.list()).toEqual([]);
  });

  test('6a: a nonce whose address stays empty is kept a day, then dropped', async () => {
    const { fw, store, clock, d } = rig();
    const w: TradeWallet = {
      ...fw.w,
      fund: async () => {
        throw new Error('wallet refused');
      },
    };
    const dd: Deps = { ...d, wallet: w };
    await expect(prepareBuy(dd, await loadMarket(dd, TOKEN), BigInt(1_000_000), 300)).rejects.toThrow();
    clock.set(Date.now() + 60 * 60_000);
    expect(await sweepFundings(d)).toEqual({ returned: 0, spent: 0, kept: 1 });
    clock.set(Date.now() + 25 * 60 * 60_000);
    expect(await sweepFundings(d)).toEqual({ returned: 0, spent: 1, kept: 0 });
    expect(store.list()).toEqual([]);
  });
});
