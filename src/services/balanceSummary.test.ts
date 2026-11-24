import { afterEach, describe, expect, test } from 'bun:test';
import { getBsv21Balances } from '@1sat/actions';
import {
  BALANCE_CACHE_MS,
  BALANCE_READ_BASKET,
  BALANCE_READ_DETAIL,
  BALANCE_READ_LABEL,
  BALANCE_READ_LINE,
  BALANCE_SUMMARY_ACTION,
  BalanceSummaryMemory,
  isBalanceReadRequestId,
  isBalanceSummaryAction,
  readBalanceSummary,
  runBalanceSummary,
  summarizeBalance,
  type BalanceAnswer,
  type BalanceSummaryDeps,
} from './balanceSummary';
import { balanceSplit } from './depositBalance';
import { approvalKindForSheet } from './approvalKind';
import { buildSheetModel, type BundleRequest } from './permissionBundle';
import { revokeBasketGrantsForOriginator, revokeReservedBasketGrants, isReservedBasket } from './reservedBaskets';
import { SessionBasketDenials } from './sessionDenials';
import { needsReconnect, noteDisconnect, noteReconnected, parseReconnectState } from './reconnectGate';
import { heldBsv21BalancesWithout } from '../mobile/airdrops/heldBalances';
import {
  QUARANTINE_MIRROR_PREFIX,
  mirrorQuarantine,
  quarantineFor,
  readQuarantineMirror,
  saveItems,
  saveSolicited,
  type MirrorArea,
} from '../mobile/airdrops/inbox';
import { mergeConnections, BALANCE_GRANT_KEY } from '../mobile/wallet/connectionLog';
import { parseXdmRequest } from '../mobile/bappFrame/frameBridge';

const ADDRESS = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const TXID = 'ab'.repeat(32);
const SCRIPT = '76a914' + 'cd'.repeat(20) + '88ac';
const ACCOUNT = '1AccountIdentityAddress';

/** A chrome.storage.local stand-in: the one place the UI and the background both reach. */
const makeArea = (): MirrorArea & { data: Record<string, unknown> } => {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k) => (k in data ? { [k]: data[k] } : {}),
    set: async (v) => void Object.assign(data, v),
  };
};

/** The wallet card's own balance function over a wallet with money in the funding AND the deposit basket. */
const cardWallet = {
  balance: async () => 3000,
  listOutputs: async () => ({ totalOutputs: 1, outputs: [{ satoshis: 500, spendable: true }] }),
};
const TOKENS = [
  { p: 'bsv-21', id: 'tokA_0', sym: 'AAA', dec: 2, amt: '1000' },
  { p: 'bsv-21', id: 'tokB_0', sym: 'BBB', dec: 0, amt: '9007199254740993' },
  { p: 'bsv-21', id: 'Quarantined.0', sym: 'SPAM', dec: 0, amt: '5' },
];
const realExecute = getBsv21Balances.execute;
afterEach(() => {
  (getBsv21Balances as { execute: unknown }).execute = realExecute;
});
const stubTokenList = () => {
  (getBsv21Balances as { execute: unknown }).execute = async () => TOKENS;
};

/** The read exactly as the background wires it: card total, mirror from storage, the real held-list filter. */
const backgroundRead = (area: MirrorArea | null) =>
  readBalanceSummary({
    total: async () => (await balanceSplit(cardWallet)).total,
    quarantined: () => readQuarantineMirror(ACCOUNT, area),
    held: (q) => heldBsv21BalancesWithout({} as never, q),
  });

/** A grant store keyed by origin, as the background keeps one (a basket grant under the site's own originator). */
const makeDeps = (answer: BalanceAnswer, opts: { locked?: boolean; blocked?: boolean } = {}) => {
  const grants = new Map<string, number | undefined>();
  const denied = new Set<string>();
  const calls = { asked: [] as string[], read: 0 };
  let account = ACCOUNT;
  let release: (() => void) | undefined;
  const state = { clock: 1_000_000, hold: false };
  const depsFor = (origin: string): BalanceSummaryDeps => ({
    locked: async () => !!opts.locked,
    account: () => account,
    blocked: async () => !!opts.blocked,
    granted: async () => grants.has(origin),
    grant: async (o, expiry) => void grants.set(o, expiry),
    denied: async (o) => denied.has(o),
    noteDenied: async (o) => void denied.add(o),
    ask: async (o) => {
      calls.asked.push(o);
      if (state.hold) await new Promise<void>((r) => (release = r));
      return answer;
    },
    read: async () => {
      calls.read++;
      return { sats: 4000, tokens: [{ id: 'tokA_0', sym: 'AAA', dec: 2, amountRaw: '1000' }] };
    },
    now: () => state.clock,
  });
  return {
    grants,
    denied,
    calls,
    depsFor,
    state,
    release: () => release?.(),
    switchAccount: (a: string) => void (account = a),
  };
};

describe('getBalanceSummary: the action', () => {
  test('is a wallet call the page, phone and frame bridges let through', () => {
    expect(isBalanceSummaryAction(BALANCE_SUMMARY_ACTION)).toBe(true);
    expect(isBalanceSummaryAction('listOutputs')).toBe(false);
    const ok = parseXdmRequest({ type: 'CWI', isInvocation: true, id: '1', call: BALANCE_SUMMARY_ACTION, args: {} });
    expect(ok?.call).toBe(BALANCE_SUMMARY_ACTION);
    expect(isBalanceReadRequestId('reconnect-balance-1')).toBe(true);
    expect(isBalanceReadRequestId('reconnect-abc')).toBe(false);
  });
});

describe('getBalanceSummary: refused without the grant', () => {
  test('a Not now refuses with the standard denial, reads nothing, and stands for the session', async () => {
    const m = makeDeps(false);
    const o = 'https://game.example';
    const r = await runBalanceSummary(o, m.depsFor(o));
    expect(r).toEqual({ success: false, error: 'Declined', code: 'ERR_PERMISSION_DENIED' });
    expect(m.calls.read).toBe(0);
    expect(m.grants.size).toBe(0);
    // The site asks again: no second sheet.
    expect((await runBalanceSummary(o, m.depsFor(o))).success).toBe(false);
    expect(m.calls.asked).toEqual([o]);
  });
  test('the session denial is the same store basket denials use, and Forget site clears it', async () => {
    const saved: string[][] = [];
    const d = new SessionBasketDenials({ load: async () => [], save: async (k) => void saved.push(k) });
    await d.add('game.example', BALANCE_READ_BASKET);
    expect(await d.has('game.example', BALANCE_READ_BASKET)).toBe(true);
    expect(await d.has('other.example', BALANCE_READ_BASKET)).toBe(false);
    await d.forget('game.example');
    expect(await d.has('game.example', BALANCE_READ_BASKET)).toBe(false);
  });
  test('a locked wallet refuses without a sheet', async () => {
    const m = makeDeps({}, { locked: true });
    const r = await runBalanceSummary('https://game.example', m.depsFor('https://game.example'), 'bWalletX');
    expect(r).toEqual({ success: false, error: 'Unlock bWalletX first', code: 'LOCKED' });
    expect(m.calls.asked).toEqual([]);
    expect(m.calls.read).toBe(0);
  });
  test('a blocked site is refused before any sheet or read', async () => {
    const m = makeDeps({}, { blocked: true });
    const r = await runBalanceSummary('https://bad.example', m.depsFor('https://bad.example'));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('ERR_PERMISSION_DENIED');
    expect(m.calls.asked).toEqual([]);
    expect(m.calls.read).toBe(0);
    expect(m.grants.size).toBe(0);
  });
  test('no origin refuses', async () => {
    const m = makeDeps({});
    const r = await runBalanceSummary(undefined, m.depsFor(''));
    expect(r.success).toBe(false);
    expect(m.calls.read).toBe(0);
  });
});

describe('getBalanceSummary: one sheet per site', () => {
  test('calls that arrive while the sheet is open share its single answer', async () => {
    const m = makeDeps({});
    m.state.hold = true;
    const memory = new BalanceSummaryMemory();
    const o = 'https://a.example';
    const calls = [1, 2, 3].map(() => runBalanceSummary(o, m.depsFor(o), 'b', memory));
    await new Promise((r) => setTimeout(r, 10));
    expect(m.calls.asked).toEqual([o]);
    m.release();
    const out = await Promise.all(calls);
    expect(out.every((r) => r.success)).toBe(true);
    expect(m.calls.asked.length).toBe(1);
  });
});

describe('getBalanceSummary: the grant is per origin and per account', () => {
  test('allow once, then the same origin reads without asking; another origin asks on its own', async () => {
    const m = makeDeps({});
    const a = 'https://a.example';
    const b = 'https://b.example';
    expect((await runBalanceSummary(a, m.depsFor(a))).success).toBe(true);
    expect((await runBalanceSummary(a, m.depsFor(a))).success).toBe(true);
    expect(m.calls.asked).toEqual([a]);
    expect((await runBalanceSummary(b, m.depsFor(b))).success).toBe(true);
    expect(m.calls.asked).toEqual([a, b]);
    expect([...m.grants.keys()].sort()).toEqual([a, b]);
  });
  test('the sheet answer carries the grant expiry (Remember off is not the long default)', async () => {
    const m = makeDeps({ expiry: 1_234_567 });
    const o = 'https://a.example';
    await runBalanceSummary(o, m.depsFor(o));
    expect(m.grants.get(o)).toBe(1_234_567);
  });
  test('an account switched while the sheet was open: nothing is granted or read', async () => {
    const m = makeDeps({});
    m.state.hold = true;
    const o = 'https://a.example';
    const p = runBalanceSummary(o, m.depsFor(o));
    await new Promise((r) => setTimeout(r, 10));
    m.switchAccount('1OtherAccount');
    m.release();
    const r = await p;
    expect(r.success).toBe(false);
    if (!r.success) expect(r.code).toBe('ACCOUNT_CHANGED');
    expect(m.grants.size).toBe(0);
    expect(m.calls.read).toBe(0);
  });
  test('Disconnect removes the grant: revoked for the site, kept for others; unlock cleanup keeps it; a site cannot list that basket', async () => {
    const key = (originator: string) => ({ type: 'basket', originator, basket: BALANCE_READ_BASKET });
    const rows = [key('a.example'), key('b.example')];
    const store = {
      listGrants: async () => rows.map((k) => ({ key: k })),
      deleteGrant: async (k: { originator: string }) => {
        rows.splice(
          rows.findIndex((x) => x.originator === k.originator),
          1,
        );
      },
    };
    expect(await revokeReservedBasketGrants(store as never, 'admin.originator')).toBe(0);
    expect(rows.length).toBe(2);
    expect(await revokeBasketGrantsForOriginator(store as never, 'a.example', (o) => o)).toBe(1);
    expect(rows.map((r) => r.originator)).toEqual(['b.example']);
    expect(isReservedBasket(BALANCE_READ_BASKET)).toBe(true);
  });
  test('after a site Disconnect the grant reads as absent until the connect sheet is answered again', () => {
    const t0 = 1_000_000;
    let state = parseReconnectState(undefined);
    expect(needsReconnect(state, 'game.example', t0)).toBe(false);
    state = noteDisconnect(state, 'game.example', t0);
    // This is what balanceSummaryDeps.granted checks first: true means "not granted".
    expect(needsReconnect(state, 'game.example', t0 + 1000)).toBe(true);
    state = noteReconnected(state, 'game.example', t0 + 2000);
    expect(needsReconnect(state, 'game.example', t0 + 3000)).toBe(false);
  });
});

describe('getBalanceSummary: a short cache per account and site', () => {
  test('a poll inside the window is served from the cache; after it, the wallet is read again', async () => {
    const m = makeDeps({});
    const memory = new BalanceSummaryMemory();
    const o = 'https://a.example';
    await runBalanceSummary(o, m.depsFor(o), 'b', memory);
    await runBalanceSummary(o, m.depsFor(o), 'b', memory);
    expect(m.calls.read).toBe(1);
    m.state.clock += BALANCE_CACHE_MS + 1;
    await runBalanceSummary(o, m.depsFor(o), 'b', memory);
    expect(m.calls.read).toBe(2);
  });
  test('a revoked grant is refused even with a fresh cache entry', async () => {
    const m = makeDeps(false);
    const memory = new BalanceSummaryMemory();
    const o = 'https://a.example';
    m.grants.set(o, undefined);
    expect((await runBalanceSummary(o, m.depsFor(o), 'b', memory)).success).toBe(true);
    m.grants.delete(o);
    expect((await runBalanceSummary(o, m.depsFor(o), 'b', memory)).success).toBe(false);
  });
  test("another account never gets the first one's cached answer", async () => {
    const m = makeDeps({});
    const memory = new BalanceSummaryMemory();
    const o = 'https://a.example';
    await runBalanceSummary(o, m.depsFor(o), 'b', memory);
    m.switchAccount('1OtherAccount');
    await runBalanceSummary(o, m.depsFor(o), 'b', memory);
    expect(m.calls.read).toBe(2);
  });
});

describe('getBalanceSummary: the numbers match the wallet card', () => {
  test('sats are balanceSplit().total (funding + deposit basket), not the default basket alone', async () => {
    stubTokenList();
    const area = makeArea();
    area.data[QUARANTINE_MIRROR_PREFIX + ACCOUNT] = [];
    const split = await balanceSplit(cardWallet);
    expect(split.total).toBe(3500);
    const r = await backgroundRead(area);
    expect(r.sats).toBe(split.total);
  });
  test('tokens are the held list amounts (getBsv21Balances), past 2^53 exact', async () => {
    stubTokenList();
    const area = makeArea();
    area.data[QUARANTINE_MIRROR_PREFIX + ACCOUNT] = [];
    const r = await backgroundRead(area);
    expect(r.tokens).toEqual([
      { id: 'Quarantined.0', sym: 'SPAM', dec: 0, amountRaw: '5' },
      { id: 'tokA_0', sym: 'AAA', dec: 2, amountRaw: '1000' },
      { id: 'tokB_0', sym: 'BBB', dec: 0, amountRaw: '9007199254740993' },
    ]);
  });
  test('summarizeBalance: bad amounts and empty lists are skipped, never turned into a silent zero row', () => {
    expect(summarizeBalance(0, [])).toEqual({ sats: 0, tokens: [] });
    expect(
      summarizeBalance(-5, [
        { id: 'x_0', amt: 'abc' },
        { id: 'y_0', amt: '0' },
        { id: '', amt: '4' },
      ]).tokens,
    ).toEqual([]);
  });
});

describe('getBalanceSummary: quarantined tokens never reach a site (the background has no localStorage)', () => {
  test('a mirrored quarantine set filters the real read path', async () => {
    stubTokenList();
    const area = makeArea();
    area.data[QUARANTINE_MIRROR_PREFIX + ACCOUNT] = ['quarantined_0'];
    const r = await backgroundRead(area);
    expect(r.tokens.map((t) => t.id)).toEqual(['tokA_0', 'tokB_0']);
    expect(JSON.stringify(r)).not.toContain('SPAM');
  });
  test('never mirrored (unknown): no tokens at all, sats still answer. Fails closed', async () => {
    stubTokenList();
    const r = await backgroundRead(makeArea());
    expect(r.tokens).toEqual([]);
    expect(r.sats).toBe(3500);
  });
  test('no storage at all: no tokens', async () => {
    stubTokenList();
    expect((await backgroundRead(null)).tokens).toEqual([]);
  });
  test('the UI side writes the set the background reads, with no localStorage in the background', async () => {
    expect((globalThis as { localStorage?: unknown }).localStorage).toBeUndefined();
    // The UI's own storage (what localStorage is on the page) holds an unsolicited airdrop of Quarantined.0.
    const ui: Record<string, string> = {};
    const st = { getItem: (k: string) => ui[k] ?? null, setItem: (k: string, v: string) => void (ui[k] = v) };
    const area = makeArea();
    const item = {
      key: 'k1',
      txid: TXID,
      issuer: '1Spammer',
      asset: { kind: 'token', id: 'Quarantined.0' },
    } as never;
    saveSolicited(ACCOUNT, ['tokA_0'], st);
    saveItems(ACCOUNT, [item], Date.now(), st);
    expect([...quarantineFor(ACCOUNT, st)]).toEqual(['quarantined_0']);
    mirrorQuarantine(ACCOUNT, st, area);
    await Promise.resolve();
    expect(area.data[QUARANTINE_MIRROR_PREFIX + ACCOUNT]).toEqual(['quarantined_0']);
    stubTokenList();
    const r = await backgroundRead(area);
    expect(r.tokens.map((t) => t.id)).toEqual(['tokA_0', 'tokB_0']);
  });
});

describe('getBalanceSummary: nothing else rides out', () => {
  test('the payload holds only sats and tokens, no outpoints, addresses, scripts or txids', async () => {
    const m = makeDeps({});
    const r = await runBalanceSummary('https://a.example', m.depsFor('https://a.example'));
    if (!r.success) throw new Error('expected success');
    expect(Object.keys(r.data).sort()).toEqual(['sats', 'tokens']);
    for (const t of r.data.tokens) expect(Object.keys(t).sort()).toEqual(['amountRaw', 'dec', 'id', 'sym']);
    const text = JSON.stringify(r);
    for (const secret of [ADDRESS, TXID, SCRIPT, 'outpoint', 'address', 'lockingScript', 'customInstructions'])
      expect(text).not.toContain(secret);
  });
  test('extra fields a reader returns are dropped before the site sees them', async () => {
    const deps = makeDeps({}).depsFor('https://a.example');
    deps.read = async () =>
      ({
        sats: 5,
        tokens: [{ id: 't_0', sym: 'T', dec: 0, amountRaw: '1', outpoint: `${TXID}.0`, address: ADDRESS }],
        history: [TXID],
      }) as never;
    const r = await runBalanceSummary('https://a.example', deps);
    expect(JSON.stringify(r)).not.toContain(TXID);
    expect(JSON.stringify(r)).not.toContain(ADDRESS);
    expect(JSON.stringify(r)).not.toContain('history');
  });
});

describe('getBalanceSummary: what the person reads', () => {
  test('Connections shows a readable label, not the stored basket name', () => {
    const rows = mergeConnections(
      {},
      [
        {
          originator: 'game.example',
          permissions: [
            { type: 'basket', basketName: BALANCE_READ_BASKET },
            { type: 'basket', basketName: 'default' },
          ],
        },
      ],
      [],
    );
    expect(rows[0].grants[BALANCE_GRANT_KEY]).toBe(1);
    expect(rows[0].grants.basket).toBe(1);
    expect(BALANCE_READ_LABEL).toBe('balance (read-only)');
  });
  test('the detail says individual coins, and never "coins" alone as a list of what is shared', () => {
    expect(BALANCE_READ_DETAIL).toBe(
      'Your total balance and token amounts. Never your addresses, individual coins or history.',
    );
  });
});

describe('getBalanceSummary: the sheet line', () => {
  const line = (): BundleRequest => ({
    requestID: 'reconnect-balance-1',
    type: 'protocol',
    originator: 'game.example',
    protocolID: [1, 'balance read'],
    counterparty: 'self',
    balanceRead: true,
  });
  const identity = (): BundleRequest => ({
    requestID: 'r2',
    type: 'protocol',
    originator: 'game.example',
    protocolID: [1, 'identity key retrieval'],
    counterparty: 'self',
  });
  test('reads "See your balance (read-only)", ticked, not risky, and joins the connect sheet', () => {
    const model = buildSheetModel({ originator: 'game.example', items: [identity(), line()] });
    const l = model.lines.find((x) => x.requestID === 'reconnect-balance-1')!;
    expect(l.text).toBe(BALANCE_READ_LINE);
    expect(l.text).toBe('See your balance (read-only)');
    expect(l.checked).toBe(true);
    expect(l.risky).toBe(false);
    expect(model.lines.length).toBe(2);
    expect(approvalKindForSheet(model)).not.toBe('careful');
  });
  test('alone, it is one calm line', () => {
    const model = buildSheetModel({ originator: 'game.example', items: [line()] });
    expect(model.lines.map((x) => x.text)).toEqual([BALANCE_READ_LINE]);
    expect(model.lines[0].detail).not.toContain('protocol');
  });
});
