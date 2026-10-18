import { describe, expect, test } from 'bun:test';
import { Lock } from '@1sat/templates';
import { P2PKH, PrivateKey, ProtoWallet, PublicKey, Spend, Transaction, type LockingScript } from '@bsv/sdk';
import {
  VEST_KEY_ID,
  VEST_PROTOCOL,
  buildVestReceipt,
  defaultVestPlan,
  keptAmount,
  monthsToBlocks,
  parseVestReceiptScript,
  validateVestPlan,
  verifyVestingTx,
  vestReceiptScript,
  vestSchedule,
  vestTrancheScript,
} from './vesting';

const TOKEN = `${'ab'.repeat(32)}_0`;
const START = 920_000;
const creator = PrivateKey.fromRandom();
const stranger = PrivateKey.fromRandom();
const ADDR = creator.toAddress();
const UNTIL = START + monthsToBlocks(13);

type Template = Parameters<Transaction['addInput']>[0]['unlockingScriptTemplate'];

/** Builds a spend of `lockingScript` and runs the @bsv/sdk interpreter on it. */
async function spends(lockingScript: LockingScript, template: Template, lockTime: number, sequence = 0) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(ADDR),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript, satoshis: 1 });
  const tx = new Transaction();
  tx.lockTime = lockTime;
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence, unlockingScriptTemplate: template });
  tx.addOutput({ lockingScript: new P2PKH().lock(ADDR), satoshis: 1 });
  try {
    await tx.sign();
    return new Spend({
      sourceTXID: src.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript,
      transactionVersion: tx.version,
      otherInputs: [],
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript: tx.inputs[0].unlockingScript!,
      inputSequence: sequence,
      lockTime,
    }).validate();
  } catch {
    return false;
  }
}

describe('vesting plan', () => {
  test('defaults: 10%, 12-month cliff, 24 months linear', () => {
    expect(defaultVestPlan()).toEqual({ keepBps: 1000, cliffMonths: 12, linearMonths: 24 });
    expect(validateVestPlan(defaultVestPlan())).toBeNull();
  });
  test('0–20% only, at least 6 months in all', () => {
    expect(validateVestPlan({ keepBps: 2001, cliffMonths: 12, linearMonths: 24 })).not.toBeNull();
    expect(validateVestPlan({ keepBps: -1, cliffMonths: 12, linearMonths: 24 })).not.toBeNull();
    expect(validateVestPlan({ keepBps: 2000, cliffMonths: 3, linearMonths: 2 })).not.toBeNull();
    expect(validateVestPlan({ keepBps: 2000, cliffMonths: 6, linearMonths: 0 })).toBeNull();
    expect(validateVestPlan({ keepBps: 0, cliffMonths: 0, linearMonths: 0 })).toBeNull();
    expect(validateVestPlan({ keepBps: 500, cliffMonths: 1.5, linearMonths: 24 })).not.toBeNull();
  });
  test('default ladder: 24 monthly tranches after the cliff, adding up exactly', () => {
    const supply = 1_000_000_000n;
    const t = vestSchedule(supply, defaultVestPlan(), START);
    expect(t.length).toBe(24);
    expect(t.reduce((n, x) => n + x.amt, 0n)).toBe(100_000_000n);
    expect(t[0].height).toBe(START + monthsToBlocks(13));
    expect(t[23].height).toBe(START + monthsToBlocks(36));
    for (let i = 1; i < t.length; i++) expect(t[i].height).toBeGreaterThan(t[i - 1].height);
  });
  test('remainder goes to the last tranche', () => {
    const t = vestSchedule(1001n, { keepBps: 2000, cliffMonths: 0, linearMonths: 7 }, START);
    expect(keptAmount(1001n, 2000)).toBe(200n);
    expect(t.map((x) => x.amt)).toEqual([28n, 28n, 28n, 28n, 28n, 28n, 32n]);
  });
  test('cliff only = one tranche; keep 0 = none; fail closed on bad input', () => {
    expect(vestSchedule(1000n, { keepBps: 1000, cliffMonths: 6, linearMonths: 0 }, START)).toEqual([
      { height: START + monthsToBlocks(6), amt: 100n },
    ]);
    expect(vestSchedule(1000n, { keepBps: 0, cliffMonths: 0, linearMonths: 0 }, START)).toEqual([]);
    expect(() => vestSchedule(1000n, defaultVestPlan(), 0)).toThrow();
    expect(() => vestSchedule(100n, defaultVestPlan(), START)).toThrow(); // 10 tokens can't fill 24 tranches
    expect(() => vestSchedule(1000n, { keepBps: 3000, cliffMonths: 12, linearMonths: 24 }, START)).toThrow();
  });
});

describe('tranche lock script (interpreter)', () => {
  const lock = vestTrancheScript(TOKEN, 4_166_666n, ADDR, UNTIL);

  test('carries the BSV-21 transfer and decodes as a 1Sat Lock', () => {
    const d = Lock.decode(lock);
    expect(d).toEqual({ address: ADDR, until: UNTIL });
    expect(lock.toHex()).toContain(Buffer.from(`"id":"${TOKEN}","amt":"4166666"`).toString('hex'));
  });
  test('before the unlock height the creator cannot spend', async () => {
    expect(await spends(lock, Lock.unlock(creator), UNTIL - 1)).toBe(false);
    expect(await spends(lock, Lock.unlock(creator), 0)).toBe(false);
  });
  test('a final nSequence (which would ignore nLockTime) is refused', async () => {
    expect(await spends(lock, Lock.unlock(creator), UNTIL, 0xffffffff)).toBe(false);
  });
  test('at and after the unlock height the creator can spend', async () => {
    expect(await spends(lock, Lock.unlock(creator), UNTIL)).toBe(true);
    expect(await spends(lock, Lock.unlock(creator), UNTIL + 10_000)).toBe(true);
  });
  test('nobody else can spend, ever', async () => {
    expect(await spends(lock, Lock.unlock(stranger), UNTIL + 10_000)).toBe(false);
  });
  test('seed-derived key: a BRC-100 wallet from the same root key derives the lock key and unlocks', async () => {
    // The creator's wallet: root key from their seed. The lock key is BRC-42 derived (1sat / vest / self).
    const root = PrivateKey.fromRandom();
    const wallet = new ProtoWallet(root);
    const { publicKey } = await wallet.getPublicKey({
      protocolID: VEST_PROTOCOL,
      keyID: VEST_KEY_ID,
      counterparty: 'self',
    });
    const address = PublicKey.fromString(publicKey).toAddress();
    const l = vestTrancheScript(TOKEN, 10n, address, UNTIL);
    const restored = new ProtoWallet(PrivateKey.fromString(root.toString())); // same seed, new device
    const t = Lock.unlockWithWallet(restored, VEST_PROTOCOL, VEST_KEY_ID, 'self');
    expect(await spends(l, t, UNTIL - 1)).toBe(false);
    expect(await spends(l, t, UNTIL)).toBe(true);
    const other = Lock.unlockWithWallet(new ProtoWallet(PrivateKey.fromRandom()), VEST_PROTOCOL, VEST_KEY_ID, 'self');
    expect(await spends(l, other, UNTIL)).toBe(false);
  });
});

describe('public receipt', () => {
  const supply = 1_000_000_000n;
  const plan = defaultVestPlan();
  const tranches = vestSchedule(supply, plan, START);
  const receipt = buildVestReceipt({
    tokenId: TOKEN,
    sym: 'TEST',
    supply,
    plan,
    startHeight: START,
    lockAddress: ADDR,
    tranches,
  });

  const vestTx = (mutate?: (tx: Transaction) => void) => {
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: TOKEN.split('_')[0],
      sourceOutputIndex: 0,
      sequence: 0xffffffff,
      unlockingScript: new P2PKH().lock(ADDR), // stands in for the signed token spend
    });
    for (const t of tranches)
      tx.addOutput({ lockingScript: vestTrancheScript(TOKEN, t.amt, ADDR, t.height), satoshis: 1 });
    tx.addOutput({ lockingScript: new P2PKH().lock(ADDR), satoshis: 1 }); // the rest to the creator
    tx.addOutput({ lockingScript: vestReceiptScript(receipt), satoshis: 0 });
    mutate?.(tx);
    return tx;
  };

  test('round-trips through the OP_RETURN', () => {
    expect(parseVestReceiptScript(vestReceiptScript(receipt))).toEqual(receipt);
    expect(receipt.kept).toBe('100000000');
    expect(receipt.tranches[0]).toEqual({ vout: 0, height: tranches[0].height, amt: tranches[0].amt.toString() });
  });
  test('verifies against the outputs', () => {
    const v = verifyVestingTx(vestTx(), TOKEN);
    expect(typeof v).toBe('object');
    if (typeof v === 'object') {
      expect(v.kept).toBe(100_000_000n);
      expect(v.tranches.length).toBe(24);
    }
  });
  test('fails closed when an output does not match', () => {
    const swapped = vestTx((tx) => {
      tx.outputs[3].lockingScript = vestTrancheScript(TOKEN, tranches[3].amt, ADDR, tranches[3].height - 1);
    });
    expect(typeof verifyVestingTx(swapped, TOKEN)).toBe('string');
    const p2pkh = vestTx((tx) => {
      tx.outputs[0].lockingScript = new P2PKH().lock(ADDR);
    });
    expect(typeof verifyVestingTx(p2pkh, TOKEN)).toBe('string');
  });
  test('fails closed on another token, no deploy spend, or a lying receipt', () => {
    expect(typeof verifyVestingTx(vestTx(), `${'cd'.repeat(32)}_0`)).toBe('string');
    const noSpend = vestTx((tx) => {
      tx.inputs[0].sourceOutputIndex = 1;
    });
    expect(typeof verifyVestingTx(noSpend, TOKEN)).toBe('string');
    const greedy = vestTx((tx) => {
      tx.outputs[tx.outputs.length - 1].lockingScript = vestReceiptScript({ ...receipt, keepBps: 500 });
    });
    expect(typeof verifyVestingTx(greedy, TOKEN)).toBe('string');
    const short = buildVestReceipt({
      tokenId: TOKEN,
      sym: 'TEST',
      supply,
      plan,
      startHeight: tranches[23].height - 10,
      lockAddress: ADDR,
      tranches,
    });
    const tooShort = vestTx((tx) => {
      tx.outputs[tx.outputs.length - 1].lockingScript = vestReceiptScript(short);
    });
    expect(typeof verifyVestingTx(tooShort, TOKEN)).toBe('string');
  });
});
