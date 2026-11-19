/**
 * b-Aware 315 review: a strategy proposal must not outlive the pairing that sent it. Disconnect, a lapse (grant
 * expired), a re-pair on the same channel and removing the wallet drop it, and isAgentSessionLive (what Approve checks)
 * says no once the pairing is gone, lacks the `strategy` scope or holds a different grant. Local only: fake WebSocket,
 * in-memory storage, throwaway keys, no network.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_VERSION, pairUrl } from '../../pair/protocol';
import { stubGlobals } from '../../testing/stubGlobals';
import { exampleStrategy } from '../agents/strategy';
import { getProposal, proposeStrategy } from '../agents/strategyProposal';
import { CLI_ORIGIN, makeGrant, type AgentGrant } from './agentPairing';

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
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
const propose = (session: string, grant: AgentGrant) =>
  proposeStrategy(
    ID,
    { ...exampleStrategy('ABC'), name: 'Wide' },
    { computer: 'trader', session, expiresAt: grant.expiresAt },
  );
const settle = () => new Promise<void>((r) => setTimeout(r, 25));

beforeEach(() => {
  mem.clear();
  sessions.setPairRevoker(async () => true);
  sessions.setAgentPairDeps({ ctx: undefined, currentId: ID, accountCount: 1, accountIds: [ID] });
});

describe('a strategy proposal ends with its pairing', () => {
  test('a live pairing keeps its proposal and counts as live for Approve', () => {
    const g = makeGrant(ID, 'trader', ['strategy'], 7);
    pairChannel(C, g);
    propose(C, g);
    expect(sessions.pairedSites().length).toBe(1);
    expect(getProposal(ID)?.session).toBe(C);
    expect(sessions.isAgentSessionLive(C, ID, g.expiresAt)).toBe(true);
    expect(sessions.isAgentSessionLive(C, '1SomeOtherAccount', g.expiresAt)).toBe(false);
  });

  test('Approve needs the same grant, still holding the strategy scope', () => {
    const g = makeGrant(ID, 'trader', ['trade'], 7);
    pairChannel(C, g);
    expect(sessions.isAgentSessionLive(C, ID, g.expiresAt)).toBe(false); // no 'strategy' scope
    mem.clear();
    const s = makeGrant(ID, 'trader', ['strategy'], 7);
    pairChannel(C, s);
    expect(sessions.isAgentSessionLive(C, ID, s.expiresAt + 1)).toBe(false); // another grant on this channel
  });

  test("a re-pair on the same channel drops the old pairing's proposal", async () => {
    const old = makeGrant(ID, 'trader', ['strategy'], 7, Date.now() - 1000);
    pairChannel(C, old);
    propose(C, old);
    const url = pairUrl({
      v: PAIR_VERSION,
      r: 'relay.bwallet.space',
      c: C,
      k: PrivateKey.fromRandom().toPublicKey().toString(),
      o: CLI_ORIGIN,
      e: Math.floor(Date.now() / 1000) + 120,
    });
    const pending = sessions.beginPairing(url, { allowCli: true });
    FakeWS.all.at(-1)!.deliver({ t: 'relay', verifiedOrigin: CLI_ORIGIN });
    const fresh = makeGrant(ID, 'trader', ['trade'], 7); // "Suggest strategies" off this time
    (await pending).confirm(fresh);
    await settle();
    expect(sessions.pairedSites().find((s) => s.c === C)?.agent?.expiresAt).toBe(fresh.expiresAt);
    expect(getProposal(ID)).toBeNull();
    expect(sessions.isAgentSessionLive(C, ID, old.expiresAt)).toBe(false);
  });

  test('Disconnect (forget) drops the proposal it sent', () => {
    const g = makeGrant(ID, 'trader', ['strategy'], 7);
    pairChannel(C, g);
    propose(C, g);
    sessions.forget(C, false);
    expect(getProposal(ID)).toBeNull();
    expect(sessions.isAgentSessionLive(C, ID, g.expiresAt)).toBe(false);
  });

  test("Disconnect leaves another pairing's proposal alone", () => {
    const g = makeGrant(ID, 'trader', ['strategy'], 7);
    pairChannel(C, g);
    pairChannel('OTHERCHANNELOTHERCHANN', g);
    propose('OTHERCHANNELOTHERCHANN', g);
    sessions.forget(C, false);
    expect(getProposal(ID)?.session).toBe('OTHERCHANNELOTHERCHANN');
  });

  test('a pairing whose grant expired drops its proposal when it lapses', () => {
    const g = { ...makeGrant(ID, 'trader', ['strategy'], 7), expiresAt: Date.now() - 1 };
    pairChannel(C, g);
    propose(C, g);
    expect(sessions.isAgentSessionLive(C, ID, g.expiresAt)).toBe(false);
    expect(sessions.pairedSites().length).toBe(0); // load() drops the lapsed session
    expect(getProposal(ID)).toBeNull();
  });

  test('removing the wallet drops it too', () => {
    const g = makeGrant(ID, 'trader', ['strategy'], 7);
    pairChannel(C, g);
    propose(C, g);
    sessions.closeAllPairings();
    expect(getProposal(ID)).toBeNull();
  });
});
