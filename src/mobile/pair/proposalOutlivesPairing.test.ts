/**
 * b-Aware 315 review: a strategy proposal must not outlive the pairing that sent it. Disconnect, a lapse (grant
 * expired) and removing the wallet drop it, and isAgentSessionLive (what Approve checks) says no once the pairing is
 * gone. Local only: fake WebSocket, in-memory storage, no network.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { stubGlobals } from '../../testing/stubGlobals';
import { exampleStrategy } from '../agents/strategy';
import { getProposal, proposeStrategy } from '../agents/strategyProposal';
import { makeGrant, type AgentGrant } from './agentPairing';

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
stubGlobals({
  WebSocket: FakeWS,
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
  document: { visibilityState: 'visible', addEventListener: () => undefined },
});

// A private copy of sessions.ts (bun shares one module registry across test files).
const sessions = (await import('./sessions?proposalOutlivesPairing' as string)) as typeof import('./sessions');
afterAll(() => sessions.__resetPairingForTests());

const ID = '1AgentProposalAccount';
const C = 'PROPOSALCHANNELPROPOSA';
const SESSIONS_KEY = 'bwallet.pair.sessions';

/** Store a CLI pairing for `c` the way sessions.ts does. */
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
};
const propose = (session: string) =>
  proposeStrategy(ID, { ...exampleStrategy('ABC'), name: 'Wide' }, { computer: 'trader', session });

beforeEach(() => {
  mem.clear();
  sessions.setPairRevoker(async () => true);
  sessions.setAgentPairDeps({ ctx: undefined, currentId: ID, accountCount: 1, accountIds: [ID] });
});

describe('a strategy proposal ends with its pairing', () => {
  test('a live pairing keeps its proposal and counts as live for Approve', () => {
    pairChannel(C, makeGrant(ID, 'trader', ['strategy'], 7));
    propose(C);
    expect(sessions.pairedSites().length).toBe(1);
    expect(getProposal(ID)?.session).toBe(C);
    expect(sessions.isAgentSessionLive(C, ID)).toBe(true);
    expect(sessions.isAgentSessionLive(C, '1SomeOtherAccount')).toBe(false);
  });

  test('Disconnect (forget) drops the proposal it sent', () => {
    pairChannel(C, makeGrant(ID, 'trader', ['strategy'], 7));
    propose(C);
    sessions.forget(C, false);
    expect(getProposal(ID)).toBeNull();
    expect(sessions.isAgentSessionLive(C, ID)).toBe(false);
  });

  test("Disconnect leaves another pairing's proposal alone", () => {
    pairChannel(C, makeGrant(ID, 'trader', ['strategy'], 7));
    pairChannel('OTHERCHANNELOTHERCHANN', makeGrant(ID, 'trader', ['strategy'], 7));
    propose('OTHERCHANNELOTHERCHANN');
    sessions.forget(C, false);
    expect(getProposal(ID)?.session).toBe('OTHERCHANNELOTHERCHANN');
  });

  test('a pairing whose grant expired drops its proposal when it lapses', () => {
    pairChannel(C, { ...makeGrant(ID, 'trader', ['strategy'], 7), expiresAt: Date.now() - 1 });
    propose(C);
    expect(sessions.isAgentSessionLive(C, ID)).toBe(false);
    expect(sessions.pairedSites().length).toBe(0); // load() drops the lapsed session
    expect(getProposal(ID)).toBeNull();
  });

  test('removing the wallet drops it too', () => {
    pairChannel(C, makeGrant(ID, 'trader', ['strategy'], 7));
    propose(C);
    sessions.closeAllPairings();
    expect(getProposal(ID)).toBeNull();
  });
});
