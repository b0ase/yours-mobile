import { describe, expect, test } from 'bun:test';
import { BSV21, Lock, buildInscriptionScript } from '@1sat/templates';
import { KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Spend, Transaction, type WalletProtocol } from '@bsv/sdk';
import {
  TOKEN_LOCK_KEY_ID,
  blocksLeft,
  canUnlock,
  countdown,
  decodeTokenLock,
  mergeRecords,
  parseTokenAmount,
  tokenLockScript,
  tokenUnlockLength,
  type TokenLockRecord,
} from './tokenLocks';
import { buildReceipt, fmtToken, parseReceipt, receiptMap, receiptSvg } from './receipt';
import { checkLockTx } from './verify';

const P1SAT: WalletProtocol = [0, 'onesat'];
const TOKEN = 'a'.repeat(64) + '_0';
const OTHER = 'b'.repeat(64) + '_1';
const UNTIL = 970_500;
const AMT = 1_250_000n;

// The seed's root key. In the wallet this comes from the recovery phrase; nothing else is needed.
const root = PrivateKey.fromRandom();
const lockKey = new KeyDeriver(root).derivePrivateKey(P1SAT, TOKEN_LOCK_KEY_ID, 'self');
const lockAddress = lockKey.toAddress();

/** A transaction that locks AMT tokens at vout 0 (plus token change and, optionally, a receipt). */
function lockTx(opts: { amt?: bigint; until?: number; receipt?: ReturnType<typeof buildInscriptionScript> } = {}) {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(lockAddress),
    sequence: 0xffffffff,
  });
  tx.addOutput({
    lockingScript: tokenLockScript(TOKEN, opts.amt ?? AMT, lockAddress, opts.until ?? UNTIL),
    satoshis: 1,
  });
  tx.addOutput({ lockingScript: BSV21.transfer(TOKEN, 5n).lock(new P2PKH().lock(lockAddress)), satoshis: 1 });
  if (opts.receipt) tx.addOutput({ lockingScript: opts.receipt, satoshis: 1 });
  return tx;
}

/** Spend the token lock at vout 0 the way the wallet does: nLockTime = height, sequence 0. */
async function trySpend(lockTime: number, sequence = 0, signer = lockKey) {
  const src = lockTx();
  const tx = new Transaction();
  tx.lockTime = lockTime;
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence, unlockingScriptTemplate: Lock.unlock(signer) });
  const back = new KeyDeriver(root).derivePrivateKey(P1SAT, `${TOKEN}-1`, 'self').toAddress();
  tx.addOutput({ lockingScript: BSV21.transfer(TOKEN, AMT).lock(new P2PKH().lock(back)), satoshis: 1 });
  await tx.sign();
  const spend = new Spend({
    sourceTXID: src.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: 1,
    lockingScript: src.outputs[0].lockingScript,
    transactionVersion: tx.version,
    otherInputs: [],
    outputs: tx.outputs,
    inputIndex: 0,
    unlockingScript: tx.inputs[0].unlockingScript!,
    inputSequence: sequence,
    lockTime,
  });
  let ok = false;
  try {
    ok = spend.validate();
  } catch {
    ok = false;
  }
  return { ok, tx, src };
}

describe('token lock script', () => {
  test('a BSV-21 transfer inscription in front of the 1Sat time-lock', () => {
    const s = tokenLockScript(TOKEN, AMT, lockAddress, UNTIL);
    expect(decodeTokenLock(s)).toEqual({ tokenId: TOKEN, amt: AMT, address: lockAddress, until: UNTIL });
    const t = BSV21.decode(s)!;
    expect(t.tokenData).toMatchObject({ p: 'bsv-20', op: 'transfer', id: TOKEN, amt: String(AMT) });
    // The script after the envelope is exactly the BSV lock contract.
    const bare = Lock.lock(lockAddress, UNTIL).toHex();
    expect(s.toHex().endsWith(bare)).toBe(true);
  });
  test('refuses bad ids, amounts and heights', () => {
    expect(() => tokenLockScript('nope', AMT, lockAddress, UNTIL)).toThrow();
    expect(() => tokenLockScript(TOKEN, 0n, lockAddress, UNTIL)).toThrow();
    expect(() => tokenLockScript(TOKEN, 2n ** 64n, lockAddress, UNTIL)).toThrow();
    expect(() => tokenLockScript(TOKEN, AMT, lockAddress, 0)).toThrow();
    expect(() => tokenLockScript(TOKEN, AMT, lockAddress, 600_000_000)).toThrow();
  });
  test('a plain BSV lock or a P2PKH token output is not a token lock', () => {
    expect(decodeTokenLock(Lock.lock(lockAddress, UNTIL))).toBeNull();
    expect(decodeTokenLock(BSV21.transfer(TOKEN, AMT).lock(new P2PKH().lock(lockAddress)))).toBeNull();
  });
});

describe('token lock (interpreter)', () => {
  test('cannot be spent before the height', async () => {
    expect((await trySpend(UNTIL - 1)).ok).toBe(false);
    expect((await trySpend(0)).ok).toBe(false);
  });
  test('cannot dodge nLockTime with a final sequence number', async () => {
    expect((await trySpend(UNTIL, 0xffffffff)).ok).toBe(false);
  });
  test('cannot be spent by another key, even after the height', async () => {
    expect((await trySpend(UNTIL + 10, 0, PrivateKey.fromRandom())).ok).toBe(false);
    // Nor by the BSV lock key of the same wallet.
    const bsvLockKey = new KeyDeriver(root).derivePrivateKey(P1SAT, 'lock', 'self');
    expect((await trySpend(UNTIL + 10, 0, bsvLockKey)).ok).toBe(false);
  });
  test('recovery: only the seed and the lock transaction, no server', async () => {
    // A fresh device: re-derive the lock key from the root key and read the lock from the raw tx.
    const { src } = await trySpend(UNTIL);
    const raw = src.toHex();
    const again = new KeyDeriver(PrivateKey.fromHex(root.toHex())).derivePrivateKey(P1SAT, TOKEN_LOCK_KEY_ID, 'self');
    const found = Transaction.fromHex(raw)
      .outputs.map((o, vout) => ({ vout, d: decodeTokenLock(o.lockingScript) }))
      .filter((x) => x.d && x.d.address === again.toAddress());
    expect(found).toHaveLength(1);
    expect(found[0].d!.amt).toBe(AMT);
    const { ok, tx } = await trySpend(UNTIL, 0, again);
    expect(ok).toBe(true);
    // The tokens come back as an ordinary BSV-21 output for the same id and amount.
    const back = BSV21.decode(tx.outputs[0].lockingScript)!;
    expect(back.tokenData.id).toBe(TOKEN);
    expect(back.getAmount()).toBe(AMT);
    expect((await trySpend(UNTIL + 5000, 0, again)).ok).toBe(true);
  });
  test('the wallet (BRC-100 getPublicKey forSelf) and the recovery path agree on the lock key', async () => {
    const { publicKey } = await new ProtoWallet(root).getPublicKey({
      protocolID: P1SAT,
      keyID: TOKEN_LOCK_KEY_ID,
      counterparty: 'self',
      forSelf: true,
    });
    expect(publicKey).toBe(lockKey.toPublicKey().toString());
  });
  test('the unlocking script length estimate covers the real one', async () => {
    const { tx, src } = await trySpend(UNTIL);
    expect(tokenUnlockLength(src.outputs[0].lockingScript)).toBeGreaterThanOrEqual(
      tx.inputs[0].unlockingScript!.toBinary().length,
    );
  });
});

describe('eligibility + countdown', () => {
  test('ready at and after the height', () => {
    expect(canUnlock(UNTIL, UNTIL - 1)).toBe(false);
    expect(canUnlock(UNTIL, UNTIL)).toBe(true);
    expect(canUnlock(UNTIL, UNTIL + 1)).toBe(true);
    expect(canUnlock(UNTIL, 0)).toBe(false);
    expect(blocksLeft(UNTIL, UNTIL - 6)).toBe(6);
  });
  test('countdown text', () => {
    expect(countdown(UNTIL, UNTIL)).toBe('Ready to unlock');
    expect(countdown(UNTIL, UNTIL - 3)).toBe('30m');
    expect(countdown(UNTIL, UNTIL - 150)).toBe('1d 1h');
    expect(countdown(UNTIL, UNTIL - 144 * 730)).toBe('2.0 years');
  });
});

describe('amounts + records', () => {
  test('parseTokenAmount respects decimals', () => {
    expect(parseTokenAmount('12.5', 2)).toBe(1250n);
    expect(parseTokenAmount('1,000', 0)).toBe(1000n);
    expect(parseTokenAmount('0.001', 2)).toBeNull();
    expect(parseTokenAmount('0', 8)).toBeNull();
    expect(parseTokenAmount('abc', 8)).toBeNull();
  });
  test('fmtToken shows decimals and symbol', () => {
    expect(fmtToken({ amt: '1250000', dec: 4, sym: 'VEX' })).toBe('125 VEX');
    expect(fmtToken({ amt: '1250001', dec: 4, sym: 'VEX' })).toBe('125.0001 VEX');
    expect(fmtToken({ amt: '7', dec: 0 })).toBe('7 tokens');
  });
  test('mergeRecords keeps one per outpoint and remembers unlocks', () => {
    const a: TokenLockRecord = {
      outpoint: 'x.0',
      tokenId: TOKEN,
      dec: 0,
      amt: '1',
      until: UNTIL,
      label: 'Vesting',
      lockAddress,
      createdAt: '2026-10-15T00:00:00Z',
      receipt: true,
    };
    const merged = mergeRecords([a], [{ ...a, unlockedTxid: 'u' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].unlockedTxid).toBe('u');
  });
});

describe('token receipt + verifier', () => {
  const identity = { handle: '$alice', idKey: '02'.padEnd(66, '1'), address: '1Alice' };
  const receipt = buildReceipt({
    mode: 'date',
    pieces: [{ height: UNTIL, sats: 1 }],
    lockAddress,
    identity,
    token: { id: TOKEN, amt: String(AMT), dec: 4, sym: 'VEX' },
    label: 'Vesting',
  });
  const inscription = (r: typeof receipt) =>
    buildInscriptionScript(
      new P2PKH().lock(lockAddress),
      new TextEncoder().encode(receiptSvg(r)),
      'image/svg+xml',
      receiptMap(r),
    );

  test('the receipt carries the token, amount, height, owner and label', () => {
    expect(receipt.token).toEqual({ id: TOKEN, amt: String(AMT), dec: 4, sym: 'VEX' });
    expect(receipt.schedule).toEqual([{ vout: 0, height: UNTIL, sats: 1 }]);
    expect(receipt.label).toBe('Vesting');
    expect(receipt.usdAtLock).toBeUndefined();
    const svg = receiptSvg(receipt);
    expect(svg).toContain('125 VEX');
    expect(svg).toContain('these tokens');
    expect(parseReceipt(inscription(receipt))).toEqual(receipt);
  });
  test('verifies against the lock transaction', () => {
    const tx = lockTx({ receipt: inscription(receipt) });
    const v = checkLockTx(tx.toHex(), new Set(), UNTIL - 1);
    expect(v.receiptValid).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.status).toBe('Locked');
    expect(v.locks).toHaveLength(1);
    expect(v.locks[0]).toMatchObject({
      vout: 0,
      height: UNTIL,
      address: lockAddress,
      token: { id: TOKEN, amt: String(AMT) },
    });
    expect(checkLockTx(tx.toHex(), new Set(), UNTIL).locks[0].matured).toBe(true);
    expect(checkLockTx(tx.toHex(), new Set([0]), UNTIL).status).toBe('Fully claimed');
  });
  test('a receipt that overstates the amount, token or height fails', () => {
    const bigger = { ...receipt, token: { ...receipt.token!, amt: String(AMT * 10n) } };
    const v1 = checkLockTx(lockTx({ receipt: inscription(bigger) }).toHex(), new Set(), 0);
    expect(v1.receiptValid).toBe(false);
    const other = { ...receipt, token: { ...receipt.token!, id: OTHER } };
    expect(checkLockTx(lockTx({ receipt: inscription(other) }).toHex(), new Set(), 0).receiptValid).toBe(false);
    const later = { ...receipt, schedule: [{ vout: 0, height: UNTIL + 1, sats: 1 }] };
    expect(checkLockTx(lockTx({ receipt: inscription(later) }).toHex(), new Set(), 0).receiptValid).toBe(false);
  });
  test('a BSV receipt over a token lock fails', () => {
    const bsv = { ...receipt, token: undefined };
    const v = checkLockTx(lockTx({ receipt: inscription(bsv) }).toHex(), new Set(), 0);
    expect(v.receiptValid).toBe(false);
  });
});
