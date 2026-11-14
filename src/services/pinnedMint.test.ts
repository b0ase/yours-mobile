import { describe, expect, test } from 'bun:test';
import {
  DeferredEncrypts,
  labelCoveredByIntent,
  MAX_DEFERRED_ENCRYPTS,
  mintIntentFor,
  mintSheetFor,
  ProtocolCalls,
  shouldDeferEncrypt,
} from './pinnedMint';

const PID: [number, string] = [2, 'bvideox records'];
const SITE = 'bvideox.com';
const enc = { type: 'protocol', originator: SITE, protocolID: PID, counterparty: 'self', privileged: false };
const mintParams = {
  description: 'bVideoX: 3 private video records',
  labels: ['bvideox records'],
  outputs: [{ satoshis: 0 }, { satoshis: 0 }, { satoshis: 0 }, { satoshis: 3600 }],
  options: { spendingAuthorization: { protocolID: PID } },
};

describe('shouldDeferEncrypt: a pinned site self-encrypt goes through for one call', () => {
  test('only while a self-encrypt on that protocol is running', () => {
    const calls = new ProtocolCalls();
    const d = new DeferredEncrypts();
    expect(shouldDeferEncrypt(enc, calls, d, 0)).toBe(false); // nothing running: e.g. the companion pre-ask
    const end = calls.start('encrypt', SITE, { protocolID: PID, counterparty: 'self' });
    expect(shouldDeferEncrypt(enc, calls, d, 0)).toBe(true);
    end();
    expect(shouldDeferEncrypt(enc, calls, d, 0)).toBe(false);
  });

  test('never while a decrypt (or any other call) on the protocol is in flight', () => {
    const calls = new ProtocolCalls();
    const d = new DeferredEncrypts();
    calls.start('encrypt', SITE, { protocolID: PID, counterparty: 'self' });
    calls.start('decrypt', SITE, { protocolID: PID, counterparty: 'self' });
    expect(shouldDeferEncrypt(enc, calls, d, 0)).toBe(false);
  });

  test('never for another site, another counterparty, privileged, or an unpinned protocol', () => {
    const calls = new ProtocolCalls();
    const d = new DeferredEncrypts();
    calls.start('encrypt', 'evil.com', { protocolID: PID });
    calls.start('encrypt', SITE, { protocolID: PID });
    calls.start('encrypt', SITE, { protocolID: [2, 'other thing'] });
    expect(shouldDeferEncrypt({ ...enc, originator: 'evil.com' }, calls, d, 0)).toBe(false);
    expect(shouldDeferEncrypt({ ...enc, counterparty: 'anyone' }, calls, d, 0)).toBe(false);
    expect(shouldDeferEncrypt({ ...enc, privileged: true }, calls, d, 0)).toBe(false);
    expect(shouldDeferEncrypt({ ...enc, protocolID: [2, 'other thing'] }, calls, d, 0)).toBe(false);
    expect(shouldDeferEncrypt({ ...enc, type: 'spending' }, calls, d, 0)).toBe(false);
    // bmintx archive is pinned but has no mint action: always its own sheet.
    calls.start('encrypt', 'bmintx.com', { protocolID: [2, 'bmintx archive'] });
    expect(
      shouldDeferEncrypt({ ...enc, originator: 'bmintx.com', protocolID: [2, 'bmintx archive'] }, calls, d, 0),
    ).toBe(false);
  });

  test('an encrypt for someone else counts as "other": no let-through', () => {
    const calls = new ProtocolCalls();
    calls.start('encrypt', SITE, { protocolID: PID, counterparty: '02abc' });
    expect(calls.onlyEncrypt(SITE, PID)).toBe(false);
  });

  test('rate cap per site per window', () => {
    const calls = new ProtocolCalls();
    const d = new DeferredEncrypts();
    calls.start('encrypt', SITE, { protocolID: PID });
    for (let i = 0; i < MAX_DEFERRED_ENCRYPTS; i++) d.note(SITE, PID, 1000);
    expect(shouldDeferEncrypt(enc, calls, d, 1000)).toBe(false);
    expect(shouldDeferEncrypt(enc, calls, d, 1000 + 11 * 60_000)).toBe(true);
  });
});

describe('mintIntentFor and the sheet words', () => {
  test('a bvideox.com mint', () => {
    const i = mintIntentFor(SITE, mintParams);
    expect(i).not.toBeNull();
    expect(i?.count).toBe(3);
    expect(i?.outputSats).toBe(3600);
    const sheet = mintSheetFor(i!, 3600 + 120);
    expect(sheet.title).toBe('Mint 3 videos, locked to you on bvideox.com');
    expect(sheet.premiumSats).toBe(3600);
    expect(sheet.feeSats).toBe(120);
    expect(mintSheetFor({ ...i!, count: 1 }, 1300).title).toBe('Mint 1 video, locked to you on bvideox.com');
  });

  test('no intent from another site, without the protocol option, or for an unpinned protocol', () => {
    expect(mintIntentFor('evil.com', mintParams)).toBeNull();
    expect(mintIntentFor(SITE, { ...mintParams, options: {} })).toBeNull();
    expect(
      mintIntentFor(SITE, { ...mintParams, options: { spendingAuthorization: { protocolID: [2, 'x'] } } }),
    ).toBeNull();
    expect(mintIntentFor(undefined, mintParams)).toBeNull();
  });

  test('a spend smaller than the outputs never shows a negative fee', () => {
    const s = mintSheetFor(mintIntentFor(SITE, mintParams)!, 100);
    expect(s.premiumSats).toBe(100);
    expect(s.feeSats).toBe(0);
  });
});

describe('labelCoveredByIntent', () => {
  const intent = mintIntentFor(SITE, mintParams)!;
  const label = {
    type: 'protocol',
    originator: SITE,
    protocolID: [1, 'action label bvideox records'],
    counterparty: 'self',
    usageType: 'generic',
  };
  test("only that action's label, from that site", () => {
    expect(labelCoveredByIntent(label, intent)).toBe(true);
    expect(labelCoveredByIntent({ ...label, originator: 'evil.com' }, intent)).toBe(false);
    expect(labelCoveredByIntent({ ...label, protocolID: [1, 'action label other'] }, intent)).toBe(false);
    expect(labelCoveredByIntent({ ...label, protocolID: [2, 'action label bvideox records'] }, intent)).toBe(false);
    expect(labelCoveredByIntent({ ...label, privileged: true }, intent)).toBe(false);
    expect(labelCoveredByIntent(label, undefined)).toBe(false);
  });
  // As the manager raises them during bvideox.com's own createAction (counterparty dropped at level 1).
  const asRaised = { type: 'protocol', originator: SITE, protocolID: [1, 'action label bvideox records'] };
  test('during the mint: a level-1 decrypt, an HMAC and a one-signature request under the label name each ask', () => {
    const decrypt = { ...asRaised, usageType: 'encrypting', requestID: 'proto:bvideox.com:false:1,x::encrypting' };
    const hmac = { ...asRaised, usageType: 'hmac', requestID: 'proto:bvideox.com:false:1,x::hmac' };
    const once = { ...asRaised, counterparty: undefined, usageType: 'signing', requestID: 'once:bvideox.com:1,x:a.1' };
    for (const r of [decrypt, hmac, once]) expect(labelCoveredByIntent(r, intent)).toBe(false);
    // A one-signature request is never a label, whatever usage it claims.
    expect(labelCoveredByIntent({ ...once, usageType: 'generic' }, intent)).toBe(false);
    // The label check itself still goes through.
    expect(labelCoveredByIntent({ ...asRaised, usageType: 'generic', requestID: 'proto:x::generic' }, intent)).toBe(
      true,
    );
  });
  test('a key operation under the label name is not a label: decrypt, HMAC, signing each get a sheet', () => {
    for (const usageType of ['encrypting', 'hmac', 'signing', 'publicKey', 'linkageRevelation', undefined])
      expect(labelCoveredByIntent({ ...label, usageType }, intent)).toBe(false);
  });
});
