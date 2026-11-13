/**
 * Two devices, one seed (plan fix 9, 13 Nov 2026): would this month's balance bugs have been caught?
 *
 * The phone (A) and the extension (B) run the real wallet-toolbox on their own stores (fake-indexeddb), meet only in a
 * shared backup, and use the app's own device sync, inbound guard, admission, Store release, unsentExpiry and balance
 * read. The chain and every network source are faked (src/testing/twoDeviceSim/chain.ts) and can answer 404 / 429 /
 * 500 or time out. See src/testing/twoDeviceSim/world.ts for exactly what is real and what is faked.
 *
 * Invariant, after each step and a settle (three rounds of device sync + admission + autoCoinResync + Store open +
 * unsentExpiry on both devices, Date.now moved 25 h after the first round, then a last sync A → B → A): both devices
 * show the same balance, equal to the wallet's unspent BSV on chain to the sat, and hold the same spendable tokens as
 * the chain. A failure prints the first divergence outpoint by outpoint, with the app's last relevant log lines.
 *
 * KNOWN BUGS (reproduced on origin/bwallet = 5.2.54): marked with `bug(<fix branch>, …)`, which runs them as
 * `test.failing` (the suite stays green while the bug is there, and goes red, "expected to fail", once it is fixed;
 * a known-bug case that breaks for any reason other than the invariant also goes red). On a fix branch run them as
 * plain tests: SIM_FIXED=<branch>[,<branch>…] or SIM_FIXED=all. None open right now.
 * FIXED (plain tests now):
 *   - fix/unsent-auto-release: a noSend whose input the other device spent was held for ever by unsentExpiry
 *     ('input-spent-elsewhere'), and its change counted in the balance (+change sats on that device). unsentExpiry now
 *     cancels it once the spend is conclusive and the noSend is unknown to the network (world.ts runs the app's own
 *     wiring, services/unsentExpiryWiring.ts);
 *   - fix/sync-atomic-pull: a push that lands late (row times older than the other device's cursor beyond the
 *     15-minute overlap), then the tx is proven: the incremental pull merged the 'completed' tx with none of its
 *     outputs; only the 6-hourly tail pass / daily deep pull brought the change in (hours later). The app's post-pull
 *     step (pullIntegrity afterPull, run by the harness: world.ts postPullStep) heals it within the half hour.
 * Not reproduced (pass on 5.2.54, kept as regressions): a pull cut between the tx page and the outputs page resumes
 * from its checkpoint; a 1-sat BSV-21 token taken in as a 'bsv21' insertion is admitted on the other device.
 *   bun test src/incident/twoDeviceSim.test.ts
 *   SIM_FIXED=all bun test src/incident/twoDeviceSim.test.ts        (every known-bug case must pass)
 *   SIM_LOG=1 …                                                       (the app's log lines as they happen)
 *   scripts/two-device-sim.sh <git ref>                               (this harness against any branch)
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { teardownSim, World } from '../testing/twoDeviceSim/world';
import { rng } from '../testing/twoDeviceSim/chain';

// The Store client (mobile/themeOrder/api.ts, imported by the Store open) reads its API base once, when it is first
// loaded. bun runs every file in one process: whichever file loads it first fixes it for the rest, so this file sets
// the same value the Store test files set (storeRestart, rv06c-*), never a different one.
(globalThis as { __PAYMAIL_API__?: string }).__PAYMAIL_API__ ??= 'https://pay.store.test';

const T = 120_000;
let current: World | undefined;
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const realLog = console.log;
beforeAll(() => {
  // Any code path that reaches for the global fetch talks to the current fake chain, never the network.
  globalThis.fetch = ((u: string, i?: RequestInit) =>
    current ? current.chain.fetch(u, i) : Promise.resolve(new Response('', { status: 404 }))) as typeof fetch;
  // The app's own console.warn lines go to the world's log (printed with a divergence), not the test output.
  if (!process.env.SIM_LOG) {
    console.warn = (...a: unknown[]) => current?.log(...a);
    console.log = (...a: unknown[]) => (current ? current.log(...a) : realLog(...a));
  }
});
afterAll(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.log = realLog;
  teardownSim();
});
afterEach(async () => {
  await current?.close();
  current = undefined;
});
const world = async (seed = 1) => (current = await World.open({ seed, log: !!process.env.SIM_LOG }));

const FIXED = new Set(
  (process.env.SIM_FIXED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
/**
 * A scenario that reproduces a known bug a fix branch is working on: test.failing until that branch lands. None open
 * right now; kept for the next one.
 */
export const bug = (branch: string, name: string, fn: () => Promise<unknown>) =>
  FIXED.has('all') || FIXED.has(branch)
    ? test(`[${branch}] ${name}`, fn, T)
    : test.failing(
        `[${branch}] ${name}`,
        async () => {
          try {
            await fn();
          } catch (e) {
            // Only the invariant's own divergence counts as "the bug is still there".
            if (e instanceof Error && e.message.startsWith('FIRST DIVERGENCE')) throw e;
            realWarn(`[sim] known-bug case "${name}" broke before reaching the invariant:`, e);
          }
        },
        T,
      );
const sim = (name: string, fn: () => Promise<unknown>) => test(name, fn, T);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Three coins on both devices: received on A, synced through the backup to B. */
async function threeCoins(seed = 1, on: 'A' | 'B' = 'A') {
  const w = await world(seed);
  for (let i = 0; i < 3; i++) await w.receive(on, 100_000);
  await w.settleAndCheck('after the three coins arrive');
  return w;
}

describe('two devices, one seed: named cases', () => {
  sim('receive: a payment landing on one device shows on both, to the sat', async () => {
    const w = await world();
    await w.receive('A', 100_000);
    await w.settleAndCheck();
    await w.receive('B', 55_555);
    await w.settleAndCheck();
  });

  sim('send: a send from either device, with change, is the same balance on both', async () => {
    const w = await threeCoins();
    await w.send('A', 42_000);
    await w.settleAndCheck();
    await w.send('B', 70_001); // from coins B only knows through the backup
    await w.settleAndCheck();
    expect(w.chain.unspent('bsv').size).toBeGreaterThan(0);
  });

  sim(
    'Store payment signed (noSend), never told the Store, never broadcast: released, coins back on both',
    async () => {
      const w = await threeCoins();
      await w.storePay('B', 20_000);
      await w.settleAndCheck();
      expect(w.B.outbox.all()).toEqual([]);
    },
  );

  sim(
    'Store payment from before intentAt existed (the owner’s outbox entries): released once the Store never heard of it',
    async () => {
      const w = await threeCoins();
      await w.storePay('B', 20_000, { intentAt: undefined });
      await w.settleAndCheck();
    },
  );

  sim('a noSend with no outbox entry on this device: unsentExpiry releases it after its 24 h deadline', async () => {
    const w = await threeCoins();
    const p = await w.storePay('B', 20_000, { outbox: false });
    await w.settleAndCheck();
    expect(w.B.expiry.reports.flatMap((r) => r.released)).toContain(p.txid);
  });

  sim('abort: a payment created but never signed, then aborted, leaves both balances whole', async () => {
    const w = await threeCoins();
    await w.createThenAbort('A', 30_000);
    await w.settleAndCheck();
    await w.createThenAbort('B', 30_000);
    await w.settleAndCheck();
  });

  sim('abort: the manual release of an unsent Store payment (abortAction by txid, as the owner ran it)', async () => {
    const w = await threeCoins();
    const p = await w.storePay('B', 20_000, { outbox: false });
    await w.sync('B');
    await w.abortTxid('B', p.txid);
    await w.settleAndCheck();
  });

  sim(
    'the other device spends an input of a Store payment that has its outbox entry: the Store release plus the coin check bring both back to the chain',
    async () => {
      const w = await threeCoins();
      const p = await w.storePay('B', 20_000);
      // Its backup push failed (that is why it was never sent), so the phone has never heard of it and still counts
      // every coin. (Had the phone pulled it first, the merge would have marked the coin spent there too.)
      const s = await w.send('A', 250_000); // needs every coin: one of them is the noSend's input
      expect(s.inputs).toContain(p.inputs[0]);
      await w.settleAndCheck();
    },
  );

  // Fixed by fix/unsent-auto-release (services/unsentExpiry.ts 1): a plain test from here on.
  sim(
    '[fix/unsent-auto-release] the other device spends an input of a noSend with no outbox entry: unsentExpiry cancels it (once kept for ever, "input-spent-elsewhere")',
    async () => {
      const w = await threeCoins();
      const p = await w.storePay('B', 20_000, { outbox: false });
      const s = await w.send('A', 250_000); // the phone never heard of the noSend (see the case above)
      expect(s.inputs).toContain(p.inputs[0]);
      await w.settleAndCheck();
    },
  );

  // Fixed by fix/unsent-auto-release (services/unsentExpiry.ts 1): a plain test from here on.
  sim(
    '[fix/unsent-auto-release] incident shape: an older Store entry (no intentAt), the other device spends an input, the page holding the outbox is gone: only unsentExpiry is left',
    async () => {
      const w = await threeCoins();
      const p = await w.storePay('B', 20_000, { intentAt: undefined });
      const s = await w.send('A', 250_000);
      expect(s.inputs).toContain(p.inputs[0]);
      // The page that held the outbox is gone (a stale build, a new popup origin): only unsentExpiry can free it now.
      w.B.outbox.drop(p.txid);
      await w.settleAndCheck();
    },
  );

  sim('transient chain and overlay 429s / timeouts while settling: everything still converges', async () => {
    const w = await threeCoins();
    await w.storePay('B', 20_000);
    await w.receive('A', 33_000);
    // Counts kept small: autoCoinResync's withRetry backs off on real timers (0.8 s, 1.6 s, 3.2 s).
    w.fault('woc', '429', 8);
    w.fault('arc', 'timeout', 3);
    w.fault('txo', '429', 2);
    w.fault('oneSat', '429', 3);
    await w.settleAndCheck();
    expect(w.chain.faultsHit.woc).toBeGreaterThan(0);
  });

  sim('a backup that is down for a while: no device diverges once it is back', async () => {
    const w = await threeCoins();
    w.fault('backup', '500', 6);
    await w.send('A', 10_000);
    await w.sync('A');
    await w.sync('B');
    await w.settleAndCheck();
  });

  sim(
    'a pull cut between the transaction rows and their outputs: the next pull resumes from its checkpoint and the change arrives',
    async () => {
      const w = await threeCoins();
      await w.send('A', 42_000);
      await w.sync('A');
      const { cut } = await w.interruptedPull('B');
      // The harness really cut it there: the page that landed held the transaction and none of its outputs.
      expect(cut?.transactions).toBeGreaterThan(0);
      expect(cut?.outputs).toBe(0);
      await w.settleAndCheck();
    },
  );

  /** The phone's send reaches the backup late, with row times older than the extension's cursor; then it is proven. */
  async function latePush() {
    const w = await threeCoins();
    // PULL_OVERLAP_MS (15 min) scaled to 2 ms: "more than 15 minutes late" is played as ~30 real ms.
    w.scaleOverlap(2);
    w.offline.add('phone');
    const s = await w.send('A', 42_000); // tx + change rows written now, but the phone can't reach the backup
    await w.sync('A'); // fails: offline
    await sleep(30);
    await w.receive('B', 10_000); // the extension's own rows, newer
    await w.sync('B');
    await w.sync('B'); // its cursor is now past the phone's send
    await sleep(30);
    w.offline.delete('phone');
    await w.sync('A'); // the send's rows reach the backup, with their old times
    await w.sync('B'); // older than the extension's cursor by more than the overlap: not pulled
    w.chain.mine();
    await w.prove('A'); // the send is proven: its transaction row is updated (completed, a new time)
    await w.sync('A');
    await w.sync('B'); // the incremental pull: the transaction row is new, its outputs' rows are old
    const b = await w.rows(w.B);
    return {
      w,
      status: b.txs.find((t) => t.txid === s.txid)?.status,
      outputRows: b.outs.filter((o) => o.txid === s.txid).length,
    };
  }

  // Fixed by fix/sync-atomic-pull (services/pullIntegrity.ts): a plain test from here on.
  sim(
    '[fix/sync-atomic-pull] a push that lands late, then its tx is proven: the completed tx arrives without its change (within the same half hour)',
    async () => {
      const { w, status, outputRows } = await latePush();
      // On 5.2.54: 'completed' with 0 output rows (owner's phone, problem 4: change only Find missing coins brought).
      w.log(`extension holds the send as ${status ?? 'nothing'} with ${outputRows} output row(s)`);
      await w.settle({ hours: 0.5 }); // the app keeps running for half an hour: syncs, admission, coin checks
      await w.expectAgree('half an hour after the late push');
    },
  );

  sim(
    'a push that lands late: the 6-hourly tail pass / daily full pass bring the change in the end (25 h later)',
    async () => {
      const { w } = await latePush();
      await w.settleAndCheck();
      expect(w.logs.some((l) => /pushed late|full pass: (started|deep)/.test(l))).toBe(true);
    },
  );

  sim('a 1-sat BSV-21 token taken in on one device is spendable on both, and never counted as BSV', async () => {
    const w = await threeCoins();
    await w.receiveToken('A');
    await w.settleAndCheck();
  });

  sim('a 1-sat token output never changes the BSV balance on either device', async () => {
    const w = await threeCoins();
    await w.receiveToken('A');
    await w.settle();
    const r = await w.check();
    // Whatever the token rows say, the BSV balances agree with the chain (the token check is the case above).
    for (const v of r.views) expect(v.shown).toBe(r.truth);
  });
});

/** Ops that must always keep the invariant on any build (the known-bug triggers are the named cases above). */
type Op = (w: World, r: ReturnType<typeof rng>) => Promise<unknown>;
const OPS: { name: string; run: Op }[] = [
  { name: 'receive', run: (w, r) => w.receive(r.pick(['A', 'B'] as const), r.int(20, 200) * 1_000) },
  {
    name: 'send',
    run: async (w, r) => {
      const d = r.pick(['A', 'B'] as const);
      const have = (await w.view(w.dev(d))).shown;
      if (have < 20_000) return w.receive(d, 150_000);
      return w.send(d, r.int(1, Math.floor((have - 5_000) / 1_000)) * 1_000 - r.int(0, 999));
    },
  },
  {
    name: 'store-pay',
    run: async (w, r) => {
      const d = r.pick(['A', 'B'] as const);
      if ((await w.view(w.dev(d))).shown < 30_000) return w.receive(d, 150_000);
      return w.storePay(d, r.int(5, 25) * 1_000);
    },
  },
  {
    name: 'abort',
    run: async (w, r) => {
      const d = r.pick(['A', 'B'] as const);
      if ((await w.view(w.dev(d))).shown < 30_000) return w.receive(d, 150_000);
      return w.createThenAbort(d, r.int(5, 25) * 1_000);
    },
  },
  { name: 'mine', run: async (w) => w.chain.mine() },
  { name: 'one-sided sync', run: (w, r) => w.sync(r.pick(['A', 'B'] as const)) },
  {
    name: 'flaky network',
    run: async (w, r) =>
      w.fault(
        r.pick(['woc', 'arc', 'txo', 'oneSat'] as const),
        r.pick(['429', 'timeout', '500'] as const),
        r.int(1, 5),
      ),
  },
];

describe('two devices, one seed: seeded random sequences', () => {
  for (const seed of [11, 22, 33, 44]) {
    sim(`seed ${seed}: 6 random steps, each followed by a settle and the invariant`, async () => {
      const w = await world(seed);
      const r = rng(seed * 7919);
      await w.receive('A', 200_000);
      await w.settleAndCheck();
      for (let i = 0; i < 6; i++) {
        const o = r.pick(OPS);
        w.step(`[random ${o.name}]`);
        await o.run(w, r);
        await w.settleAndCheck(`after random step ${i + 1} (${o.name}), seed ${seed}`);
      }
    });
  }
});
