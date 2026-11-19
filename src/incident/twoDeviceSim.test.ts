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
import { inputsOf, SIM_ADMIN, teardownSim, World } from '../testing/twoDeviceSim/world';
import { rng } from '../testing/twoDeviceSim/chain';
import { Beef, Script, Transaction } from '@bsv/sdk';
import { Wallet, WalletPermissionsManager } from '@bsv/wallet-toolbox-client';
import { NOT_YOURS } from '../services/releaseMarks';
import { isHeld, NEEDS_CONFIRMATION, resolveUnsent, visibleUnsent } from '../services/stuckSends';

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

  for (const status of ['unsent', 'sending', 'unprocessed'] as const)
    sim(
      `b-Aware 310/316: a pulled '${status}' request for a noSend payment posts nothing from the other device`,
      async () => {
        const w = await threeCoins();
        const p = await w.storePay('A', 20_000, { outbox: false }); // signed, withheld: never to be broadcast
        await w.sync('A');
        // A hostile backup: the request goes out as one the Monitor would post.
        const [q] = await w.backup.findProvenTxReqs({ partial: { txid: p.txid } });
        expect(q).toBeDefined();
        await w.backup.updateProvenTxReq(q.provenTxReqId, {
          status,
          updated_at: new Date(Date.now() + 60_000),
        } as never);
        await w.wipe('B'); // B is new to it: restored from the backup
        await w.sync('B');
        expect((await w.statusOf('B', p.txid)).req).not.toMatch(/^(unsent|sending|unprocessed)$/);
        expect(await w.sendWaiting('B')).toEqual([]);
        expect(w.chain.unspent('bsv').size).toBeGreaterThan(0);
      },
    );

  sim(
    "b-Aware 310/316: a delayed send's request goes to the backup as 'nosend' on a routine sync; this device still sends it",
    async () => {
      const w = await threeCoins();
      const p = await w.sendDelayed('A', 20_000);
      await w.sync('A');
      expect((await w.statusOf('A', p.txid)).req).toBe('unsent');
      expect((await w.statusOf('backup', p.txid)).req).toBe('nosend');
      await w.sync('B');
      expect(await w.sendWaiting('B')).toEqual([]);
      expect((await w.sendWaiting('A')).length).toBeGreaterThan(0);
    },
  );

  /** A history whose status note makes the toolbox count a request as broadcast (EntityProvenTxReq.wasBroadcast). */
  const BROADCAST_HISTORY = JSON.stringify({
    notes: [{ what: 'status', status_was: 'sending', status_now: 'unmined', when: '2026-11-01T00:00:00.000Z' }],
  });
  /** A hostile backup rewrites the request for `txid` (with a newer time, so the next pull carries it). */
  const tamper = async (w: World, txid: string, patch: Record<string, unknown>) => {
    const [q] = await w.backup.findProvenTxReqs({ partial: { txid } });
    expect(q).toBeDefined();
    w.advance(60_000);
    await w.backup.updateProvenTxReq(q.provenTxReqId, { ...patch, updated_at: new Date(Date.now()) } as never);
  };
  /** `on`'s proof task, `runs` times, each counted as an attempt (as each new block does in the app). */
  const proveTimes = async (w: World, on: 'A' | 'B', runs: number) => {
    for (let i = 0; i < runs; i++) await w.prove(on);
  };

  for (const status of ['nosend', 'unmined', 'unknown', 'callback', 'unconfirmed', 'unsent', 'invalid'] as const)
    sim(
      `task 54 F1: a pulled '${status}' request for a noSend payment, forged attempts / wasBroadcast / history, posts nothing after the proof tasks`,
      async () => {
        const w = await threeCoins();
        const p = await w.storePay('A', 20_000, { outbox: false }); // signed, withheld: never to be broadcast
        await w.sync('A');
        await tamper(w, p.txid, {
          status,
          attempts: 10_000,
          wasBroadcast: true,
          rebroadcastAttempts: 0,
          history: BROADCAST_HISTORY,
        });
        await w.wipe('B'); // B is new to it: restored from the backup
        await w.sync('B');
        await w.prove('B', { noSends: true }); // the proof timeout runs here (CheckForProofs / CheckNoSends)
        expect(await w.sendWaiting('B')).toEqual([]);
        expect(w.chain.has(p.txid)).toBe(false);
      },
    );

  sim(
    "task 54 F1: a pulled 'unmined' request (attempts, flags and history untouched) posts nothing after 150 proof runs",
    async () => {
      const w = await threeCoins();
      const p = await w.storePay('A', 20_000, { outbox: false });
      await w.sync('A');
      await tamper(w, p.txid, { status: 'unmined' });
      await w.wipe('B');
      await w.sync('B');
      await proveTimes(w, 'B', 150); // past unprovenAttemptsLimitMain (144)
      await w.prove('B', { noSends: true });
      expect(await w.sendWaiting('B')).toEqual([]);
      expect(w.chain.has(p.txid)).toBe(false);
    },
  );

  sim(
    "task 54 F1: a later page's 'was broadcast' history on a request B already re-checks ('unknown') posts nothing after 150 proof runs",
    async () => {
      const w = await threeCoins();
      const p = await w.storePay('A', 20_000, { outbox: false });
      await w.sync('A');
      await tamper(w, p.txid, { status: 'invalid' });
      await w.wipe('B');
      await w.sync('B');
      expect((await w.statusOf('B', p.txid)).req).toBe('unknown');
      await tamper(w, p.txid, { history: BROADCAST_HISTORY });
      await w.sync('B');
      await proveTimes(w, 'B', 150);
      expect(await w.sendWaiting('B')).toEqual([]);
      expect(w.chain.has(p.txid)).toBe(false);
    },
  );

  sim(
    "task 54 F2: a delayed send queued before setActive reaches the new active store as 'unsent' and is sent from there",
    async () => {
      const w = await threeCoins();
      const p = await w.sendDelayed('A', 20_000);
      expect((await w.statusOf('A', p.txid)).req).toBe('unsent');
      await w.A.sm.setActive(w.backup.getSettings().storageIdentityKey);
      expect((await w.statusOf('backup', p.txid)).req).toBe('unsent');
      expect(w.chain.has(p.txid)).toBe(false);
      // A's Monitor now works on the backup store; the backup's own services post (not A's, so not in A's list).
      await w.sendWaiting('A');
      expect(w.chain.has(p.txid)).toBe(true);
    },
  );

  sim(
    "task 54 round 2: a withheld payment the backup slips into another payment's inputBEEF never reaches the network",
    async () => {
      const w = await threeCoins();
      const W = await w.storePay('A', 20_000, { outbox: false }); // signed, withheld: never to be broadcast
      const S1 = await w.send('A', 20_000); // a normal send: on the network, its change A's to spend
      await w.sync('A');
      // A hostile backup adds W (with its parents) to S1's request inputBEEF.
      const [wq] = await w.backup.findProvenTxReqs({ partial: { txid: W.txid } });
      const [sq] = await w.backup.findProvenTxReqs({ partial: { txid: S1.txid } });
      expect(wq && sq).toBeTruthy();
      const beef = Beef.fromBinary(Array.from(sq.inputBEEF!));
      for (const parent of new Set(W.inputs.map((o) => o.split('.')[0]))) {
        const path = w.chain.merklePath(parent);
        expect(path).toBeDefined(); // the coins W spends are mined
        beef.mergeRawTx(w.chain.txs.get(parent)!.raw, beef.mergeBump(path!));
      }
      beef.mergeRawTx(Array.from(wq.rawTx));
      expect(beef.isValid()).toBe(true);
      expect(beef.findTxid(W.txid)).toBeDefined();
      w.advance(60_000);
      await w.backup.updateProvenTxReq(sq.provenTxReqId, {
        inputBEEF: beef.toBinary(),
        updated_at: new Date(Date.now()),
      } as never);
      await w.wipe('B'); // B is new to S1: restored from the backup
      await w.sync('B');
      await w.admit(w.B);
      // S1 is mined (a payment held on B goes out with B's send only once the chain has it in a block: round 4, item 5).
      w.chain.mine();
      // B spends more than its untouched coin: S1's change goes in, and S1's request builds the BEEF it is posted in.
      const s2 = await w.send('B', 150_000);
      expect(s2.inputs.some((o) => o.startsWith(`${S1.txid}.`))).toBe(true);
      expect(w.chain.has(s2.txid)).toBe(true);
      expect(w.chain.has(W.txid)).toBe(false);
    },
  );

  sim(
    "task 54 round 2: a queued send restored from a backup is listed as held and goes out only on the user's Send now, never while paused",
    async () => {
      const w = await threeCoins();
      const p = await w.sendDelayed('A', 20_000); // queued on A; A's device is then lost before it sends
      await w.sync('A');
      await w.wipe('B'); // B restored from the backup: the queued send arrives held ('nosend')
      await w.sync('B');
      const listed = (await w.unsentDeps('B').listQueued()).find((q) => q.txid === p.txid);
      expect(listed?.reqStatus).toBe('nosend');
      expect(isHeld(listed!)).toBe(true);
      // Nothing goes out without the user: B's Monitor, the stuck-send review.
      expect(await w.sendWaiting('B')).toEqual([]);
      await w.releaseStuck('B');
      expect(w.chain.has(p.txid)).toBe(false);
      // Spending paused: refused, nothing sent.
      const paused = await resolveUnsent(w.unsentDeps('B', { paused: true }), p.txid, 'send', { confirmed: true });
      expect(paused).toEqual({ ok: false, txid: p.txid, error: 'Payments are paused for now' });
      expect(w.chain.has(p.txid)).toBe(false);
      // Send now without the confirmation sheet's yes: refused, nothing sent (review round 3, d).
      expect(await resolveUnsent(w.unsentDeps('B'), p.txid, 'send')).toEqual({
        ok: false,
        txid: p.txid,
        error: NEEDS_CONFIRMATION,
      });
      expect(w.chain.has(p.txid)).toBe(false);
      // The user's confirmed Send now: exactly that payment goes out, from B.
      const before = w.B.posted.length;
      const sent = await resolveUnsent(w.unsentDeps('B'), p.txid, 'send', { confirmed: true });
      expect(sent).toEqual({ ok: true, txid: p.txid, result: 'network-may-have-it' });
      expect(w.B.posted.slice(before)).toEqual([p.txid]);
      expect(w.chain.has(p.txid)).toBe(true);
    },
  );

  for (const to of ['unproven', 'sending', 'completed'] as const)
    sim(
      `task 54 round 3 F1: a page moving A's own withheld payment to '${to}' frees none of its change and never sends it`,
      async () => {
        const w = await threeCoins();
        const W = await w.storePay('A', 20_000, { outbox: false }); // signed on A, withheld
        await w.sync('A');
        const [bt] = await w.backup.findTransactions({ partial: { txid: W.txid }, noRawTx: true });
        w.advance(60_000);
        await w.backup.updateTransaction(bt.transactionId, { status: to, updated_at: new Date(Date.now()) } as never);
        await w.sync('A'); // A pulls the backup's word on its own payment
        expect((await w.statusOf('A', W.txid)).tx).toBe('nosend');
        // An ordinary send needing more than A's two untouched coins: W's change is not there to take.
        let s2: Awaited<ReturnType<typeof w.send>> | undefined;
        try {
          s2 = await w.send('A', 250_000);
        } catch {
          // refused: not enough spendable coins without W's change
        }
        if (s2) expect(s2.inputs.some((o) => o.startsWith(`${W.txid}.`))).toBe(false);
        await w.sendWaiting('A');
        expect(w.chain.has(W.txid)).toBe(false);
      },
    );

  for (const on of ['A', 'B'] as const)
    sim(
      `task 54 round 3 F2: a page's BRC-177 reclaim pointed at a withheld payment itself never posts it (${on === 'A' ? 'the device that signed it' : 'a device restored from the backup'})`,
      async () => {
        const w = await threeCoins();
        // A withheld payment with one input and one output (the shape the toolbox's validateReclaim accepts).
        const r = await w.A.wallet.createAction({
          description: 'Withheld payment',
          outputs: [{ lockingScript: w.externalScript(), satoshis: 99_950, outputDescription: 'payment' }],
          options: { noSend: true, randomizeOutputs: false },
        });
        const W = Transaction.fromAtomicBEEF(r.tx as number[]);
        const wid = W.id('hex');
        expect([W.inputs.length, W.outputs.length]).toEqual([1, 1]);
        const [anchor] = inputsOf(W);
        await w.sync('A');
        // The hostile backup: W's expiry "revocation-requested", its reclaim W itself, anchored on W's own input.
        const [bt] = await w.backup.findTransactions({ partial: { txid: wid }, noRawTx: true });
        w.advance(60_000);
        await w.backup.updateTransaction(bt.transactionId, {
          noSendExpiryMode: 'timestamp',
          noSendExpiryValue: 1,
          noSendExpiryDeadline: 1,
          noSendExpiryState: 'revocation-requested',
          noSendExpiryAnchorTxid: anchor.split('.')[0],
          noSendExpiryAnchorVout: Number(anchor.split('.')[1]),
          noSendExpiryReclaimTxid: wid,
          noSendExpiryReclaimRawTx: W.toBinary(),
          noSendExpiryReclaimDerivationPrefix: 'p',
          noSendExpiryReclaimDerivationSuffix: 's',
          noSendExpiryReclaimSatoshis: 99_950,
          updated_at: new Date(Date.now()),
        } as never);
        if (on === 'B') await w.wipe('B'); // W new to B: restored from the backup with the forged fields
        await w.sync(on);
        const [t] = await w.dev(on).s.findTransactions({ partial: { txid: wid }, noRawTx: true });
        expect(t).toBeDefined();
        // A transaction the device has keeps its own expiry fields; a new one (a restore) keeps the page's, which are
        // checked structurally before any reclaim is activated or posted (round 4).
        if (on === 'A') expect([t.noSendExpiryState ?? null, t.noSendExpiryReclaimTxid ?? null]).toEqual([null, null]);
        else expect(t.noSendExpiryReclaimTxid).toBe(wid);
        const m = w.dev(on).monitor as unknown as { runTask: (n: string) => Promise<string> };
        await m.runTask('NoSendExpiry');
        await w.sendWaiting(on);
        expect(w.chain.has(wid)).toBe(false);
        // Not activated and never cancelled: the row is left as it was.
        const [after] = await w.dev(on).s.findTransactions({ partial: { txid: wid }, noRawTx: true });
        expect(after.noSendExpiryState ?? null).toBe(on === 'A' ? null : 'revocation-requested');
      },
    );

  /** The permissions manager with no prompts (every grant given), as a site's calls reach the wallet in the app. */
  const NO_PROMPTS = Object.fromEntries(
    [
      'seekProtocolPermissionsForSigning',
      'seekProtocolPermissionsForEncrypting',
      'seekProtocolPermissionsForHMAC',
      'seekPermissionsForKeyLinkageRevelation',
      'seekPermissionsForPublicKeyRevelation',
      'seekPermissionsForIdentityKeyRevelation',
      'seekPermissionsForIdentityResolution',
      'seekBasketInsertionPermissions',
      'seekBasketRemovalPermissions',
      'seekBasketListingPermissions',
      'seekPermissionWhenApplyingActionLabels',
      'seekPermissionWhenListingActionsByLabel',
      'seekCertificateDisclosurePermissions',
      'seekCertificateAcquisitionPermissions',
      'seekCertificateRelinquishmentPermissions',
      'seekCertificateListingPermissions',
      'encryptWalletMetadata',
      'seekSpendingPermissions',
      'differentiatePrivilegedOperations',
    ].map((k) => [k, false]),
  );
  const pmOf = (w: World, on: 'A' | 'B') =>
    new WalletPermissionsManager(w.dev(on).wallet as never, SIM_ADMIN, NO_PROMPTS as never);
  const expiringArgs = (w: World) => ({
    description: 'Expiring payment',
    outputs: [{ lockingScript: w.externalScript(), satoshis: 20_000, outputDescription: 'payment' }],
    labels: ['p nosend expiry seconds 60'],
    options: { noSend: true },
  });
  /** A BRC-177 expiring noSend payment on `on`: through the permissions manager (two-step), or the bare toolbox. */
  const expiring = async (w: World, on: 'A' | 'B', how: 'site' | 'legacy') => {
    const r = (
      how === 'site'
        ? await pmOf(w, on).createAction(expiringArgs(w) as never, 'shop.example')
        : // Made before this release: straight through the toolbox's own createAction, none of this device's records.
          await (Wallet.prototype.createAction as (a: unknown) => Promise<unknown>).call(
            w.dev(on).wallet,
            expiringArgs(w),
          )
    ) as { txid: string };
    const [t] = await w.dev(on).s.findTransactions({ partial: { txid: r.txid }, noRawTx: true });
    expect(t.noSendExpiryState).toBe('signed');
    return { txid: r.txid, reclaimTxid: t.noSendExpiryReclaimTxid as string };
  };
  /** Past the deadline, the Monitor's NoSendExpiry task; then the reclaim mined, proved and settled. */
  const expireAndReclaim = async (w: World, on: 'A' | 'B', reclaimTxid: string) => {
    w.advance(11 * 60_000);
    const m = w.dev(on).monitor as unknown as { runTask: (n: string) => Promise<string> };
    await m.runTask('NoSendExpiry');
    const posted = w.chain.has(reclaimTxid);
    if (posted) {
      w.chain.mine();
      await w.prove(on);
      await m.runTask('NoSendExpiry');
    }
    return posted;
  };
  const reclaimSettled = async (w: World, on: 'A' | 'B', target: string, reclaimTxid: string) => {
    const s = w.dev(on).s;
    const [t] = await s.findTransactions({ partial: { txid: target }, noRawTx: true });
    const [r] = await s.findTransactions({ partial: { txid: reclaimTxid }, noRawTx: true });
    const outs = r ? await s.findOutputs({ partial: { transactionId: r.transactionId }, noScript: true }) : [];
    return { state: t.noSendExpiryState, coinsBack: outs.some((o) => o.spendable === true) };
  };

  for (const how of ['site', 'legacy'] as const)
    sim(
      `task 54 round 4 (1): a BRC-177 action ${how === 'site' ? 'made by a site through the permissions manager (two-step)' : 'made before this release (no records of it here)'} is reclaimed after expiry and its coins come back`,
      async () => {
        const w = await threeCoins();
        const { txid, reclaimTxid } = await expiring(w, 'A', how);
        expect(await expireAndReclaim(w, 'A', reclaimTxid)).toBe(true);
        expect(await reclaimSettled(w, 'A', txid, reclaimTxid)).toEqual({ state: 'reclaimed', coinsBack: true });
        expect(w.chain.has(txid)).toBe(false);
      },
    );

  sim('task 54 round 4 (1): a BRC-177 action restored onto a wiped device is reclaimed there', async () => {
    const w = await threeCoins();
    const { txid, reclaimTxid } = await expiring(w, 'A', 'site');
    await w.sync('A');
    await w.wipe('B');
    await w.sync('B');
    await w.admit(w.B);
    // The funding transaction (the anchor's) is mined by the deadline: on a restored device it came back held, and a held
    // parent goes out with the reclaim only once the chain has it in a block (round 4, item 5).
    w.chain.mine();
    expect(await expireAndReclaim(w, 'B', reclaimTxid)).toBe(true);
    expect(w.chain.has(txid)).toBe(false);
  });

  for (const forge of ['pays a foreign key', 'an extra input'] as const)
    sim(
      `task 54 round 4 (1): a forged reclaim (${forge}) restored from a backup is not posted, and its row is not cancelled`,
      async () => {
        const w = await threeCoins();
        const { txid, reclaimTxid } = await expiring(w, 'A', 'site');
        await w.sync('A');
        // The hostile backup rewrites the reclaim it hands a restored device.
        const [bt] = await w.backup.findTransactions({ partial: { txid } });
        const real = Transaction.fromBinary(Array.from(bt.noSendExpiryReclaimRawTx as number[]));
        const forged = new Transaction(real.version, [], [], real.lockTime);
        forged.addInput({ ...real.inputs[0] });
        if (forge === 'an extra input')
          forged.addInput({
            sourceTXID: 'ab'.repeat(32),
            sourceOutputIndex: 0,
            unlockingScript: real.inputs[0].unlockingScript,
            sequence: 0xffffffff,
          });
        forged.addOutput({
          lockingScript:
            forge === 'pays a foreign key' ? Script.fromHex(w.externalScript()) : real.outputs[0].lockingScript,
          satoshis: real.outputs[0].satoshis,
        });
        w.advance(60_000);
        await w.backup.updateTransaction(bt.transactionId, {
          noSendExpiryReclaimTxid: forged.id('hex'),
          noSendExpiryReclaimRawTx: forged.toBinary(),
          updated_at: new Date(Date.now()),
        } as never);
        await w.wipe('B');
        await w.sync('B');
        await w.admit(w.B);
        w.chain.mine(); // the funding transaction is mined: only the reclaim check stands in the way
        expect(await expireAndReclaim(w, 'B', forged.id('hex'))).toBe(false);
        await w.sendWaiting('B');
        expect([w.chain.has(forged.id('hex')), w.chain.has(txid), w.chain.has(reclaimTxid)]).toEqual([
          false,
          false,
          false,
        ]);
        const [t] = await w.B.s.findTransactions({ partial: { txid }, noRawTx: true });
        expect(t.noSendExpiryState).not.toBe('cancelled');
      },
    );

  sim(
    "task 54 round 4 (2): a site can't send a noSend payment the wallet or another site made; its own it can",
    async () => {
      const w = await threeCoins();
      const pm = pmOf(w, 'A');
      const noSend = (sats: number) => ({
        description: 'Held payment',
        outputs: [{ lockingScript: w.externalScript(), satoshis: sats, outputDescription: 'payment' }],
        options: { noSend: true },
      });
      const byWallet = (await w.A.wallet.createAction(noSend(10_000) as never)) as { txid: string };
      const byB = (await pm.createAction(noSend(11_000) as never, 'b.example')) as { txid: string };
      const byA = (await pm.createAction(noSend(12_000) as never, 'a.example')) as { txid: string };
      for (const W of [byWallet.txid, byB.txid])
        await expect(
          pm.createAction({ description: 'Send it now', options: { sendWith: [W] } } as never, 'a.example'),
        ).rejects.toThrow(NOT_YOURS);
      expect([w.chain.has(byWallet.txid), w.chain.has(byB.txid)]).toEqual([false, false]);
      await pm.createAction(
        { description: 'Send it now', options: { sendWith: [byA.txid], acceptDelayedBroadcast: false } } as never,
        'a.example',
      );
      expect(w.chain.has(byA.txid)).toBe(true);
    },
  );

  /** A's payment P reaches B as sent but unconfirmed (B's copy: 'unproven', request 'nosend'), then drops out. */
  const droppedElsewhere = async () => {
    const w = await threeCoins();
    const P = await w.send('A', 20_000);
    await w.sync('A');
    await w.sync('B');
    expect(await w.statusOf('B', P.txid)).toEqual({ tx: 'unproven', req: 'nosend' });
    const listed = async () =>
      (await visibleUnsent(await w.unsentDeps('B').listQueued(), (t) => Promise.resolve(w.chain.has(t)))).find(
        (q) => q.txid === P.txid,
      );
    expect(await listed()).toBeUndefined(); // in the mempool: nothing to do
    w.chain.drop(P.txid); // A's device is gone; the network forgot P
    return { w, P, listed };
  };

  sim(
    "task 54 round 5 (4): another device's payment that dropped out of the mempool is listed; Send now re-posts exactly it",
    async () => {
      const { w, P, listed } = await droppedElsewhere();
      const q = await listed();
      expect([q?.elsewhere, q?.reqStatus, q?.amountSats]).toEqual([true, 'nosend', 20_000]);
      expect(await resolveUnsent(w.unsentDeps('B'), P.txid, 'send')).toEqual({
        ok: false,
        txid: P.txid,
        error: NEEDS_CONFIRMATION,
      });
      expect(w.chain.has(P.txid)).toBe(false);
      const before = w.B.posted.length;
      expect(await resolveUnsent(w.unsentDeps('B'), P.txid, 'send', { confirmed: true })).toEqual({
        ok: true,
        txid: P.txid,
        result: 'network-may-have-it',
      });
      expect(w.B.posted.slice(before)).toEqual([P.txid]);
      expect(w.chain.has(P.txid)).toBe(true);
    },
  );

  sim('task 54 round 5 (4): …Cancel releases its inputs with nothing broadcast; paused, Send now refuses', async () => {
    const { w, P, listed } = await droppedElsewhere();
    expect((await listed())?.elsewhere).toBe(true);
    expect((await resolveUnsent(w.unsentDeps('B', { paused: true }), P.txid, 'send', { confirmed: true })).ok).toBe(
      false,
    );
    const before = w.B.posted.length;
    expect(await resolveUnsent(w.unsentDeps('B'), P.txid, 'cancel')).toEqual({
      ok: true,
      txid: P.txid,
      result: 'cancelled',
    });
    expect(w.B.posted.slice(before)).toEqual([]);
    expect(w.chain.has(P.txid)).toBe(false);
    for (const o of P.inputs)
      expect(
        (await w.B.s.findOutputs({ partial: { txid: o.split('.')[0], vout: Number(o.split('.')[1]) } }))[0]?.spendable,
      ).toBe(true);
  });

  sim(
    'task 54 round 5 (4): …and the stuck-send review gives it up after its window, inputs released, nothing sent',
    async () => {
      const { w, P } = await droppedElsewhere();
      w.advance(8 * 24 * 60 * 60_000);
      const before = w.B.posted.length;
      const r = await w.releaseStuck('B');
      expect(r.released.map((x) => x.txid)).toContain(P.txid);
      expect(w.B.posted.slice(before)).toEqual([]);
      expect(await w.statusOf('B', P.txid)).toEqual({ tx: 'failed', req: 'invalid' });
    },
  );

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
      // Its parent came back from the backup held ('nosend'), so it goes out as a parent only once it is mined (task 54
      // review, round 4, item 5: a mempool "known" is not enough).
      w.chain.mine();
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
