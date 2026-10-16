import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Spend, Transaction, type LockingScript } from '@bsv/sdk';
import {
  checkIn,
  GATE_KEY,
  heirsUnlock,
  inheritanceLock,
  keySigner as sig,
  leadHeirUnlock,
  matchesPlan,
  ownerUnlock,
  planStatus,
  validatePlan,
  type InheritancePlan,
} from './inheritance';

const owner = PrivateKey.fromRandom();
const heirs = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()];
const stranger = PrivateKey.fromRandom();
const H = 1_000_000;
const L = 1_030_000;

const plan: InheritancePlan = {
  v: 1,
  ownerPubKey: owner.toPublicKey().toString(),
  heirs: heirs.map((k, i) => ({ name: `Heir ${i + 1}`, pubKey: k.toPublicKey().toString() })),
  heirsHeight: H,
  leadHeight: L,
};
const lock = inheritanceLock(plan);

type Template = Parameters<Transaction['addInput']>[0]['unlockingScriptTemplate'];

async function spends(lockingScript: LockingScript, template: Template, lockTime = 0, sequence = 0) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(owner.toAddress()),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript, satoshis: 1000 });
  const tx = new Transaction();
  tx.lockTime = lockTime;
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence, unlockingScriptTemplate: template });
  tx.addOutput({ lockingScript: new P2PKH().lock(stranger.toAddress()), satoshis: 900 });
  try {
    await tx.sign();
    return new Spend({
      sourceTXID: src.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 1000,
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

describe('owner path', () => {
  test('owner can spend (check in / withdraw) at any time', async () => {
    expect(await spends(lock, ownerUnlock(sig(owner)))).toBe(true);
    expect(await spends(lock, ownerUnlock(sig(owner)), L + 10)).toBe(true);
  });
  test('a heir or stranger cannot use the owner path', async () => {
    expect(await spends(lock, ownerUnlock(sig(heirs[0])), L + 10)).toBe(false);
    expect(await spends(lock, ownerUnlock(sig(stranger)))).toBe(false);
  });
});

describe('heirs 2-of-3 path', () => {
  test('fails before the heirs height', async () => {
    expect(await spends(lock, heirsUnlock([sig(heirs[0]), sig(heirs[1])]), H - 1)).toBe(false);
    expect(await spends(lock, heirsUnlock([sig(heirs[0]), sig(heirs[1])]), 0)).toBe(false);
  });
  test('cannot dodge the height with a final sequence', async () => {
    expect(await spends(lock, heirsUnlock([sig(heirs[0]), sig(heirs[1])]), H, 0xffffffff)).toBe(false);
  });
  test('any two heirs (key order) can spend at and after the height', async () => {
    expect(await spends(lock, heirsUnlock([sig(heirs[0]), sig(heirs[1])]), H)).toBe(true);
    expect(await spends(lock, heirsUnlock([sig(heirs[0]), sig(heirs[2])]), H + 5)).toBe(true);
    expect(await spends(lock, heirsUnlock([sig(heirs[1]), sig(heirs[2])]), L + 5)).toBe(true);
  });
  test('one heir twice, a stranger, or the public gate key alone cannot', async () => {
    expect(await spends(lock, heirsUnlock([sig(heirs[0]), sig(heirs[0])]), H)).toBe(false);
    expect(await spends(lock, heirsUnlock([sig(heirs[0]), sig(stranger)]), H)).toBe(false);
    expect(await spends(lock, heirsUnlock([sig(GATE_KEY), sig(GATE_KEY)]), H)).toBe(false);
    expect(await spends(lock, heirsUnlock([sig(heirs[1]), sig(heirs[0])]), H)).toBe(false);
  });
});

describe('lead heir alone path', () => {
  test('fails before the lead height, even after the heirs height', async () => {
    expect(await spends(lock, leadHeirUnlock(heirs[0]), H)).toBe(false);
    expect(await spends(lock, leadHeirUnlock(heirs[0]), L - 1)).toBe(false);
  });
  test('works at and after the lead height', async () => {
    expect(await spends(lock, leadHeirUnlock(heirs[0]), L)).toBe(true);
  });
  test('only the lead heir', async () => {
    expect(await spends(lock, leadHeirUnlock(heirs[1]), L + 1)).toBe(false);
    expect(await spends(lock, leadHeirUnlock(owner), L + 1)).toBe(false);
    expect(await spends(lock, leadHeirUnlock(GATE_KEY), L + 1)).toBe(false);
  });
  test('cannot dodge with a final sequence', async () => {
    expect(await spends(lock, leadHeirUnlock(heirs[0]), L, 0xffffffff)).toBe(false);
  });
});

describe('plan', () => {
  test('rebuilds byte-for-byte from the plan (no server needed)', () => {
    const copy = JSON.parse(JSON.stringify(plan)) as InheritancePlan;
    expect(matchesPlan(lock, copy)).toBe(true);
    expect(matchesPlan(lock, { ...copy, heirsHeight: H + 1 })).toBe(false);
  });
  test('refuses bad plans', () => {
    expect(() => validatePlan({ ...plan, heirs: plan.heirs.slice(0, 2) })).toThrow();
    expect(() => validatePlan({ ...plan, leadHeight: H })).toThrow();
    expect(() => validatePlan({ ...plan, heirsHeight: 1_700_000_000 })).toThrow();
    expect(() => validatePlan({ ...plan, heirs: [plan.heirs[0], plan.heirs[0], plan.heirs[2]] })).toThrow();
    expect(() => validatePlan({ ...plan, ownerPubKey: plan.heirs[1].pubKey })).toThrow();
    expect(() => validatePlan({ ...plan, heirs: [{ ...plan.heirs[0], name: ' ' }, ...plan.heirs.slice(1)] })).toThrow();
  });
  test('check-in pushes both heights forward and produces a new script', () => {
    const next = checkIn(plan, 1_100_000);
    expect(next.heirsHeight).toBe(1_100_000 + 52_601);
    expect(next.leadHeight).toBeGreaterThan(next.heirsHeight);
    expect(inheritanceLock(next).toHex()).not.toBe(lock.toHex());
  });
  test('status text', () => {
    expect(planStatus(plan, H - 144)).toContain('about 1 day ');
    expect(planStatus(plan, H)).toContain('Any two heirs');
    expect(planStatus(plan, L)).toContain('Heir 1 can now claim alone');
  });
});
