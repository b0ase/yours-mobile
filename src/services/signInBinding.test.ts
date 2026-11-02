/**
 * Sign-in signatures bound to the caller's origin on every transport (security review of the SSO hub, 2 Nov 2026).
 * The attack: evil.com fetches a challenge from another site's server (id.bwalletx.com, any b*X site), asks the user's
 * bWalletX to sign it under the shared sign-in protocol, relays the signature and signs in as the user.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { InMemoryPermissionStore, LocalWalletPermissionsManager } from '@1sat/wallet';
import {
  guardSignInProtocols,
  HUB_DEV_ORIGIN,
  HUB_ORIGIN,
  HUB_PROTOCOL_REFUSAL,
  hubMessage,
  hubOrigins,
  isSignInCall,
  loginMessage,
  originsForOriginator,
  parseSignInRequest,
  revokeSignInGrants,
  SIGN_IN_REFUSAL,
  signInBindingRefusal,
  signInKind,
  signInRefusalForOriginator,
} from './signInBinding';
import { pinnedAllowed, pinnedProtocolRefusal, PINNED_PROTOCOLS_VERSION } from './pinnedProtocols';
import { guardReservedProtocols, isReservedProtocol, reservedProtocolRefusal } from './reservedProtocols';
import { buildSheetModel } from './permissionBundle';
import { approvalKindForSheet, sheetTitleText } from './approvalKind';

const GOOD = 'https://good.example';
const EVIL = 'https://evil.example';
const NONCE = 'n0nce_abcdefghijk';
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const EXP = '2026-11-02T12:02:00.000Z';
const bytes = (s: string) => Utils.toArray(s, 'utf8');

const login = (origin = GOOD, over: Record<string, unknown> = {}, text = loginMessage(origin, NONCE, EXP)) => ({
  protocolID: [2, 'bwallet sign in'],
  keyID: NONCE,
  counterparty: 'anyone',
  data: bytes(text),
  ...over,
});
const hub = (over: Record<string, unknown> = {}, text = hubMessage(HUB_ORIGIN, NONCE, '2026-11-02T12:00:30.000Z')) => ({
  protocolID: [2, 'bwalletx id sign in'],
  keyID: NONCE,
  counterparty: 'anyone',
  data: bytes(text),
  ...over,
});

describe('the shared validator', () => {
  test('the hub line is exactly the documented format', () => {
    expect(hubMessage(HUB_ORIGIN, NONCE, EXP)).toBe(`Sign in to id.bwalletx.com · challenge ${NONCE} · ${EXP}`);
  });

  test("a foreign origin signing another origin's challenge is refused", () => {
    // evil.example relays good.example's challenge (the attack).
    expect(signInBindingRefusal('createSignature', login(GOOD), EVIL, NOW)).toContain(SIGN_IN_REFUSAL);
    // evil.example relays the hub's own challenge under the shared protocol.
    expect(signInBindingRefusal('createSignature', login(HUB_ORIGIN), EVIL, NOW)).toContain(SIGN_IN_REFUSAL);
    // a sibling or parent of the named site is still another origin.
    for (const caller of ['https://www.good.example', 'https://app.good.example', 'http://good.example'])
      expect(signInBindingRefusal('createSignature', login(GOOD), caller, NOW)).toContain(SIGN_IN_REFUSAL);
    // a different port is a different origin.
    expect(signInBindingRefusal('createSignature', login('https://good.example:8443'), GOOD, NOW)).toContain(
      SIGN_IN_REFUSAL,
    );
  });

  test('the correct origin passes', () => {
    expect(signInBindingRefusal('createSignature', login(GOOD), GOOD, NOW)).toBeNull();
    // A trailing slash or default port from the transport is still the same origin.
    expect(signInBindingRefusal('createSignature', login(GOOD), 'https://good.example:443/', NOW)).toBeNull();
    expect(parseSignInRequest(login(GOOD), GOOD, NOW)).toEqual({
      kind: 'login',
      protocolID: [2, 'bwallet sign in'],
      keyID: NONCE,
      origin: GOOD,
      host: 'good.example',
      nonce: NONCE,
      message: loginMessage(GOOD, NONCE, EXP),
    });
  });

  test('no caller origin from the transport: refused (never taken from the page)', () => {
    for (const o of [undefined, null, '', 'null', 'good.example', 'chrome-extension://abc', 'file:///x'])
      expect(signInBindingRefusal('createSignature', login(GOOD), o as string, NOW)).toContain(SIGN_IN_REFUSAL);
  });

  test('the hub protocol from any origin but the hub is refused, on every protocol method', () => {
    for (const caller of [EVIL, GOOD, 'https://bchatx.com', 'https://id.bwalletx.com.evil.example', HUB_DEV_ORIGIN]) {
      // Even with a perfectly formed hub line naming the caller itself.
      const own = hub({}, hubMessage(caller, NONCE, '2026-11-02T12:00:30.000Z'));
      expect(signInBindingRefusal('createSignature', own, caller, NOW)).toContain(HUB_PROTOCOL_REFUSAL);
      expect(signInBindingRefusal('createSignature', hub(), caller, NOW)).toContain(HUB_PROTOCOL_REFUSAL);
      for (const m of ['getPublicKey', 'encrypt', 'decrypt', 'createHmac', 'verifySignature'])
        expect(signInBindingRefusal(m, { protocolID: [2, 'bwalletx id sign in'], keyID: '1' }, caller)).toContain(
          HUB_PROTOCOL_REFUSAL,
        );
    }
    // http://id.bwalletx.com is not the hub (strict on scheme).
    expect(signInBindingRefusal('createSignature', hub(), 'http://id.bwalletx.com', NOW)).toContain(
      HUB_PROTOCOL_REFUSAL,
    );
  });

  test('the hub passes with its own line, tolerant of the time format', () => {
    expect(signInBindingRefusal('createSignature', hub(), HUB_ORIGIN, NOW)).toBeNull();
    for (const t of [
      '2026-11-02T12:00:30Z',
      '2026-11-02T12:00:30.123456Z',
      '2026-11-02T12:00Z',
      '2026-11-02T13:00:30+01:00',
      '2026-11-02T12:05:00.000Z', // an expiry a few minutes ahead
      '2026-11-02T11:55:00.000Z', // an issue time a few minutes ago
    ])
      expect(signInBindingRefusal('createSignature', hub({}, hubMessage(HUB_ORIGIN, NONCE, t)), HUB_ORIGIN, NOW)).toBe(
        null,
      );
    // And the connect loginMessage form for the hub's own origin, under either protocol (while the hub moves over).
    expect(
      signInBindingRefusal('createSignature', hub({}, loginMessage(HUB_ORIGIN, NONCE, EXP)), HUB_ORIGIN, NOW),
    ).toBe(null);
    expect(signInBindingRefusal('createSignature', login(HUB_ORIGIN), HUB_ORIGIN, NOW)).toBeNull();
    const r = parseSignInRequest(hub(), HUB_ORIGIN, NOW);
    expect(r).toMatchObject({ kind: 'hub', protocolID: [2, 'bwalletx id sign in'], host: 'id.bwalletx.com' });
  });

  test('the hub line is strict on the origin it names', () => {
    for (const named of ['id.bwalletx.com.evil.example', 'evil.example', 'bwalletx.com', 'ID.BWALLETX.COM'])
      expect(
        signInBindingRefusal(
          'createSignature',
          hub({}, `Sign in to ${named} · challenge ${NONCE} · 2026-11-02T12:00:30Z`),
          HUB_ORIGIN,
          NOW,
        ),
      ).toContain(SIGN_IN_REFUSAL);
  });

  test('the dev hub (http://localhost:3400) only in dev builds', () => {
    expect(hubOrigins()).toEqual([HUB_ORIGIN]); // bun test is not a dev build
    expect(hubOrigins(true)).toEqual([HUB_ORIGIN, HUB_DEV_ORIGIN]);
    const dev = hub({}, hubMessage(HUB_DEV_ORIGIN, NONCE, '2026-11-02T12:00:30Z'));
    expect(signInBindingRefusal('createSignature', dev, HUB_DEV_ORIGIN, NOW)).toContain(HUB_PROTOCOL_REFUSAL);
    expect(signInBindingRefusal('createSignature', dev, HUB_DEV_ORIGIN, NOW, { dev: true })).toBeNull();
    expect(signInBindingRefusal('createSignature', dev, 'http://localhost:3401', NOW, { dev: true })).toContain(
      HUB_PROTOCOL_REFUSAL,
    );
  });

  test('malformed messages are refused', () => {
    const bad: [string, unknown][] = [
      ['extra line', login(GOOD, {}, loginMessage(GOOD, NONCE, EXP) + '\nPay 1 BSV')],
      ['first line only', login(GOOD, {}, 'Sign in to good.example with bWallet')],
      ['keyID not the nonce', login(GOOD, { keyID: 'othernonce123' })],
      ['short nonce', login(GOOD, { keyID: 'abc' }, loginMessage(GOOD, 'abc', EXP))],
      ['counterparty self', login(GOOD, { counterparty: 'self' })],
      ['counterparty missing', login(GOOD, { counterparty: undefined })],
      ['a hash, not text', login(GOOD, { hashToDirectlySign: [1, 2, 3] })],
      ['privileged', login(GOOD, { privileged: true })],
      ['no data', login(GOOD, { data: undefined })],
      ['empty data', login(GOOD, { data: [] })],
      ['data not bytes', login(GOOD, { data: 'Sign in' })],
      ['bytes out of range', login(GOOD, { data: [256, 1] })],
      ['not UTF-8', login(GOOD, { data: [0xff, 0xfe, 0xfd] })],
      ['huge', login(GOOD, { data: new Array(4096).fill(65) })],
      ['expired', login(GOOD, {}, loginMessage(GOOD, NONCE, '2026-11-02T11:59:00.000Z'))],
      ['too far ahead', login(GOOD, {}, loginMessage(GOOD, NONCE, '2026-11-03T12:00:00.000Z'))],
      ['bad date', login(GOOD, {}, loginMessage(GOOD, NONCE, '2026-13-45T99:99:99.000Z'))],
      ['hub line, stale', hub({}, hubMessage(HUB_ORIGIN, NONCE, '2026-11-02T11:00:00Z'))],
      ['hub line, no time', hub({}, `Sign in to id.bwalletx.com · challenge ${NONCE} · `)],
      ['hub line, newline smuggled', hub({}, hubMessage(HUB_ORIGIN, NONCE, '2026-11-02T12:00:30Z') + '\nPay')],
      ['hub line, other wording', hub({}, `Sign in to id.bwalletx.com - challenge ${NONCE} - 2026-11-02T12:00:30Z`)],
    ];
    for (const [why, p] of bad) {
      const caller =
        (p as { protocolID: [number, string] }).protocolID[1] === 'bwalletx id sign in' ? HUB_ORIGIN : GOOD;
      const r = signInBindingRefusal('createSignature', p, caller, NOW);
      if (!r) throw new Error(`accepted: ${why}`);
      expect(r).toContain(SIGN_IN_REFUSAL);
    }
    expect(signInBindingRefusal('createSignature', { protocolID: [2, 'bwallet sign in'] }, GOOD, NOW)).not.toBeNull();
    expect(signInBindingRefusal('createSignature', null, GOOD, NOW)).toBeNull(); // no protocol: not a sign-in
  });

  test('case and spacing of the name do not get round the binding (the SDK derives the same key)', () => {
    for (const name of ['Bwallet Sign In', ' bwallet sign in ', 'BWALLET SIGN IN']) {
      expect(signInKind([2, name])).toBe('login');
      expect(signInBindingRefusal('createSignature', login(GOOD, { protocolID: [2, name] }), EVIL, NOW)).toContain(
        SIGN_IN_REFUSAL,
      );
    }
    expect(signInKind([2, ' BWalletX ID Sign In'])).toBe('hub');
    expect(
      signInBindingRefusal('createSignature', hub({ protocolID: [2, 'BWalletX ID Sign In'] }), EVIL, NOW),
    ).toContain(HUB_PROTOCOL_REFUSAL);
    // Other levels and names are other keys: untouched here.
    expect(signInKind([1, 'bwallet sign in'])).toBeNull();
    expect(signInKind([2, 'bwallet sign inx'])).toBeNull();
    expect(signInBindingRefusal('createSignature', { protocolID: [2, 'some app'], data: [1] }, EVIL, NOW)).toBeNull();
  });

  test('the shared protocol stays open for its other methods (getPublicKey, verify)', () => {
    for (const m of ['getPublicKey', 'verifySignature'])
      expect(signInBindingRefusal(m, { protocolID: [2, 'bwallet sign in'], keyID: '1' }, EVIL)).toBeNull();
    expect(signInBindingRefusal('createAction', login(GOOD), EVIL, NOW)).toBeNull();
    expect(isSignInCall('createSignature', login(GOOD))).toBe(true);
    expect(isSignInCall('getPublicKey', login(GOOD))).toBe(false);
  });
});

describe('originators (the permission manager knows only "host[:port]")', () => {
  test('https implied; loopback may be either scheme; a full origin stands for itself', () => {
    expect(originsForOriginator('good.example')).toEqual([GOOD]);
    expect(originsForOriginator('Good.Example:443')).toEqual([GOOD]);
    expect(originsForOriginator('localhost:3400')).toEqual(['http://localhost:3400', 'https://localhost:3400']);
    expect(originsForOriginator('https://good.example/')).toEqual([GOOD]);
    expect(originsForOriginator(`good.example.c${'ab'.repeat(22)}.paired.invalid`)).toEqual([
      `https://good.example.c${'ab'.repeat(22)}.paired.invalid`,
    ]);
    expect(originsForOriginator('')).toEqual([]);
  });

  test('a paired originator never matches the site it claims (pairLogin.ts answers sign-ins for pairings)', () => {
    const paired = `good.example.c${'ab'.repeat(22)}.paired.invalid`;
    expect(signInRefusalForOriginator('createSignature', login(GOOD), paired, NOW)).toContain(SIGN_IN_REFUSAL);
    expect(signInRefusalForOriginator('createSignature', login(GOOD), 'good.example', NOW)).toBeNull();
    expect(signInRefusalForOriginator('createSignature', login(GOOD), 'evil.example', NOW)).toContain(SIGN_IN_REFUSAL);
    expect(signInRefusalForOriginator('createSignature', hub(), 'id.bwalletx.com', NOW)).toBeNull();
  });
});

describe('the hub protocol is pinned and classified', () => {
  test('pinned to id.bwalletx.com (and advertised as pin level 4)', () => {
    const HUB = [2, 'bwalletx id sign in'];
    expect(pinnedAllowed(HUB, 'id.bwalletx.com')).toBe(true);
    for (const o of ['evil.example', 'bwalletx.com', 'localhost:3400', undefined]) {
      expect(pinnedAllowed(HUB, o)).toBe(false);
      expect(pinnedProtocolRefusal('createSignature', { protocolID: HUB }, o)).not.toBeNull();
    }
    expect(PINNED_PROTOCOLS_VERSION).toBeGreaterThanOrEqual(4);
  });

  test('shared, not reserved: the hub (a site) may use it, and the reserved list does not block sign-in', () => {
    expect(isReservedProtocol([2, 'bwalletx id sign in'])).toBe(false);
    expect(isReservedProtocol([2, 'bwallet sign in'])).toBe(false);
    expect(reservedProtocolRefusal('createSignature', hub())).toBeNull();
  });
});

describe('inside the permissions manager', () => {
  const ADMIN = 'admin.test';

  /** A real LocalWalletPermissionsManager over a throwaway ProtoWallet: no real wallet data. */
  const realManager = (guard: boolean) => {
    const pw = new ProtoWallet(PrivateKey.fromRandom());
    const base = new Proxy(pw as unknown as Record<string | symbol, unknown>, {
      get(t, k) {
        if (k in t) return typeof t[k] === 'function' ? (t[k] as (...a: unknown[]) => unknown).bind(t) : t[k];
        // Token look-ups the toolbox makes (no on-chain grants here).
        return async () => ({ outputs: [], totalOutputs: 0, actions: [], totalActions: 0 });
      },
    });
    const store = new InMemoryPermissionStore();
    const m = new LocalWalletPermissionsManager(base as never, ADMIN, {}, { store });
    const prompts: string[] = [];
    m.bindCallback('onProtocolPermissionRequested', async (r: { requestID: string; originator: string }) => {
      prompts.push(r.originator);
      // What background.ts does on Allow: a grant "for GRANT_DEFAULT_DAYS" (remember on).
      await m.grantPermission({ requestID: r.requestID, expiry: 0 });
    });
    if (guard) guardSignInProtocols(m, ADMIN, { now: () => Date.now() });
    return { m, store, prompts };
  };
  const fresh = (origin: string) =>
    login(origin, {}, loginMessage(origin, NONCE, new Date(Date.now() + 60_000).toISOString()));

  test('without the guard a sign-in is remembered (the old behaviour this fixes)', async () => {
    const { m, store, prompts } = realManager(false);
    await m.createSignature(fresh(GOOD) as never, 'good.example');
    await m.createSignature(fresh(GOOD) as never, 'good.example');
    expect(prompts).toHaveLength(1);
    expect(await store.listGrants()).toHaveLength(1);
  });

  test('no remembered grant: every sign-in asks, nothing is stored', async () => {
    const { m, store, prompts } = realManager(true);
    const a = await m.createSignature(fresh(GOOD) as never, 'good.example');
    const b = await m.createSignature(fresh(GOOD) as never, 'good.example');
    expect(a.signature.length).toBeGreaterThan(0);
    expect(b.signature.length).toBeGreaterThan(0);
    expect(prompts).toEqual(['good.example', 'good.example']);
    expect(await store.listGrants()).toEqual([]);
  });

  test('a grant stored before this fix never answers a sign-in', async () => {
    const { m, store, prompts } = realManager(true);
    await store.putGrant({
      key: {
        type: 'protocol',
        originator: 'good.example',
        privileged: false,
        protocolLevel: 2,
        protocolName: 'bwallet sign in',
        counterparty: 'anyone',
      },
      expiry: 0,
      grantedAt: Date.now(),
    });
    await m.createSignature(fresh(GOOD) as never, 'good.example');
    expect(prompts).toEqual(['good.example']);
    expect(await store.listGrants()).toEqual([]);
  });

  test("another origin's challenge is refused before any sheet", async () => {
    const { m, prompts } = realManager(true);
    await expect(m.createSignature(fresh(GOOD) as never, 'evil.example')).rejects.toThrow(SIGN_IN_REFUSAL);
    await expect(m.createSignature(fresh(HUB_ORIGIN) as never, 'evil.example')).rejects.toThrow(SIGN_IN_REFUSAL);
    expect(prompts).toEqual([]);
  });

  test('the hub protocol from a non-hub originator: refused before any sheet, on every path', async () => {
    const { m, prompts } = realManager(true);
    const t = new Date().toISOString();
    const own = hub({}, hubMessage(GOOD, NONCE, t));
    await expect(m.createSignature(own as never, 'good.example')).rejects.toThrow(HUB_PROTOCOL_REFUSAL);
    await expect(
      m.ensureProtocolPermission({
        originator: 'good.example',
        privileged: false,
        protocolID: [2, 'bwalletx id sign in'],
        counterparty: 'anyone',
        usageType: 'signing',
      } as never),
    ).rejects.toThrow(HUB_PROTOCOL_REFUSAL);
    expect(prompts).toEqual([]);
    // The hub itself: one sheet, nothing stored.
    await m.createSignature(hub({}, hubMessage(HUB_ORIGIN, NONCE, t)) as never, 'id.bwalletx.com');
    expect(prompts).toEqual(['id.bwalletx.com']);
  });

  test('admin calls are untouched (the wallet signs its own wallet-address proof under the shared protocol)', async () => {
    const { m, prompts } = realManager(true);
    await m.createSignature(
      {
        protocolID: [2, 'bwallet sign in'],
        keyID: 'wallet-address',
        counterparty: 'anyone',
        data: bytes('x'),
      } as never,
      ADMIN,
    );
    expect(prompts).toEqual([]);
  });

  test('grouped (manifest) and counterparty grants drop sign-in protocols', async () => {
    const seen: unknown[] = [];
    const m = guardSignInProtocols(
      {
        grantGroupedPermission: async (p: unknown) => void seen.push(p),
        grantCounterpartyPermission: async (p: unknown) => void seen.push(p),
      },
      ADMIN,
    );
    await m.grantGroupedPermission({
      requestID: 'g',
      granted: {
        protocolPermissions: [
          { protocolID: [2, 'bwallet sign in'], counterparty: 'anyone' },
          { protocolID: [2, 'BWalletX ID Sign In'], counterparty: 'anyone' },
          { protocolID: [2, 'bchat documents'], counterparty: 'self' },
        ],
      },
    } as never);
    await m.grantCounterpartyPermission({
      requestID: 'c',
      granted: {
        protocols: [
          { protocolID: [2, 'bwallet sign in'] },
          { protocolName: 'bwalletx id sign in' },
          { protocolID: [2, 'chat'] },
        ],
      },
    } as never);
    expect(seen).toEqual([
      {
        requestID: 'g',
        granted: { protocolPermissions: [{ protocolID: [2, 'bchat documents'], counterparty: 'self' }] },
      },
      { requestID: 'c', granted: { protocols: [{ protocolID: [2, 'chat'] }] } },
    ]);
  });

  test('revokeSignInGrants removes only outside sign-in grants (upgrade migration)', async () => {
    const grants = [
      { key: { type: 'protocol', originator: 'a.example', protocolLevel: 2, protocolName: 'bwallet sign in' } },
      { key: { type: 'protocol', originator: 'a.example', protocolLevel: 2, protocolName: 'bchat documents' } },
      { key: { type: 'protocol', originator: ADMIN, protocolLevel: 2, protocolName: 'bwallet sign in' } },
      {
        key: { type: 'protocol', originator: 'id.bwalletx.com', protocolLevel: 2, protocolName: 'bwalletx id sign in' },
      },
    ];
    const deleted: unknown[] = [];
    const n = await revokeSignInGrants(
      { listGrants: async () => grants, deleteGrant: async (k: never) => void deleted.push(k) },
      ADMIN,
    );
    expect(n).toBe(2);
    expect(deleted).toEqual([grants[0].key, grants[3].key]);
  });

  test('works alongside the reserved-protocol guard (as initWallet.ts stacks them)', async () => {
    const calls: string[] = [];
    const m = guardReservedProtocols(
      guardSignInProtocols(
        {
          createSignature: async () => (calls.push('sign'), { signature: [1] }),
          ensureProtocolPermission: async () => (calls.push('ensure'), true),
        },
        ADMIN,
        { now: () => NOW },
      ),
      ADMIN,
    );
    await expect(m.createSignature(login(GOOD), 'evil.example')).rejects.toThrow(SIGN_IN_REFUSAL);
    await expect(m.createSignature(hub(), 'good.example')).rejects.toThrow();
    expect(calls).toEqual([]);
    await m.createSignature(login(GOOD), 'good.example');
    expect(calls).toEqual(['sign']);
  });
});

describe('the sign-in sheet names the caller', () => {
  test('"Sign in to <host>" on the line and the SIGN IN card title', () => {
    const model = buildSheetModel({
      originator: 'id.bwalletx.com',
      items: [
        {
          requestID: 'r1',
          type: 'protocol',
          originator: 'id.bwalletx.com',
          protocolID: [2, 'bwalletx id sign in'],
          counterparty: 'anyone',
        },
      ],
    } as never);
    expect(model.lines[0]).toMatchObject({ text: 'Sign in to id.bwalletx.com', boundSignIn: true, signIn: true });
    expect(approvalKindForSheet(model)).toBe('signin');
    expect(sheetTitleText('signin', 'id', model, 'id.bwalletx.com')).toBe('Sign in to id.bwalletx.com');
    // Unbound sheets keep their wording.
    const other = buildSheetModel({
      originator: 'good.example',
      items: [
        {
          requestID: 'r2',
          type: 'protocol',
          originator: 'good.example',
          protocolID: [2, 'x auth'],
          counterparty: 'anyone',
        },
      ],
    } as never);
    expect(sheetTitleText('signin', 'good', other, 'good.example')).toBe('Connect and sign in to good');
  });
});

describe('every transport is wired to the shared check', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('extension / web / phone background: sender.origin, before the frame sheet, unlock and permission sheets', () => {
    const bg = src('../background.ts');
    const at = bg.indexOf('signInBindingRefusal(String(message?.action');
    expect(at).toBeGreaterThan(0);
    expect(bg.slice(at, at + 140)).toContain('sender.origin');
    expect(at).toBeLessThan(bg.indexOf('const frame = framePolicy(sender)'));
    expect(at).toBeLessThan(bg.indexOf('walletForSiteRequest(message.originator)'));
    expect(at).toBeLessThan(bg.indexOf('reservedProtocolRefusal(String(message?.action'));
  });

  test('in-app dApp browser and framed bApps: the verified origin, before the Face ID gate', () => {
    const d = src('../mobile/dappBrowser.ts');
    const at = d.indexOf('signInBindingRefusal(type, params, o.origin)');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(d.indexOf('await siteGate.check(o.origin, type);'));
  });

  test('phone pairing: the pairing origin, through the same validator', () => {
    const p = src('../mobile/pair/pairLogin.ts');
    expect(p).toContain('parseSignInRequest(params, sessionOrigin, now)');
    expect(p).toContain("from '../../services/signInBinding'");
  });

  test('permissions manager: the guard is stacked and stored sign-in grants are removed on unlock', () => {
    const w = src('../initWallet.ts');
    expect(w).toContain('guardSignInProtocols(');
    expect(w).toContain('revokeSignInGrants(permissionStore, ADMIN_ORIGINATOR)');
    // Inside guardSiteTokens (which snapshots the methods it wraps), so every caller goes through it.
    expect(w.indexOf('guardSignInProtocols(')).toBeGreaterThan(w.indexOf('const wallet = guardSiteTokens('));
  });
});
