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
 *   - fix/change-writeahead: a send's change lived only on the sending device until its next push (~20 s, longer on a
 *     back-off); a device wiped in that window (the extension's Remove + reload) lost it for good. The payment's rows now
 *     reach the backup before the broadcast (services/changeWriteAhead.ts), as 'sending', never 'unprocessed' (which the
 *     abandoned-payment sweep on a restored copy would fail); a backup that is down never holds a payment back.
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

  // Fixed by fix/change-writeahead (services/changeWriteAhead.ts): a payment's rows reach the backup before it is
  // broadcast. On 5.2.54 the change of a send lived only on the sending device until its next push (~20 s later).
  sim(
    '[fix/change-writeahead] a send, then the sending device is wiped before its next sync: the restore has the change and can spend it',
    async () => {
      const w = await threeCoins();
      const s = await w.send('A', 42_000);
      const change = s.tx.outputs.length - 1; // the payment is output 0; its change after it
      expect(change).toBeGreaterThan(0);
      await w.wipe('A'); // no device sync ran since the send
      // The restored phone and the extension take the backup in, then run the wallet-open abandoned-payment sweep: the
      // payment must not read as one that never went out (failed, its inputs freed, its change dropped).
      await w.sync('A');
      await w.sync('B');
      await w.failAbandoned('A');
      await w.failAbandoned('B');
      await w.settleAndCheck('after the restore from the backup');
      // The restored phone spends everything it has, the change included: signed with the derivation from the backup.
      const all = (await w.view(w.A)).shown;
      const s2 = await w.send('A', all - 5_000);
      expect(s2.inputs.some((i) => i.startsWith(`${s.txid}.`))).toBe(true);
      expect(await s2.tx.verify('scripts only')).toBe(true);
      await w.settleAndCheck('after spending the change');
    },
  );

  sim(
    '[fix/change-writeahead] the backup is down when a send goes out: it is broadcast anyway, flagged, backed up once the backup is back',
    async () => {
      const w = await threeCoins();
      w.offline.add('phone');
      const s = await w.send('A', 42_000);
      expect(w.chain.has(s.txid)).toBe(true); // never held back by the backup
      expect(w.A.writeAhead?.unbacked().map((u) => u.txid)).toEqual([s.txid]);
      expect(await w.A.writeAhead?.retryNow()).toBe(false); // still down: still flagged
      w.offline.delete('phone');
      expect(await w.A.writeAhead?.retryNow()).toBe(true); // the urgent retry
      expect(w.A.writeAhead?.count()).toBe(0);
      await w.wipe('A');
      await w.settleAndCheck('after the restore from the backup');
    },
  );

  // Review of fix/change-writeahead (13 Nov 2026, MEDIUM-HIGH): the copy the backup keeps of a payment about to go out
  // was a request 'unsent'. The toolbox never merges a request's status, so the backup and every device that pulls it
  // kept it 'unsent' for good, and each one's Monitor (SendWaiting) broadcast it. A payment this device gave up on (the
  // network refused it for a while; inputs freed, perhaps paid again) could then go out from the other device.
  sim(
    '[fix/change-writeahead] a send the network did not take, given up on by its device: the other device never broadcasts the backup’s copy',
    async () => {
      const w = await threeCoins();
      w.fault('broadcast', '500', 1); // the network does not take it (a transient error)
      // The toolbox reports it for review (WERR_REVIEW_ACTIONS, with the txid): the payment is queued as 'sending'.
      const s = await w.send('A', 42_000).then(
        (r) => r,
        (e: { txid?: string }) => ({ txid: String(e?.txid ?? '') }),
      );
      expect(s.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(w.chain.has(s.txid)).toBe(false);
      await w.giveUp('A', s.txid);
      await w.sync('A');
      await w.sync('B');
      expect((await w.statusOf('B', s.txid)).req).toBeDefined(); // B holds the backup's copy
      expect(await w.sendWaiting('B')).toEqual([]); // its Monitor never sends it
      expect(w.chain.has(s.txid)).toBe(false);
      expect(['unsent', 'sending']).not.toContain((await w.statusOf('B', s.txid)).req);
      // The backup's own copy is not one to send either (a server Monitor, or the next device restored from it).
      expect(['unsent', 'sending']).not.toContain((await w.statusOf('backup', s.txid)).req);
    },
  );

  // Re-review of 18c93dd9 (MEDIUM-HIGH): a delayed send (acceptDelayedBroadcast; bigDelayed's big mints) already has
  // its request at 'unsent' when the Monitor posts it, and only 'unprocessed' was turned into 'nosend': the backup kept
  // 'unsent', and the other device's Monitor broadcast a payment its own device had given up on.
  sim(
    '[fix/change-writeahead] a delayed send the network did not take, given up on by its device: the other device never broadcasts it',
    async () => {
      const w = await threeCoins();
      const s = await w.sendDelayed('A', 42_000);
      expect(w.chain.has(s.txid)).toBe(false); // queued, not yet posted
      expect((await w.statusOf('A', s.txid)).req).toBe('unsent');
      w.fault('broadcast', '500', 1); // the Monitor's post does not reach the network
      expect(await w.sendWaiting('A')).toEqual([]);
      expect(w.chain.has(s.txid)).toBe(false);
      expect((await w.statusOf('backup', s.txid)).req).toBeDefined(); // the write-ahead pushed it before the post
      await w.giveUp('A', s.txid);
      await w.sync('A');
      await w.sync('B');
      expect((await w.statusOf('B', s.txid)).req).toBeDefined();
      expect(await w.sendWaiting('B')).toEqual([]); // B's Monitor never sends it
      expect(w.chain.has(s.txid)).toBe(false);
      expect(['unsent', 'sending']).not.toContain((await w.statusOf('backup', s.txid)).req);
    },
  );

  // Re-review of 18c93dd9 (LOW, stuck money): the toolbox counts no attempts on a 'nosend' request, and the stuck-send
  // release needed 6, so a restored copy of a payment whose broadcast never landed stayed 'sending' for ever.
  sim(
    '[fix/change-writeahead] the broadcast never lands and the device is lost before its next push: the restored copy is released a week later',
    async () => {
      const w = await threeCoins();
      w.fault('broadcast', '500', 1); // the write-ahead lands; the broadcast does not
      const s = await w.send('A', 42_000).then(
        (r) => r,
        (e: { txid?: string }) => ({ txid: String(e?.txid ?? ''), inputs: [] as string[] }),
      );
      expect(w.chain.has(s.txid)).toBe(false);
      expect((await w.statusOf('backup', s.txid)).req).toBe('nosend');
      await w.wipe('A'); // lost before any device sync
      await w.sync('A');
      await w.sync('B');
      for (const d of ['A', 'B'] as const) expect((await w.statusOf(d, s.txid)).tx).toBe('sending');
      // A day later: not yet (its sending device, if alive, could still be sending it; its own 24 h rule acts first).
      w.advance(25 * 3_600_000);
      for (const d of ['A', 'B'] as const) expect((await w.releaseStuck(d)).released).toEqual([]);
      // A week later: released. (Rows' created_at is on the real clock, which the harness does not move, so the
      // first 25 h of world-clock offset from the coins' settle count too; the exact boundary is in stuckSends.test.ts.)
      w.advance(6 * 24 * 3_600_000);
      for (const d of ['A', 'B'] as const) {
        const r = await w.releaseStuck(d);
        expect(r.released.map((q) => q.txid)).toEqual([s.txid]);
        expect((await w.statusOf(d, s.txid)).tx).toBe('failed');
      }
      // The inputs are spendable again and the change is not counted: the chain's 300,000 on both.
      await w.settleAndCheck('after the release');
      for (const d of [w.A, w.B]) expect((await w.view(d)).shown).toBe(300_000);
    },
  );

  sim(
    '[fix/change-writeahead] the same restored copy of a payment that did reach the network is never released',
    async () => {
      const w = await threeCoins();
      const s = await w.send('A', 42_000);
      expect(w.chain.has(s.txid)).toBe(true);
      await w.wipe('A');
      await w.sync('A');
      await w.sync('B');
      w.advance(8 * 24 * 3_600_000);
      for (const d of ['A', 'B'] as const) {
        const r = await w.releaseStuck(d);
        expect(r.released).toEqual([]);
        expect(r.kept).toEqual([s.txid]);
        expect((await w.statusOf(d, s.txid)).tx).toBe('sending');
      }
      // The network check failing is no licence either.
      w.fault('woc', '500', 20);
      w.fault('oneSat', '500', 20);
      expect((await w.releaseStuck('A')).released).toEqual([]);
      w.chain.clearFaults();
      w.chain.mine();
      for (const d of ['A', 'B'] as const) {
        await w.prove(d, { noSends: true });
        expect((await w.statusOf(d, s.txid)).tx).toBe('completed');
      }
      await w.settleAndCheck('after the proof');
    },
  );

  sim(
    '[fix/change-writeahead] a restore from the backup that the sending device never synced again: the payment is tracked to its proof, never resent',
    async () => {
      const w = await threeCoins();
      const s = await w.send('A', 42_000);
      await w.wipe('A');
      await w.sync('A');
      await w.sync('B');
      for (const d of ['A', 'B'] as const) {
        expect(await w.sendWaiting(d)).toEqual([]); // the network has it: no copy sends it again
        expect((await w.statusOf(d, s.txid)).tx).toBe('sending');
      }
      w.chain.mine();
      for (const d of ['A', 'B'] as const) {
        await w.prove(d, { noSends: true });
        expect(await w.statusOf(d, s.txid)).toEqual({ tx: 'completed', req: 'completed' });
      }
      await w.settleAndCheck('after the proof');
    },
  );

  /**
   * A slow backup (each push page waits the next of `delays` before it merges, and merges even when the device gave
   * up), then two payments, the second spending old coins already in the backup. Afterwards the backup must hold every
   * coin either payment spent as spent.
   */
  async function slowBackupThenTwoPayments(o: { delays: number[]; backlog: number; budgetMs: number }) {
    const w = (current = await World.open({ seed: 1, writeAheadBudgetMs: o.budgetMs }));
    for (let i = 0; i < 3; i++) await w.receive('A', 100_000);
    await w.settleAndCheck('after the three coins arrive');
    // A backlog on A that no sync has pushed yet.
    for (let i = 0; i < o.backlog; i++) await w.receive('A', 1_000 + i);
    w.backupPageDelays.push(...o.delays);
    const pagesBefore = w.backupPages.length;
    const p1 = await w.send('A', 42_000);
    const p2 = await w.send('A', 150_000);
    expect(p2.inputs.some((i) => !p1.inputs.includes(i))).toBe(true);
    await sleep(Math.max(...o.delays) + 500); // anything the backup was still merging has landed
    w.backupPageDelays.length = 0;
    await w.sync('A'); // the ordinary device-sync push
    for (const i of [...p1.inputs, ...p2.inputs]) {
      const c = await w.backupCoin(i);
      if (c) expect({ coin: i, spendable: c.spendable }).toEqual({ coin: i, spendable: false });
    }
    await w.settleAndCheck('after both payments');
    return { w, pages: w.backupPages.length - pagesBefore };
  }

  // Review of fix/change-writeahead (13 Nov 2026, MEDIUM): one 8 s deadline for the whole push cycle could cut it after
  // its first page was committed, leaving the backup's checkpoint mid-cycle ("a push cycle is never paused",
  // pushView.ts): the next payment's spent coin sorts before the saved position, is never sent, and the backup keeps it
  // spendable for good.
  sim(
    '[fix/change-writeahead] a backlog of more than one page and a slow backup, then two payments: the backup ends with every spent coin spent',
    async () => {
      // The first page answers at once, the second takes longer than the payment's deadline.
      const { pages } = await slowBackupThenTwoPayments({ delays: [0, 4_000], backlog: 20, budgetMs: 3_000 });
      expect(pages).toBeGreaterThan(2); // the backlog went as more than one data page
    },
  );

  // Re-review of 18c93dd9 (MEDIUM-LOW): the first data page itself, cut by the deadline, was still merged by the
  // backup afterwards, which left its checkpoint mid-cycle the same way (every cycle is a data page plus a closing page).
  sim(
    '[fix/change-writeahead] a first page slower than the payment deadline, then a second payment: the backup ends with every spent coin spent',
    async () => {
      await slowBackupThenTwoPayments({ delays: [4_000], backlog: 0, budgetMs: 3_000 });
    },
  );

  sim('[fix/change-writeahead] a flagged send is cleared by the next ordinary device sync too', async () => {
    const w = await threeCoins();
    w.fault('backup', '500', 1); // the push before the broadcast fails at its first request
    const s = await w.send('A', 42_000);
    expect(w.chain.has(s.txid)).toBe(true);
    expect(w.A.writeAhead?.count()).toBe(1);
    await w.sync('A');
    expect(w.A.writeAhead?.count()).toBe(0);
    await w.wipe('A');
    await w.settleAndCheck('after the restore from the backup');
  });

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
