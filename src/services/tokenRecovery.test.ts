import { describe, expect, test } from 'bun:test';
import { BSV21 } from '@1sat/templates';
import { P2PKH, PrivateKey } from '@bsv/sdk';
import { recoverTokenOutputs, searchWindow, type TokenRecoveryDeps, type TxTokenOutput } from './tokenRecovery';
import { parseTokenOutput } from './tokenRecoveryWallet';

const TOKEN = '8cc12904e6d7491077d6d511d9846ac39e58f058603f6b2cc710e216ab89f012_0';
const DEPLOY = '8cc12904e6d7491077d6d511d9846ac39e58f058603f6b2cc710e216ab89f012';
const SEND = '75f04ce83532e7280b5ba068462a0c3004d3e75260b2957f35b37de2b5f5e9a0';
const CHANGE_H160 = '75b89edd5d11bc99cee268ef1bedc6060535a36a'.slice(0, 40);
const RECIPIENT_H160 = '1e7ab71a069af9edcab65184956aa9b5621d5208';
const BLOCK_TIME = 1791266364;
const PREV_BLOCK_TIME = 1791265306;
const CHANGE_MS = 1791266001234;

/**
 * Mocked indexer for the TERANODE case (7 Oct 2026): the wallet knows only the
 * deploy output; a send it never recorded spent it, leaving 1,000 at a
 * recipient (vout 0) and 20,999,000 change (vout 1) at a timestamp keyID.
 */
const makeDeps = (over: Partial<TokenRecoveryDeps> = {}) => {
  const cache = new Map<string, string>();
  const imported: { txid: string; vout: number; keyID: string }[] = [];
  const dropped: string[] = [];
  const searches: [string, number, number][] = [];
  const spends: Record<string, string | null> = {
    [`${DEPLOY}.0`]: SEND,
    [`${SEND}.0`]: null,
    [`${SEND}.1`]: null,
  };
  const txs: Record<string, TxTokenOutput[]> = {
    [SEND]: [
      { vout: 0, tokenId: TOKEN, amt: '1000', hash160: RECIPIENT_H160 },
      { vout: 1, tokenId: TOKEN, amt: '20999000', hash160: CHANGE_H160 },
    ],
  };
  const deps: TokenRecoveryDeps = {
    knownTokenOutputs: async () => [{ outpoint: `${DEPLOY}.0`, spendable: false }],
    getSpends: async (ops) => new Map(ops.map((o) => [o, spends[o] ?? null])),
    getTxTokenOutputs: async (txid) => txs[txid] ?? [],
    getTxTiming: async () => ({ blockTime: BLOCK_TIME, prevBlockTime: PREV_BLOCK_TIME }),
    overlayStatus: async (_t, ops) => new Map(ops.map((o) => [o, 'valid'])),
    searchKeys: async (prefix, targets, from, to) => {
      searches.push([prefix, from, to]);
      return targets.has(CHANGE_H160) && from <= CHANGE_MS && CHANGE_MS <= to
        ? [{ hash160: CHANGE_H160, keyID: `${prefix}${CHANGE_MS}` }]
        : [];
    },
    importOutput: async ({ txid, vout, keyID }) => {
      imported.push({ txid, vout, keyID });
    },
    dropStale: async (o) => {
      dropped.push(o);
    },
    cacheGet: async (k) => cache.get(k) ?? null,
    cacheSet: async (k, v) => {
      cache.set(k, v);
    },
    now: () => (BLOCK_TIME + 86400) * 1000,
    ...over,
  };
  return { deps, cache, imported, dropped, searches, spends, txs };
};

describe('recoverTokenOutputs', () => {
  test('finds and imports the unrecorded change of a send that spent a known output', async () => {
    const { deps, imported, searches } = makeDeps();
    const r = await recoverTokenOutputs(deps);
    expect(imported).toEqual([{ txid: SEND, vout: 1, keyID: `${TOKEN}-${CHANGE_MS}` }]);
    expect(r.imported).toEqual([{ outpoint: `${SEND}.1`, tokenId: TOKEN, amt: '20999000' }]);
    // Only the change position is searched, never the recipient's output.
    expect(searches.length).toBe(1);
    expect(searches[0][0]).toBe(`${TOKEN}-`);
  });

  test('a second run imports nothing and does not search again', async () => {
    const { deps, imported, searches } = makeDeps();
    await recoverTokenOutputs(deps);
    // The wallet now knows the change.
    deps.knownTokenOutputs = async () => [
      { outpoint: `${DEPLOY}.0`, spendable: false },
      { outpoint: `${SEND}.1`, spendable: true },
    ];
    await recoverTokenOutputs(deps);
    expect(imported.length).toBe(1);
    expect(searches.length).toBe(1);
  });

  test('does not import an output the overlay does not report valid; keeps the key for later', async () => {
    const { deps, imported, cache } = makeDeps({
      overlayStatus: async (_t, ops) => new Map(ops.map((o) => [o, 'spent'])),
    });
    const r = await recoverTokenOutputs(deps);
    expect(imported).toEqual([]);
    expect(r.pending).toEqual([`${SEND}.1`]);
    expect(cache.get(`tokenRecovery:key:${SEND}.1`)).toBe(`${TOKEN}-${CHANGE_MS}`);
  });

  test('drops a token output storage lists spendable that the chain spent', async () => {
    const { deps, dropped } = makeDeps({
      knownTokenOutputs: async () => [{ outpoint: `${DEPLOY}.0`, spendable: true }],
    });
    const r = await recoverTokenOutputs(deps);
    expect(dropped).toEqual([`${DEPLOY}.0`]);
    expect(r.stale).toEqual([`${DEPLOY}.0`]);
    expect(r.imported.length).toBe(1);
  });

  test('a search that misses is cached and skipped next time; Repair (thorough) widens it', async () => {
    const { deps, searches, imported } = makeDeps({
      getTxTiming: async () => ({ blockTime: BLOCK_TIME + 3 * 3600, prevBlockTime: BLOCK_TIME + 3 * 3600 - 600 }),
    });
    await recoverTokenOutputs(deps);
    await recoverTokenOutputs(deps);
    expect(searches.length).toBe(1);
    expect(imported).toEqual([]);
    const { deps: d2, searches: s2 } = makeDeps({
      getTxTiming: async () => ({ blockTime: BLOCK_TIME + 1800, prevBlockTime: BLOCK_TIME + 1200 }),
    });
    const r = await recoverTokenOutputs(d2, { thorough: true });
    expect(s2.length).toBe(2);
    expect(r.imported.length).toBe(1);
  });

  test('follows a chain of unrecorded sends to the latest change', async () => {
    const SEND2 = 'cd'.repeat(32);
    const { deps, spends, txs, imported } = makeDeps();
    spends[`${SEND}.1`] = SEND2;
    spends[`${SEND2}.1`] = null;
    txs[SEND2] = [
      { vout: 0, tokenId: TOKEN, amt: '5', hash160: RECIPIENT_H160 },
      { vout: 1, tokenId: TOKEN, amt: '20998995', hash160: CHANGE_H160 },
    ];
    const r = await recoverTokenOutputs(deps);
    expect(imported.map((i) => `${i.txid}.${i.vout}`)).toEqual([`${SEND2}.1`]);
    expect(r.imported[0].amt).toBe('20998995');
  });

  test('a send the wallet recorded needs no search', async () => {
    const { deps, searches } = makeDeps({
      knownTokenOutputs: async () => [
        { outpoint: `${DEPLOY}.0`, spendable: false },
        { outpoint: `${SEND}.1`, spendable: true },
      ],
    });
    const r = await recoverTokenOutputs(deps);
    expect(searches).toEqual([]);
    expect(r.imported).toEqual([]);
  });
});

describe('searchWindow', () => {
  test('mined: the block interval with margins', () => {
    const [from, to] = searchWindow({ blockTime: BLOCK_TIME, prevBlockTime: PREV_BLOCK_TIME }, 0, 0);
    expect(from).toBe(PREV_BLOCK_TIME * 1000 - 600_000);
    expect(to).toBe(BLOCK_TIME * 1000 + 300_000);
  });
  test('unmined: the last two hours', () => {
    expect(searchWindow({}, 10_000_000, 0)).toEqual([10_000_000 - 7_200_000, 10_000_000]);
  });
});

describe('parseTokenOutput', () => {
  test('reads a sendBsv21 transfer output with its P2PKH owner', () => {
    const addr = PrivateKey.fromRandom().toAddress();
    const lock = new P2PKH().lock(addr);
    const script = BSV21.transfer(TOKEN, 20999000n).lock(lock);
    const parsed = parseTokenOutput(script.toHex(), SEND, 1);
    expect(parsed?.tokenId).toBe(TOKEN);
    expect(parsed?.amt).toBe('20999000');
    expect(parsed?.hash160).toBe(lock.toHex().slice(6, 46));
  });
  test('ignores plain P2PKH', () => {
    const lock = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    expect(parseTokenOutput(lock.toHex(), SEND, 2)).toBeNull();
  });
});
