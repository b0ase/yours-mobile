/**
 * The verifier and the lock finder count an output as a lock only when its script is exactly the lock
 * (b-Aware report, INBOX 496): the lock pattern with anything else around it may be spendable now.
 */
import { describe, expect, test } from 'bun:test';
import { BSV21, Inscription, Lock, buildInscriptionScript } from '@1sat/templates';
import { LockingScript, P2PKH, PrivateKey, Script, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import { lockAt } from './lockFinder';
import { buildReceipt, receiptMap, receiptSvg } from './receipt';
import { exactLock, lockScriptFor, tokenLockScript } from './tokenLocks';
import { checkLockTx } from './verify';

const key = PrivateKey.fromRandom();
const address = key.toAddress();
const other = PrivateKey.fromRandom().toAddress();
const UNTIL = 970_500;
const TOKEN = 'a'.repeat(64) + '_0';
const AMT = 1_250_000n;
const SATS = 100_000;

const bareHex = (a = address, until = UNTIL) => Lock.lock(a, until).toHex();
/** OP_IF <the lock> OP_ELSE OP_1 OP_ENDIF: the lock pattern is all there, but OP_0 spends it at once. */
const escapeHatch = (a = address, until = UNTIL) => LockingScript.fromHex(`63${bareHex(a, until)}675168`);
/** The lock, then OP_DROP OP_1 after it. */
const trailing = () => LockingScript.fromHex(`${bareHex()}7551`);
/** The until push with its sign bit set: a negative height (always met), which Lock.decode reads as a huge one. */
const negativeUntil = () => {
  const pkh = Utils.toHex(Utils.fromBase58Check(address).data as number[]);
  const until = new Script().writeNumber(UNTIL).toHex();
  const hex = bareHex();
  expect(hex).toContain(`14${pkh}${until}`);
  const le = until.slice(2);
  return LockingScript.fromHex(hex.replace(`14${pkh}${until}`, `14${pkh}04${le}${'00'.repeat(3 - le.length / 2)}80`));
};
const tokenEscape = () => BSV21.transfer(TOKEN, AMT).lock(escapeHatch());

function txWith(outputs: { lockingScript: Script; satoshis: number }[]) {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(address),
    sequence: 0xffffffff,
  });
  for (const o of outputs)
    tx.addOutput({ lockingScript: LockingScript.fromHex(o.lockingScript.toHex()), satoshis: o.satoshis });
  return tx;
}

/** A receipt (vout 1) claiming one lock at vout 0 of SATS until UNTIL, to `address`. */
const receiptFor = (token?: boolean) => {
  const r = buildReceipt({
    mode: 'date',
    pieces: [{ height: UNTIL, sats: token ? 1 : SATS }],
    lockAddress: address,
    identity: { handle: '$test', address },
    ...(token ? { token: { id: TOKEN, amt: String(AMT), dec: 0, sym: 'TST' } } : {}),
  });
  return buildInscriptionScript(
    new P2PKH().lock(address),
    new TextEncoder().encode(receiptSvg(r)),
    'image/svg+xml',
    receiptMap(r),
  );
};

describe('the escape-hatch script really is spendable now', () => {
  test('OP_0 spends it at nLockTime 0 with no signature', () => {
    const src = txWith([{ lockingScript: escapeHatch(), satoshis: SATS }]);
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: src.id('hex'),
      sourceOutputIndex: 0,
      unlockingScript: UnlockingScript.fromHex('00'),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(other), satoshis: SATS - 1000 });
    const spend = new Spend({
      sourceTXID: src.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: SATS,
      lockingScript: src.outputs[0].lockingScript,
      transactionVersion: tx.version,
      otherInputs: [],
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript: tx.inputs[0].unlockingScript!,
      inputSequence: 0xffffffff,
      lockTime: 0,
    });
    expect(spend.validate()).toBe(true);
    // ...and Lock.decode still reads it as a lock to `address` until UNTIL, which is what the old check trusted.
    expect(Lock.decode(escapeHatch())).toEqual({ address, until: UNTIL });
  });
});

describe('exactLock', () => {
  test('a genuine BSV lock and a genuine token lock pass', () => {
    expect(exactLock(Lock.lock(address, UNTIL))).toEqual({ address, until: UNTIL });
    expect(exactLock(tokenLockScript(TOKEN, AMT, address, UNTIL))).toEqual({
      address,
      until: UNTIL,
      token: { id: TOKEN, amt: AMT },
    });
  });
  test('the lock pattern with anything else around it fails', () => {
    expect(exactLock(escapeHatch())).toBeNull();
    expect(exactLock(trailing())).toBeNull();
    expect(exactLock(negativeUntil())).toBeNull();
    expect(exactLock(tokenEscape())).toBeNull();
    expect(exactLock(LockingScript.fromHex(`${tokenLockScript(TOKEN, AMT, address, UNTIL).toHex()}7551`))).toBeNull();
    expect(exactLock(Lock.lock(address, 0))).toBeNull();
  });
  test('only the well-formed BSV-21 transfer envelope may sit in front', () => {
    const lock = lockScriptFor(address, UNTIL);
    // A picture inscription, a reordered transfer JSON, an extra JSON field, a deploy+mint: none is the transfer envelope.
    expect(exactLock(buildInscriptionScript(lock, new Uint8Array([1, 2, 3]), 'image/png'))).toBeNull();
    const json = (o: object) =>
      Inscription.fromText(JSON.stringify(o), 'application/bsv-20', { scriptSuffix: lock }).lock();
    expect(exactLock(json({ p: 'bsv-20', op: 'transfer', id: TOKEN, amt: String(AMT) }))).not.toBeNull();
    expect(exactLock(json({ op: 'transfer', p: 'bsv-20', id: TOKEN, amt: String(AMT) }))).toBeNull();
    expect(exactLock(json({ p: 'bsv-20', op: 'transfer', id: TOKEN, amt: String(AMT), x: 1 }))).toBeNull();
    expect(exactLock(BSV21.deployMint('TST', AMT).lock(lock))).toBeNull();
  });
});

describe('checkLockTx: only exact locks are locks', () => {
  test('a genuine BSV lock with its receipt verifies', () => {
    const v = checkLockTx(
      txWith([
        { lockingScript: Lock.lock(address, UNTIL), satoshis: SATS },
        { lockingScript: receiptFor(), satoshis: 1 },
      ]).toHex(),
      new Set(),
      UNTIL - 1,
    );
    expect(v.problems).toEqual([]);
    expect(v.receiptValid).toBe(true);
    expect(v.status).toBe('Locked');
  });
  test('a genuine token lock with its receipt verifies', () => {
    const v = checkLockTx(
      txWith([
        { lockingScript: tokenLockScript(TOKEN, AMT, address, UNTIL), satoshis: 1 },
        { lockingScript: receiptFor(true), satoshis: 1 },
      ]).toHex(),
      new Set(),
      UNTIL - 1,
    );
    expect(v.problems).toEqual([]);
    expect(v.receiptValid).toBe(true);
    expect(v.locks[0].token).toEqual({ id: TOKEN, amt: String(AMT) });
  });
  for (const [name, script, token] of [
    ['an escape hatch', escapeHatch(), false],
    ['trailing script', trailing(), false],
    ['a negative until', negativeUntil(), false],
    ['a token lock with an escape hatch', tokenEscape(), true],
  ] as const)
    test(`${name} is not a lock, and its receipt does not verify`, () => {
      const v = checkLockTx(
        txWith([
          { lockingScript: script, satoshis: token ? 1 : SATS },
          { lockingScript: receiptFor(token), satoshis: 1 },
        ]).toHex(),
        new Set(),
        UNTIL - 1,
      );
      expect(v.locks).toEqual([]);
      expect(v.totalSats).toBe(0);
      expect(v.status).toBe('No locks');
      expect(v.receiptValid).toBe(false);
      expect(v.problems).toContain('Output 0 is not a valid lock: it may be spendable now.');
    });
  test('a lookalike beside a genuine lock is flagged and left out', () => {
    const v = checkLockTx(
      txWith([
        { lockingScript: Lock.lock(address, UNTIL), satoshis: SATS },
        { lockingScript: receiptFor(), satoshis: 1 },
        { lockingScript: escapeHatch(), satoshis: SATS },
      ]).toHex(),
      new Set(),
      UNTIL - 1,
    );
    expect(v.locks.map((l) => l.vout)).toEqual([0]);
    expect(v.totalSats).toBe(SATS);
    expect(v.receiptValid).toBe(false);
    expect(v.problems).toEqual(['Output 2 is not a valid lock: it may be spendable now.']);
  });
  test('a lock to another address or another height does not match the receipt', () => {
    const wrongKey = checkLockTx(
      txWith([
        { lockingScript: Lock.lock(other, UNTIL), satoshis: SATS },
        { lockingScript: receiptFor(), satoshis: 1 },
      ]).toHex(),
      new Set(),
      0,
    );
    expect(wrongKey.receiptValid).toBe(false);
    expect(wrongKey.problems).toContain('Output 0 is locked to a different key.');
    const wrongHeight = checkLockTx(
      txWith([
        { lockingScript: Lock.lock(address, UNTIL - 1), satoshis: SATS },
        { lockingScript: receiptFor(), satoshis: 1 },
      ]).toHex(),
      new Set(),
      0,
    );
    expect(wrongHeight.receiptValid).toBe(false);
    expect(wrongHeight.problems).toContain(`Output 0 unlocks at block ${UNTIL - 1}, not ${UNTIL}.`);
  });
});

describe('lockAt (the finder) shares the rule', () => {
  test('files only the exact bare lock to this wallet', () => {
    const tx = txWith([
      { lockingScript: Lock.lock(address, UNTIL), satoshis: SATS },
      { lockingScript: escapeHatch(), satoshis: SATS },
      { lockingScript: trailing(), satoshis: SATS },
      { lockingScript: tokenLockScript(TOKEN, AMT, address, UNTIL), satoshis: SATS },
      { lockingScript: Lock.lock(other, UNTIL), satoshis: SATS },
    ]);
    expect(lockAt(tx, 0, address)).toEqual({ until: UNTIL, satoshis: SATS });
    for (const vout of [1, 2, 3, 4]) expect(lockAt(tx, vout, address)).toBeNull();
  });
});
