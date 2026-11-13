/**
 * b-Aware (Limenelo, 13 Nov 2026, HIGH): one tap on a pre-ticked "Prove it's you" line gave a site a standing grant,
 * and then it could mint sign-in tokens other services accept (BitPlan: [1, 'bitcoin auth'], keyID = a timestamp,
 * counterparty 'anyone') with no sheet. Now every such signature asks, and the answer covers that one signature.
 *
 * Real LocalWalletPermissionsManager over a ProtoWallet with an in-memory grant store, wrapped as initWallet.ts wraps
 * it (reserved protocols → cross-site → shared-key signing). The sheet is the callback, answering the way
 * background.ts does: a "once:" request with oneUseGrant, anything else with a standing grant (Remember on).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { InMemoryPermissionStore, LocalWalletPermissionsManager } from '@1sat/wallet';
import { oneUseGrant } from './oneShotGrant';
import { guardCrossSiteSigning } from './crossSiteSignGuard';
import { guardReservedProtocols } from './reservedProtocols';
import { guardSharedKeySigning, isBearerSignature, isOneUseRequestID, isTimeKeyID } from './sharedKeySigning';

const ADMIN = 'admin.bwalletx.invalid';
const SITE = 'evil.example';
const NOW_S = '1763040000'; // a unix-seconds keyID, BitPlan's shape
const enc = (t: string) => Array.from(new TextEncoder().encode(t));

type Req = { requestID: string; protocolID: [number, string]; counterparty?: string; oneUse?: boolean };

const setup = (opts: { guard?: boolean; answer?: (r: Req, n: number) => boolean } = {}) => {
  const store = new InMemoryPermissionStore();
  const keys = new ProtoWallet(PrivateKey.fromRandom());
  const underlying = {
    createSignature: (a: never, o?: string) => keys.createSignature(a, o),
    verifySignature: (a: never, o?: string) => keys.verifySignature(a, o),
    getPublicKey: (a: never, o?: string) => keys.getPublicKey(a, o),
    listOutputs: async () => ({ outputs: [], totalOutputs: 0 }), // no on-chain permission tokens
  };
  const mgr = new LocalWalletPermissionsManager(underlying as never, ADMIN, {}, { store });
  const sheets: Req[] = [];
  const answer = opts.answer ?? (() => true);
  mgr.bindCallback('onProtocolPermissionRequested', (async (r: Req) => {
    sheets.push(r);
    if (!answer(r, sheets.length)) return void (await mgr.denyPermission(r.requestID));
    // What background.ts's bundle answer does (processBundlePermissionResponse).
    await mgr.grantPermission(
      isOneUseRequestID(r.requestID) ? oneUseGrant(r.requestID) : { requestID: r.requestID, expiry: 0 },
    );
  }) as never);
  const inner = opts.guard === false ? mgr : guardSharedKeySigning(mgr, { adminOriginator: ADMIN });
  const wallet = guardReservedProtocols(guardCrossSiteSigning(inner, ADMIN), ADMIN) as unknown as {
    createSignature: (a: unknown, o?: string) => Promise<{ signature: number[] }>;
    verifySignature: (a: unknown, o?: string) => Promise<{ valid: boolean }>;
  };
  return { mgr, store, keys, wallet, sheets };
};

const bitplan = (keyID = NOW_S, data = enc(`${keyID}`)) => ({
  protocolID: [1, 'bitcoin auth'] as [1, string],
  keyID,
  counterparty: 'anyone',
  data,
});

describe('sign-in tokens other services accept: one approval per signature', () => {
  test('control, the old wiring: one tap, then the site mints a second token with no sheet', async () => {
    const { wallet, sheets } = setup({ guard: false });
    await wallet.createSignature(bitplan(NOW_S), SITE);
    await wallet.createSignature(bitplan('1763040060'), SITE);
    expect(sheets.length).toBe(1); // the hole this fix closes
  });

  test('BitPlan shape: every token asks, and a No refuses the second one', async () => {
    const { wallet, sheets } = setup({ answer: (_r, n) => n === 1 });
    const first = await wallet.createSignature(bitplan(NOW_S), SITE);
    expect(first.signature.length).toBeGreaterThan(0);
    await expect(wallet.createSignature(bitplan('1763040060'), SITE)).rejects.toThrow('Permission denied');
    expect(sheets.length).toBe(2);
    expect(sheets.every((s) => isOneUseRequestID(s.requestID))).toBe(true);
  });

  test('the token is a real signature anyone can check with the identity key', async () => {
    const { wallet, keys } = setup();
    const { signature } = await wallet.createSignature(bitplan(NOW_S), SITE);
    const anyone = new ProtoWallet('anyone');
    const { publicKey } = await keys.getPublicKey({ identityKey: true });
    const { valid } = await anyone.verifySignature({
      protocolID: [1, 'bitcoin auth'],
      keyID: NOW_S,
      counterparty: publicKey,
      data: enc(NOW_S),
      signature,
    });
    expect(valid).toBe(true);
  });

  test('the one-use answer stores nothing at all', async () => {
    const { wallet, store } = setup();
    await wallet.createSignature(bitplan(NOW_S), SITE);
    const g = await store.findGrant({
      type: 'protocol',
      originator: SITE,
      privileged: false,
      protocolLevel: 1,
      protocolName: 'bitcoin auth',
      counterparty: '',
    } as never);
    expect(g).toBeFalsy();
  });

  test('a standing grant the site already holds (approved for a self-sign) does not cover a token', async () => {
    const { wallet, sheets } = setup();
    // Level 1 ignores the counterparty: this one approval used to cover every 'anyone' token after it.
    await wallet.createSignature({ ...bitplan('my-own-key'), counterparty: 'self' }, SITE);
    await wallet.createSignature({ ...bitplan('my-own-key-2'), counterparty: 'self' }, SITE);
    expect(sheets.length).toBe(1); // ordinary use keeps its grant
    await wallet.createSignature(bitplan(NOW_S), SITE);
    expect(sheets.length).toBe(2);
    expect(isOneUseRequestID(sheets[1].requestID)).toBe(true);
  });

  test("BRC-77 [2, 'message signing'] and a time keyID under any name ask every time", async () => {
    const { wallet, sheets } = setup();
    const msg = (keyID: string) => ({ protocolID: [2, 'message signing'], keyID, counterparty: 'anyone', data: [1] });
    await wallet.createSignature(msg('a1b2c3d4e5f6'), SITE);
    await wallet.createSignature(msg('f6e5d4c3b2a1'), SITE);
    const feed = (keyID: string) => ({ protocolID: [2, 'acme feed'], keyID, counterparty: 'anyone', data: [1] });
    await wallet.createSignature(feed('2026-11-13T10:00:00Z'), SITE);
    await wallet.createSignature(feed('2026-11-13T10:00:01Z'), SITE);
    expect(sheets.length).toBe(4);
  });

  test('two tokens at once are two requests: one answer never releases the other', async () => {
    const { wallet, sheets } = setup({ answer: (r) => r === sheets[0] });
    const both = await Promise.allSettled([
      wallet.createSignature(bitplan(NOW_S), SITE),
      wallet.createSignature(bitplan('1763040001'), SITE),
    ]);
    expect(sheets.length).toBe(2);
    expect(new Set(sheets.map((s) => s.requestID)).size).toBe(2);
    expect(both.map((b) => b.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  test('a refused call never raises a sheet: cross-site text and reserved names are refused first', async () => {
    const { wallet, sheets } = setup();
    await expect(
      wallet.createSignature(bitplan(NOW_S, enc('Sign in to bitplan.example\nNonce: 1')), SITE),
    ).rejects.toThrow(/different site/);
    await expect(
      wallet.createSignature(
        { protocolID: [2, 'bwalletx auth'], keyID: NOW_S, counterparty: 'anyone', data: [1] },
        SITE,
      ),
    ).rejects.toThrow(/reserved/);
    expect(sheets.length).toBe(0);
  });

  test("the wallet's own calls are not touched", async () => {
    const { wallet, sheets } = setup();
    await wallet.createSignature(bitplan(NOW_S), ADMIN);
    expect(sheets.length).toBe(0);
  });
});

describe('regression: sign-ins that kept their one tap still do (one sheet, then remembered)', () => {
  const twice = async (args: (n: number) => unknown) => {
    const { wallet, sheets } = setup();
    await wallet.createSignature(args(1), SITE);
    await wallet.createSignature(args(2), SITE);
    return sheets;
  };
  test("Sign in with bWalletX [2, 'bwallet sign in'] (bChatX, bit-sign), even with a digits-only nonce", async () => {
    const sheets = await twice((n) => ({
      protocolID: [2, 'bwallet sign in'],
      keyID: `176304000${n}`,
      counterparty: 'anyone',
      data: enc(`Sign in to ${SITE} with bWallet\nNonce: ${n}`),
    }));
    expect(sheets.length).toBe(1);
    expect(isOneUseRequestID(sheets[0].requestID)).toBe(false);
  });
  test("bAds sign-in [2, 'bads session'] (badvertisingx.com)", async () => {
    const sheets = await twice((n) => ({
      protocolID: [2, 'bads session'],
      keyID: `0123456789abcdef0123456789abcde${n}`,
      counterparty: 'anyone',
      data: enc(`Sign in to bAdvertisingX (bAds)\nNonce: ${n}`),
    }));
    expect(sheets.length).toBe(1);
  });
  test("BRC-103/104 mutual auth [2, 'auth message signature'] to a server's key", async () => {
    const server = (await new ProtoWallet(PrivateKey.fromRandom()).getPublicKey({ identityKey: true })).publicKey;
    const sheets = await twice((n) => ({
      protocolID: [2, 'auth message signature'],
      keyID: `nonce-a-${n} nonce-b-${n}`,
      counterparty: server,
      data: [n],
    }));
    expect(sheets.length).toBe(1);
  });
});

describe('isBearerSignature', () => {
  const sig = (protocolID: unknown, keyID = 'k1', counterparty = 'anyone') => ({ protocolID, keyID, counterparty });
  test('sign-in names, BRC-77 and time keyIDs with anyone', () => {
    expect(isBearerSignature(sig([1, 'bitcoin auth']))).toBe(true);
    expect(isBearerSignature(sig([2, 'message signing']))).toBe(true);
    expect(isBearerSignature(sig([2, 'acme login']))).toBe(true);
    expect(isBearerSignature(sig([2, 'acme feed'], '1763040000123'))).toBe(true);
  });
  test('not: other counterparties, our one-tap sign-ins, ordinary anyone signatures, module names, level 0', () => {
    expect(isBearerSignature(sig([1, 'bitcoin auth'], NOW_S, 'self'))).toBe(false);
    expect(isBearerSignature(sig([1, 'bitcoin auth'], NOW_S, '02'.padEnd(66, 'a')))).toBe(false);
    expect(isBearerSignature(sig([2, 'bwallet sign in'], NOW_S))).toBe(false);
    expect(isBearerSignature(sig([2, 'Auth Message Signature'], NOW_S))).toBe(false);
    expect(isBearerSignature(sig([2, 'bads session'], 'abcdef0123456789'))).toBe(false);
    expect(isBearerSignature(sig([2, 'p auth'], NOW_S))).toBe(false);
    expect(isBearerSignature(sig([0, 'bitcoin auth'], NOW_S))).toBe(false);
  });
  test('isTimeKeyID', () => {
    for (const k of [
      '1763040000',
      '1763040000123',
      '1763040000.5',
      '2026-11-13T10:00:00Z',
      '2026-11-13 10:00',
      '20261113T100000Z',
      '176304000',
      '17630400001',
      'ts-1763040000-a1b2',
      'nonce-1763040000',
    ])
      expect(isTimeKeyID(k)).toBe(true);
    for (const k of ['123', 'a1b2c3d4e5f6', '0123456789abcdef0123456789abcdef', 'abc1763040000def', undefined])
      expect(isTimeKeyID(k)).toBe(false);
  });
});

describe('wiring', () => {
  const root = join(import.meta.dir, '..');
  const bg = readFileSync(join(root, 'background.ts'), 'utf8');
  const init = readFileSync(join(root, 'initWallet.ts'), 'utf8');
  test("the bundle answer grants a one-signature request with oneUseGrant, never the sheet's standing expiry", () => {
    const fn = bg.slice(bg.indexOf('const processBundlePermissionResponse'));
    const grant = fn.slice(fn.indexOf("if (!wallet) throw new Error('Wallet is locked');"));
    expect(grant.slice(0, grant.indexOf('pending.resolve();'))).toContain(
      'isOneUseRequestID(r.requestID) ? oneUseGrant(r.requestID) : { requestID: r.requestID, expiry }',
    );
  });
  test('initWallet installs the guard inside the reserved-protocol and cross-site refusals', () => {
    const reserved = init.indexOf('guardReservedProtocols(\n');
    const cross = init.indexOf('guardCrossSiteSigning(\n');
    const shared = init.indexOf('guardSharedKeySigning(\n');
    expect(reserved).toBeGreaterThan(0);
    expect(cross).toBeGreaterThan(reserved);
    expect(shared).toBeGreaterThan(cross);
    expect(shared).toBeLessThan(init.indexOf('preserveOriginalErrors(\n'));
  });
  test('the guard refuses to install on a manager without the members it relies on', () => {
    expect(() => guardSharedKeySigning({ createSignature: async () => ({}) }, { adminOriginator: ADMIN })).toThrow(
      /missing/,
    );
  });
});
