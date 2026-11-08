/**
 * BRC-219, third review (8 Nov 2026), through the real payment-run guard (spendRecipients.ts) and the sheet hooks
 * background.ts uses (sheetHooksFor + TrackedSheets + CallerRegistry):
 *  - Medium: a payment sheet is owned by exactly its own call. A call that passed every guarded wait and lost its
 *    caller while the payment was being prepared must have its sheet closed, even with another live createAction
 *    from the same site in flight (which used to be counted as its owner).
 *  - Low: a caller that leaves the unlock screen takes its waiter with it.
 *  - Low: a solo (module) run holds the site until its full sheet is answered, not just its prefunding sheet.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeOriginator } from '@1sat/wallet';
import {
  CallerRegistry,
  TrackedSheets,
  dropTokenWaiters,
  sheetHooksFor,
  withCallerGoneSignal,
  type SheetRef,
} from './promptLiveness';
import {
  guardSpendRecipients,
  recipientsForSheet,
  releaseSpendRuns,
  spendRunCaller,
  spendSheetSettled,
} from './spendRecipients';

const SITE = 'pay.example';
const script = (byte: string) => `76a914${byte.repeat(20)}88ac`;
type Out = { lockingScript: string; satoshis: number };
type Req = {
  requestID: string;
  type: 'spending';
  originator: string;
  spending: { satoshis: number; lineItems?: { type: string; satoshis: number; description: string }[] };
};
const deferred = <T = void>() => {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { p, resolve };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => undefined;

/** background.ts in miniature: the registry, the tracked payment-sheet map with its hooks, and the closer. */
const background = () => {
  const reg = new CallerRegistry();
  const closed: string[] = [];
  const close = (refs: SheetRef[]) => {
    for (const r of refs) if (sheets.delete(r.id)) closed.push(r.id);
  };
  const sheets: TrackedSheets<{ request: { originator?: string; type?: string } }> = new TrackedSheets(
    'permission',
    sheetHooksFor(reg, {
      siteOf: (o) => o,
      paymentOwner: (kind, id) => (kind === 'permission' ? spendRunCaller(id) : undefined),
      close,
      settled: (kind, id) => kind === 'permission' && spendSheetSettled(id),
      defer: (fn) => fn(),
    }),
  );
  /** showPermissionPrompt: bind the request to its run, then the pending entry (which raises the sheet). */
  const show = (req: Req) => {
    recipientsForSheet(SITE, req);
    sheets.set(req.requestID, { request: { originator: SITE, type: 'spending' } });
  };
  /** The live port's disconnect (attachLivePort): the caller is gone, close what it owned. */
  const leave = (token: string) => close(reg.callerGone(token));
  return { reg, sheets, closed, show, leave };
};

describe('Medium: a payment sheet belongs to exactly its own call', () => {
  test('caller leaves while the payment is prepared, a live createAction is in flight: the dead sheet closes', async () => {
    const bg = background();
    const prepared = new Map<number, ReturnType<typeof deferred>>();
    const raised: Req[] = [];
    let seq = 0;
    const manager = {
      createAction: async (args: { outputs: Out[] }, originator?: string) => {
        const n = ++seq;
        const prep = deferred();
        prepared.set(n, prep);
        await prep.p; // the toolbox prepares the payment (inputs, change) before asking
        const req: Req = {
          requestID: `spend:${n}`,
          type: 'spending',
          originator: originator ?? '',
          spending: {
            satoshis: args.outputs[0].satoshis,
            lineItems: args.outputs.map((o) => ({ type: 'output', satoshis: o.satoshis, description: 'x' })),
          },
        };
        raised.push(req);
        bg.show(req);
        return new Promise(() => undefined);
      },
    };
    const w = guardSpendRecipients(manager, { adminOriginator: 'admin', normalize: normalizeOriginator });
    // Call A passes every guarded wait (unlock, funding, run wait) and is preparing its payment.
    bg.reg.start('A', SITE, 'createAction');
    const argsA = withCallerGoneSignal(
      { outputs: [{ lockingScript: script('11'), satoshis: 1_000 }] },
      bg.reg.whenGone('A'),
      'A',
    );
    w.createAction(argsA, SITE).catch(quiet);
    // A live createAction B from the same site is in flight too (different amount: it runs alongside).
    bg.reg.start('B', SITE, 'createAction');
    const argsB = withCallerGoneSignal(
      { outputs: [{ lockingScript: script('22'), satoshis: 5_000 }] },
      bg.reg.whenGone('B'),
      'B',
    );
    w.createAction(argsB, SITE).catch(quiet);
    await sleep(2);
    bg.leave('A'); // A's page goes away mid-preparation: nothing to close yet
    prepared.get(1)!.resolve(); // A's spending request arrives now
    await sleep(2);
    expect(raised.map((r) => r.requestID)).toEqual(['spend:1']);
    expect(spendRunCaller('spend:1')).toBe('A');
    expect(bg.closed).toEqual(['spend:1']); // closed at once: B never "owns" A's payment
    expect(bg.sheets.has('spend:1')).toBe(false);
    // B's own sheet stays, and goes when B's caller goes.
    prepared.get(2)!.resolve();
    await sleep(2);
    expect(bg.sheets.has('spend:2')).toBe(true);
    bg.leave('B');
    expect(bg.closed).toEqual(['spend:1', 'spend:2']);
    releaseSpendRuns();
  });
});

describe('Low: a caller that leaves the unlock screen takes its waiter with it', () => {
  test('the guard fires, the waiter is dropped; the unlock surface is free to close when none are left', async () => {
    const reg = new CallerRegistry();
    const waiters: { token?: string; resolve: () => void }[] = [];
    const unlock = deferred();
    const waitUnlock = (token: string) => {
      waiters.push({ token, resolve: () => undefined }); // ensureWallet's pendingWalletWaiters entry
      return unlock.p;
    };
    reg.start('only', SITE, 'createAction');
    let left = -1;
    const answered = reg.guard('only', waitUnlock('only')).catch(() => {
      if (reg.isDead('only')) left = dropTokenWaiters(waiters, 'only').left;
      return 'gone';
    });
    reg.callerGone('only');
    expect(await answered).toBe('gone');
    expect(waiters).toEqual([]);
    expect(left).toBe(0); // background.ts: closeDappPopupIfNoUi() now closes the unlock window
    expect(dropTokenWaiters([{ token: 'x' }, { token: 'y' }], 'x')).toEqual({ removed: 1, left: 1 });
  });
});

describe('Low: a solo (module) run holds until its full sheet is answered', () => {
  test('prefunding answered, full sheet still to come: a look-alike waits, so the two never meet and both refuse', async () => {
    const raised: Req[] = [];
    const answers = new Map<string, () => void>();
    let seq = 0;
    const ask = (req: Req) =>
      new Promise<void>((r) => {
        answers.set(req.requestID, r);
        raised.push(req);
      });
    const manager = {
      createAction: async (args: { outputs: Out[]; labels?: string[] }, originator?: string) => {
        const total = args.outputs.reduce((s, o) => s + o.satoshis, 0);
        const n = ++seq;
        await ask({
          requestID: `pre:${n}`,
          type: 'spending',
          originator: originator ?? '',
          spending: { satoshis: total },
        });
        await ask({
          requestID: `full:${n}`,
          type: 'spending',
          originator: originator ?? '',
          spending: {
            satoshis: total,
            lineItems: args.outputs.map((o) => ({ type: 'output', satoshis: o.satoshis, description: 'x' })),
          },
        });
        return new Promise(() => undefined);
      },
    };
    const w = guardSpendRecipients(manager, { adminOriginator: 'admin', normalize: normalizeOriginator });
    const solo = (b: string) => ({ outputs: [{ lockingScript: script(b), satoshis: 700 }], labels: ['p nosend x'] });
    w.createAction(solo('55'), 'solo.example').catch(quiet);
    await sleep(2);
    const pre = raised[0];
    expect(recipientsForSheet('solo.example', pre)).not.toBeNull(); // bound as A's prefunding
    answers.get(pre.requestID)!();
    spendSheetSettled(pre.requestID);
    w.createAction(solo('66'), 'solo.example').catch(quiet);
    await sleep(5);
    expect(raised.map((r) => r.requestID)).toEqual(['pre:1', 'full:1']); // B has not started: A still holds
    const full = raised[1];
    expect(recipientsForSheet('solo.example', full)).toMatchObject({ recipients: expect.any(Array) }); // not refused
    answers.get(full.requestID)!();
    spendSheetSettled(full.requestID);
    await sleep(5);
    expect(raised.map((r) => r.requestID)).toEqual(['pre:1', 'full:1', 'pre:2']); // now B goes ahead
    releaseSpendRuns();
  });
});
