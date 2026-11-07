import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  arcLookup,
  chainLookups,
  chainVerdict,
  chainHasSeen,
  chainMayHave,
  chainSaysUnknown,
  defaultLookups,
  oneSatLookup,
  oneSatPresenceLookup,
  refusedBeforeBroadcast,
  releaseAfterHandoff,
  sendThroughWallet,
  settleWhenSeen,
  wocLookup,
  type Sighting,
} from './unsentGuard';
import { releasePayment } from '../mobile/chat/roomSpend';
import { ThemeOrderError } from '../mobile/themeOrder/api';

/** tx 877d2505… (25 Oct 2026 16:17 UTC, block 972621): the theme purchase whose change the wallet lost. */
const TXID = '877d2505159194dcd7ea01ae8ee68bfb9740bd85335badd836671e1844ce4224';

const fakeWallet = () => {
  const aborted: string[] = [];
  const sent: string[][] = [];
  return {
    aborted,
    sent,
    abortAction: async (a: { reference: string }) => {
      aborted.push(a.reference);
      return { aborted: true };
    },
    createAction: async (a: { options: { sendWith: string[] } }) => {
      sent.push(a.options.sendWith);
      return { sendWithResults: a.options.sendWith.map((txid) => ({ txid, status: 'unproven' })) };
    },
  };
};

/** The chain right after a broadcast: nothing for the first `lag` lookups, then the tx. */
const laggingChain = (lag: number) => {
  let n = 0;
  return async (): Promise<Sighting> => (n++ < lag ? 'missing' : 'seen');
};
const quiet = { sleep: async () => {}, log: () => {} };

describe('the 16:17 scenario: the server broadcast, then answered with an error', () => {
  test("buy-claim 502 'broadcast_failed' after the network took it: no abort, change kept, then settled", async () => {
    const w = fakeWallet();
    const err = new ThemeOrderError('The network didn’t take the payment.', 'broadcast_failed', 502);
    const r = await releaseAfterHandoff(w, TXID, {
      ...quiet,
      notBroadcast: refusedBeforeBroadcast(err),
      lookups: [laggingChain(2)],
      settleDelaysMs: [1, 1, 1],
      background: false,
    });
    expect(r.kind).toBe('kept');
    expect(w.aborted).toEqual([]);
    expect(await r.settled).toBe('sent');
    expect(w.sent).toEqual([[TXID]]);
  });

  test('a 4xx answer while the chain is slow to show it: the retries see it, so no abort', async () => {
    const w = fakeWallet();
    const err = new ThemeOrderError('quote used', 'quote_used', 409);
    const r = await releaseAfterHandoff(w, TXID, {
      ...quiet,
      notBroadcast: refusedBeforeBroadcast(err),
      lookups: [laggingChain(3)], // the toolbox's single instant check would have said "not known"
      settleDelaysMs: [1],
      background: false,
    });
    expect(r).toMatchObject({ kind: 'kept', reason: 'chain-has-it-or-unclear' });
    expect(w.aborted).toEqual([]);
  });

  test('releasePayment (theme orders, room charges) with the 502 never calls abortAction', async () => {
    const w = fakeWallet();
    await releasePayment({ wallet: w } as never, TXID, new ThemeOrderError('x', 'broadcast_failed', 502), {
      ...quiet,
      lookups: [async () => 'missing'],
      settleDelaysMs: [],
      background: false,
    });
    expect(w.aborted).toEqual([]);
  });

  test('theme order client: the wallet sends Store payments itself and never aborts one (P0, 3 Nov 2026)', () => {
    const src = readFileSync('src/mobile/themeOrder/api.ts', 'utf8');
    expect(src).not.toContain("e.code === 'broadcast_failed')");
    // No abort path for a payment that may have gone out: the only release is of one the Store refused BEFORE any
    // broadcast (claim intent), and it goes through releaseAfterHandoff's ~30 s chain check (review 4 Nov 2026).
    expect(src).not.toMatch(/releasePayment/);
    // The one abort (06c M2): an orphan that never reached the outbox, released only after the Store says it never
    // heard of it and the chain says unknown over the retries, and re-checked right before.
    expect(src.match(/abortAction\(/g)?.length).toBe(1);
    const orphan = src.slice(src.indexOf('06c M2: an orphan'), src.indexOf('await w.abortAction('));
    expect(orphan).toMatch(/storeHeardOf\([\s\S]*chainSaysUnknown\([\s\S]*inOutbox\(txid\) \|\| \(await storeHeardOf/);
    expect(src.match(/releaseAfterHandoff\(/g)?.length).toBe(1);
    expect(src).toMatch(/releaseAfterHandoff\(wallet, txid, \{\s*notBroadcast: true/);
    expect(src.match(/signStorePayment\(/g)?.length).toBe(2);
    expect(src).toContain('sendStorePayment(');
  });
});

describe('releaseAfterHandoff', () => {
  test('aborts only on a refusal before broadcast AND a clean "missing" on every retry', async () => {
    const w = fakeWallet();
    const r = await releaseAfterHandoff(w, TXID, {
      ...quiet,
      notBroadcast: true,
      lookups: [async () => 'missing', async () => 'missing'],
    });
    expect(r.kind).toBe('aborted');
    expect(w.aborted).toEqual([TXID]);
  });

  test('network error / timeout (no HTTP status) is not "not broadcast"', async () => {
    expect(refusedBeforeBroadcast(new TypeError('Failed to fetch'))).toBe(false);
    expect(refusedBeforeBroadcast({ status: 500 })).toBe(false);
    expect(refusedBeforeBroadcast({ status: 502 })).toBe(false);
    expect(refusedBeforeBroadcast({ status: 402 })).toBe(true);
  });

  test('an unclear chain answer (rate limit, offline) keeps it', async () => {
    const w = fakeWallet();
    const r = await releaseAfterHandoff(w, TXID, {
      ...quiet,
      notBroadcast: true,
      lookups: [async () => 'missing', async () => 'unclear'],
      settleDelaysMs: [],
      background: false,
    });
    expect(r.kind).toBe('kept');
    expect(w.aborted).toEqual([]);
  });

  test('a throwing lookup counts as unclear', async () => {
    expect(
      await chainSaysUnknown(TXID, {
        ...quiet,
        lookups: [
          async () => {
            throw new Error('boom');
          },
        ],
      }),
    ).toBe(false);
  });

  test('the default retries span about 30 s', async () => {
    const waited: number[] = [];
    await chainSaysUnknown(TXID, { lookups: [async () => 'missing'], sleep: async (ms) => void waited.push(ms) });
    const total = waited.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(25_000);
    expect(total).toBeLessThanOrEqual(40_000);
  });

  test('never seen: left pending (nosend), never aborted', async () => {
    const w = fakeWallet();
    expect(await settleWhenSeen(w, TXID, { ...quiet, lookups: [async () => 'missing'], settleDelaysMs: [1, 1] })).toBe(
      'not-seen',
    );
    expect(w.aborted).toEqual([]);
    expect(w.sent).toEqual([]);
  });
});

describe('"seen" means the network has it (P0, 3 Nov 2026)', () => {
  const respond =
    (status: number, body: unknown = {}) =>
    async () =>
      new Response(JSON.stringify(body), { status });
  const offline = async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };

  test('1Sat\'s BEEF store: a copy there is never "seen" (it holds refused txs too); 404 is missing', async () => {
    expect(await oneSatLookup(respond(200))(TXID)).toBe('unclear');
    expect(await oneSatLookup(respond(404))(TXID)).toBe('missing');
    expect(await oneSatLookup(offline)(TXID)).toBe('unclear');
    // unsentExpiry's own variant: a copy leads only to the wallet's own (chain-checked) send of that tx.
    expect(await oneSatPresenceLookup(respond(200))(TXID)).toBe('seen');
  });

  test('ARC: SEEN / ACCEPTED / MINED are seen; QUEUED / ANNOUNCED unclear; 404 missing; REJECTED missing only in retried checks', async () => {
    for (const s of ['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'ACCEPTED_BY_NETWORK', 'MINED'])
      expect(await arcLookup(respond(200, { txStatus: s }))(TXID)).toBe('seen');
    for (const s of [
      'QUEUED',
      'RECEIVED',
      'STORED',
      'ANNOUNCED_TO_NETWORK',
      'SENT_TO_NETWORK',
      'SEEN_IN_ORPHAN_MEMPOOL',
    ])
      expect(await arcLookup(respond(200, { txStatus: s }))(TXID)).toBe('unclear');
    // One snapshot: a GorillaPool refusal says nothing about the wallet's own broadcaster (review F1/F5).
    expect(await arcLookup(respond(200, { txStatus: 'REJECTED' }))(TXID)).toBe('unclear');
    expect(await arcLookup(respond(200, { txStatus: 'REJECTED' }), { rejectedIsMissing: true })(TXID)).toBe('missing');
    expect(await arcLookup(respond(404))(TXID)).toBe('missing');
    expect(await arcLookup(respond(500))(TXID)).toBe('unclear');
    expect(await arcLookup(offline)(TXID)).toBe('unclear');
  });

  test('"not found" is not known; a sighting, ARC holding it or any error is (fail closed)', async () => {
    const say = (...a: Sighting[]) => a.map((x) => async () => x);
    expect(await chainMayHave(TXID, say('missing', 'missing'))).toBe(false);
    expect(await chainMayHave(TXID, say('missing', 'unclear'))).toBe(true);
    expect(await chainMayHave(TXID, say('seen', 'missing'))).toBe(true);
    expect(await chainHasSeen(TXID, say('unclear', 'unclear'))).toBe(false);
    expect(await chainHasSeen(TXID, say('missing', 'seen'))).toBe(true);
    // The real lookups: WhatsOnChain 404 + ARC 404 → not known.
    const f404 = respond(404);
    expect(await chainMayHave(TXID, [wocLookup(f404), arcLookup(f404)])).toBe(false);
  });

  test("settleWhenSeen no longer sends a payment just because 1Sat's store has a copy", async () => {
    const w = fakeWallet();
    const r = await settleWhenSeen(w, TXID, {
      ...quiet,
      lookups: defaultLookups(async (u: string) =>
        u.includes('1sat.app') ? new Response('{}', { status: 200 }) : new Response('{}', { status: 404 }),
      ),
      settleDelaysMs: [0],
      sleep: async () => undefined,
    });
    expect(r).toBe('not-seen');
    expect(w.sent).toEqual([]);
  });
});

describe('sendThroughWallet: the wallet broadcasts a stored payment and says what happened', () => {
  const wallet = (answer: () => unknown) => ({
    abortAction: async () => {
      throw new Error('never aborts');
    },
    createAction: async () => {
      const a = answer();
      if (a instanceof Error) throw a;
      return a;
    },
  });
  const err = (fields: Record<string, unknown>) => Object.assign(new Error('WERR_REVIEW_ACTIONS'), fields);

  test("'unproven' sent; 'sending' pending (the wallet keeps retrying)", async () => {
    expect(
      await sendThroughWallet(
        wallet(() => ({ sendWithResults: [{ txid: TXID, status: 'unproven' }] })),
        TXID,
        quiet,
      ),
    ).toBe('sent');
    expect(
      await sendThroughWallet(
        wallet(() =>
          err({
            sendWithResults: [{ txid: TXID, status: 'sending' }],
            reviewActionResults: [{ txid: TXID, status: 'serviceError' }],
          }),
        ),
        TXID,
        quiet,
      ),
    ).toBe('pending');
  });

  test("'failed' is a refusal only when the broadcaster answered for it; with no post it is unknown", async () => {
    expect(
      await sendThroughWallet(
        wallet(() =>
          err({
            sendWithResults: [{ txid: TXID, status: 'failed' }],
            reviewActionResults: [{ txid: TXID, status: 'invalidTx' }],
          }),
        ),
        TXID,
        quiet,
      ),
    ).toBe('refused');
    // The batch / row was gone: the toolbox marks it failed without posting anything (no throw, no answers).
    expect(
      await sendThroughWallet(
        wallet(() => ({ sendWithResults: [{ txid: TXID, status: 'failed' }] })),
        TXID,
        quiet,
      ),
    ).toBe('unknown');
    expect(
      await sendThroughWallet(
        wallet(() => new Error('offline')),
        TXID,
        quiet,
      ),
    ).toBe('unknown');
    expect(
      await sendThroughWallet(
        wallet(() => ({})),
        'not-a-txid',
        quiet,
      ),
    ).toBe('unknown');
  });
});

describe('review 4 Nov 2026: refusals and releases need repeated answers', () => {
  const say = (...a: Sighting[]) => a.map((x) => async () => x);
  const fast = { delaysMs: [0, 1, 1], sleep: async () => undefined };

  test('chainVerdict: seen as soon as any retry sees it; missing only when every lookup says so on every retry', async () => {
    expect(await chainVerdict(TXID, say('missing', 'missing'), fast)).toBe('missing');
    expect(await chainVerdict(TXID, say('missing', 'unclear'), fast)).toBe('unclear');
    let n = 0;
    const lagging = async (): Promise<Sighting> => (++n >= 3 ? 'seen' : 'missing');
    expect(await chainVerdict(TXID, [lagging], fast)).toBe('seen'); // WhatsOnChain caught up on the third look
    expect(await chainVerdict('not-a-txid', say('missing'), fast)).toBe('unclear');
  });

  test('a WhatsOnChain 429 (or 5xx) is unclear, never missing', async () => {
    const r429 = async () => new Response('rate limited', { status: 429 });
    const r503 = async () => new Response('', { status: 503 });
    expect(await wocLookup(r429)(TXID)).toBe('unclear');
    expect(await wocLookup(r503)(TXID)).toBe('unclear');
    expect(
      await chainMayHave(TXID, [wocLookup(r429), arcLookup(async () => new Response('{}', { status: 404 }))]),
    ).toBe(true);
  });
});

describe('06c: lookups have deadlines; one look never counts an ARC refusal as "missing"', () => {
  test('every lookup passes an AbortSignal (a hung WhatsOnChain / ARC can not hold storage)', async () => {
    const signals: unknown[] = [];
    const f = async (_u: string, init?: RequestInit) => (
      signals.push(init?.signal),
      new Response('{}', { status: 404 })
    );
    await wocLookup(f)(TXID);
    await arcLookup(f)(TXID);
    await oneSatLookup(f)(TXID);
    await oneSatPresenceLookup(f)(TXID);
    expect(signals.length).toBe(4);
    for (const sig of signals) expect(sig).toBeInstanceOf(AbortSignal);
  });

  test('N15: chainLookups (one look) with ARC REJECTED and WhatsOnChain 404 says "may have it"', async () => {
    const f = async (u: string) =>
      u.includes('gorillapool')
        ? new Response(JSON.stringify({ txStatus: 'REJECTED' }), { status: 200 })
        : new Response('{}', { status: 404 });
    expect(await chainMayHave(TXID, chainLookups(f))).toBe(true);
  });
});
