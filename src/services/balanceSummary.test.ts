import { describe, expect, test } from 'bun:test';
import {
  BALANCE_READ_BASKET,
  BALANCE_READ_LINE,
  BALANCE_SUMMARY_ACTION,
  isBalanceSummaryAction,
  runBalanceSummary,
  summarizeBalance,
  type BalanceRow,
  type BalanceSummaryDeps,
  type HeldToken,
} from './balanceSummary';
import { everyOutput } from './everyOutput';
import { approvalKindForSheet } from './approvalKind';
import { buildSheetModel, type BundleRequest } from './permissionBundle';
import { revokeBasketGrantsForOriginator, revokeReservedBasketGrants, isReservedBasket } from './reservedBaskets';
import { parseXdmRequest } from '../mobile/bappFrame/frameBridge';

const ADDRESS = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const TXID = 'ab'.repeat(32);
const SCRIPT = '76a914' + 'cd'.repeat(20) + '88ac';

/** A wallet's own listings, in the shape the toolbox returns them (outpoints, scripts, custom instructions and all). */
const listings: Record<string, (BalanceRow & Record<string, unknown>)[]> = {
  default: [
    { outpoint: `${TXID}.0`, satoshis: 1500, spendable: true, lockingScript: SCRIPT, customInstructions: ADDRESS },
    { outpoint: `${TXID}.1`, satoshis: 2500, spendable: true, tags: [`address:${ADDRESS}`] },
    { outpoint: `${TXID}.2`, satoshis: 999_999, spendable: false },
  ],
  bsv21: [
    { outpoint: `${TXID}.3`, satoshis: 1, spendable: true, tags: [`bsv21:tokA_0`, 'amt:700'] },
    { outpoint: `${TXID}.4`, satoshis: 1, spendable: true, tags: [`bsv21:tokA_0`, 'amt:300'] },
    { outpoint: `${TXID}.5`, satoshis: 1, spendable: true, tags: [`bsv21:tokB_0`, 'amt:9007199254740993'] },
    { outpoint: `${TXID}.6`, satoshis: 1, spendable: true, tags: [`bsv21:quarantined_0`, 'amt:5'] },
  ],
};
const held: HeldToken[] = [
  { id: 'tokA_0', sym: 'AAA', dec: 2, amt: '1000' },
  { id: 'tokB_0', sym: 'BBB', dec: 0, amt: '1' },
];
// What the wallet's own list call returns, so the test sums exactly what listOutputs holds.
const fakeWallet = {
  listOutputs: async (a: { basket: string; limit: number; offset: number }) => {
    const rows = listings[a.basket] ?? [];
    return { totalOutputs: rows.length, outputs: rows.slice(a.offset, a.offset + a.limit) };
  },
};
const read = async () => {
  const all = (basket: string) =>
    everyOutput<BalanceRow>(
      fakeWallet,
      (a) => fakeWallet.listOutputs(a as never),
      { basket, includeTags: true },
      'admin',
    );
  const [coins, tokenRows] = await Promise.all([all('default'), all('bsv21')]);
  return summarizeBalance(coins, tokenRows, held);
};

/** A grant store keyed by origin, as the background keeps one (a basket grant under the site's own originator). */
const makeDeps = (answer: boolean, opts: { locked?: boolean } = {}) => {
  const grants = new Set<string>();
  const calls = { asked: [] as string[], read: 0 };
  const depsFor = (origin: string): BalanceSummaryDeps => ({
    locked: async () => !!opts.locked,
    granted: async () => grants.has(origin),
    grant: async () => void grants.add(origin),
    ask: async () => {
      calls.asked.push(origin);
      return answer;
    },
    read: async () => {
      calls.read++;
      return read();
    },
  });
  return { grants, calls, depsFor };
};

describe('getBalanceSummary: the action', () => {
  test('is a wallet call the page, phone and frame bridges let through', () => {
    expect(isBalanceSummaryAction(BALANCE_SUMMARY_ACTION)).toBe(true);
    expect(isBalanceSummaryAction('listOutputs')).toBe(false);
    const ok = parseXdmRequest({ type: 'CWI', isInvocation: true, id: '1', call: BALANCE_SUMMARY_ACTION, args: {} });
    expect(ok?.call).toBe(BALANCE_SUMMARY_ACTION);
  });
});

describe('getBalanceSummary: refused without the grant', () => {
  test('a Not now refuses with the standard denial and reads nothing', async () => {
    const m = makeDeps(false);
    const r = await runBalanceSummary('https://game.example', m.depsFor('https://game.example'));
    expect(r).toEqual({ success: false, error: 'Declined', code: 'ERR_PERMISSION_DENIED' });
    expect(m.calls.read).toBe(0);
    expect(m.grants.size).toBe(0);
  });
  test('a locked wallet refuses without a sheet', async () => {
    const m = makeDeps(true, { locked: true });
    const r = await runBalanceSummary('https://game.example', m.depsFor('https://game.example'), 'bWalletX');
    expect(r).toEqual({ success: false, error: 'Unlock bWalletX first', code: 'LOCKED' });
    expect(m.calls.asked).toEqual([]);
    expect(m.calls.read).toBe(0);
  });
  test('no origin refuses', async () => {
    const m = makeDeps(true);
    const r = await runBalanceSummary(undefined, m.depsFor(''));
    expect(r.success).toBe(false);
    expect(m.calls.read).toBe(0);
  });
});

describe('getBalanceSummary: the grant is per origin', () => {
  test('allow once, then the same origin reads without asking; another origin asks on its own', async () => {
    const m = makeDeps(true);
    const a = 'https://a.example';
    const b = 'https://b.example';
    expect((await runBalanceSummary(a, m.depsFor(a))).success).toBe(true);
    expect((await runBalanceSummary(a, m.depsFor(a))).success).toBe(true);
    expect(m.calls.asked).toEqual([a]);
    expect((await runBalanceSummary(b, m.depsFor(b))).success).toBe(true);
    expect(m.calls.asked).toEqual([a, b]);
    expect([...m.grants].sort()).toEqual([a, b]);
  });
  test('Disconnect removes it with the site grants; unlock cleanup keeps it; a site cannot list that basket', async () => {
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
});

describe('getBalanceSummary: the numbers', () => {
  test('match the wallet listOutputs totals (spendable default coins, tag amounts of held tokens)', async () => {
    const m = makeDeps(true);
    const r = await runBalanceSummary('https://a.example', m.depsFor('https://a.example'));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const defaultTotal = (await fakeWallet.listOutputs({ basket: 'default', limit: 100, offset: 0 })).outputs
      .filter((o) => o.spendable)
      .reduce((n, o) => n + (o.satoshis ?? 0), 0);
    expect(r.data.sats).toBe(defaultTotal);
    expect(r.data.sats).toBe(4000);
    expect(r.data.tokens).toEqual([
      { id: 'tokA_0', sym: 'AAA', dec: 2, amountRaw: '1000' },
      // Past 2^53: a string, exact.
      { id: 'tokB_0', sym: 'BBB', dec: 0, amountRaw: '9007199254740993' },
    ]);
  });
  test('a token the wallet does not show as yours (quarantined) is left out; nothing held is an empty list', () => {
    expect(summarizeBalance([], listings.bsv21, []).tokens).toEqual([]);
    // No tagged rows: the wallet's own held amount stands (never a silent zero for a token it shows).
    expect(summarizeBalance([], [], held).tokens.map((t) => t.amountRaw)).toEqual(['1000', '1']);
    expect(summarizeBalance([], [], [])).toEqual({ sats: 0, tokens: [] });
  });
});

describe('getBalanceSummary: nothing else rides out', () => {
  test('the payload holds only sats and tokens, no outpoints, addresses, scripts or txids', async () => {
    const m = makeDeps(true);
    const r = await runBalanceSummary('https://a.example', m.depsFor('https://a.example'));
    if (!r.success) throw new Error('expected success');
    expect(Object.keys(r.data).sort()).toEqual(['sats', 'tokens']);
    for (const t of r.data.tokens) expect(Object.keys(t).sort()).toEqual(['amountRaw', 'dec', 'id', 'sym']);
    const text = JSON.stringify(r);
    for (const secret of [ADDRESS, TXID, SCRIPT, 'outpoint', 'address', 'lockingScript', 'customInstructions'])
      expect(text).not.toContain(secret);
  });
  test('extra fields a reader returns are dropped before the site sees them', async () => {
    const deps = makeDeps(true).depsFor('https://a.example');
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
