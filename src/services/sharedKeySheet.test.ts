/**
 * The connect sheet's protocol lines (b-Aware, Limenelo, 13 Nov 2026, HIGH; Juann E-2, Low).
 *
 * Before: every counterparty-'anyone' request was one pre-ticked "Prove it's you (a signature anyone can check)" line
 * on the SIGN IN card, whatever it was for (a decrypt too), and a level-1 sign-in protocol such as [1, 'bitcoin auth']
 * (whose grant covers 'anyone' signatures other services accept as you) was a pre-ticked sign-in.
 * After: each line names its operation; keys every app shares are never pre-ticked, are red, and say in words that
 * other sites could accept the signature; our own sign-ins and BRC-103 keep their one tap.
 *
 * Requests are built the way the toolbox raises them (usageType set; a level-1 request has no counterparty).
 */
import { describe, expect, test } from 'bun:test';
import { approvalKindForSheet } from './approvalKind';
import {
  buildSheetModel,
  isSharedKeyRequest,
  isSignInRequest,
  keyOperation,
  sheetAnswer,
  sheetView,
  type BundleRequest,
} from './permissionBundle';
import { ProtocolCalls } from './pinnedMint';

const SITE = 'evil.example';
const req = (requestID: string, extra: Partial<BundleRequest>): BundleRequest => ({
  requestID,
  type: 'protocol',
  originator: SITE,
  ...extra,
});
const sheet = (...items: BundleRequest[]) => {
  const model = buildSheetModel({ originator: SITE, items });
  const kind = approvalKindForSheet(model);
  return { model, kind, line: model.lines[0] };
};
/** What one tap on the main button answers, with the card's real view (BundleSheet, nothing ticked by hand). */
const oneTap = (s: ReturnType<typeof sheet>) =>
  sheetAnswer(s.model, 'allow', {}, s.kind !== 'careful', sheetView(s.model, s.kind === 'careful', undefined, s.kind))
    .decisions;

const bitcoinAuth = req('proto:evil.example:false:1,bitcoin auth::signing', {
  protocolID: [1, 'bitcoin auth'],
  usageType: 'signing',
});

describe('keys every app shares are never pre-ticked', () => {
  test("[1, 'bitcoin auth'] signing: unticked, red, careful card, no longer a sign-in", () => {
    const s = sheet(bitcoinAuth);
    expect(isSharedKeyRequest(bitcoinAuth)).toBe(true);
    expect(s.line.checked).toBe(false); // was true
    expect(s.line.risky).toBe(true);
    expect(s.line.signIn).toBe(false); // was true
    expect(s.kind).toBe('careful'); // was 'signin'
    expect(oneTap(s)[bitcoinAuth.requestID]).toBe(false); // a tap on the button alone grants nothing
  });

  test('the line names the site and says other sites could accept it, in plain words', () => {
    const { line } = sheet(bitcoinAuth);
    expect(line.text).toContain(SITE);
    expect(line.text).toContain('Other sites could accept');
    expect(line.text).not.toContain("Prove it's you");
    expect(line.text).not.toMatch(/counterparty|BRC|level|derive/i); // the jargon stays under Details
    expect(line.detail).toContain('protocol "bitcoin auth" level 1');
  });

  test('ticking it, then Allow, grants it (the user chooses knowingly)', () => {
    const s = sheet(bitcoinAuth);
    const d = sheetAnswer(s.model, 'allow', { [bitcoinAuth.requestID]: true }, false, sheetView(s.model, true));
    expect(d.decisions[bitcoinAuth.requestID]).toBe(true);
  });

  test('a one-signature request: "Sign once", unticked, careful', () => {
    const once = req('once:evil.example:2,message signing:x.1', {
      protocolID: [2, 'message signing'],
      counterparty: 'anyone',
      usageType: 'signing',
      oneUse: true,
    });
    const s = sheet(once);
    expect(s.line.text).toMatch(/^Sign once as you for evil\.example/);
    expect(s.line.checked).toBe(false);
    expect(s.kind).toBe('careful');
    expect(oneTap(s)[once.requestID]).toBe(false);
  });

  test('a level-1 decrypt is shared too (its grant lets the site sign), and says so', () => {
    const r = req('d', { protocolID: [1, 'docs vault'], usageType: 'encrypting', calls: ['decrypt'] });
    const s = sheet(r);
    expect(s.line.text).toBe(
      `Decrypt with your "docs vault" keys. This also lets ${SITE} sign as you, and other sites could accept it`,
    );
    expect(s.line.checked).toBe(false);
  });

  test('not shared: the public identity key, the first-post signature, level-1 labels', () => {
    const id = req('i', { protocolID: [1, 'identity key retrieval'], counterparty: 'self', usageType: 'identityKey' });
    const sigma = req('s', { protocolID: [1, 'sigma'], counterparty: 'self', usageType: 'signing' });
    const label = req('l', { protocolID: [1, 'action label shop'], usageType: 'generic' });
    for (const r of [id, sigma, label]) expect(isSharedKeyRequest(r)).toBe(false);
    expect(sheet(id).line.checked).toBe(true);
  });
});

describe('each line names its operation', () => {
  const anyone = (usageType: string, calls?: string[]) =>
    sheet(req('a', { protocolID: [2, 'docs vault'], counterparty: 'anyone', usageType, ...(calls ? { calls } : {}) }))
      .line.text;
  test("counterparty 'anyone'", () => {
    expect(anyone('signing', ['createSignature'])).toBe("Prove it's you (a signature anyone can check)");
    expect(anyone('signing', ['verifySignature'])).toBe('Check signatures with your "docs vault" keys');
    expect(anyone('encrypting', ['encrypt'])).toBe('Encrypt with your "docs vault" keys, readable by anyone');
    expect(anyone('encrypting', ['decrypt'])).toBe('Decrypt with your "docs vault" keys');
    expect(anyone('encrypting')).toBe('Encrypt and decrypt with your "docs vault" keys');
    expect(anyone('hmac', ['createHmac'])).toBe('Make and check HMAC codes with your "docs vault" keys');
    expect(anyone('linkageRevelation')).toBe('Reveal how others can link your "docs vault" keys');
  });
  test('your own keys (self) and keys shared with one named service', () => {
    const self = sheet(
      req('s', { protocolID: [2, 'acme files'], counterparty: 'self', usageType: 'encrypting', calls: ['decrypt'] }),
    );
    expect(self.line.text).toBe('Decrypt with your "acme files" keys');
    const peer = sheet(
      req('p', { protocolID: [2, 'acme files'], counterparty: '02'.padEnd(66, 'b'), usageType: 'hmac' }),
    );
    expect(peer.line.text).toBe(
      'Make and check HMAC codes with your "acme files" keys, shared with one named person or service',
    );
  });
  test('keyOperation: unknown calls count as the stronger operation', () => {
    expect(keyOperation({ usageType: 'signing' })).toBe('sign');
    expect(keyOperation({ usageType: 'signing', calls: ['createSignature', 'verifySignature'] })).toBe('sign');
    expect(keyOperation({ usageType: 'encrypting', calls: ['encrypt', 'decrypt'] })).toBe('encryptDecrypt');
    expect(keyOperation({})).toBe('other');
  });
});

describe("Juann E-2: a decrypt with 'anyone' is not \"Prove it's you\"", () => {
  test('decrypt: its own words, not a sign-in, not the SIGN IN card', () => {
    const r = req('d', {
      protocolID: [2, 'docs vault'],
      counterparty: 'anyone',
      usageType: 'encrypting',
      calls: ['decrypt'],
    });
    const s = sheet(r);
    expect(s.line.text).not.toContain("Prove it's you"); // was "Prove it's you (a signature anyone can check)"
    expect(isSignInRequest(r)).toBe(false); // was true
    expect(s.kind).not.toBe('signin'); // was 'signin'
  });
  test('the same for encrypt, HMAC and key linkage', () => {
    for (const usageType of ['encrypting', 'hmac', 'linkageRevelation', 'publicKey']) {
      const r = req('x', { protocolID: [2, 'docs vault'], counterparty: 'anyone', usageType });
      expect(sheet(r).line.text).not.toContain("Prove it's you");
      expect(isSignInRequest(r)).toBe(false);
    }
  });
});

describe('regression: sign-ins that were one tap still are', () => {
  const identity = req('id', {
    protocolID: [1, 'identity key retrieval'],
    counterparty: 'self',
    usageType: 'identityKey',
  });
  test("Sign in with bWalletX (bChatX, bit-sign): identity key + [2, 'bwallet sign in'] signature", () => {
    const signIn = req('si', {
      protocolID: [2, 'bwallet sign in'],
      counterparty: 'anyone',
      usageType: 'signing',
      calls: ['createSignature'],
    });
    const s = sheet(identity, signIn);
    expect(s.kind).toBe('signin');
    expect(s.model.lines.find((l) => l.requestID === 'si')?.text).toBe("Prove it's you (a signature anyone can check)");
    expect(s.model.lines.every((l) => l.checked && !l.risky)).toBe(true);
    expect(oneTap(s)).toEqual({ id: true, si: true });
  });
  test("bAds sign-in [2, 'bads session'] (badvertisingx.com)", () => {
    const s = sheet(req('b', { protocolID: [2, 'bads session'], counterparty: 'anyone', usageType: 'signing' }));
    expect(s.kind).toBe('signin');
    expect(oneTap(s)).toEqual({ b: true });
  });
  test("BRC-103/104 [2, 'auth message signature'] to a server's key: one CONNECT tap, as before", () => {
    const s = sheet(
      req('m', { protocolID: [2, 'auth message signature'], counterparty: '03'.padEnd(66, 'c'), usageType: 'signing' }),
    );
    expect(s.kind).toBe('connect');
    expect(s.line.checked).toBe(true);
    expect(oneTap(s)).toEqual({ m: true });
  });
  test("a site's first post ([1, 'sigma'] + bap basket) keeps its POST card", () => {
    const s = sheet(req('s', { protocolID: [1, 'sigma'], counterparty: 'self', usageType: 'signing' }), {
      requestID: 'b',
      type: 'basket',
      originator: SITE,
      basket: 'bap',
    });
    expect(s.kind).toBe('post');
    expect(oneTap(s)).toEqual({ s: true, b: true });
  });
});

describe('ProtocolCalls.methods (what raised a protocol request)', () => {
  test('lists running methods for a site+protocol, and forgets them when they end', () => {
    const calls = new ProtocolCalls();
    const args = { protocolID: [2, 'docs vault'], counterparty: 'anyone' };
    const end1 = calls.start('decrypt', SITE, args);
    const end2 = calls.start('decrypt', SITE, args);
    const end3 = calls.start('createSignature', SITE, args);
    expect(calls.methods(SITE, [2, 'docs vault'])).toEqual(['createSignature', 'decrypt']);
    end3();
    end1();
    expect(calls.methods(SITE, [2, 'docs vault'])).toEqual(['decrypt']);
    end2();
    expect(calls.methods(SITE, [2, 'docs vault'])).toEqual([]);
    expect(calls.methods('other.example', [2, 'docs vault'])).toEqual([]);
  });
});
