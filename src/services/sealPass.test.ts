import { describe, expect, test } from 'bun:test';
import { Hash, PrivateKey, Utils } from '@bsv/sdk';
import {
  SEAL_MAX_SATS,
  SEAL_PASS_MS,
  SealPasses,
  canonicalJson,
  isSealRequestId,
  opReturnData,
  readSealSign,
  sealActionMatches,
  sealSheetFor,
} from './sealPass';

const SITE = 'chat.bwalletx.com';
const OTHER = 'evil.example';
const KEY = PrivateKey.fromRandom().toPublicKey().toString();
const sha = (s: string) => Utils.toHex(Hash.sha256(Utils.toArray(s, 'utf8')));
const NONCE = 'n0nce_abcdefghijklmnop';

const record = (over: Record<string, unknown> = {}) => ({
  v: 'bitsign-seal-2',
  doc: sha('original document'),
  manifest: sha('manifest'),
  ref: 'BCORP-BOARD-013',
  fields: [{ id: 'sig-director', party: 'The Bitcoin Corporation Ltd', role: 'Director' }],
  svg: sha('<svg/>'),
  key: KEY,
  handle: 'b0asex',
  ts: '2026-11-02T12:00:00.000Z',
  nonce: NONCE,
  ...over,
});

const signArgs = (rec: Record<string, unknown> = record(), over: Record<string, unknown> = {}) => ({
  protocolID: [2, 'bitsign seal'],
  keyID: NONCE,
  counterparty: 'anyone',
  data: Array.from(new TextEncoder().encode(canonicalJson(rec))),
  ...over,
});

/** The OP_RETURN bit-sign writes (seal-inscription.ts sealLockingScriptHex), for a given payload. */
const scriptFor = (payload: Record<string, unknown>) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const n = bytes.length;
  const push =
    n < 0x4c
      ? n.toString(16).padStart(2, '0')
      : n <= 0xff
        ? `4c${n.toString(16).padStart(2, '0')}`
        : `4d${(n & 0xff).toString(16).padStart(2, '0')}${((n >> 8) & 0xff).toString(16).padStart(2, '0')}`;
  return '006a' + push + Utils.toHex(Array.from(bytes));
};

const payloadFor = (rec = record(), over: Record<string, unknown> = {}) => ({
  protocol: 'b0ase-bitsign',
  version: '2.0',
  type: 'nds_field_seal',
  docHash: sha('composed document'),
  origHash: rec.doc,
  recordHash: sha(canonicalJson(rec)),
  svgHash: rec.svg,
  fields: (rec.fields as { id: string }[]).map((f) => f.id).join(','),
  key: rec.key,
  ref: rec.ref,
  ts: rec.ts,
  ...over,
});

const actionArgs = (payload: Record<string, unknown> = payloadFor(), over: Record<string, unknown> = {}) => ({
  description: 'bit-sign: sign and seal a document',
  outputs: [
    { satoshis: 0, lockingScript: scriptFor(payload), outputDescription: 'Document seal (OP_RETURN, hashes only)' },
  ],
  options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  ...over,
});

const protoReq = (originator = SITE, over: Record<string, unknown> = {}) => ({
  type: 'protocol',
  originator,
  privileged: false,
  protocolID: [2, 'bitsign seal'],
  counterparty: 'anyone',
  ...over,
});
const spendReq = (satoshis: number, originator = SITE) => ({ type: 'spending', originator, spending: { satoshis } });

describe('readSealSign: recognises exactly a bit-sign seal', () => {
  test('a canonical seal record for this account is a seal; its hash is sha256 of the signed bytes', () => {
    const s = readSealSign(signArgs(), KEY);
    expect(s).not.toBeNull();
    expect(s!.recordHash).toBe(sha(canonicalJson(record())));
    expect(s!.doc).toBe(record().doc);
    expect(s!.nonce).toBe(NONCE);
  });

  test('anything else is not a seal (so it gets the normal sheets)', () => {
    expect(readSealSign(signArgs(record(), { protocolID: [2, 'other'] }), KEY)).toBeNull();
    expect(readSealSign(signArgs(record(), { counterparty: 'self' }), KEY)).toBeNull();
    expect(readSealSign(signArgs(record(), { privileged: true }), KEY)).toBeNull();
    expect(readSealSign(signArgs(record(), { keyID: 'another_nonce_123456' }), KEY)).toBeNull();
    expect(readSealSign(signArgs(record(), { hashToDirectlySign: [1, 2, 3] }), KEY)).toBeNull();
    expect(readSealSign(signArgs(record({ v: 'bitsign-seal-1' })), KEY)).toBeNull();
    expect(readSealSign(signArgs(record({ extra: 'x' })), KEY)).toBeNull();
    // Another account's key: not this person's seal.
    expect(readSealSign(signArgs(), PrivateKey.fromRandom().toPublicKey().toString())).toBeNull();
    // Not canonical (re-spaced): the bytes signed would not hash to what the chain carries.
    const spaced = Array.from(new TextEncoder().encode(JSON.stringify(record(), null, 1)));
    expect(readSealSign(signArgs(record(), { data: spaced }), KEY)).toBeNull();
  });

  test('the sheet names the document, never a bare id', () => {
    const s = readSealSign(signArgs(), KEY)!;
    expect(sealSheetFor(s, SITE).title).toBe('Seal BCORP-BOARD-013');
    expect(sealSheetFor(s, SITE).maxSats).toBe(SEAL_MAX_SATS);
    const id = readSealSign(signArgs(record({ ref: '89d9a8a1-0f76-47a5-8877-e2df5d209536' })), KEY)!;
    expect(sealSheetFor(id, SITE).title).toBe('Seal this document');
  });

  test('synthetic sheet ids', () => {
    expect(isSealRequestId('seal-abc')).toBe(true);
    expect(isSealRequestId('reconnect-abc')).toBe(false);
  });
});

describe('sealActionMatches: the seal transaction of the record just signed', () => {
  const s = readSealSign(signArgs(), KEY)!;

  test('the matching OP_RETURN action matches (direct push, PUSHDATA1 and PUSHDATA2 alike)', () => {
    expect(sealActionMatches(s, actionArgs())).toBe(true);
    const long = record({ ref: 'R'.repeat(190) });
    const sl = readSealSign(signArgs(long), KEY)!;
    expect(scriptFor(payloadFor(long)).slice(4, 6)).toBe('4d');
    expect(sealActionMatches(sl, actionArgs(payloadFor(long)))).toBe(true);
    expect(opReturnData('006a03616263')).toEqual(new Uint8Array([0x61, 0x62, 0x63]));
  });

  test('a different hash, document, key or field set does not match', () => {
    expect(sealActionMatches(s, actionArgs(payloadFor(record(), { recordHash: sha('another record') })))).toBe(false);
    expect(sealActionMatches(s, actionArgs(payloadFor(record(), { origHash: sha('another doc') })))).toBe(false);
    expect(sealActionMatches(s, actionArgs(payloadFor(record(), { svgHash: sha('another svg') })))).toBe(false);
    expect(
      sealActionMatches(s, actionArgs(payloadFor(record(), { key: PrivateKey.fromRandom().toPublicKey().toString() }))),
    ).toBe(false);
    expect(sealActionMatches(s, actionArgs(payloadFor(record(), { fields: 'sig-director,sig-other' })))).toBe(false);
    expect(sealActionMatches(s, actionArgs(payloadFor(record(), { type: 'transfer' })))).toBe(false);
  });

  test('money to anyone, extra outputs, site inputs, labels or other options do not match', () => {
    const one = actionArgs();
    expect(sealActionMatches(s, { ...one, outputs: [{ ...one.outputs[0], satoshis: 1 }] })).toBe(false);
    expect(
      sealActionMatches(s, {
        ...one,
        outputs: [...one.outputs, { satoshis: 500, lockingScript: '76a914' + '00'.repeat(20) + '88ac' }],
      }),
    ).toBe(false);
    expect(
      sealActionMatches(s, {
        ...one,
        outputs: [{ ...one.outputs[0], lockingScript: '76a914' + '00'.repeat(20) + '88ac' }],
      }),
    ).toBe(false);
    expect(sealActionMatches(s, { ...one, outputs: [{ ...one.outputs[0], basket: 'mine' }] })).toBe(false);
    expect(sealActionMatches(s, { ...one, inputs: [{ outpoint: 'ab'.repeat(32) + '.0' }] })).toBe(false);
    expect(sealActionMatches(s, { ...one, inputBEEF: [1, 2, 3] })).toBe(false);
    expect(sealActionMatches(s, { ...one, labels: ['x'] })).toBe(false);
    expect(sealActionMatches(s, { ...one, options: { noSend: true } })).toBe(false);
    expect(sealActionMatches(s, { ...one, options: { signAndProcess: false } })).toBe(false);
    // A trailing opcode after the push: not a plain OP_RETURN.
    expect(
      sealActionMatches(s, {
        ...one,
        outputs: [{ ...one.outputs[0], lockingScript: one.outputs[0].lockingScript + '75' }],
      }),
    ).toBe(false);
  });
});

describe('SealPasses: match → one approval; anything else prompts again', () => {
  const setup = () => {
    let t = 1_000_000;
    const passes = new SealPasses(() => t);
    const seal = readSealSign(signArgs(), KEY)!;
    return { passes, seal, advance: (ms: number) => (t += ms) };
  };

  test('match: the sign protocol and the seal spend are covered once, under one approval', () => {
    const { passes, seal } = setup();
    passes.approve(SITE, seal);
    expect(passes.coversProtocol(protoReq(), 1)).toBe(true);
    passes.signed(SITE, seal.recordHash);
    expect(passes.beginAction(SITE, actionArgs())).toBe(true);
    expect(passes.coversSpend(spendReq(70), 1)).toBe(true);
    // Once only: a second spend request on the same pass asks.
    expect(passes.coversSpend(spendReq(70), 1)).toBe(false);
    passes.endAction(SITE);
    // The pass is gone: the next seal action from the site asks again.
    expect(passes.beginAction(SITE, actionArgs())).toBe(false);
    expect(passes.coversSpend(spendReq(70), 1)).toBe(false);
  });

  test('no approval, no pass', () => {
    const { passes } = setup();
    expect(passes.coversProtocol(protoReq(), 1)).toBe(false);
    expect(passes.beginAction(SITE, actionArgs())).toBe(false);
    expect(passes.coversSpend(spendReq(70), 1)).toBe(false);
  });

  test('mismatched hash: prompts, and the pass is used up', () => {
    const { passes, seal } = setup();
    passes.approve(SITE, seal);
    passes.signed(SITE, seal.recordHash);
    expect(passes.beginAction(SITE, actionArgs(payloadFor(record(), { recordHash: sha('x') })))).toBe(false);
    expect(passes.coversSpend(spendReq(70), 1)).toBe(false);
    // Even the right action afterwards asks: only the very next payment could ride the approval.
    expect(passes.beginAction(SITE, actionArgs())).toBe(false);
  });

  test('another origin: prompts', () => {
    const { passes, seal } = setup();
    passes.approve(SITE, seal);
    expect(passes.coversProtocol(protoReq(OTHER), 1)).toBe(false);
    passes.signed(SITE, seal.recordHash);
    expect(passes.beginAction(OTHER, actionArgs())).toBe(false);
    expect(passes.beginAction(SITE, actionArgs())).toBe(true);
    expect(passes.coversSpend(spendReq(70, OTHER), 1)).toBe(false);
    expect(passes.coversSpend(spendReq(70), 1)).toBe(true);
  });

  test('over the cap: prompts', () => {
    const { passes, seal } = setup();
    passes.approve(SITE, seal);
    passes.signed(SITE, seal.recordHash);
    expect(passes.beginAction(SITE, actionArgs())).toBe(true);
    expect(passes.coversSpend(spendReq(SEAL_MAX_SATS + 1), 1)).toBe(false);
    expect(passes.coversSpend(spendReq(SEAL_MAX_SATS), 1)).toBe(true);
  });

  test('a late call (past the window): prompts', () => {
    const { passes, seal, advance } = setup();
    passes.approve(SITE, seal);
    passes.signed(SITE, seal.recordHash);
    advance(SEAL_PASS_MS + 1);
    expect(passes.beginAction(SITE, actionArgs())).toBe(false);
    expect(passes.coversSpend(spendReq(70), 1)).toBe(false);
  });

  test('just inside the window still rides; an approval nobody signed with expires too', () => {
    const { passes, seal, advance } = setup();
    passes.approve(SITE, seal);
    passes.signed(SITE, seal.recordHash);
    advance(SEAL_PASS_MS - 1);
    expect(passes.beginAction(SITE, actionArgs())).toBe(true);
    const b = setup();
    b.passes.approve(SITE, b.seal);
    b.advance(SEAL_PASS_MS + 1);
    expect(b.passes.coversProtocol(protoReq(), 1)).toBe(false);
  });

  test('concurrent calls never share the pass', () => {
    const { passes, seal } = setup();
    passes.approve(SITE, seal);
    // Two calls on the seal protocol at once: the request could be the other one.
    expect(passes.coversProtocol(protoReq(), 2)).toBe(false);
    passes.signed(SITE, seal.recordHash);
    expect(passes.beginAction(SITE, actionArgs())).toBe(true);
    // Two payments in flight from the site: the spend could be the other one's.
    expect(passes.coversSpend(spendReq(70), 2)).toBe(false);
  });

  test('the sign must be the approved record; a privileged or other-protocol request is never covered', () => {
    const { passes, seal } = setup();
    passes.approve(SITE, seal);
    expect(passes.coversProtocol(protoReq(SITE, { privileged: true }), 1)).toBe(false);
    expect(passes.coversProtocol(protoReq(SITE, { protocolID: [2, 'bitsign seal x'] }), 1)).toBe(false);
    expect(passes.coversProtocol(protoReq(SITE, { counterparty: 'self' }), 1)).toBe(false);
    passes.signed(SITE, sha('some other record'));
    // Still 'approved', not 'signed': no action rides it.
    expect(passes.beginAction(SITE, actionArgs())).toBe(false);
  });

  test('a payment that is not a seal, before the sign finished, asks and leaves nothing behind for later', () => {
    const { passes, seal } = setup();
    passes.approve(SITE, seal);
    expect(passes.beginAction(SITE, actionArgs())).toBe(false); // not signed yet
    passes.drop(SITE); // the sign failed
    passes.signed(SITE, seal.recordHash);
    expect(passes.beginAction(SITE, actionArgs())).toBe(false);
  });
});
