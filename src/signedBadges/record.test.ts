import { describe, expect, test } from 'bun:test';
import { AUTHSIG_MAINNET_RECORD } from './fixtures';
import {
  decodeProofValue,
  encodeProofValue,
  isContentHashKey,
  isProofKey,
  proofTxid,
  shortKey,
  storageKeyFor,
  xPostIdFromKey,
  xPostKey,
} from './record';

describe('AuthSig record keys', () => {
  test('x-post-<status id> for a post on X', () => {
    expect(xPostKey('2116316140108648629')).toBe('x-post-2116316140108648629');
    expect(xPostIdFromKey('x-post-2116316140108648629')).toBe('2116316140108648629');
    expect(xPostKey('12a')).toBeUndefined();
    expect(xPostIdFromKey('x-post-')).toBeUndefined();
    expect(xPostIdFromKey('x-post-1;drop')).toBeUndefined();
  });
  test('content-hash keys are 64 lowercase hex', () => {
    expect(isContentHashKey('489b4ebc8413ca528505205378920579e01040937cf121cae1a6894d225c4362')).toBe(true);
    expect(isContentHashKey('489B4EBC8413CA528505205378920579E01040937CF121CAE1A6894D225C4362')).toBe(false);
    expect(isContentHashKey('abc')).toBe(false);
  });
  test('isProofKey accepts only the two forms', () => {
    expect(isProofKey('x-post-1')).toBe(true);
    expect(isProofKey('a'.repeat(64))).toBe(true);
    expect(isProofKey('kvstore-anything')).toBe(false);
    expect(isProofKey(42)).toBe(false);
  });
  test('storageKeyFor: X status id wins, else the content hash', () => {
    expect(storageKeyFor({ xStatusId: '99', contentHash: 'f'.repeat(64) })).toBe('x-post-99');
    expect(storageKeyFor({ contentHash: 'f'.repeat(64) })).toBe('f'.repeat(64));
    expect(storageKeyFor({ xStatusId: 'nope', contentHash: 'f'.repeat(64) })).toBe('f'.repeat(64));
  });
});

describe('AuthSig record values', () => {
  test('decodes a real mainnet AuthSig record', () => {
    const v = decodeProofValue(AUTHSIG_MAINNET_RECORD.value)!;
    expect(v.protocol).toBe('authsig-v1');
    expect(v.publicKey).toBe(AUTHSIG_MAINNET_RECORD.controller);
    expect(v.content).toBe('How many switch ports total');
    expect(v.contentHash).toBe('489b4ebc8413ca528505205378920579e01040937cf121cae1a6894d225c4362');
    expect(v.signer).toBeUndefined();
  });

  test('re-encoding an AuthSig value gives the same bytes (same fields, same order)', () => {
    const v = decodeProofValue(AUTHSIG_MAINNET_RECORD.value)!;
    expect(encodeProofValue(v)).toBe(AUTHSIG_MAINNET_RECORD.value);
  });

  test('our extra fields come after AuthSig’s six and round-trip', () => {
    const base = decodeProofValue(AUTHSIG_MAINNET_RECORD.value)!;
    const raw = encodeProofValue({
      ...base,
      signer: '$alice',
      pageUrl: 'https://x.com/alice/status/2116316140108648629',
      platform: 'x.com',
      postId: '2116316140108648629',
      authorHandle: 'alice',
    });
    expect(Object.keys(JSON.parse(raw))).toEqual([
      'signature',
      'publicKey',
      'signedAt',
      'protocol',
      'content',
      'contentHash',
      'signer',
      'pageUrl',
      'platform',
      'postId',
      'authorHandle',
    ]);
    expect(decodeProofValue(raw)).toEqual({
      ...base,
      signer: '$alice',
      pageUrl: 'https://x.com/alice/status/2116316140108648629',
      platform: 'x.com',
      postId: '2116316140108648629',
      authorHandle: 'alice',
    });
  });

  test('a record without content (some content-hash records) still decodes', () => {
    const v = decodeProofValue(
      '{"signature":"3044022011341880af98eade7cbae61a2048a47329b4a0de68b01aedcb3074e743cdad2602201f6ad144dff0d53bf177e7358e3bf65a279350924693c9d2eebf756c33445ddf","publicKey":"02ee08916354199095937ec494d713701e588806fcae55bba7c543889614aab682","signedAt":"2026-10-30T23:41:28.449Z","protocol":"authsig-v1"}',
    )!;
    expect(v.content).toBeUndefined();
    expect(v.publicKey).toBe('02ee08916354199095937ec494d713701e588806fcae55bba7c543889614aab682');
  });

  test.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['no signature', '{"publicKey":"02' + '0'.repeat(64) + '","signedAt":"2026-01-01","protocol":"authsig-v1"}'],
    [
      'non-hex signature',
      '{"signature":"zz' +
        '0'.repeat(20) +
        '","publicKey":"02' +
        '0'.repeat(64) +
        '","signedAt":"2026-01-01","protocol":"authsig-v1"}',
    ],
    [
      'bad key',
      '{"signature":"' +
        '0'.repeat(20) +
        '","publicKey":"04' +
        '0'.repeat(64) +
        '","signedAt":"2026-01-01","protocol":"authsig-v1"}',
    ],
    [
      'bad date',
      '{"signature":"' +
        '0'.repeat(20) +
        '","publicKey":"02' +
        '0'.repeat(64) +
        '","signedAt":"yesterday","protocol":"authsig-v1"}',
    ],
    [
      'bad content hash',
      '{"signature":"' +
        '0'.repeat(20) +
        '","publicKey":"02' +
        '0'.repeat(64) +
        '","signedAt":"2026-01-01","protocol":"authsig-v1","contentHash":"xyz"}',
    ],
  ])('rejects %s', (_label, raw) => {
    expect(decodeProofValue(raw)).toBeNull();
  });

  test('drops unsafe or malformed extras instead of failing', () => {
    const base = JSON.parse(AUTHSIG_MAINNET_RECORD.value);
    const v = decodeProofValue(
      JSON.stringify({ ...base, signer: 'alice', pageUrl: 'javascript:alert(1)', platform: 7 }),
    )!;
    expect(v.signer).toBeUndefined();
    expect(v.pageUrl).toBeUndefined();
    expect(v.platform).toBeUndefined();
    expect(v.content).toBe('How many switch ports total');
  });
});

describe('display helpers', () => {
  test('shortKey and proofTxid', () => {
    expect(shortKey(AUTHSIG_MAINNET_RECORD.controller)).toBe('023a1bd…90af');
    expect(proofTxid({ outpoint: `${AUTHSIG_MAINNET_RECORD.token.txid}.0` })).toBe(AUTHSIG_MAINNET_RECORD.token.txid);
    expect(proofTxid({ outpoint: 'bad.0' })).toBeUndefined();
    expect(proofTxid({})).toBeUndefined();
  });
});
