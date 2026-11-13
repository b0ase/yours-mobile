/**
 * b-Aware report (13 Nov 2026): (a) a paired computer unpaired while a slow mint held the spend queue still got the
 * buy / send queued behind it signed after forget(); (b) Stop pressed after an agent spend passed its check (while the
 * listing or paymail was being checked) still let it sign. Every spend now looks again inside the queued job and right
 * before the wallet's createAction. Local only: fake WebSocket, in-memory storage, stub market / wallet, no network.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { stubGlobals } from '../../testing/stubGlobals';
import {
  getAgentLog,
  markAgentAccount,
  setAgentStopped,
  setAllAgentsStopped,
} from '../agents/agentAccounts';
import { runAgentAction, type AgentTradeIo } from '../agents/agentTrade';
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
  document: { visibilityState: 'visible', addEventListener: () => undefined },
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
const SESSIONS_KEY = 'bwallet.pair.sessions';

/** Counts what actually reached the wallet's signing call. */
let signed = 0;
let paused = false;
const wallet = {
  createAction: async () => {
    signed++;
    return { txid: TXID };
  },
  getPublicKey: async () => ({ publicKey: '02' + '11'.repeat(32) }),
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
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('REFUSED');
    expect(signed).toBe(0);
  });

  test('unpaired while a paymail destination is fetched inside send: refused before createAction', async () => {
    const g = grantFor();
    const c = 'PAYMAILPAYMAILPAYMAILP';
    const isLive = pairChannel(c, g);
    const send = viaWallet(() => sessions.forget(c, false));
    const d = deps(g, { isLive, tradeIo: io({ send: send as never }) });
    expect(await callCode(g, 'send', { to: 'someone@bwalletx.com', usd: 0.5 }, d)).toBe('REFUSED');
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
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('REFUSED');
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
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('REFUSED');
    expect(signed).toBe(0);
  });

  test('Stop pressed inside the buy, before the wallet signs: createAction refuses', async () => {
    const g = grantFor();
    const d = deps(g, { tradeIo: io({ buy: viaWallet(() => setAllAgentsStopped(true)) as never }) });
    expect(await callCode(g, 'buy', { tokenId: TOKEN, usd: 1 }, d)).toBe('REFUSED');
    expect(signed).toBe(0);
  });

  test('Stop pressed while a paymail is resolved inside send: refused before createAction', async () => {
    const g = grantFor();
    const d = deps(g, { tradeIo: io({ send: viaWallet(() => setAgentStopped(ID, true)) as never }) });
    expect(await callCode(g, 'send', { to: 'someone@bwalletx.com', usd: 0.5 }, d)).toBe('REFUSED');
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
    const r = await runAgentAction(ctx, ID, { kind: 'send', token: 'BSV', usd: 0.5, to: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }, RATE, {
      io: io({ send: viaWallet(() => void loadStrategy(ID, exampleStrategy(), 'paper')) as never }),
    });
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
