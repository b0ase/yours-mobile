/**
 * The connect sheet's protocol lines (b-Aware, Limenelo, 13 Nov 2026, HIGH; Juann E-2, Low; review of ae664e79).
 *
 * Before: every counterparty-'anyone' request was one pre-ticked "Prove it's you (a signature anyone can check)" line
 * on the SIGN IN card, whatever it was for (a decrypt too), and a level-1 sign-in protocol such as 'bitcoin auth'
 * (whose grant covers 'anyone' signatures other services accept as you) was a pre-ticked sign-in.
 * After:
 *  - each line names its operation;
 *  - keys every app shares (level 1; level 2 for 'anyone' in any spelling) are never pre-ticked, in calm words;
 *  - a one-signature request alone on its sheet gets the SIGN ONCE card: one tap, the risk said in words;
 *  - our own sign-ins and BRC-103 keep their one tap.
 *
 * Requests are built the way the toolbox raises them (usageType set; a level-1 request has no counterparty).
 */
import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
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
const G = new PrivateKey(1).toPublicKey().toString();
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
const once = (id = 'once:evil.example:1,bitcoin auth:x.1') =>
  req(id, { protocolID: [1, 'bitcoin auth'], usageType: 'signing', oneUse: true });

describe('keys every app shares are never pre-ticked', () => {
  test("level-1 'bitcoin auth' (standing): pre-ticked again, but never a sign-in, in plain words", () => {
    // Consent polish (13 Nov 2026): every level-1 signature not made as 'self' asks on its own at signing time, so a
    // standing level-1 grant can't make a token. The line is an ordinary key use: ticked, CONNECT card.
    const s = sheet(bitcoinAuth);
    expect(isSharedKeyRequest(bitcoinAuth)).toBe(false);
    expect(s.line.checked).toBe(true);
    expect(s.line.risky).toBe(false);
    expect(s.line.signIn).toBe(false); // was true before ae664e79
    expect(s.kind).toBe('connect'); // was 'signin' before ae664e79
    expect(s.line.text).toBe(`Sign with your "bitcoin auth" keys for ${SITE}`);
    expect(oneTap(s)[bitcoinAuth.requestID]).toBe(true);
  });

  test('unticking it, then Allow, leaves it out', () => {
    const s = sheet(bitcoinAuth);
    const d = sheetAnswer(s.model, 'allow', { [bitcoinAuth.requestID]: false }, true, sheetView(s.model, false));
    expect(d.decisions[bitcoinAuth.requestID]).toBe(false);
  });

  test("level-2 'anyone' outside our sign-ins: unticked, in any spelling of 'anyone'", () => {
    for (const counterparty of ['anyone', G, G.toUpperCase()]) {
      const r = req('a', { protocolID: [2, 'acme feed'], counterparty, usageType: 'signing' });
      const s = sheet(r);
      expect(isSharedKeyRequest(r)).toBe(true);
      expect(s.line.checked).toBe(false); // was true ("Prove it's you")
      expect(s.line.text).toBe(`Sign as you for ${SITE} ("acme feed"), a signature anyone can check`);
    }
  });

  test('a level-1 decrypt names its operation and the site, pre-ticked', () => {
    const r = req('d', { protocolID: [1, 'docs vault'], usageType: 'encrypting', calls: ['decrypt'] });
    const s = sheet(r);
    expect(s.line.text).toBe(`Decrypt with your "docs vault" keys for ${SITE}`);
    expect(s.line.checked).toBe(true);
  });

  test('not shared: the public identity key, the first-post signature, labels, a known-safe level-1 name', () => {
    const id = req('i', { protocolID: [1, 'identity key retrieval'], counterparty: 'self', usageType: 'identityKey' });
    const sigma = req('s', { protocolID: [1, 'sigma'], counterparty: 'self', usageType: 'signing' });
    const label = req('l', { protocolID: [1, 'action label shop'], usageType: 'generic' });
    const bcal = req('c', { protocolID: [1, 'bcal record'], usageType: 'signing' });
    for (const r of [id, sigma, label, bcal]) expect(isSharedKeyRequest(r)).toBe(false);
    expect(sheet(id).line.checked).toBe(true);
  });
});

describe('one signature: the SIGN ONCE card, one tap', () => {
  test('alone on its sheet: SIGN ONCE, its line ticked, one tap answers it', () => {
    const r = once();
    const s = sheet(r);
    expect(s.kind).toBe('signonce');
    expect(s.line.once).toBe(true);
    expect(s.line.risky).toBe(false);
    expect(s.line.text).toBe(`Sign once as you for ${SITE} ("bitcoin auth"). Other sites could accept this too`);
    expect(oneTap(s)).toEqual({ [r.requestID]: true });
  });

  test('two at once, or beside other lines: careful card, each unticked (one tap never answers two)', () => {
    const two = sheet(once('once:a'), once('once:b'));
    expect(two.kind).toBe('careful');
    expect(two.model.lines.every((l) => !l.checked && l.risky)).toBe(true);
    const mixed = sheet(once('once:c'), req('k', { type: 'basket', basket: 'tickets' }));
    expect(mixed.kind).toBe('careful');
    expect(mixed.model.lines.find((l) => l.requestID === 'once:c')?.checked).toBe(false);
  });

  test('a one-signature line that joined a sheet live is never pre-ticked', () => {
    const s = sheet({ ...once('once:live'), addedLive: true });
    expect(s.line.checked).toBe(false);
    expect(s.kind).not.toBe('signonce');
  });
});

describe('each line names its operation', () => {
  const ours = (usageType: string, calls?: string[]) =>
    sheet(
      req('a', { protocolID: [2, 'bwallet sign in'], counterparty: 'anyone', usageType, ...(calls ? { calls } : {}) }),
    ).line.text;
  test("our sign-in protocol with 'anyone': only a real signature is \"Prove it's you\"", () => {
    expect(ours('signing', ['createSignature'])).toBe("Prove it's you (a signature anyone can check)");
    expect(ours('signing', ['verifySignature'])).toBe('Check signatures with your "bwallet sign in" keys');
    expect(ours('encrypting', ['encrypt'])).toBe('Encrypt with your "bwallet sign in" keys, readable by anyone');
    expect(ours('encrypting', ['decrypt'])).toBe('Decrypt with your "bwallet sign in" keys');
    expect(ours('encrypting')).toBe('Encrypt and decrypt with your "bwallet sign in" keys');
    expect(ours('hmac', ['createHmac'])).toBe('Make and check HMAC codes with your "bwallet sign in" keys');
    expect(ours('linkageRevelation')).toBe('Reveal how others can link your "bwallet sign in" keys');
  });
  test("other level-2 'anyone' keys name the operation too", () => {
    const t = (usageType: string, calls?: string[]) =>
      sheet(req('a', { protocolID: [2, 'docs vault'], counterparty: 'anyone', usageType, ...(calls ? { calls } : {}) }))
        .line.text;
    expect(t('encrypting', ['decrypt'])).toBe(`Decrypt with your "docs vault" keys for ${SITE}`);
    expect(t('hmac')).toBe(`Make and check HMAC codes with your "docs vault" keys for ${SITE}`);
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
    for (const protocolID of [
      [2, 'docs vault'],
      [2, 'bwallet sign in'],
    ] as [number, string][]) {
      const r = req('d', { protocolID, counterparty: 'anyone', usageType: 'encrypting', calls: ['decrypt'] });
      const s = sheet(r);
      expect(s.line.text).not.toContain("Prove it's you"); // was "Prove it's you (a signature anyone can check)"
      expect(isSignInRequest(r)).toBe(false); // was true
      expect(s.kind).not.toBe('signin'); // was 'signin'
    }
  });
  test('the same for encrypt, HMAC, key linkage and public keys', () => {
    for (const usageType of ['encrypting', 'hmac', 'linkageRevelation', 'publicKey']) {
      const r = req('x', { protocolID: [2, 'bwallet sign in'], counterparty: 'anyone', usageType });
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
  test("Sign in with bWalletX (bChatX, bit-sign): identity key + 'bwallet sign in' signature", () => {
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
  test("bAds sign-in 'bads session' (badvertisingx.com)", () => {
    const s = sheet(req('b', { protocolID: [2, 'bads session'], counterparty: 'anyone', usageType: 'signing' }));
    expect(s.kind).toBe('signin');
    expect(oneTap(s)).toEqual({ b: true });
  });
  test("BRC-103/104 'auth message signature' to a server's key: one CONNECT tap, as before", () => {
    const s = sheet(
      req('m', { protocolID: [2, 'auth message signature'], counterparty: '03'.padEnd(66, 'c'), usageType: 'signing' }),
    );
    expect(s.kind).toBe('connect');
    expect(s.line.checked).toBe(true);
    expect(oneTap(s)).toEqual({ m: true });
  });
  test("a site's first post ('sigma' + bap basket) keeps its POST card", () => {
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
