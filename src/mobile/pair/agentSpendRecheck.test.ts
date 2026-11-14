/**
 * b-Aware report (13 Nov 2026): (a) a paired computer unpaired while a slow mint held the spend queue still got the
 * buy / send queued behind it signed after forget(); (b) Stop pressed after an agent spend passed its check (while the
 * listing or paymail was being checked) still let it sign. Every spend now looks again inside the queued job and right
 * before the wallet's createAction. Local only: fake WebSocket, in-memory storage, stub market / wallet, no network.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { PrivateKey } from '@bsv/sdk';
import { stubGlobals } from '../../testing/stubGlobals';
import { getAgentLog, markAgentAccount, setAgentStopped, setAllAgentsStopped } from '../agents/agentAccounts';
import { appendAgentLog, MAX_SPENDS_PER_HOUR } from '../agents/agentAccounts';
import { runAgentAction, type AgentTradeIo } from '../agents/agentTrade';
import { checkedPurchaseContext } from '../p2p/checkedPurchase';
import { serialSpend } from '../agents/spendQueue';
import { AgentCallError, handleAgentCall, makeGrant, type AgentDeps, type AgentGrant } from './agentPairing';
import { makeMintLimits } from './mintScope';

class FakeWS {
  readyState = 1;
  onmessage = null;
  onopen = null;
  onclose = null;
  onerror = null;
  send() {}
  close() {
    this.readyState = 3;
  }
}
const mem = new Map<string, string>();
let storageBlocked = false;
let visibility = 'visible';
stubGlobals({
  WebSocket: FakeWS,
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (storageBlocked) throw new Error('QuotaExceededError');
      mem.set(k, v);
    },
    removeItem: (k: string) => void mem.delete(k),
  },
  document: {
    get visibilityState() {
      return visibility;
    },
    addEventListener: () => undefined,
  },
});

// A private copy of sessions.ts (bun shares one module registry across test files).
const sessions = (await import('./sessions?agentSpendRecheck' as string)) as typeof import('./sessions');
afterAll(() => sessions.__resetPairingForTests());

const ID = '1AgentRecheckAccount';
const RATE = 50; // USD per BSV
const TOKEN = `${'ab'.repeat(32)}_0`;
const LISTING = {
  outpoint: `${'cd'.repeat(32)}_0`,
  priceSats: 100_000, // $0.05
  perTokenSats: 10_000,
  amount: '10',
  label: '10 TEST',
  origin: null,
  seller: '',
  buyable: true,
};
const TXID = 'ef'.repeat(32);
const PUBKEY = PrivateKey.fromRandom().toPublicKey().toString(); // throwaway, for checkedPurchaseContext
const SESSIONS_KEY = 'bwallet.pair.sessions';

/** Counts what actually reached the wallet's signing call. */
let signed = 0;
let paused = false;
const wallet = {
  createAction: async () => {
    signed++;
    return { txid: TXID };
  },
  getPublicKey: async () => ({ publicKey: PUBKEY }),
};
const ctx = { wallet } as unknown as OneSatContext;

/** Like upstream buyBsv21 / sendBsv: some awaits, then createAction; errors come back as { error }. */
const viaWallet =
  (before?: () => void | Promise<void>) =>
  async (c: OneSatContext): Promise<{ txid?: string; error?: string }> => {
    try {
      await before?.();
      const r = (await c.wallet.createAction({ description: 'x', outputs: [] } as never)) as { txid?: string };
      return { txid: r.txid };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

const io = (over: Partial<AgentTradeIo> = {}): Partial<AgentTradeIo> => ({
  roomMarket: (async () => ({ listings: [LISTING] })) as never,
  roomMeta: (async () => ({ title: '$TEST' })) as never,
  assertOrdLockV2: async () => undefined,
  checkedPurchaseContext: (async (c: OneSatContext) => c) as never,
  buy: viaWallet() as never,
  send: viaWallet() as never,
  spendingPaused: async () => paused,
  ...over,
});

const grantFor = () => makeGrant(ID, 'trader', ['trade', 'send'], 7);

const deps = (grant: AgentGrant, over: Partial<AgentDeps> = {}): AgentDeps => ({
  ctx,
  currentId: ID,
  bsvUsd: async () => RATE,
  spendingPaused: async () => paused,
  tradeIo: io(),
  ...over,
});

const callCode = async (g: AgentGrant, action: string, params: unknown, d: AgentDeps) => {
  try {
    await handleAgentCall(g, action, params, d);
    return 'OK';
  } catch (e) {
    return e instanceof AgentCallError ? e.code : `THROW ${String(e)}`;
  }
};

/** Store a live CLI pairing for `c` the way sessions.ts does, and make it the open account's. */
const pairChannel = (c: string, grant: AgentGrant) => {
  const now = Date.now();
  const all = JSON.parse(mem.get(SESSIONS_KEY) ?? '[]') as unknown[];
  all.push({
    c,
    r: 'relay.bwallet.space',
    origin: 'https://cli.bwalletx.com',
    sitePub: '02' + '22'.repeat(32),
    phoneKey: '33'.repeat(32),
    sent: 0,
    lastSeen: 0,
    createdAt: now,
    lastUsed: now,
    agent: grant,
    account: ID,
  });
  mem.set(SESSIONS_KEY, JSON.stringify(all));
  return sessions.pairingLiveCheck(c, grant, ctx);
};

/** Hold the spend queue (a slow mint) until release() is called. */
const holdQueue = () => {
  let release!: () => void;
  const held = serialSpend(() => new Promise<void>((r) => (release = r)));
  return { release: () => (release(), held) };
};
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

beforeEach(() => {
  mem.clear();
  storageBlocked = false;
  visibility = 'visible';
  signed = 0;
  paused = false;
  markAgentAccount(ID, []);
  sessions.setPairRevoker(async () => true);
  sessions.setAgentPairDeps({ ctx, currentId: ID, accountCount: 1, accountIds: [ID] });
});

describe('unpair while a spend waits in the queue (report a)', () => {
  test('the normal path still signs once and logs the spend', async () => {
    const g = grantFor();
    const isLive = pairChannel('NORMALNORMALNORMALNORM', g);
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, deps(g, { isLive }))).toBe('OK');
    expect(await callCode(g, 'send', { to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usd: 0.5 }, deps(g, { isLive }))).toBe(
      'OK',
    );
    expect(signed).toBe(2);
    expect(getAgentLog(ID).filter((e) => e.action === 'buy' || e.action === 'send')).toHaveLength(2);
  });

  test('forget() while a buy is queued behind a slow mint: refused, nothing signed', async () => {
    const g = grantFor();
    const c = 'QUEUEDQUEUEDQUEUEDQUEU';
    const isLive = pairChannel(c, g);
    const q = holdQueue();
    const buy = callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, deps(g, { isLive }));
    await tick();
    sessions.forget(c, false);
    await q.release();
    expect(await buy).toBe('UNPAIRED');
    expect(signed).toBe(0);
  });

  test('several requests queued after unpair are all refused', async () => {
    const g = grantFor();
    const c = 'SEVERALSEVERALSEVERALS';
    const isLive = pairChannel(c, g);
    const q = holdQueue();
    const d = deps(g, { isLive });
    const calls = [
      callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d),
      callCode(g, 'send', { to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usd: 0.5 }, d),
      callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d),
      callCode(g, 'send', { to: 'someone@bwalletx.com', usd: 0.5 }, d),
    ];
    await tick();
    sessions.forget(c, false);
    await q.release();
    expect(await Promise.all(calls)).toEqual(['UNPAIRED', 'UNPAIRED', 'UNPAIRED', 'UNPAIRED']);
    expect(signed).toBe(0);
  });

  test('unpair wins even when storage is blocked and the session cannot be removed', async () => {
    const g = grantFor();
    const c = 'BLOCKEDBLOCKEDBLOCKEDB';
    const isLive = pairChannel(c, g);
    const q = holdQueue();
    const buy = callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, deps(g, { isLive }));
    await tick();
    storageBlocked = true;
    sessions.forget(c, false);
    storageBlocked = false;
    await q.release();
    expect(await buy).toBe('UNPAIRED');
    expect(signed).toBe(0);
  });

  test('switching to another account while queued refuses the spend', async () => {
    const g = grantFor();
    const isLive = pairChannel('SWITCHSWITCHSWITCHSWIT', g);
    const q = holdQueue();
    const buy = callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, deps(g, { isLive }));
    await tick();
    sessions.setAgentPairDeps({ ctx, currentId: '1OtherAccount', accountCount: 2, accountIds: [ID, '1OtherAccount'] });
    await q.release();
    expect(await buy).toBe('UNPAIRED');
    expect(signed).toBe(0);
  });

  test('unpaired while the listing is checked (after the queue): refused before signing', async () => {
    const g = grantFor();
    const c = 'LISTINGLISTINGLISTINGL';
    const isLive = pairChannel(c, g);
    const d = deps(g, { isLive, tradeIo: io({ assertOrdLockV2: async () => sessions.forget(c, false) }) });
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('UNPAIRED');
    expect(signed).toBe(0);
  });

  test('unpaired while a paymail destination is fetched inside send: refused before createAction', async () => {
    const g = grantFor();
    const c = 'PAYMAILPAYMAILPAYMAILP';
    const isLive = pairChannel(c, g);
    const send = viaWallet(() => sessions.forget(c, false));
    const d = deps(g, { isLive, tradeIo: io({ send: send as never }) });
    expect(await callCode(g, 'send', { to: 'someone@bwalletx.com', usd: 0.5 }, d)).toBe('UNPAIRED');
    expect(signed).toBe(0);
  });

  test('a mint queued behind another spend is refused after unpair', async () => {
    const g = makeGrant(ID, 'minter', ['mint'], 7, Date.now(), makeMintLimits(5, 5));
    const c = 'MINTMINTMINTMINTMINTMI';
    const isLive = pairChannel(c, g);
    let minted = 0;
    const q = holdQueue();
    const mint = callCode(
      g,
      'mint',
      { contentType: 'text/plain', name: 'Note', base64Content: btoa('hi') },
      deps(g, {
        isLive,
        feeRate: () => 100,
        mintMedia: async () => {
          minted++;
          return { txid: TXID, outpoint: `${TXID}_0`, origin: `${TXID}_0`, networkSats: null };
        },
      }),
    );
    await tick();
    sessions.forget(c, false);
    await q.release();
    expect(await mint).toBe('UNPAIRED');
    expect(minted).toBe(0);
  });

  test('the spending pause turned on while queued refuses the spend', async () => {
    const g = grantFor();
    const isLive = pairChannel('PAUSEPAUSEPAUSEPAUSEPA', g);
    const q = holdQueue();
    const buy = callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, deps(g, { isLive }));
    await tick();
    paused = true;
    await q.release();
    expect(await buy).toBe('PAUSED');
    expect(signed).toBe(0);
  });
});

describe('Stop pressed after the spend passed its check (report b)', () => {
  test('Stop all during the listing check: refused, nothing signed', async () => {
    const g = grantFor();
    const d = deps(g, { tradeIo: io({ assertOrdLockV2: async () => setAllAgentsStopped(true) }) });
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('STOPPED');
    expect(signed).toBe(0);
  });

  test("the account's Stop during the purchase-context check: refused", async () => {
    const g = grantFor();
    const d = deps(g, {
      tradeIo: io({
        checkedPurchaseContext: (async (c: OneSatContext) => {
          setAgentStopped(ID, true);
          return c;
        }) as never,
      }),
    });
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('STOPPED');
    expect(signed).toBe(0);
  });

  test('Stop pressed inside the buy, before the wallet signs: createAction refuses', async () => {
    const g = grantFor();
    const d = deps(g, { tradeIo: io({ buy: viaWallet(() => setAllAgentsStopped(true)) as never }) });
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('STOPPED');
    expect(signed).toBe(0);
  });

  test('Stop pressed while a paymail is resolved inside send: refused before createAction', async () => {
    const g = grantFor();
    const d = deps(g, { tradeIo: io({ send: viaWallet(() => setAgentStopped(ID, true)) as never }) });
    expect(await callCode(g, 'send', { to: 'someone@bwalletx.com', usd: 0.5 }, d)).toBe('STOPPED');
    expect(signed).toBe(0);
    expect(getAgentLog(ID).some((e) => e.action === 'refused' && /stopped/i.test(e.detail))).toBe(true);
  });

  test('b agent chat (no pairing): Stop during the listing check still refuses', async () => {
    const r = await runAgentAction(ctx, ID, { kind: 'buy', token: TOKEN, usd: 1 }, RATE, {
      io: io({ assertOrdLockV2: async () => setAllAgentsStopped(true) }),
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^Refused: /);
    expect(signed).toBe(0);
  });

  test('a strategy switched to paper meanwhile is not signed live', async () => {
    const { loadStrategy, exampleStrategy } = await import('../agents/strategy');
    const r = await runAgentAction(
      ctx,
      ID,
      { kind: 'send', token: 'BSV', usd: 0.5, to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' },
      RATE,
      {
        io: io({ send: viaWallet(() => void loadStrategy(ID, exampleStrategy(), 'paper')) as never }),
      },
    );
    expect(r.ok).toBe(false);
    expect(signed).toBe(0);
  });

  test('a beforeSign hook that throws fails closed', async () => {
    const r = await runAgentAction(ctx, ID, { kind: 'buy', token: TOKEN, usd: 1 }, RATE, {
      io: io(),
      beforeSign: () => {
        throw new Error('liveness unknown');
      },
    });
    expect(r).toEqual({ ok: false, text: 'Refused: liveness unknown' });
    expect(signed).toBe(0);
  });
});

describe('review fixes (13 Nov 2026)', () => {
  test('a paymail send that broadcast but failed delivery is logged and answered ok (no retry, caps count it)', async () => {
    const g = grantFor();
    const send = async () => ({ txid: TXID, error: 'delivery-failed: P2P send failed: 500' });
    const d = deps(g, { tradeIo: io({ send: send as never }) });
    const r = (await handleAgentCall(g, 'send', { to: 'someone@bwalletx.com', usd: 0.5 }, d)) as {
      text: string;
      txid: string;
    };
    expect(r.txid).toBe(TXID);
    expect(r.text).toMatch(/delivery-failed/);
    const sent = getAgentLog(ID).filter((e) => e.action === 'send');
    expect(sent).toHaveLength(1);
    expect(sent[0].usd).toBe(0.5);
  });

  test('a send with no txid is still a failure and not logged as spent', async () => {
    const g = grantFor();
    const send = async () => ({ error: 'no-txid-returned' });
    expect(
      await callCode(
        g,
        'send',
        { to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usd: 0.5 },
        deps(g, { tradeIo: io({ send: send as never }) }),
      ),
    ).toBe('REFUSED');
    expect(getAgentLog(ID).filter((e) => e.action === 'send')).toHaveLength(0);
  });

  test('b agent chat send: the spending pause refuses it (fail closed when the status read throws)', async () => {
    const block = { kind: 'send' as const, token: 'BSV', usd: 0.5, to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' };
    paused = true;
    expect((await runAgentAction(ctx, ID, block, RATE, { io: io() })).ok).toBe(false);
    const r = await runAgentAction(ctx, ID, block, RATE, {
      io: io({ spendingPaused: async () => Promise.reject(new Error('offline')) }),
    });
    expect(r.ok).toBe(false);
    expect(signed).toBe(0);
    paused = false;
    expect((await runAgentAction(ctx, ID, block, RATE, { io: io() })).ok).toBe(true);
    expect(signed).toBe(1);
  });

  test('pause turned on during the listing check reaches the computer as PAUSED', async () => {
    const g = grantFor();
    const isLive = pairChannel('PAUSE2PAUSE2PAUSE2PAUS', g);
    const d = deps(g, {
      isLive,
      tradeIo: io({
        assertOrdLockV2: async () => {
          paused = true;
        },
      }),
    });
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('PAUSED');
    expect(signed).toBe(0);
  });

  test('pairingLiveCheck only reads storage: no write, and a failing write cannot refuse a live pairing', () => {
    const g = grantFor();
    const isLive = pairChannel('READONLYREADONLYREADON', g);
    // Another, lapsed pairing in storage: load() would rewrite storage to drop it (and, with the write failing,
    // answer "no sessions" and refuse this live one).
    pairChannel('LAPSEDLAPSEDLAPSEDLAPS', { ...g, expiresAt: Date.now() - 1 });
    const before = mem.get(SESSIONS_KEY);
    storageBlocked = true;
    expect(isLive()).toBe(true);
    storageBlocked = false;
    expect(mem.get(SESSIONS_KEY)).toBe(before);
  });

  test('an expired grant or an unpinned relay is not live', () => {
    const g = grantFor();
    const c = 'EXPIREDEXPIREDEXPIREDE';
    const isLive = pairChannel(c, g);
    const edit = (patch: Record<string, unknown>) =>
      mem.set(
        SESSIONS_KEY,
        JSON.stringify(
          (JSON.parse(mem.get(SESSIONS_KEY)!) as Array<Record<string, unknown>>).map((x) =>
            x.c === c ? { ...x, ...patch } : x,
          ),
        ),
      );
    edit({ r: 'relay.attacker.invalid' });
    expect(isLive()).toBe(false);
    edit({ r: 'relay.bwallet.space', agent: { ...g, expiresAt: Date.now() - 1 } });
    expect(sessions.pairingLiveCheck(c, { ...g, expiresAt: Date.now() - 1 }, ctx)()).toBe(false);
  });

  // Reviewer's probes.
  test('a socket reconnect (wake) and a same-account deps refresh leave queued work alone', async () => {
    const g = grantFor();
    const isLive = pairChannel('WAKEWAKEWAKEWAKEWAKEWA', g);
    const q = holdQueue();
    const buy = callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, deps(g, { isLive }));
    await tick();
    visibility = 'hidden';
    sessions.onPairVisibility();
    await new Promise((r) => setTimeout(r, 10));
    visibility = 'visible';
    sessions.onPairVisibility();
    sessions.setAgentPairDeps({ ctx, currentId: ID, accountCount: 1, accountIds: [ID] });
    expect(isLive()).toBe(true);
    await q.release();
    expect(await buy).toBe('OK');
    expect(signed).toBe(1);
  });

  test('hourly limit boundary: with 29 spends this hour the 30th still signs (the last look does not double count)', async () => {
    const g = grantFor();
    const isLive = pairChannel('HOURHOURHOURHOURHOURHO', g);
    for (let i = 0; i < MAX_SPENDS_PER_HOUR - 1; i++)
      appendAgentLog(ID, { at: Date.now() - 1000, action: 'send', detail: 'x', usd: 0.01 });
    const d = deps(g, { isLive });
    expect(await callCode(g, 'send', { to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usd: 0.5 }, d)).toBe('OK');
    expect(signed).toBe(1);
    expect(await callCode(g, 'send', { to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', usd: 0.5 }, d)).toBe('REFUSED');
    expect(signed).toBe(1);
  });

  // Through the real wrappers, not io stubs: gatedContext over the real purchaseContext + checkedPurchaseContext
  // (checkedContext), and the real guardedSendBsv → upstream sendBsv → createAction.
  test('real guardedSendBsv: a refusal inside createAction comes back Refused and the wallet never signs', async () => {
    let looks = 0;
    // Upstream sendBsv (@1sat/actions payments) catches whatever createAction throws, logs it with
    // console.error('[sendBsv]', error) and returns { error }. So the refusal is not an unhandled rejection: it
    // reaches runAgentAction as { error } and comes back Refused. Capture that one log and assert it is exactly the
    // refusal, so any other error printed here fails the test instead of passing silently.
    const logged: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a);
    let r: Awaited<ReturnType<typeof runAgentAction>>;
    try {
      r = await runAgentAction(
        ctx,
        ID,
        { kind: 'send', token: 'BSV', usd: 0.5, to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' },
        RATE,
        {
          io: { spendingPaused: async () => false }, // the real send
          // Passes the look before sendBsv, refuses the one inside createAction.
          beforeSign: () => (++looks === 1 ? null : 'Pressed Stop while sending'),
        },
      );
    } finally {
      console.error = orig;
    }
    expect(logged).toHaveLength(1);
    expect(logged[0][0]).toBe('[sendBsv]');
    expect(logged[0][1]).toBeInstanceOf(Error);
    expect((logged[0][1] as Error).message).toBe('Pressed Stop while sending');
    expect(looks).toBe(2);
    expect(r).toEqual({ ok: false, text: 'Refused: Pressed Stop while sending' });
    expect(signed).toBe(0);
    expect(getAgentLog(ID).filter((e) => e.action === 'send')).toHaveLength(0);
  });

  test('real guardedSendBsv: the normal path reaches the wallet once', async () => {
    const r = await runAgentAction(
      ctx,
      ID,
      { kind: 'send', token: 'BSV', usd: 0.5, to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' },
      RATE,
      { io: { spendingPaused: async () => false } },
    );
    expect(r.ok).toBe(true);
    expect(signed).toBe(1);
  });

  test('real purchaseContext + checkedPurchaseContext: Stop inside the buy is refused before their createAction', async () => {
    const r = await runAgentAction(ctx, ID, { kind: 'buy', token: TOKEN, usd: 1 }, RATE, {
      io: io({
        checkedPurchaseContext, // the real one (checkedContext)
        buy: viaWallet(() => setAgentStopped(ID, true)) as never,
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/^Refused: .*stopped/i);
    expect(signed).toBe(0);
  });
});
