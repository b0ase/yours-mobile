import { describe, expect, test } from 'bun:test';
import {
  allowanceSats,
  buildSheetModel,
  isAutoGrantable,
  isRiskyRequest,
  sheetCanTrust,
  TRUST_SITE_BASKET,
  PermissionBundler,
  type BundleRequest,
  type PermissionBundle,
} from './permissionBundle';

/** Manual clock: timers fire only when tick() passes them. */
const fakeTimers = () => {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    now: () => now,
    tick: (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
};

const setup = () => {
  const clock = fakeTimers();
  const ready: PermissionBundle[] = [];
  const updated: PermissionBundle[] = [];
  let n = 0;
  const bundler = new PermissionBundler({
    windowMs: 400,
    onReady: (b) => ready.push(b),
    onUpdate: (b) => updated.push(b),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    newId: () => `b${++n}`,
  });
  return { clock, ready, updated, bundler };
};

const proto = (id: string, originator = 'bmovies.app', extra: Partial<BundleRequest> = {}): BundleRequest => ({
  requestID: id,
  type: 'protocol',
  originator,
  protocolID: [1, 'bmovies ticket'],
  ...extra,
});
const basket = (id: string, originator = 'bmovies.app'): BundleRequest => ({
  requestID: id,
  type: 'basket',
  originator,
  basket: 'bmovies tickets',
});
const spend = (id: string, sats: number, originator = 'bmovies.app'): BundleRequest => ({
  requestID: id,
  type: 'spending',
  originator,
  spending: { satoshis: sats, lineItems: [{ type: 'output', description: 'Ticket: Off-Key Heroes', satoshis: sats }] },
});

describe('PermissionBundler grouping', () => {
  test('requests from one site inside the merge window become one bundle', () => {
    const { clock, ready, bundler } = setup();
    bundler.add(proto('r1'));
    clock.tick(100);
    bundler.add(basket('r2'));
    clock.tick(100);
    bundler.add(spend('r3', 1000));
    expect(ready).toHaveLength(0);
    clock.tick(200); // 400 ms after the first request
    expect(ready).toHaveLength(1);
    expect(ready[0].items.map((i) => i.requestID)).toEqual(['r1', 'r2', 'r3']);
    expect(ready[0].state).toBe('shown');
  });

  test('the window counts from the first request, so a stream cannot hold the sheet back', () => {
    const { clock, ready, bundler } = setup();
    bundler.add(proto('r1'));
    clock.tick(399);
    bundler.add(basket('r2'));
    clock.tick(1);
    expect(ready).toHaveLength(1);
  });

  test('different sites get different bundles', () => {
    const { clock, ready, bundler } = setup();
    bundler.add(proto('a1', 'bmovies.app'));
    bundler.add(proto('b1', 'bchatx.com'));
    clock.tick(400);
    expect(ready.map((b) => b.originator).sort()).toEqual(['bchatx.com', 'bmovies.app']);
    expect(ready.every((b) => b.items.length === 1)).toBe(true);
  });

  test('flush shows a bundle at once and cancels its timer', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(proto('r1'));
    bundler.flush(b.id);
    expect(ready).toHaveLength(1);
    expect(clock.pending()).toBe(0);
    bundler.flush(b.id); // second flush is a no-op
    expect(ready).toHaveLength(1);
  });

  test('a duplicate requestID is not added twice', () => {
    const { bundler } = setup();
    const r = proto('r1');
    bundler.add(r);
    const b = bundler.add(r);
    expect(b.items).toHaveLength(1);
  });
});

describe('PermissionBundler answers', () => {
  test('a partial untick grants the ticked requests and denies the rest', () => {
    const { clock, bundler } = setup();
    bundler.add(proto('r1'));
    bundler.add(basket('r2'));
    bundler.add(spend('r3', 500));
    clock.tick(400);
    const id = bundler.list()[0].id;
    const res = bundler.resolve(id, { r1: true, r2: false, r3: true })!;
    expect(res.granted.map((r) => r.requestID)).toEqual(['r1', 'r3']);
    expect(res.denied.map((r) => r.requestID)).toEqual(['r2']);
    expect(res.carried).toBeUndefined();
    expect(bundler.get(id)).toBeUndefined();
  });

  test('a request arriving mid-sheet joins the open sheet and fires onUpdate', () => {
    const { clock, ready, updated, bundler } = setup();
    bundler.add(proto('r1'));
    clock.tick(400);
    expect(ready).toHaveLength(1);
    bundler.add(basket('r2'));
    expect(ready).toHaveLength(1); // no second sheet
    expect(updated).toHaveLength(1);
    expect(updated[0].items.map((i) => i.requestID)).toEqual(['r1', 'r2']);
  });

  test('a request the user never saw is carried into a new sheet, not approved', () => {
    const { clock, ready, bundler } = setup();
    bundler.add(proto('r1'));
    clock.tick(400);
    const id = ready[0].id;
    bundler.add(basket('late')); // joined after the view was built
    const res = bundler.resolve(id, { r1: true })!;
    expect(res.granted.map((r) => r.requestID)).toEqual(['r1']);
    expect(res.denied).toHaveLength(0);
    expect(res.carried?.items.map((r) => r.requestID)).toEqual(['late']);
    expect(res.carried?.state).toBe('shown');
    expect(ready).toHaveLength(2);
  });

  test('removeRequest drops empty bundles', () => {
    const { bundler } = setup();
    const b = bundler.add(proto('r1'));
    bundler.removeRequest('r1');
    expect(bundler.get(b.id)).toBeUndefined();
  });

  test('resolve on an unknown bundle returns undefined', () => {
    const { bundler } = setup();
    expect(bundler.resolve('nope', {})).toBeUndefined();
  });
});

describe('sheet model', () => {
  test('connect only: plain words, everything ticked', () => {
    const m = buildSheetModel({ originator: 'bmovies.app', items: [proto('r1'), basket('r2')] });
    expect(m.mode).toBe('connect');
    expect(m.lines.map((l) => l.text)).toEqual([
      'Sign in and sign its messages',
      'Keep its tickets and tokens in your wallet',
    ]);
    expect(m.lines.every((l) => l.checked)).toBe(true);
    expect(m.lines[1].detail).toContain('bmovies tickets');
  });

  test('connect and pay: the spend becomes the Pay now section', () => {
    const m = buildSheetModel({ originator: 'bmovies.app', items: [proto('r1'), spend('r2', 2500)] });
    expect(m.mode).toBe('connectAndPay');
    expect(m.payment).toMatchObject({ requestID: 'r2', satoshis: 2500, description: 'Ticket: Off-Key Heroes' });
    expect(m.lines).toHaveLength(1);
  });

  test('pay only', () => {
    expect(buildSheetModel({ originator: 'x', items: [spend('r1', 10)] }).mode).toBe('pay');
  });

  test('risky permissions are never pre-ticked', () => {
    const items = [
      proto('anyone', 'x', { counterparty: 'anyone' }),
      proto('priv', 'x', { privileged: true }),
      {
        requestID: 'cert',
        type: 'certificate',
        originator: 'x',
        certificate: { verifier: 'v', certType: 't', fields: ['email', 'nickname'] },
      } as BundleRequest,
      proto('ok', 'x'),
    ];
    const m = buildSheetModel({ originator: 'x', items });
    const byId = Object.fromEntries(m.lines.map((l) => [l.requestID, l]));
    expect(byId.anyone.checked).toBe(false);
    expect(byId.priv.checked).toBe(false);
    expect(byId.cert.checked).toBe(false);
    expect(byId.cert.risky).toBe(true);
    expect(byId.ok.checked).toBe(true);
    expect(isRiskyRequest(proto('p'))).toBe(false);
  });

  test('a second spend in one bundle is a separate unticked line', () => {
    const m = buildSheetModel({ originator: 'x', items: [spend('a', 10), spend('b', 20)] });
    expect(m.payment?.requestID).toBe('a');
    expect(m.lines[0]).toMatchObject({ requestID: 'b', checked: false, risky: true });
  });
});

describe('allowanceSats', () => {
  test('$5 at $50/BSV is 0.1 BSV', () => {
    expect(allowanceSats(5, 50)).toBe(10_000_000);
  });
  test('no rate or no allowance gives 0', () => {
    expect(allowanceSats(5, undefined)).toBe(0);
    expect(allowanceSats(5, 0)).toBe(0);
    expect(allowanceSats(0, 50)).toBe(0);
  });
});

describe("Don't ask again on this site", () => {
  const base = { requestID: 'r', originator: 'bchatx.com' };
  test('routine signing and baskets can be granted without a sheet', () => {
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [1, 'bitsign auth'], counterparty: 'self' })).toBe(
      true,
    );
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [0, 'feed post'] })).toBe(true);
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [2, 'own key'], counterparty: 'self' })).toBe(true);
    expect(isAutoGrantable({ ...base, type: 'basket', basket: 'bchat posts' })).toBe(true);
  });
  test('payments, personal details and risky key use still ask', () => {
    expect(isAutoGrantable({ ...base, type: 'spending', spending: { satoshis: 50 } })).toBe(false);
    expect(
      isAutoGrantable({
        ...base,
        type: 'certificate',
        certificate: { verifier: 'v', certType: 't', fields: ['email'] },
      }),
    ).toBe(false);
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [1, 'x'], counterparty: 'anyone' })).toBe(false);
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [1, 'x'], privileged: true })).toBe(false);
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [2, 'x'], counterparty: '02abc' })).toBe(false);
    expect(isAutoGrantable({ ...base, type: 'basket', basket: TRUST_SITE_BASKET })).toBe(false);
  });
  test('the sheet offers it only when something routine is asked', () => {
    expect(sheetCanTrust({ items: [{ ...base, type: 'spending', spending: { satoshis: 5 } }] })).toBe(false);
    expect(
      sheetCanTrust({
        items: [
          { ...base, type: 'spending', spending: { satoshis: 5 } },
          { ...base, requestID: 'r2', type: 'protocol', protocolID: [1, 'post'] },
        ],
      }),
    ).toBe(true);
  });
});

describe('allowance in dollars', () => {
  test('converts at the given rate and refuses a missing rate', () => {
    expect(allowanceSats(5, 50)).toBe(10_000_000);
    expect(allowanceSats(1, 20)).toBe(5_000_000);
    expect(allowanceSats(5, undefined)).toBe(0);
    expect(allowanceSats(0, 50)).toBe(0);
  });
});
