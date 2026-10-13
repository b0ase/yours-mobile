import { describe, expect, test } from 'bun:test';
import type { Transaction } from '@bsv/sdk';
import type { Fetch } from './names';
import { applySweep, runBatch, TAKEN_OTHER, YOURS_ELSEWHERE, type BatchState } from './opnsBatch';
import { isTaken, NamesServerError, type MintStepResult } from './opnsMint';
import { mineName, TreeHoldError, type MineChar } from './opnsRegister';
import { OpnsTree } from './opnsTree';
import { confirmingNote, DEAD_GRACE_MS, releasedNote, sweepDeadMints, txNetStatus, WOC_TX } from './opnsTxStatus';

/**
 * The owner's 13 Oct 2026 jam: the browser minted danielwagner in several transactions, most of which the network
 * never received (WhatsOnChain 404), while the local mine-tree cache still treated them as ours. Every name then
 * ended in "still catching up" for hours.
 */
const T0 = `0815e7c1${'0'.repeat(56)}`; // our mint of "dan" from the indexer's node "da" (dead: 404)
const T1 = `229814b3${'1'.repeat(56)}`; // our mint of "dani" from T0 (dead too: it spends T0's output)
const T2 = `14467f50${'2'.repeat(56)}`; // our mint of "dav" (alive: in the mempool)
const DA_NODE = `65d93b0f${'0'.repeat(50)}d2902a.1`;

const memKV = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const step = (txid: string, newDomain: string): MintStepResult => ({ txid, newDomain, childOutpoint: `${txid}.1` });

let clock = 1_000_000;
const now = () => clock;

/** Tree after the three mints above, all broadcast 5 minutes ago. */
const jammedTree = (kv = memKV()) => {
  clock = 1_000_000;
  const t = new OpnsTree(kv, 'k', now);
  t.record(DA_NODE, 'da', step(T0, 'dan'));
  t.record(`${T0}.1`, 'dan', step(T1, 'dani'));
  t.record(DA_NODE, 'da', step(T2, 'dav'));
  clock += 5 * 60_000;
  return { t, kv };
};

/** WhatsOnChain + the overlay. `woc` maps txid → status code (or 'mempool' / 'mined'); the overlay's node is "da". */
const net =
  (woc: Record<string, number | 'mempool' | 'mined'>, overlay: Record<string, number> = {}): Fetch =>
  async (url) => {
    if (url.startsWith(WOC_TX)) {
      const v = woc[url.slice(WOC_TX.length + 1)] ?? 404;
      if (typeof v === 'number') return new Response('{}', { status: v });
      return new Response(JSON.stringify(v === 'mined' ? { blockheight: 970_000 } : { blockheight: 0 }), {
        status: 200,
      });
    }
    const name = decodeURIComponent(url.split('/').pop() ?? '');
    if (overlay[name]) return new Response('Bad Gateway', { status: overlay[name] });
    if (url.includes('/mine/'))
      return new Response(JSON.stringify({ outpoint: DA_NODE, domain: 'da' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };

describe('WhatsOnChain transaction status', () => {
  test('mined / mempool / missing, and 429 or 5xx or offline is unknown, never missing', async () => {
    const f = net({ [T0]: 404, [T1]: 429, [T2]: 'mempool', ['a'.repeat(64)]: 'mined', ['b'.repeat(64)]: 502 });
    expect(await txNetStatus(f, T0)).toBe('missing');
    expect(await txNetStatus(f, T1)).toBe('unknown');
    expect(await txNetStatus(f, T2)).toBe('mempool');
    expect(await txNetStatus(f, 'a'.repeat(64))).toBe('mined');
    expect(await txNetStatus(f, 'b'.repeat(64))).toBe('unknown');
    expect(
      await txNetStatus(async () => {
        throw new Error('offline');
      }, T0),
    ).toBe('unknown');
  });
});

describe('dead-mint eviction', () => {
  test('a 404 mint older than the grace period is evicted with the mints chained from it; the parent node is free again', async () => {
    const { t, kv } = jammedTree();
    expect(t.isOurs('dan')).toBe(true);
    expect(t.isSpent(DA_NODE)).toBe(true);
    const r = await sweepDeadMints(t, net({ [T0]: 404, [T1]: 404, [T2]: 'mempool' }));
    expect(r.dead).toEqual([{ txid: T0, names: ['dan', 'dani'] }]);
    expect(r.seen).toEqual([{ txid: T2, name: 'dav', status: 'mempool' }]);
    expect(t.isOurs('dan')).toBe(false);
    expect(t.isOurs('dani')).toBe(false);
    expect(t.isOurs('dav')).toBe(true);
    // T2 (alive) also spent DA_NODE, so it stays spent; the cache's best node for "danielwagner" is T2's restated "da".
    expect(t.isSpent(DA_NODE)).toBe(true);
    expect(t.best('danielwagner')?.outpoint).toBe(`${T2}.0`);
    // Saved: a reload sees the same state and the surviving mint is never checked again.
    const again = new OpnsTree(kv, 'k', now);
    expect(again.isOurs('dan')).toBe(false);
    expect(again.unverified(0)).toEqual([]);
  });

  test('the only mint from an indexer node: that node is usable again after eviction', async () => {
    clock = 1_000_000;
    const t = new OpnsTree(memKV(), 'k', now);
    t.record(DA_NODE, 'da', step(T0, 'dan'));
    clock += DEAD_GRACE_MS + 1;
    await sweepDeadMints(t, net({ [T0]: 404 }));
    expect(t.isSpent(DA_NODE)).toBe(false);
    expect(t.best('danielwagner')).toBeNull();
  });

  test('a dead child of a live parent: the parent node we minted comes back as the best node', async () => {
    clock = 1_000_000;
    const t = new OpnsTree(memKV(), 'k', now);
    t.record(DA_NODE, 'da', step(T0, 'dan'));
    t.record(`${T0}.1`, 'dan', step(T1, 'dani'));
    clock += DEAD_GRACE_MS + 1;
    const r = await sweepDeadMints(t, net({ [T0]: 'mempool', [T1]: 404 }));
    expect(r.dead).toEqual([{ txid: T1, names: ['dani'] }]);
    expect(t.isOurs('dan')).toBe(true);
    expect(t.best('danielwagner')).toMatchObject({ domain: 'dan', outpoint: `${T0}.1`, txid: T0 });
  });

  test('429 (rate-limited) and a fresh broadcast are left alone; the wallet-side failed set is dead at once', async () => {
    const { t } = jammedTree();
    const r1 = await sweepDeadMints(t, net({ [T0]: 429, [T1]: 429, [T2]: 429 }));
    expect(r1.dead).toEqual([]);
    expect(r1.unknown.sort()).toEqual([T0, T1, T2].sort());
    expect(t.isOurs('dan')).toBe(true);

    const T3 = 'f'.repeat(64);
    t.record(`${T2}.1`, 'dav', step(T3, 'davi')); // just now
    const r2 = await sweepDeadMints(t, net({ [T0]: 'mempool', [T1]: 'mempool', [T2]: 'mempool', [T3]: 404 }));
    expect(r2.dead).toEqual([]);
    expect(t.isOurs('davi')).toBe(true);

    const r3 = await sweepDeadMints(t, net({}), { offChain: new Set([T3]) });
    expect(r3.dead).toEqual([{ txid: T3, names: ['davi'] }]);
    expect(t.isOurs('davi')).toBe(false);
  });

  test('caches written before mint records existed still load and simply have nothing to check', () => {
    const kv = memKV();
    kv.setItem('k', JSON.stringify({ v: 1, nodes: {}, spent: {}, names: { old: Date.now() } }));
    const t = new OpnsTree(kv, 'k');
    expect(t.isOurs('old')).toBe(true);
    expect(t.unverified(0)).toEqual([]);
    expect(t.forget('nope')).toEqual([]);
  });
});

// ---- the three states the page shows ------------------------------------------------------------------------

const fakeNode = (outpoint: string, domain: string, claimed = [0]) => ({
  outpoint,
  beef: [],
  tx: {} as Transaction,
  vout: 1,
  state: { claimed, domain, pow: new Array(32).fill(1) },
});
const instant: MineChar = async () => ({ nonce: new Array(32).fill(0), hash: new Array(32).fill(0) });

describe('mineName hold states', () => {
  test('confirming: the node we need was spent by our own unconfirmed mint → TreeHoldError naming that txid', async () => {
    clock = 1_000_000;
    const t = new OpnsTree(memKV(), 'k', now);
    t.record(DA_NODE, 'da', step(T0, 'dan'));
    t.markSpent(`${T0}.1`); // its child is gone too (e.g. a review failure), so there is nothing to mine from
    t.markSpent(`${T0}.0`);
    const err = await mineName(
      { ctx: {} as never, fetch: net({}), tree: t, mineChar: instant, load: async (_c, op) => fakeNode(op, 'da') },
      'danielwagner',
      new AbortController().signal,
      () => undefined,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TreeHoldError);
    expect((err as TreeHoldError).txid).toBe(T0);
    expect((err as Error).message).toBe(confirmingNote('danielwagner', T0));
    expect((err as Error).message).toContain('0815e7c1…0000');
    expect((err as Error).message).toContain('not indexed yet');
  });

  test('someone else spent the node: the hold names no txid and blames the indexer lag, not our mints', async () => {
    const t = new OpnsTree(memKV(), 'k', now);
    let mints = 0;
    const err = await mineName(
      {
        ctx: {} as never,
        fetch: net({}),
        tree: t,
        mineChar: instant,
        load: async (_c, op) => fakeNode(op, 'da'),
        mint: async () => {
          mints++;
          throw Object.assign(new Error('require review'), { name: 'WERR_REVIEW_ACTIONS' });
        },
      },
      'danielwagner',
      new AbortController().signal,
      () => undefined,
    ).catch((e: unknown) => e);
    expect(mints).toBe(1);
    expect(err).toBeInstanceOf(TreeHoldError);
    expect((err as TreeHoldError).txid).toBeUndefined();
    expect((err as Error).message).toContain('still catching up with the network');
  });

  test('names server down: a 502 from the overlay is a NamesServerError naming the host, never "not taken"', async () => {
    const f = net({}, { danielwagner: 502 });
    const err = await isTaken(f, 'danielwagner').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NamesServerError);
    expect((err as Error).message).toBe("The names server isn't answering (api.1sat.app 502). Resume later.");
    const offline: Fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(isTaken(offline, 'x')).rejects.toThrow("isn't answering (api.1sat.app)");
    await expect(
      mineName({ ctx: {} as never, fetch: f }, 'danielwagner', new AbortController().signal, () => undefined),
    ).rejects.toBeInstanceOf(NamesServerError);
  });
});

describe('runBatch with the three states', () => {
  const start = (...names: string[]): BatchState => ({
    v: 1,
    approvedSats: 0,
    createdAt: 0,
    items: names.map((name) => ({ name, status: 'pending', txids: [] })),
  });
  const silent = { save: () => undefined, onUpdate: () => undefined, isMine: () => false };

  test('never reached the network: the sweep releases the name and the run mines it again', async () => {
    const { t } = jammedTree();
    const f = net({ [T0]: 404, [T1]: 404, [T2]: 'mempool' });
    const mined: string[] = [];
    const r = await runBatch(
      {
        ...silent,
        fetch: f,
        tree: t,
        sweep: () => sweepDeadMints(t, f),
        mine: async (name) => {
          mined.push(name);
          t.record(`${T2}.1`, 'dav', step('e'.repeat(64), name)); // pretend it extends the live chain
          return [{ txid: 'e'.repeat(64) }];
        },
        perCharSats: 100,
      },
      {
        ...start('dan', 'dav'),
        items: [{ name: 'dan', status: 'done', txids: [T0] }, start('dav').items[0]],
        spentSats: 200,
      },
      new AbortController().signal,
    );
    expect(mined).toEqual(['dan']);
    expect(r.stopped).toBe('finished');
    expect(r.state.items[0]).toMatchObject({ name: 'dan', status: 'done', txids: ['e'.repeat(64)] });
    expect(r.state.items[1]).toMatchObject({ name: 'dav', status: 'mine', note: 'Yours, confirming' });
  });

  test('applySweep: released names go back to pending with the honest note, dead txids dropped, fee credited', () => {
    const s: BatchState = {
      ...start('dan', 'dani', 'dav', 'zed'),
      items: [
        { name: 'dan', status: 'done', txids: [T0], listed: true },
        { name: 'dani', status: 'done', txids: [T1] },
        { name: 'dav', status: 'done', txids: [T2] },
        { name: 'zed', status: 'skipped', txids: [], note: TAKEN_OTHER },
      ],
      spentSats: 300,
    };
    const n = applySweep(s, { dead: [{ txid: T0, names: ['dan', 'dani', 'zed'] }], seen: [], unknown: [] }, 100);
    expect(n.items[0]).toEqual({
      name: 'dan',
      status: 'pending',
      txids: [],
      note: releasedNote('dan'),
      listed: undefined,
    });
    expect(n.items[0].note).toBe(
      'Your last mint of dan never reached the network. It has been released; Resume mines it again.',
    );
    expect(n.items[1].status).toBe('pending');
    expect(n.items[1].txids).toEqual([T1]); // T1 wasn't the sweep's dead txid, so its link stays until its own sweep
    expect(n.items[2].status).toBe('done');
    expect(n.items[3].status).toBe('skipped');
    expect(n.spentSats).toBe(200);
    expect(applySweep(s, { dead: [], seen: [], unknown: [] })).toBe(s);
  });

  test('confirming: a TreeHoldError leaves the name pending with its note and the run moves on', async () => {
    const r = await runBatch(
      {
        ...silent,
        fetch: net({}),
        mine: async (name) => {
          if (name === 'dan') throw new TreeHoldError('dan', T0);
          return [{ txid: 'e'.repeat(64) }];
        },
      },
      start('dan', 'dav'),
      new AbortController().signal,
    );
    expect(r.stopped).toBe('finished');
    expect(r.state.items[0]).toMatchObject({ status: 'pending', note: confirmingNote('dan', T0) });
    expect(r.state.items[1]).toMatchObject({ status: 'done' });
  });

  test('names server down: the run stops at that name and reports the host, not the tree', async () => {
    let mined = 0;
    const r = await runBatch(
      { ...silent, fetch: net({}, { dan: 502 }), mine: async () => (mined++, []) },
      start('dan', 'dav'),
      new AbortController().signal,
    );
    expect(mined).toBe(0);
    expect(r.stopped).toBe('error');
    expect(r.namesServer).toBe('api.1sat.app');
    expect(r.error).toBe("The names server isn't answering (api.1sat.app 502). Resume later.");
    expect(r.state.items[0]).toMatchObject({ status: 'pending', note: r.error });
    expect(r.state.items[1].status).toBe('pending');
  });

  test('mined elsewhere since: taken by one of our other accounts is "yours", by anyone else "taken"; no retry', async () => {
    const takenNow: Fetch = async (url) =>
      url.includes('/origin/')
        ? new Response(JSON.stringify({ outpoint: `${'a'.repeat(64)}.2` }), { status: 200 })
        : new Response('{}', { status: 404 });
    let mined = 0;
    const r = await runBatch(
      {
        ...silent,
        fetch: takenNow,
        mine: async () => (mined++, []),
        takenBy: async (name) => (name === 'danielwagner' ? 'another-account' : 'other'),
      },
      start('danielwagner', 'lukerohenaz'),
      new AbortController().signal,
    );
    expect(mined).toBe(0);
    expect(r.stopped).toBe('finished');
    expect(r.state.items[0]).toMatchObject({ status: 'mine', note: YOURS_ELSEWHERE });
    expect(r.state.items[1]).toMatchObject({ status: 'skipped', note: TAKEN_OTHER });
  });
});
