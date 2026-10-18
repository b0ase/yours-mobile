import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Cosign } from '@1sat/templates';
import {
  Hash,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Script,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type LockingScript,
} from '@bsv/sdk';
import { canonicalJson } from './canonical';
import { buildClaim, claimSignedBytes, CLAIM_PROTOCOL, lockPubKeyFor, signClaim } from './claim';
import vector from './__fixtures__/npg-claim-test-vector.json';
import { COMPANIES, NOT_CONFIGURED, NPG_TOKEN_2022A } from './companies';
import { checkLockTx } from './confirm';
import { checkHolding, HOLDING_PROTOCOL } from './holding';
import { checkInvite, INVITE_KEY_ID, INVITE_PROTOCOL, inviteSignedBytes, parseClaimLink } from './invite';
import { buildShareLock, decodeShareLock, matchesShareLock } from './lockScript';
import { recoverLockKeys } from './recovery';

const companyId = PrivateKey.fromRandom();
const companyLock = PrivateKey.fromRandom();
const attacker = PrivateKey.fromRandom();
const holderSeed = PrivateKey.fromRandom();
const holderWallet = new ProtoWallet(holderSeed);
const INVITE = 'A'.repeat(21) + '_-' + 'b'.repeat(20); // 43 chars
const pin = COMPANIES.npg;
const NOW = Date.parse('2026-10-18T12:00:00Z');

beforeAll(() => {
  pin.identityKey = companyId.toPublicKey().toString();
  pin.lockKey = companyLock.toPublicKey().toString();
});
afterAll(() => {
  pin.identityKey = '';
  pin.lockKey = '';
});

const body = (over: Record<string, unknown> = {}) => ({
  v: 1,
  company: { name: 'Ninja Punk Girls Ltd', number: '13706347', ticker: 'NINJAPUNKGIRLS' },
  tokens: [{ standard: 'bsv21', id: NPG_TOKEN_2022A, decimals: 0, tranche: '2022A', amount: 1200 }],
  holder: { registerEntry: '17', shares: 1200, nameOnRegister: 'A. Holder' },
  lock: { type: '2of2', companyPubKey: companyLock.toPublicKey().toString(), releaseAfterBlock: null },
  claimUrl: 'https://www.ninjapunkgirls.com/api/shareholders/claim',
  expiresAt: '2026-11-17T12:00:00.000Z',
  ...over,
});

async function sign(payload: Record<string, unknown>, key = companyId) {
  const { signature } = await new ProtoWallet(key).createSignature({
    data: inviteSignedBytes(payload),
    protocolID: INVITE_PROTOCOL,
    keyID: INVITE_KEY_ID,
    counterparty: 'anyone',
  });
  return { ...payload, sig: Utils.toHex(signature) };
}

describe('canonical JSON', () => {
  test('sorted keys, no whitespace, undefined dropped, arrays in order', () => {
    expect(canonicalJson({ b: 1, a: [3, 1, { d: undefined, c: 'x' }], e: undefined })).toBe(
      '{"a":[3,1,{"c":"x"}],"b":1}',
    );
  });
  test('exact invite bytes the company signs', () => {
    expect(Utils.toUTF8(inviteSignedBytes({ ...body(), sig: 'ff' }))).toBe(
      `{"claimUrl":"https://www.ninjapunkgirls.com/api/shareholders/claim","company":{"name":"Ninja Punk Girls Ltd","number":"13706347","ticker":"NINJAPUNKGIRLS"},"expiresAt":"2026-11-17T12:00:00.000Z","holder":{"nameOnRegister":"A. Holder","registerEntry":"17","shares":1200},"lock":{"companyPubKey":"${companyLock.toPublicKey().toString()}","releaseAfterBlock":null,"type":"2of2"},"tokens":[{"amount":1200,"decimals":0,"id":"${NPG_TOKEN_2022A}","standard":"bsv21","tranche":"2022A"}],"v":1}`,
    );
  });
  test('exact claim bytes the wallet signs (keys lowercased)', () => {
    expect(Utils.toUTF8(claimSignedBytes(INVITE, '02AB', '03CD'))).toBe(
      `{"identityKey":"02ab","inviteId":"${INVITE}","lockPubKey":"03cd"}`,
    );
  });
});

describe('claim links', () => {
  test('deep link and web fallback', () => {
    expect(parseClaimLink(`bwalletx://claim/${INVITE}?c=npg`)).toEqual({ inviteId: INVITE, company: 'npg' });
    expect(parseClaimLink(`https://web.bwalletx.com/m/claim/${INVITE}?c=npg`)).toEqual({
      inviteId: INVITE,
      company: 'npg',
    });
  });
  test('bad id, unknown company or other host is ignored', () => {
    expect(parseClaimLink(`bwalletx://claim/short?c=npg`)).toBeNull();
    expect(parseClaimLink(`bwalletx://claim/${INVITE}?c=acme`)).toBeNull();
    expect(parseClaimLink(`https://evil.example/m/claim/${INVITE}?c=npg`)).toBeNull();
    expect(parseClaimLink(`bwalletx://claim/${INVITE.slice(0, 42)}!?c=npg`)).toBeNull();
  });
});

describe('invite checks', () => {
  test('a good invite passes', async () => {
    const inv = await checkInvite(await sign(body()), INVITE, 'npg', NOW);
    expect(inv.holder.shares).toBe(1200);
    expect(inv.tokens[0].tranche).toBe('2022A');
  });
  test('tampering is rejected', async () => {
    const s = (await sign(body())) as Record<string, unknown>;
    const t = { ...s, holder: { registerEntry: '17', shares: 99999, nameOnRegister: 'A. Holder' } };
    await expect(checkInvite(t, INVITE, 'npg', NOW)).rejects.toThrow('signature');
  });
  test('the pinned key is enforced: a different signer fails', async () => {
    await expect(checkInvite(await sign(body(), attacker), INVITE, 'npg', NOW)).rejects.toThrow('signature');
  });
  test('a lock key inside the payload is never trusted', async () => {
    const p = body({
      lock: { type: '2of2', companyPubKey: attacker.toPublicKey().toString(), releaseAfterBlock: null },
    });
    await expect(checkInvite(await sign(p), INVITE, 'npg', NOW)).rejects.toThrow('pinned company key');
  });
  test('expired', async () => {
    await expect(checkInvite(await sign(body()), INVITE, 'npg', Date.parse('2026-12-01'))).rejects.toThrow('expired');
  });
  test('wrong token id', async () => {
    const p = body({
      tokens: [{ standard: 'bsv21', id: 'ab'.repeat(32) + '_0', decimals: 0, tranche: '2022A', amount: 1200 }],
    });
    await expect(checkInvite(await sign(p), INVITE, 'npg', NOW)).rejects.toThrow('not this company');
  });
  test('decimals must be 0', async () => {
    const p = body({
      tokens: [{ standard: 'bsv21', id: NPG_TOKEN_2022A, decimals: 8, tranche: '2022A', amount: 1200 }],
    });
    await expect(checkInvite(await sign(p), INVITE, 'npg', NOW)).rejects.toThrow('0 decimals');
  });
  test('holder.shares must equal the tranche sum', async () => {
    const p = body({ holder: { registerEntry: '17', shares: 1201, nameOnRegister: 'A. Holder' } });
    await expect(checkInvite(await sign(p), INVITE, 'npg', NOW)).rejects.toThrow('add up');
  });
  test('claim URL must be on the company host', async () => {
    await expect(
      checkInvite(await sign(body({ claimUrl: 'https://evil.example/claim' })), INVITE, 'npg', NOW),
    ).rejects.toThrow('company host');
  });
  test('no pinned key: every claim refused', async () => {
    const saved = pin.identityKey;
    pin.identityKey = '';
    await expect(checkInvite(await sign(body()), INVITE, 'npg', NOW)).rejects.toThrow(NOT_CONFIGURED);
    pin.identityKey = saved;
  });
});

describe('lock key + claim', () => {
  test('derivation is deterministic and per invite', async () => {
    const a = await lockPubKeyFor(holderWallet, INVITE);
    expect(await lockPubKeyFor(new ProtoWallet(holderSeed), INVITE)).toBe(a);
    expect(await lockPubKeyFor(holderWallet, 'Z'.repeat(43))).not.toBe(a);
  });
  test('claim signature verifies against the identity key over the exact bytes', async () => {
    const c = await buildClaim(holderWallet, INVITE);
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: claimSignedBytes(INVITE, c.identityKey, c.lockPubKey),
      signature: Utils.toArray(c.signature, 'hex'),
      protocolID: CLAIM_PROTOCOL,
      keyID: INVITE,
      counterparty: holderSeed.toPublicKey().toString(),
    });
    expect(valid).toBe(true);
  });
  test('recovery rebuilds the same keys from local + server ids', async () => {
    const a = await lockPubKeyFor(holderWallet, INVITE);
    const r = await recoverLockKeys(holderWallet, [
      [{ inviteId: INVITE }],
      [{ inviteId: INVITE }, { inviteId: 'bad' }],
    ]);
    expect(r.map((x) => x.lockPubKey)).toEqual([a]);
  });
});

describe('lock script', () => {
  const holderLock = PrivateKey.fromRandom();
  const p = {
    tokenId: NPG_TOKEN_2022A,
    amount: 1200,
    holderPubKey: holderLock.toPublicKey().toString(),
    companyPubKey: companyLock.toPublicKey().toString(),
  };
  test('round trip', () => {
    const s = buildShareLock(p);
    expect(decodeShareLock(s)).toEqual({
      tokenId: NPG_TOKEN_2022A,
      amount: 1200,
      holderAddress: holderLock.toAddress(),
      companyPubKey: p.companyPubKey,
    });
    expect(matchesShareLock(s, p)).toBe(true);
    expect(matchesShareLock(s, { ...p, amount: 1201 })).toBe(false);
    expect(Utils.toUTF8(Script.fromHex(s.toHex()).chunks[6].data!)).toBe(
      `{"p":"bsv-20","op":"transfer","id":"${NPG_TOKEN_2022A}","amt":"1200"}`,
    );
  });

  const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;
  async function spend(lockingScript: LockingScript, signers: PrivateKey[]) {
    const src = new Transaction();
    src.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
    src.addOutput({ lockingScript, satoshis: 1 });
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence: 0xffffffff });
    tx.addOutput({ lockingScript: new P2PKH().lock(holderLock.toAddress()), satoshis: 1 });
    const preimage = TransactionSignature.format({
      sourceTXID: src.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      transactionVersion: tx.version,
      otherInputs: [],
      outputs: tx.outputs,
      inputIndex: 0,
      subscript: lockingScript,
      inputSequence: 0xffffffff,
      lockTime: tx.lockTime,
      scope: SCOPE,
    });
    const der = (k: PrivateKey) => k.sign(Hash.sha256(preimage), undefined, true).toDER() as number[];
    const [owner, approver] = signers;
    let unlock: UnlockingScript = Cosign.ownerUnlock(der(owner), SCOPE, owner.toPublicKey().toString());
    if (approver) unlock = Cosign.approverUnlock(der(approver), SCOPE, unlock);
    try {
      return new Spend({
        sourceTXID: src.id('hex'),
        sourceOutputIndex: 0,
        sourceSatoshis: 1,
        lockingScript,
        transactionVersion: tx.version,
        otherInputs: [],
        outputs: tx.outputs,
        inputIndex: 0,
        unlockingScript: unlock,
        inputSequence: 0xffffffff,
        lockTime: tx.lockTime,
      }).validate();
    } catch {
      return false;
    }
  }
  test('2-of-2: holder + company signatures spend it', async () => {
    expect(await spend(buildShareLock(p), [holderLock, companyLock])).toBe(true);
  });
  test('one signature alone fails, and a stranger cannot stand in for the company', async () => {
    expect(await spend(buildShareLock(p), [holderLock])).toBe(false);
    expect(await spend(buildShareLock(p), [holderLock, attacker])).toBe(false);
    expect(await spend(buildShareLock(p), [companyLock, companyLock])).toBe(false);
  });

  test('confirm: the lock tx must carry every tranche at the pinned keys', async () => {
    const inv = await checkInvite(await sign(body()), INVITE, 'npg', NOW);
    const good = new Transaction();
    good.addOutput({ lockingScript: new P2PKH().lock(holderLock.toAddress()), satoshis: 1 });
    good.addOutput({ lockingScript: buildShareLock(p), satoshis: 1 });
    expect(checkLockTx(good, inv, p.holderPubKey)[0].outpoint).toBe(`${good.id('hex')}_1`);
    const bad = new Transaction();
    bad.addOutput({
      lockingScript: buildShareLock({ ...p, companyPubKey: attacker.toPublicKey().toString() }),
      satoshis: 1,
    });
    expect(() => checkLockTx(bad, inv, p.holderPubKey)).toThrow('2022A');
  });
});

describe('holding card data', () => {
  const me = holderSeed.toPublicKey().toString();
  const holding = (over: Record<string, unknown> = {}) => ({
    v: 1,
    company: { name: 'Ninja Punk Girls Ltd', number: '13706347', ticker: 'NINJAPUNKGIRLS' },
    holder: { identityKey: me, registerEntry: '17', nameOnRegister: 'A. Holder', shares: 1200 },
    tokens: [{ id: NPG_TOKEN_2022A, tranche: '2022A', amount: 1200 }],
    activity: [{ at: '2026-10-18', text: 'Entry confirmed' }],
    ...over,
  });
  const signH = async (b: Record<string, unknown>, key = companyId) => {
    const { signature } = await new ProtoWallet(key).createSignature({
      data: Utils.toArray(canonicalJson(b), 'utf8'),
      protocolID: HOLDING_PROTOCOL,
      keyID: '1',
      counterparty: 'anyone',
    });
    return { ...b, sig: Utils.toHex(signature) };
  };
  test('own signed entry renders', async () => {
    expect((await checkHolding(await signH(holding()), pin, me))?.holder.shares).toBe(1200);
  });
  test('someone else’s entry, a forged signature or a wrong sum renders nothing', async () => {
    expect(await checkHolding(await signH(holding()), pin, attacker.toPublicKey().toString())).toBeNull();
    expect(await checkHolding(await signH(holding(), attacker), pin, me)).toBeNull();
    const wrong = holding({ holder: { identityKey: me, registerEntry: '17', nameOnRegister: 'A', shares: 5 } });
    expect(await checkHolding(await signH(wrong), pin, me)).toBeNull();
  });
});

// Shared vector from the NPG side (npg-shareholders src/lib/shareholders/__fixtures__/npg-claim-test-vector.json,
// copied 18 Oct 2026). THROWAWAY keys 0x11/0x22/0x33 x32; deterministic (RFC6979).

describe('NPG shared test vector', () => {
  test('canonical invite bytes match and the sig verifies against companyIdentityKey', async () => {
    expect(Utils.toUTF8(inviteSignedBytes(vector.payload))).toBe(vector.canonical);
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(vector.canonical, 'utf8'),
      signature: Utils.toArray(vector.sig, 'hex'),
      protocolID: INVITE_PROTOCOL,
      keyID: INVITE_KEY_ID,
      counterparty: vector.companyIdentityKey,
    });
    expect(valid).toBe(true);
  });
  test('wallet reproduces claim.signedBytes and claim.signature byte for byte', async () => {
    const holder = new ProtoWallet(PrivateKey.fromHex(vector.holderPrivHex));
    const { publicKey } = await holder.getPublicKey({ identityKey: true });
    expect(publicKey).toBe(vector.claim.identityKey);
    const c = vector.claim;
    expect(Utils.toUTF8(claimSignedBytes(c.inviteId, c.identityKey, c.lockPubKey))).toBe(c.signedBytes);
    const out = await signClaim(holder, c.inviteId, c.identityKey, c.lockPubKey);
    expect(out.signature).toBe(c.signature);
  });
  test('lockPubKey == identityKey is refused', async () => {
    const holder = new ProtoWallet(PrivateKey.fromHex(vector.holderPrivHex));
    await expect(
      signClaim(holder, vector.inviteId, vector.claim.identityKey, vector.claim.identityKey),
    ).rejects.toThrow();
  });
});
