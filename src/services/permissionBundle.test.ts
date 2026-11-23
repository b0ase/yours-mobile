import { describe, expect, test } from 'bun:test';
import { approvalKindForSheet, sheetTitleText } from './approvalKind';
import {
  actionLabelOf,
  LABEL_SHOWN_MAX,
  shownLabel,
  privateLabelFor,
  postPackCompanions,
  allowanceGranted,
  allowanceSats,
  offersAllowance,
  buildSheetModel,
  isAutoGrantable,
  isIdentityKeyRequest,
  isRiskyRequest,
  sheetCanTrust,
  sheetDecisions,
  sheetView,
  shownItems,
  sheetAnswer,
  sheetHash,
  MAX_LIVE_CHANGES,
  blockActive,
  BLOCK_SITE_BASKET,
  MAX_QUEUED_PER_SITE,
  PermissionQueueFullError,
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
  const promoted: PermissionBundle[] = [];
  const updated: PermissionBundle[] = [];
  let n = 0;
  const bundler = new PermissionBundler({
    windowMs: 400,
    onReady: (b) => ready.push(b),
    onPromote: (b) => promoted.push(b),
    onUpdate: (b) => updated.push(b),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    newId: () => `b${++n}`,
  });
  return { clock, ready, promoted, updated, bundler };
};

const proto = (id: string, originator = 'bmovies.app', extra: Partial<BundleRequest> = {}): BundleRequest => ({
  requestID: id,
  type: 'protocol',
  originator,
  // Level 2: level-1 keys are shared by every app and are never pre-ticked (isSharedKeyRequest, 13 Nov 2026).
  protocolID: [2, 'bmovies ticket'],
  ...extra,
});
/** The view of the card the user actually gets for this model (as BundleSheet builds it, Details closed). */
const cardView = (m: ReturnType<typeof buildSheetModel>) => {
  const kind = approvalKindForSheet(m);
  return sheetView(m, kind === 'careful', undefined, kind);
};
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

  test('a request arriving mid-sheet waits in the queue; the open sheet is unchanged', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(proto('r1'))!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    expect(bundler.add(basket('r2'))).toBeUndefined();
    expect(ready).toHaveLength(1); // no second sheet yet
    expect(b.items.map((i) => i.requestID)).toEqual(['r1']);
    expect(bundler.queued('bmovies.app').map((i) => i.requestID)).toEqual(['r2']);
  });

  test('an identical repeat still piggybacks on the open sheet (same requestID)', () => {
    const { clock, bundler } = setup();
    const b = bundler.add(proto('r1'))!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    expect(bundler.add(proto('r1'))).toBe(b);
    expect(b.items).toHaveLength(1);
    expect(bundler.queued('bmovies.app')).toHaveLength(0);
  });

  test('a request the user never saw is carried into a new sheet, not approved', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(proto('r1'))!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    b.items.push(basket('unseen')); // defensive path: an item missing from the decisions
    const res = bundler.resolve(b.id, { r1: true })!;
    expect(res.granted.map((r) => r.requestID)).toEqual(['r1']);
    expect(res.denied).toHaveLength(0);
    expect(res.carried?.items.map((r) => r.requestID)).toEqual(['unseen']);
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
  test('connect only: plain words; requested key use is pre-ticked and drawn (owner, 26 Oct 2026, replaces audit C1)', () => {
    const m = buildSheetModel({ originator: 'bmovies.app', items: [proto('r1'), basket('r2')] });
    expect(m.mode).toBe('connect');
    expect(m.lines.map((l) => l.text)).toEqual([
      'Sign and encrypt anything with your "bmovies ticket" keys',
      'Keep its tickets and tokens in your wallet',
    ]);
    expect(m.lines.map((l) => l.checked)).toEqual([true, true]);
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
      proto('anyone', 'x', { protocolID: [2, 'bwallet sign in'], counterparty: 'anyone' }),
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
    // A signature anyone can check (Sign in with bWalletX) is pre-ticked and not red.
    expect(byId.anyone.checked).toBe(true);
    expect(byId.anyone.risky).toBe(false);
    expect(byId.anyone.text).toBe("Prove it's you (a signature anyone can check)");
    expect(byId.priv.checked).toBe(false);
    expect(byId.cert.checked).toBe(false);
    expect(byId.cert.risky).toBe(true);
    expect(byId.ok.checked).toBe(true); // requested, not risky: ticked and drawn (owner, 26 Oct 2026)
    expect(isRiskyRequest(proto('p'))).toBe(false);
  });

  test('the public identity key line is pre-ticked and plain, so Allow does not deny it (Sign in with bWalletX)', () => {
    const idKey = (id: string, extra: Partial<BundleRequest> = {}) =>
      proto(id, 'x', { protocolID: [1, 'identity key retrieval'], counterparty: 'self', ...extra });
    const m = buildSheetModel({ originator: 'x', items: [idKey('id'), proto('other', 'x', { counterparty: 'self' })] });
    const byId = Object.fromEntries(m.lines.map((l) => [l.requestID, l]));
    expect(byId.id.checked).toBe(true);
    expect(byId.id.risky).toBe(false);
    expect(byId.id.text).toBe('See your public identity (the key that names you)');
    // Other requested key use is ticked too now that every line is drawn (owner, 26 Oct 2026).
    expect(byId.other.checked).toBe(true);
    // A privileged identity request is not the plain one.
    expect(isIdentityKeyRequest(idKey('p', { privileged: true }))).toBe(false);
    expect(buildSheetModel({ originator: 'x', items: [idKey('p', { privileged: true })] }).lines[0].checked).toBe(
      false,
    );
    // Another counterparty is not the plain one either.
    expect(isIdentityKeyRequest(idKey('q', { counterparty: '02abcdef' }))).toBe(false);
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
  test('baskets can be granted without a sheet; protocol (key) access never is (audit C1)', () => {
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [1, 'bitsign auth'], counterparty: 'self' })).toBe(
      false,
    );
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [0, 'feed post'] })).toBe(false);
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [2, 'own key'], counterparty: 'self' })).toBe(
      false,
    );
    expect(isAutoGrantable({ ...base, type: 'protocol', protocolID: [1, 'btrust'], counterparty: 'self' })).toBe(false);
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
          { ...base, requestID: 'r2', type: 'basket', basket: 'posts' },
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

describe('sheetDecisions (chat.bwalletx.com, 23 Oct 2026)', () => {
  const history = proto('h1', 'chat.bwalletx.com', {
    protocolID: [2, 'bchatx agent history'],
    counterparty: 'self',
  });
  const sigma = proto('s1', 'chat.bwalletx.com', { protocolID: [1, 'sigma'], counterparty: 'self' });

  test('Allow on the card grants the one protocol line it showed (Details never opened)', () => {
    const m = buildSheetModel({ originator: 'chat.bwalletx.com', items: [history] });
    expect(m.lines[0].checked).toBe(true); // drawn ticked (owner, 26 Oct 2026)
    expect(sheetDecisions(m, true, {}, false, cardView(m))).toEqual({ h1: true });
  });

  test('a Like signature is granted by Allow, not answered "Permission denied."', () => {
    const m = buildSheetModel({ originator: 'chat.bwalletx.com', items: [sigma] });
    expect(sheetDecisions(m, true, {}, false, cardView(m))).toEqual({ s1: true });
  });

  test('once Details was opened, the ticks decide', () => {
    const m = buildSheetModel({ originator: 'chat.bwalletx.com', items: [history, sigma] });
    expect(sheetDecisions(m, true, {}, true)).toEqual({ h1: true, s1: true });
    expect(sheetDecisions(m, true, { h1: false }, true)).toEqual({ h1: false, s1: true });
    expect(sheetDecisions(m, true, { s1: true, h1: false }, true)).toEqual({ h1: false, s1: true });
  });

  test('an untick before Details closed is honoured', () => {
    const m = buildSheetModel({ originator: 'chat.bwalletx.com', items: [history, sigma] });
    expect(sheetDecisions(m, true, { h1: false }, false, cardView(m))).toEqual({ h1: false, s1: true });
  });

  test('risky lines keep their tick state; Not now denies everything', () => {
    const risky = proto('p1', 'chat.bwalletx.com', { privileged: true });
    const m = buildSheetModel({ originator: 'chat.bwalletx.com', items: [risky, history, spend('pay', 100)] });
    // The careful card draws h1 with its own (unticked, audit C1) box, so Allow leaves it denied until ticked.
    expect(sheetDecisions(m, true, {}, false, cardView(m))).toEqual({ p1: false, h1: true, pay: true });
    expect(sheetDecisions(m, true, { h1: true }, false, cardView(m))).toEqual({ p1: false, h1: true, pay: true });
    expect(sheetDecisions(m, false, { p1: true }, false)).toEqual({ p1: false, h1: false, pay: false });
  });
});

describe('first-post companions', () => {
  const o = 'bchatx.com';
  test('a bap listing asks for the post signature too, and the other way round', () => {
    expect(postPackCompanions([{ type: 'basket', basket: 'bap' }])).toEqual(['protocol']);
    expect(postPackCompanions([{ type: 'protocol', protocolID: [1, 'sigma'] }])).toEqual(['basket']);
    expect(
      postPackCompanions([
        { type: 'basket', basket: 'bap' },
        { type: 'protocol', protocolID: [1, 'sigma'] },
      ]),
    ).toEqual([]);
  });
  test('anything else asks for nothing extra', () => {
    expect(postPackCompanions([{ type: 'basket', basket: 'tickets' }])).toEqual([]);
    expect(postPackCompanions([{ type: 'protocol', protocolID: [1, 'sigma'], privileged: true }])).toEqual([]);
  });
  test('the post lines say what they do in plain words', () => {
    const m = buildSheetModel({
      originator: o,
      items: [
        { requestID: 'b', type: 'basket', originator: o, basket: 'bap' },
        { requestID: 's', type: 'protocol', originator: o, protocolID: [1, 'sigma'], counterparty: 'self' },
      ],
    });
    expect(m.purpose).toBe('post');
    expect(m.lines.map((l) => l.text)).toEqual([
      'Use your public profile (name and picture) on its posts',
      'Sign your posts and likes as you',
    ]);
    expect(m.lines.every((l) => !l.signIn)).toBe(true);
  });
});

describe('allowance only on money sheets (b-Aware 24 Oct 2026: sign-in stored a hidden allowance)', () => {
  test('a plain sign-in / connect sheet never offers or stores an allowance', () => {
    const b = { originator: 'evil.example', items: [proto('r1', 'evil.example'), basket('r2', 'evil.example')] };
    expect(offersAllowance(buildSheetModel(b))).toBe(false);
    expect(allowanceGranted(b, b.items)).toBe(false);
  });
  test('a payment sheet stores it only when the payment itself is granted', () => {
    const b = { originator: 'bmovies.app', items: [proto('r1'), spend('r2', 2500)] };
    expect(offersAllowance(buildSheetModel(b))).toBe(true);
    expect(allowanceGranted(b, [b.items[1]])).toBe(true);
    expect(allowanceGranted(b, [b.items[0]])).toBe(false);
    expect(allowanceGranted(b, [])).toBe(false);
  });
  test('a first-post sheet offers it', () => {
    const b = { originator: 'bmovies.app', items: [{ ...basket('r1'), basket: 'bap' }] };
    expect(offersAllowance(buildSheetModel(b))).toBe(true);
    expect(allowanceGranted(b, b.items)).toBe(true);
  });
});

describe('requests that arrive after the user touched a sheet (option A, 24 Oct 2026)', () => {
  test("the first sheet's Allow never grants a late request", () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(
      proto('sign', 'evil.example', { protocolID: [2, 'bwallet sign in'], counterparty: 'anyone' }),
    )!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    bundler.add(basket('late', 'evil.example'));
    const model = buildSheetModel(b);
    expect(model.lines.map((l) => l.requestID)).toEqual(['sign']);
    const d = sheetDecisions(model, true, {}, false, cardView(model));
    expect(d).toEqual({ sign: true });
    const res = bundler.resolve(b.id, d)!;
    expect(res.granted.map((r) => r.requestID)).toEqual(['sign']);
    expect([...res.granted, ...res.denied].some((r) => r.requestID === 'late')).toBe(false);
    // It gets its own sheet next, after the merge window.
    expect(ready).toHaveLength(1);
    clock.tick(400);
    expect(ready).toHaveLength(2);
    expect(ready[1].items.map((i) => i.requestID)).toEqual(['late']);
  });

  test('the queued request is judged on its own merits: a routine one is not a careful card', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(
      proto('sign', 'evil.example', { protocolID: [2, 'bwallet sign in'], counterparty: 'anyone' }),
    )!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    bundler.add(basket('late', 'evil.example'));
    bundler.resolve(b.id, { sign: false });
    clock.tick(400);
    const line = buildSheetModel(ready[1]).lines[0];
    expect(line.risky).toBe(false);
    expect(line.text).not.toMatch(/Added while/);
  });

  test('a late spend becomes the main payment of its own sheet, not a line on the first', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(
      proto('sign', 'evil.example', { protocolID: [2, 'bwallet sign in'], counterparty: 'anyone' }),
    )!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    bundler.add(spend('pay', 5000, 'evil.example'));
    const first = buildSheetModel(b);
    expect(first.payment).toBeUndefined();
    expect(sheetDecisions(first, true, {}, false, cardView(first)).pay).toBeUndefined();
    bundler.resolve(b.id, sheetDecisions(first, true, {}, false, cardView(first)));
    clock.tick(400);
    expect(buildSheetModel(ready[1]).payment?.requestID).toBe('pay');
  });

  test('closing the sheet (drop) also promotes the queue', () => {
    const { clock, ready, promoted, bundler } = setup();
    const b = bundler.add(proto('a'))!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    bundler.add(basket('q'));
    bundler.drop(b.id);
    expect(promoted).toHaveLength(1);
    clock.tick(400);
    expect(ready[1].items.map((i) => i.requestID)).toEqual(['q']);
  });

  test('queued requests keep arrival order', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(proto('a'))!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    for (const id of ['q1', 'q2', 'q3']) bundler.add(basket(id));
    bundler.resolve(b.id, { a: true });
    clock.tick(400);
    expect(ready[1].items.map((i) => i.requestID)).toEqual(['q1', 'q2', 'q3']);
  });

  test('more than the cap per site is refused with a clear error; other sites are unaffected', () => {
    const { clock, bundler } = setup();
    bundler.add(proto('a'));
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    for (let i = 0; i < MAX_QUEUED_PER_SITE; i++) bundler.add(basket(`q${i}`));
    expect(() => bundler.add(basket('one-too-many'))).toThrow(PermissionQueueFullError);
    expect(() => bundler.add(basket('x'))).toThrow(/Too many permission requests/);
    expect(bundler.queued('bmovies.app')).toHaveLength(MAX_QUEUED_PER_SITE);
    expect(bundler.add(basket('other', 'other.example'))).toBeDefined();
  });

  test('a site that goes away loses its queued requests (removeRequest, clear)', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(proto('a'))!;
    clock.tick(400);
    bundler.freeze(bundler.list()[0].id); // touched: later requests queue
    bundler.add(basket('q1'));
    bundler.add(basket('q2'));
    bundler.removeRequest('q1');
    expect(bundler.queued('bmovies.app').map((i) => i.requestID)).toEqual(['q2']);
    // Tab closed: background removes every pending request of the site; nothing is shown afterwards.
    bundler.removeRequest('a');
    bundler.removeRequest('q2');
    clock.tick(400);
    expect(ready).toHaveLength(1);
    expect(bundler.get(b.id)).toBeUndefined();
    bundler.add(proto('c'));
    clock.tick(400);
    bundler.add(basket('q3'));
    bundler.clear();
    expect(bundler.queued('bmovies.app')).toHaveLength(0);
    expect(bundler.list()).toHaveLength(0);
  });

  test('requests inside the merge window still share one sheet', () => {
    const { bundler } = setup();
    const b = bundler.add(proto('a'))!;
    bundler.add(basket('b'));
    expect(b.items.map((i) => i.requestID)).toEqual(['a', 'b']);
  });
});

describe('the three answers of a careful sheet (owner, 24 Oct 2026)', () => {
  const careful = () =>
    buildSheetModel({
      originator: 'evil.example',
      items: [proto('key', 'evil.example', { privileged: true }), basket('bk', 'evil.example')],
    });

  test('I trust it, allow: ticked lines are granted and things may be stored', () => {
    const a = sheetAnswer(careful(), 'allow', { key: true }, true);
    expect(a.decisions).toEqual({ key: true, bk: true });
    expect(a.block).toBe(false);
    expect(a.mayStore).toBe(true);
  });

  test('Not now: everything declined, nothing stored, nothing blocked', () => {
    const a = sheetAnswer(careful(), 'notNow', { key: true, bk: true }, true);
    expect(Object.values(a.decisions).every((v) => v === false)).toBe(true);
    expect(a.block).toBe(false);
    expect(a.mayStore).toBe(false);
  });

  test('Block this site: everything declined and a block is asked for', () => {
    const a = sheetAnswer(careful(), 'block', { key: true, bk: true }, true);
    expect(Object.values(a.decisions).every((v) => v === false)).toBe(true);
    expect(a.block).toBe(true);
    expect(a.mayStore).toBe(false);
  });

  test('a block record blocks until removed; the block basket is a wallet-reserved name', () => {
    expect(blockActive({ expiry: 0 })).toBe(true);
    expect(blockActive(null)).toBe(false);
    expect(blockActive({ expiry: 1 }, 5000)).toBe(false);
    expect(BLOCK_SITE_BASKET.startsWith('bwalletx.')).toBe(true);
  });
});

describe('the live sheet (owner, 24 Oct 2026)', () => {
  test('an untouched open sheet takes a new line live, marked New and unticked', () => {
    const { clock, updated, bundler } = setup();
    const b = bundler.add(proto('sign'))!;
    clock.tick(400);
    expect(bundler.add(basket('late'))).toBe(b);
    expect(updated).toHaveLength(1);
    const line = buildSheetModel(b).lines.find((l) => l.requestID === 'late')!;
    expect(line.isNew).toBe(true);
    expect(line.checked).toBe(false);
    expect(line.text).toMatch(/^New: /);
  });

  test('Allow alone never grants a New line; ticking it does', () => {
    const { clock, bundler } = setup();
    const b = bundler.add(proto('sign'))!;
    clock.tick(400);
    bundler.add(basket('late'));
    const model = buildSheetModel(b);
    // Left unticked: not granted, and not answered either (it gets its own sheet, see below).
    expect(sheetDecisions(model, true, {}, false, cardView(model))).toEqual({ sign: true });
    expect(sheetDecisions(model, true, { late: true }, false, cardView(model)).late).toBe(true);
  });

  test('regression (paid playtest, 25 Oct 2026): Allow never denies a joined line; it gets its own sheet', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(proto('sign'))!;
    clock.tick(400);
    bundler.add(basket('late'));
    const model = buildSheetModel(b);
    const view = sheetView(model, true);
    const answer = sheetAnswer(model, 'allow', {}, false, view);
    const res = bundler.resolve(b.id, answer.decisions, sheetHash(b.items))!;
    expect(res.granted.map((r) => r.requestID)).toEqual(['sign']);
    expect(res.denied).toHaveLength(0);
    expect(res.carried?.items.map((r) => r.requestID)).toEqual(['late']);
    expect(res.carried?.items[0].addedLive).toBeUndefined();
    expect(ready.at(-1)?.id).toBe(res.carried!.id);
    // On its own sheet it is an ordinary line, judged on its own.
    expect(buildSheetModel(res.carried!).lines[0].isNew).toBeUndefined();
  });

  test('Not now still declines a joined line; an explicit untick on Allow declines it', () => {
    const { clock, bundler } = setup();
    const b = bundler.add(proto('sign'))!;
    clock.tick(400);
    bundler.add(basket('late'));
    const model = buildSheetModel(b);
    expect(sheetAnswer(model, 'notNow', {}, false).decisions).toEqual({ sign: false, late: false });
    expect(sheetDecisions(model, true, { late: false }, false, cardView(model))).toEqual({ sign: true, late: false });
  });

  test('a tap made before a line joined decides what it saw; the late line gets its own sheet (RB, 23 Nov 2026)', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(proto('sign'))!;
    clock.tick(400);
    const before = buildSheetModel(b);
    const seen = sheetHash(b.items); // what was on screen when the user tapped
    bundler.add(basket('late')); // arrives before the tap reaches the background
    const res = bundler.resolve(b.id, sheetDecisions(before, true, {}, false, cardView(before)), seen)!;
    expect(res.stale).toBeUndefined();
    expect(res.granted.map((r) => r.requestID)).toEqual(['sign']);
    expect(res.denied).toHaveLength(0);
    // Never granted by a tap that could not have seen it: it is carried to a sheet of its own.
    expect(res.carried?.items.map((r) => r.requestID)).toEqual(['late']);
    expect(ready.at(-1)?.id).toBe(res.carried!.id);
  });

  test('an approve bound to a different set of lines (not just late joiners) still grants nothing', () => {
    const { clock, bundler } = setup();
    const b = bundler.add(proto('sign'))!;
    bundler.add(basket('bk'));
    clock.tick(400);
    const seen = sheetHash(b.items);
    bundler.removeRequest('bk'); // an original line went away: the tap's view no longer matches
    bundler.add(basket('late'));
    const res = bundler.resolve(b.id, { sign: true, bk: true }, seen)!;
    expect(res.stale).toBe(true);
    expect(res.granted).toHaveLength(0);
    // A tap that answers the late line was built after it joined: its hash must include it.
    const two = setup();
    const b2 = two.bundler.add(proto('sign'))!;
    two.clock.tick(400);
    const seen2 = sheetHash(b2.items);
    two.bundler.add(basket('late'));
    const res2 = two.bundler.resolve(b2.id, { sign: true, late: true }, seen2)!;
    expect(res2.stale).toBe(true);
    expect(res2.granted).toHaveLength(0);
  });

  test('a missing hash grants nothing; a matching hash grants the ticked lines', () => {
    const one = setup();
    const b1 = one.bundler.add(proto('sign'))!;
    one.clock.tick(400);
    expect(one.bundler.resolve(b1.id, { sign: true }, '')!.granted).toHaveLength(0);
    const two = setup();
    const b2 = two.bundler.add(proto('sign'))!;
    two.clock.tick(400);
    two.bundler.add(basket('late'));
    const res = two.bundler.resolve(b2.id, { sign: true, late: false }, sheetHash(b2.items))!;
    expect(res.granted.map((r) => r.requestID)).toEqual(['sign']);
    expect(res.denied.map((r) => r.requestID)).toEqual(['late']);
  });

  test('the hash depends on the set, not the order', () => {
    expect(sheetHash([{ requestID: 'a' }, { requestID: 'b' }])).toBe(
      sheetHash([{ requestID: 'b' }, { requestID: 'a' }]),
    );
    expect(sheetHash([{ requestID: 'a' }])).not.toBe(sheetHash([{ requestID: 'a' }, { requestID: 'b' }]));
  });

  test('after pointerdown (freeze) a new request queues for its own sheet', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(proto('a'))!;
    clock.tick(400);
    bundler.freeze(b.id);
    expect(bundler.add(basket('late'))).toBeUndefined();
    expect(b.items).toHaveLength(1);
    bundler.resolve(b.id, { a: true }, sheetHash(b.items));
    clock.tick(400);
    expect(ready[1].items.map((i) => i.requestID)).toEqual(['late']);
  });

  test('live changes are capped; beyond the cap requests queue', () => {
    const { clock, bundler } = setup();
    const b = bundler.add(proto('a'))!;
    clock.tick(400);
    for (let i = 0; i < MAX_LIVE_CHANGES; i++) expect(bundler.add(basket(`l${i}`))).toBe(b);
    expect(bundler.add(basket('over'))).toBeUndefined();
    expect(bundler.queued('bmovies.app').map((i) => i.requestID)).toEqual(['over']);
  });

  test('a payment never joins a sheet on screen: it waits for its own PAY sheet (RB, 23 Nov 2026)', () => {
    const { clock, ready, updated, bundler } = setup();
    const b = bundler.add(proto('sign'))!;
    clock.tick(400);
    expect(bundler.add(spend('pay', 5000))).toBeUndefined();
    expect(updated).toHaveLength(0);
    expect(b.items.map((i) => i.requestID)).toEqual(['sign']);
    const model = buildSheetModel(b);
    expect(model.payment).toBeUndefined();
    expect(approvalKindForSheet(model)).not.toBe('careful');
    bundler.resolve(b.id, sheetDecisions(model, true, {}, false, cardView(model)), sheetHash(b.items));
    clock.tick(400);
    const next = buildSheetModel(ready.at(-1)!);
    expect(next.payment?.requestID).toBe('pay');
    expect(approvalKindForSheet(next)).toBe('pay');
  });
});

describe('never approve a line the user cannot read (mixed careful batch, 24 Oct 2026)', () => {
  const site = 'mixed.example';
  const mixed = () =>
    buildSheetModel({
      originator: site,
      items: [proto('key', site, { privileged: true }), basket('bk', site)],
    });

  test('a line under Details is never granted unless it was shown on the card', () => {
    const m = mixed();
    const hidden = { hidden: new Set(['bk']), faceTicks: new Set(['key']) };
    // Allow without opening Details: the hidden line is left out of the answer, never granted.
    const a = sheetAnswer(m, 'allow', { key: true }, false, hidden);
    expect(a.decisions).toEqual({ key: true });
    expect('bk' in a.decisions).toBe(false);
    // Even a stray tick for it cannot grant it while it was never on screen.
    expect(sheetDecisions(m, true, { key: true, bk: true }, false, hidden)).toEqual({ key: true });
    // Details opened: now it was shown, and its tick decides.
    expect(sheetDecisions(m, true, { key: true }, true, hidden)).toEqual({ key: true, bk: true });
  });

  test('the careful card draws every line on its face, so nothing is hidden', () => {
    const m = mixed();
    const v = sheetView(m, true);
    expect([...v.faceTicks].sort()).toEqual(['bk', 'key']);
    expect(v.hidden.size).toBe(0);
    // The ordinary line is drawn ticked, so Allow grants it as drawn; unticked on the face, it is denied.
    expect(sheetDecisions(m, true, { key: true }, false, v)).toEqual({ key: true, bk: true });
    expect(sheetDecisions(m, true, { key: true, bk: false }, false, v)).toEqual({ key: true, bk: false });
  });

  test('a protocol line drawn unticked on the careful face is not granted by Allow', () => {
    const m = buildSheetModel({
      originator: site,
      items: [proto('key', site, { privileged: true }), proto('h1', site, { counterparty: 'self' })],
    });
    expect(sheetDecisions(m, true, { key: true, h1: false }, false, sheetView(m, true))).toEqual({
      key: true,
      h1: false,
    });
  });

  test('a careful line that never scrolled onto the screen is hidden, so Allow cannot grant it', () => {
    const m = mixed();
    const v = sheetView(m, true, new Set(['key']));
    expect([...v.hidden]).toEqual(['bk']);
    expect(sheetDecisions(m, true, { key: true }, false, v)).toEqual({ key: true });
    // Once it has been on screen it is drawn, ticked, and granted as drawn.
    const all = sheetView(m, true, new Set(['key', 'bk']));
    expect(all.hidden.size).toBe(0);
    expect(sheetDecisions(m, true, { key: true }, false, all)).toEqual({ key: true, bk: true });
  });

  test('the shown items are exactly what the answer may cover', () => {
    const items = [proto('key', site, { privileged: true }), basket('bk', site)];
    expect(shownItems(items, { hidden: new Set(['bk']) }).map((i) => i.requestID)).toEqual(['key']);
    expect(shownItems(items, sheetView(mixed(), true))).toEqual(items);
  });

  test('the hash covers only the shown lines: a hidden line makes the answer stale, so nothing is granted', () => {
    const { clock, bundler } = setup();
    const b = bundler.add(proto('key', site, { privileged: true }))!;
    bundler.add(basket('bk', site));
    clock.tick(400);
    const hidden = { hidden: new Set(['bk']) };
    const seen = sheetHash(shownItems(b.items, hidden));
    expect(seen).not.toBe(sheetHash(b.items));
    const answer = sheetAnswer(buildSheetModel(b), 'allow', { key: true }, false, hidden);
    const r = bundler.resolve(b.id, answer.decisions, seen)!;
    expect(r.granted).toEqual([]);
    expect(r.stale).toBe(true);
  });
});

describe('labels on the payment sheet', () => {
  test('a payment carrying new labels shows them on its pay line', () => {
    const model = buildSheetModel({
      originator: 'game.example',
      items: [
        {
          requestID: 'p1',
          type: 'spending',
          originator: 'game.example',
          spending: { satoshis: 500 },
          labels: ['tokenblaster'],
        },
      ],
    });
    expect(model.payment?.labels).toEqual(['tokenblaster']);
    expect(model.payment?.detail).toContain('labels: tokenblaster');
  });
});

describe('b-Aware: Allow grants only lines the card showed (unseen lines fail closed)', () => {
  const o = 'bmovies.app';
  const keyLine = proto('k1', o, { protocolID: [2, 'bmovies ticket'], counterparty: 'self' });
  const viewFor = (m: ReturnType<typeof buildSheetModel>) => {
    const kind = approvalKindForSheet(m);
    return sheetView(m, kind === 'careful', undefined, kind);
  };

  test('pay card: an unticked protocol line and an undrawn basket line are not granted', () => {
    const m = buildSheetModel({ originator: o, items: [keyLine, basket('b1', o), spend('pay', 100, o)] });
    expect(approvalKindForSheet(m)).toBe('pay');
    const a = sheetAnswer(m, 'allow', {}, false, viewFor(m));
    expect(a.decisions.k1).not.toBe(true);
    expect(a.decisions.b1).not.toBe(true);
    expect(a.decisions.pay).toBe(true);
  });

  test('connect card: an unticked protocol line is not granted; the pre-ticked basket it tiles is', () => {
    const m = buildSheetModel({ originator: o, items: [keyLine, basket('b1', o)] });
    expect(approvalKindForSheet(m)).toBe('connect');
    const a = sheetAnswer(m, 'allow', { k1: false }, false, viewFor(m));
    expect(a.decisions.k1).not.toBe(true);
    expect(a.decisions.b1).toBe(true);
  });

  test('no view given: nothing undrawn is granted', () => {
    const m = buildSheetModel({ originator: o, items: [keyLine, basket('b1', o)] });
    expect(sheetDecisions(m, true, {}, false)).toEqual({ k1: false, b1: false });
  });

  test('Details opened and ticked: the ticks decide', () => {
    const m = buildSheetModel({ originator: o, items: [keyLine, spend('pay', 100, o)] });
    expect(sheetDecisions(m, true, { k1: true }, true, viewFor(m))).toEqual({ k1: true, pay: true });
  });
});

describe('merge window default', () => {
  test('stays short: it is waited before every Connect prompt', async () => {
    const { DEFAULT_MERGE_WINDOW_MS } = await import('./permissionBundle');
    expect(DEFAULT_MERGE_WINDOW_MS).toBeLessThanOrEqual(100);
  });
});

describe('history reads by action label (RB on scammerscartel.com, 23 Nov 2026)', () => {
  const site = 'scammerscartel.com';
  /** What the toolbox asks for listActions({ labels: [label] }) (ensureLabelAccess). */
  const labelRead = (
    id: string,
    label = 'scam-order-239af5c079e4',
    extra: Partial<BundleRequest> = {},
  ): BundleRequest =>
    proto(id, site, {
      protocolID: [1, `action label ${label}`],
      counterparty: 'self',
      usageType: 'generic',
      reason: 'listActions',
      ...extra,
    });
  const LINE = 'See and add to payments labelled "scam-order-239af5c079e4" (from any app)';

  test('a label line says what its one grant covers (see and add, any app), never keys; it is never pre-ticked', () => {
    const m = buildSheetModel({ originator: site, items: [labelRead('read')] });
    const line = m.lines[0];
    expect(line.text).toBe(LINE);
    expect(line.text).not.toMatch(/key|sign|encrypt/i);
    expect(line.historyLabel).toBe('scam-order-239af5c079e4');
    expect(line.risky).toBe(false);
    expect(line.checked).toBe(false);
    expect(approvalKindForSheet(m)).toBe('connect');
    expect(sheetTitleText('connect', 'scammerscartel', m)).toBe(
      'Let scammerscartel see and add to payments labelled "scam-order-239af5c079e4"',
    );
    // Allow alone grants nothing the user did not tick.
    expect(sheetDecisions(m, true, {}, true, cardView(m))).toEqual({ read: false });
    expect(sheetDecisions(m, true, { read: true }, true, cardView(m))).toEqual({ read: true });
  });

  test('the same words whatever the call (review of #558, M1: an "apply" grant also lists)', () => {
    const apply = buildSheetModel({
      originator: site,
      items: [labelRead('apply', 'scammerscartel', { reason: 'Scammers Cartel: unlock SMILAZ' })],
    });
    expect(apply.lines[0].text).toBe('See and add to payments labelled "scammerscartel" (from any app)');
    expect(apply.lines[0].checked).toBe(false);
    // Not a label request: signing with a protocol that happens to be named like one.
    const signing = labelRead('sig', 'x', { usageType: 'signing' });
    expect(actionLabelOf(signing)).toBeUndefined();
    expect(buildSheetModel({ originator: site, items: [signing] }).lines[0].text).toMatch(/keys/);
    // Nor at level 2, nor for another counterparty.
    expect(actionLabelOf(labelRead('l2', 'x', { protocolID: [2, 'action label x'] }))).toBeUndefined();
    expect(actionLabelOf(labelRead('cp', 'x', { counterparty: '02' + 'ab'.repeat(32) }))).toBeUndefined();
  });

  test('review of #558, L6: the site-chosen label is shown without quotes or control characters, capped', () => {
    const m = buildSheetModel({ originator: site, items: [labelRead('q', 'x" and nothing else. "\u0007')] });
    expect(m.lines[0].text).toBe('See and add to payments labelled "x and nothing else." (from any app)');
    expect(sheetTitleText('connect', 's', m)).toBe('Let s see and add to payments labelled "x and nothing else."');
    expect(shownLabel('a'.repeat(60))).toBe(`${'a'.repeat(LABEL_SHOWN_MAX - 1)}…`);
    expect(shownLabel('  a \t b  ')).toBe('a b');
  });

  test('a label with "history" or "chat" in it is not "your private data"', () => {
    const r = labelRead('h', 'chat history');
    expect(privateLabelFor(r)).toBeUndefined();
    const m = buildSheetModel({ originator: site, items: [r] });
    expect(approvalKindForSheet(m)).toBe('connect');
    expect(m.lines[0].text).toBe('See and add to payments labelled "chat history" (from any app)');
  });

  test('beside a key line, the connect title names the keys, never the label', () => {
    const m = buildSheetModel({
      originator: site,
      items: [labelRead('read'), proto('k', site, { counterparty: 'self', protocolID: [2, 'cartel docs'] })],
    });
    expect(sheetTitleText('connect', 'scammerscartel', m)).toBe(
      'Connect to scammerscartel and use your "cartel docs" keys',
    );
  });

  test('regression: the payment arrives while the history read is on screen; it is never cancelled by Allow', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(labelRead('read'))!;
    clock.tick(400);
    // Was: joined as an unticked red "New: pay 100,000,142 sats" line, card CAREFUL ("Wants more than usual").
    expect(bundler.add(spend('pay', 100_000_142, site))).toBeUndefined();
    const first = buildSheetModel(b);
    expect(approvalKindForSheet(first)).toBe('connect');
    expect(first.lines.map((l) => l.text)).toEqual([LINE]);
    const res = bundler.resolve(
      b.id,
      sheetDecisions(first, true, { read: true }, true, cardView(first)),
      sheetHash(b.items),
    )!;
    expect(res.granted.map((r) => r.requestID)).toEqual(['read']);
    expect(res.denied).toHaveLength(0);
    // The payment's own PAY sheet comes next: Pay grants it.
    clock.tick(400);
    const payBundle = ready.at(-1)!;
    const pay = buildSheetModel(payBundle);
    expect(approvalKindForSheet(pay)).toBe('pay');
    expect(pay.payment?.satoshis).toBe(100_000_142);
    const paid = bundler.resolve(
      payBundle.id,
      sheetDecisions(pay, true, {}, true, cardView(pay)),
      sheetHash(payBundle.items),
    )!;
    expect(paid.granted.map((r) => r.requestID)).toEqual(['pay']);
  });

  test('a line that would change the card never joins it live (its big button would change meaning)', () => {
    const { clock, ready, updated, bundler } = setup();
    const b = bundler.add(spend('pay', 100_000_142, site))!;
    clock.tick(400);
    expect(bundler.add(proto('priv', site, { privileged: true }))).toBeUndefined();
    expect(updated).toHaveLength(0);
    expect(approvalKindForSheet(buildSheetModel(b))).toBe('pay');
    const m = buildSheetModel(b);
    expect(
      bundler.resolve(b.id, sheetDecisions(m, true, {}, true, cardView(m)), sheetHash(b.items))!.granted,
    ).toHaveLength(1);
    clock.tick(400);
    expect(ready.at(-1)!.items.map((i) => i.requestID)).toEqual(['priv']);
    // A sheet that is already CAREFUL may take another risky line live: nothing flips.
    const two = setup();
    const c = two.bundler.add(proto('p1', site, { privileged: true }))!;
    two.clock.tick(400);
    expect(two.bundler.add(proto('p2', site, { privileged: true }))).toBe(c);
  });

  test('review of #558, M2: a plain line never turns a SIGN ONCE card CAREFUL; nothing joins a Seal sheet', () => {
    const { clock, updated, bundler } = setup();
    const once = bundler.add(
      proto('once:abc', site, {
        protocolID: [1, 'bitcoin auth'],
        counterparty: 'anyone',
        usageType: 'signing',
      }),
    )!;
    clock.tick(400);
    expect(approvalKindForSheet(buildSheetModel(once))).toBe('signonce');
    expect(bundler.add(basket('bk', site))).toBeUndefined();
    expect(updated).toHaveLength(0);
    expect(approvalKindForSheet(buildSheetModel(once))).toBe('signonce');
    const two = setup();
    const seal = two.bundler.add(
      proto('seal-1', site, {
        protocolID: [2, 'bitsign seal'],
        counterparty: 'anyone',
        seal: { title: 'Seal', lines: [] } as never,
      }),
    )!;
    two.clock.tick(400);
    expect(two.bundler.add(basket('bk2', site))).toBeUndefined();
    expect(seal.items).toHaveLength(1);
  });

  test('regression: a history read joining an open PAY sheet mid-tap never cancels the payment', () => {
    const { clock, ready, bundler } = setup();
    const b = bundler.add(spend('pay', 100_000_142, site))!;
    clock.tick(400);
    const seen = buildSheetModel(b);
    const seenHash = sheetHash(b.items); // the user taps Pay on this
    bundler.add(labelRead('read')); // the site's background check lands first
    const res = bundler.resolve(b.id, sheetDecisions(seen, true, {}, true, cardView(seen)), seenHash)!;
    expect(res.stale).toBeUndefined();
    expect(res.granted.map((r) => r.requestID)).toEqual(['pay']);
    expect(res.denied).toHaveLength(0);
    expect(res.carried?.items.map((r) => r.requestID)).toEqual(['read']);
    expect(ready.at(-1)?.id).toBe(res.carried!.id);
    // And when the sheet already showed it (New, unticked), Pay pays and the read gets its own sheet.
    const two = setup();
    const b2 = two.bundler.add(spend('pay', 100_000_142, site))!;
    two.clock.tick(400);
    two.bundler.add(labelRead('read'));
    const shown = buildSheetModel(b2);
    expect(approvalKindForSheet(shown)).toBe('pay');
    expect(shown.lines[0].text).toBe(`New: ${LINE}`);
    const r2 = two.bundler.resolve(b2.id, sheetDecisions(shown, true, {}, true, cardView(shown)), sheetHash(b2.items))!;
    expect(r2.granted.map((r) => r.requestID)).toEqual(['pay']);
    expect(r2.carried?.items.map((r) => r.requestID)).toEqual(['read']);
  });

  test('review of #558, L5: a second line joining mid-tap after one the sheet showed never cancels the payment', () => {
    const { clock, bundler } = setup();
    const b = bundler.add({ ...spend('pay', 1_000, site), recipientsHash: 'h' })!;
    clock.tick(400);
    bundler.add(labelRead('l1'));
    const seenIDs = b.items.map((i) => i.requestID); // the sheet showed pay + l1 (New, left unticked)
    const seen = sheetHash(b.items);
    bundler.add(labelRead('l2', 'other-order'));
    const res = bundler.resolve(b.id, { pay: true }, seen, seenIDs)!;
    expect(res.stale).toBeUndefined();
    expect(res.granted.map((r) => r.requestID)).toEqual(['pay']);
    expect(res.carried?.items.map((r) => r.requestID).sort()).toEqual(['l1', 'l2']);
  });

  test('review of #558, L5: the shown IDs bind the tap; a decision outside them, or a changed line, is stale', () => {
    const one = setup();
    const b = one.bundler.add({ ...spend('pay', 1_000, site), recipientsHash: 'h' })!;
    one.clock.tick(400);
    one.bundler.add(labelRead('l1'));
    const seen = sheetHash(b.items);
    one.bundler.add(labelRead('l2', 'other-order'));
    // Answers l2, which it never showed.
    expect(one.bundler.resolve(b.id, { pay: true, l2: true }, seen, ['pay', 'l1'])!.stale).toBe(true);
    const two = setup();
    const b2 = two.bundler.add({ ...spend('pay', 1_000, site), recipientsHash: 'h' })!;
    two.clock.tick(400);
    const seen2 = sheetHash([{ requestID: 'pay', recipientsHash: 'other' }]); // the recipients it showed differ
    two.bundler.add(labelRead('l1'));
    expect(two.bundler.resolve(b2.id, { pay: true }, seen2, ['pay'])!.stale).toBe(true);
    // An original (not live) line the sheet did not show is never "late".
    const three = setup();
    const b3 = three.bundler.add({ ...spend('pay', 1_000, site), recipientsHash: 'h' })!;
    three.bundler.add(basket('orig', site));
    three.clock.tick(400);
    const only = b3.items.filter((i) => i.requestID === 'pay');
    expect(three.bundler.resolve(b3.id, { pay: true }, sheetHash(only), ['pay'])!.stale).toBe(true);
  });
});
