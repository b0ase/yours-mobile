import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getAgentLog,
  markAgentAccount,
  setAgentDailyCap,
  setAgentStopped,
  setAllAgentsStopped,
} from '../agents/agentAccounts';
import { estimateCost } from '../mint/mint';
import type { OneSatContext } from '@1sat/actions';
import {
  AgentCallError,
  checkGrant,
  handleAgentCall,
  makeGrant,
  MAX_GRANT_DAYS,
  type AgentDeps,
  type AgentGrant,
} from './agentPairing';
import { makeMintLimits } from './mintScope';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
const NOW = Date.UTC(2026, 9, 5);
const code = (f: () => void) => {
  try {
    f();
    return 'OK';
  } catch (e) {
    return (e as AgentCallError).code;
  }
};

describe('CLI pairing grants', () => {
  beforeEach(() => {
    mem.clear();
    markAgentAccount('1A', [], NOW);
  });

  test('read is always granted; expiry is capped at 30 days', () => {
    const g = makeGrant('1A', 'trader', ['trade'], 365, NOW);
    expect(g.scopes).toEqual(['read', 'trade']);
    expect(g.expiresAt).toBe(NOW + MAX_GRANT_DAYS * 86_400_000);
  });

  test('scope, expiry, open account and agent status are all checked', () => {
    const g = makeGrant('1A', 'trader', ['trade'], 7, NOW);
    expect(code(() => checkGrant(g, 'buy', '1A', NOW))).toBe('OK');
    expect(code(() => checkGrant(g, 'send', '1A', NOW))).toBe('SCOPE');
    expect(code(() => checkGrant(g, 'balance', '1B', NOW))).toBe('NOT_OPEN');
    expect(code(() => checkGrant(g, 'balance', '1A', NOW + 8 * 86_400_000))).toBe('EXPIRED');
    expect(code(() => checkGrant(g, 'mint', '1A', NOW))).toBe('SCOPE');
    expect(code(() => checkGrant(g, 'nope', '1A', NOW))).toBe('UNKNOWN');
    expect(code(() => checkGrant(makeGrant('1Z', 'x', [], 1, NOW), 'info', '1Z', NOW))).toBe('NOT_AGENT');
    // b-Aware 25 Oct: a pot keeps no daily cap, so a paired CLI may never trade or send from it.
    markAgentAccount('1P', [], NOW, { kind: 'pot' });
    expect(code(() => checkGrant(makeGrant('1P', 'Pot', ['send'], 1, NOW), 'send', '1P', NOW))).toBe('NOT_AGENT');
  });
});

describe('paired CLI spends: Stop all, Stop, pause and the daily cap', () => {
  const RATE = 1_000_000; // USD per BSV, so a tiny mint costs cents and the cap is easy to reach
  const CONTENT = btoa('hi there');
  const oneMintUsd = estimateCost(6, 100, RATE).usd!;
  let signed = 0;
  let paused = false;
  const deps = (over: Partial<AgentDeps> = {}): AgentDeps => ({
    ctx: {} as OneSatContext,
    currentId: over.currentId ?? '1A',
    bsvUsd: async () => RATE,
    feeRate: () => 100,
    spendingPaused: async () => paused,
    mintMedia: async () => {
      signed++;
      return {
        txid: 'ab'.repeat(32),
        outpoint: `${'ab'.repeat(32)}_0`,
        origin: `${'ab'.repeat(32)}_0`,
        networkSats: null,
      };
    },
    ...over,
  });
  const mintParams = { contentType: 'text/plain', name: 'Note', base64Content: CONTENT };
  const callCode = async (g: AgentGrant, action: string, params: unknown, d: AgentDeps) => {
    try {
      await handleAgentCall(g, action, params, d);
      return 'OK';
    } catch (e) {
      return (e as AgentCallError).code;
    }
  };
  const mintGrant = (id = '1A') => makeGrant(id, 'minter', ['mint'], 7, Date.now(), makeMintLimits(10, 50));

  beforeEach(() => {
    mem.clear();
    signed = 0;
    paused = false;
    markAgentAccount('1A', []);
  });

  test('Stop all agents refuses a mint before signing, on agent and ordinary accounts', async () => {
    setAllAgentsStopped(true);
    expect(await callCode(mintGrant(), 'mint', mintParams, deps())).toBe('STOPPED');
    expect(await callCode(mintGrant('1M'), 'mint', mintParams, deps({ currentId: '1M' }))).toBe('STOPPED');
    expect(signed).toBe(0);
    setAllAgentsStopped(false);
    expect(await callCode(mintGrant('1M'), 'mint', mintParams, deps({ currentId: '1M' }))).toBe('OK');
    expect(signed).toBe(1);
  });

  test('Stop all turned on while a mint is being prepared still stops it before signing', async () => {
    const d = deps({
      currentId: '1M',
      bsvUsd: async () => {
        setAllAgentsStopped(true);
        return RATE;
      },
    });
    expect(await callCode(mintGrant('1M'), 'mint', mintParams, d)).toBe('STOPPED');
    expect(signed).toBe(0);
  });

  test("the account's own Stop and the spending pause refuse a mint", async () => {
    setAgentStopped('1A', true);
    expect(await callCode(mintGrant(), 'mint', mintParams, deps())).toBe('STOPPED');
    setAgentStopped('1A', false);
    paused = true;
    expect(await callCode(mintGrant(), 'mint', mintParams, deps())).toBe('PAUSED');
    expect(signed).toBe(0);
  });

  test("an agent account's daily cap covers paired-CLI mints, and each mint counts against it", async () => {
    setAgentDailyCap('1A', oneMintUsd * 1.5);
    const g = mintGrant();
    expect(await callCode(g, 'mint', mintParams, deps())).toBe('OK');
    const mint = getAgentLog('1A').find((e) => e.action === 'mint');
    expect(mint?.usd).toBeGreaterThan(0);
    expect(await callCode(g, 'mint', mintParams, deps())).toBe('REFUSED');
    expect(signed).toBe(1);
    expect(getAgentLog('1A')[0].action).toBe('refused');
  });

  test('buy and send from a paired CLI are refused under Stop all or the pause before anything runs', async () => {
    const g = makeGrant('1A', 'trader', ['trade', 'send'], 7, Date.now());
    setAllAgentsStopped(true);
    expect(await callCode(g, 'buy', { tokenId: 'x', usd: 1 }, deps())).toBe('STOPPED');
    expect(await callCode(g, 'send', { to: '1B', usd: 1 }, deps())).toBe('STOPPED');
    setAllAgentsStopped(false);
    paused = true;
    expect(await callCode(g, 'send', { to: '1B', usd: 1 }, deps())).toBe('PAUSED');
  });
});
