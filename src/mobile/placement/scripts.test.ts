import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Spend, Transaction, type LockingScript } from '@bsv/sdk';
import {
  keySigner,
  multisigUnlock,
  parseShareLock,
  reassignTreasuryKey,
  treasuryScriptFor,
  type TreasuryConfig,
  shareLabel,
  shareLock,
  shareUnlock2of2,
  shareUnlockAfterTimelock,
  treasuryLock,
  unlockHeightAfterMonths,
} from './scripts';
import { shareTokenScript } from './token';

const director = PrivateKey.fromRandom();
const investor = PrivateKey.fromRandom();
const stranger = PrivateKey.fromRandom();
const UNTIL = 1_020_000;

const lock = shareLock({
  directorPubKey: director.toPublicKey(),
  investorPubKey: investor.toPublicKey(),
  unlockHeight: UNTIL,
});

function funded(lockingScript: LockingScript) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(investor.toAddress()),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript, satoshis: 1 });
  return src;
}

type Template = Parameters<Transaction['addInput']>[0]['unlockingScriptTemplate'];

async function spends(lockingScript: LockingScript, template: Template, lockTime = 0, sequence = 0) {
  const src = funded(lockingScript);
  const tx = new Transaction();
  tx.lockTime = lockTime;
  tx.addInput({ sourceTransaction: src, sourceOutputIndex: 0, sequence, unlockingScriptTemplate: template });
  tx.addOutput({ lockingScript: new P2PKH().lock(investor.toAddress()), satoshis: 1 });
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

const sig = keySigner;

describe('share lock: 2-of-2 path', () => {
  test('director + investor can move the shares at any time', async () => {
    expect(await spends(lock, shareUnlock2of2(sig(director), sig(investor)))).toBe(true);
    expect(await spends(lock, shareUnlock2of2(sig(director), sig(investor)), UNTIL + 10)).toBe(true);
  });
  test('wrong order or a stranger fails', async () => {
    expect(await spends(lock, shareUnlock2of2(sig(investor), sig(director)))).toBe(false);
    expect(await spends(lock, shareUnlock2of2(sig(director), sig(stranger)))).toBe(false);
  });
  test('director alone always fails (either branch, any time)', async () => {
    expect(await spends(lock, multisigUnlock([sig(director)], true))).toBe(false);
    expect(await spends(lock, shareUnlock2of2(sig(director), sig(director)), UNTIL + 10)).toBe(false);
    expect(await spends(lock, shareUnlockAfterTimelock(director), UNTIL + 10)).toBe(false);
  });
});

describe('share lock: investor-alone timelock path', () => {
  test('fails before the unlock height', async () => {
    expect(await spends(lock, shareUnlockAfterTimelock(investor), UNTIL - 1)).toBe(false);
    expect(await spends(lock, shareUnlockAfterTimelock(investor), 0)).toBe(false);
  });
  test('cannot dodge nLockTime with a final sequence', async () => {
    expect(await spends(lock, shareUnlockAfterTimelock(investor), UNTIL, 0xffffffff)).toBe(false);
  });
  test('works at and after the unlock height', async () => {
    expect(await spends(lock, shareUnlockAfterTimelock(investor), UNTIL)).toBe(true);
    expect(await spends(lock, shareUnlockAfterTimelock(investor), UNTIL + 5000)).toBe(true);
  });
  test('investor signature alone on the multisig branch fails', async () => {
    expect(await spends(lock, multisigUnlock([sig(investor)], true), UNTIL + 10)).toBe(false);
  });
});

describe('share lock: parsing and labels', () => {
  test('round trip', () => {
    expect(parseShareLock(lock)).toEqual({
      directorPubKey: director.toPublicKey().toString(),
      investorPubKey: investor.toPublicKey().toString(),
      unlockHeight: UNTIL,
    });
    expect(parseShareLock(new P2PKH().lock(investor.toAddress()))).toBeNull();
  });
  test('refuses bad parameters', () => {
    const p = director.toPublicKey();
    expect(() => shareLock({ directorPubKey: p, investorPubKey: p, unlockHeight: UNTIL })).toThrow();
    expect(() =>
      shareLock({ directorPubKey: p, investorPubKey: investor.toPublicKey(), unlockHeight: 1_700_000_000 }),
    ).toThrow();
  });
  test('12 months is ~52.6k blocks', () => {
    expect(unlockHeightAfterMonths(900_000) - 900_000).toBe(52_601);
    expect(() => unlockHeightAfterMonths(900_000, 0)).toThrow();
  });
  test('wallet label', () => {
    expect(shareLabel(1_000_000, UNTIL, UNTIL - 1, 'Acme Ltd')).toBe('Acme Ltd shares · 1,000,000 · locked 2-of-2');
    expect(shareLabel(5, UNTIL, UNTIL)).toBe('Shares · 5 · unlocked');
  });
});

describe('treasury m-of-n', () => {
  const d = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()];
  const t = treasuryLock(
    2,
    d.map((k) => k.toPublicKey()),
  );
  test('2-of-3 spends with any two in key order', async () => {
    expect(await spends(t, multisigUnlock([sig(d[0]), sig(d[1])]))).toBe(true);
    expect(await spends(t, multisigUnlock([sig(d[0]), sig(d[2])]))).toBe(true);
  });
  test('one director, or a stranger, fails', async () => {
    expect(await spends(t, multisigUnlock([sig(d[0])]))).toBe(false);
    expect(await spends(t, multisigUnlock([sig(d[0]), sig(stranger)]))).toBe(false);
  });
  test('config checks', () => {
    const pk = d[0].toPublicKey();
    expect(() => treasuryLock(3, [pk, d[1].toPublicKey()])).toThrow();
    expect(() => treasuryLock(1, [pk, pk])).toThrow();
  });
});

describe('bCorp treasury: configurable 2-of-3, all keys with the director', () => {
  const k = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()];
  const cfg: TreasuryConfig = {
    m: 2,
    slots: [
      { label: 'phone', holder: 'director', pubKey: k[0].toPublicKey().toString() },
      { label: 'desktop', holder: 'director', pubKey: k[1].toPublicKey().toString() },
      { label: 'offline backup', holder: 'director', pubKey: k[2].toPublicKey().toString() },
    ],
  };
  const t = treasuryScriptFor(cfg);
  test('any two of the three devices spend; one lost device does not lock the treasury', async () => {
    expect(await spends(t, multisigUnlock([sig(k[0]), sig(k[1])]))).toBe(true);
    expect(await spends(t, multisigUnlock([sig(k[0]), sig(k[2])]))).toBe(true);
    expect(await spends(t, multisigUnlock([sig(k[1]), sig(k[2])]))).toBe(true);
  });
  test('one key alone, a stranger, or the wrong order fails', async () => {
    expect(await spends(t, multisigUnlock([sig(k[2])]))).toBe(false);
    expect(await spends(t, multisigUnlock([sig(k[0]), sig(stranger)]))).toBe(false);
    expect(await spends(t, multisigUnlock([sig(k[1]), sig(k[0])]))).toBe(false);
  });
  test('script is OP_2 <3 keys> OP_3 OP_CHECKMULTISIG', () => {
    const hex = t.toHex();
    expect(hex.startsWith('5221')).toBe(true);
    expect(hex.endsWith('53ae')).toBe(true);
  });
  test('refuses anything but 2-of-3 with distinct compressed keys', () => {
    expect(() => treasuryScriptFor({ ...cfg, m: 3 })).toThrow();
    expect(() => treasuryScriptFor({ m: 2, slots: cfg.slots.slice(0, 2) })).toThrow();
    expect(() => treasuryScriptFor({ m: 2, slots: [cfg.slots[0], cfg.slots[0], cfg.slots[2]] })).toThrow();
    expect(() =>
      treasuryScriptFor({ m: 2, slots: [{ ...cfg.slots[0], pubKey: 'not-a-key' }, cfg.slots[1], cfg.slots[2]] }),
    ).toThrow();
  });
  test('one slot can be reassigned to a second director; the new script needs them or two of the rest', async () => {
    const second = PrivateKey.fromRandom();
    const next = reassignTreasuryKey(cfg, 'offline backup', {
      holder: 'second director',
      pubKey: second.toPublicKey().toString(),
    });
    expect(next.slots[2]).toEqual({
      label: 'offline backup',
      holder: 'second director',
      pubKey: second.toPublicKey().toString(),
    });
    const t2 = treasuryScriptFor(next);
    expect(await spends(t2, multisigUnlock([sig(k[0]), sig(second)]))).toBe(true);
    expect(await spends(t2, multisigUnlock([sig(k[0]), sig(k[2])]))).toBe(false); // retired key is out
    expect(() => reassignTreasuryKey(cfg, 'nope', { holder: 'x', pubKey: second.toPublicKey().toString() })).toThrow();
    expect(() => reassignTreasuryKey(cfg, 'phone', { holder: 'x', pubKey: cfg.slots[1].pubKey })).toThrow();
  });
});

describe('the inscribed $403 token output spends the same way', () => {
  const tok = shareTokenScript(
    {
      p: '403',
      op: 'allot',
      ticker: 'TEST',
      company: 'Test Co',
      shareClass: 'Ordinary',
      shares: 10,
      holder: 'alice',
      offerId: 'o1',
      allottedAt: '2026-10-14',
      register: 'https://example.invalid/r',
    },
    { directorPubKey: director.toPublicKey(), investorPubKey: investor.toPublicKey(), unlockHeight: UNTIL },
  );
  test('2-of-2 yes; investor alone only after the height; director alone never', async () => {
    expect(await spends(tok, shareUnlock2of2(sig(director), sig(investor)))).toBe(true);
    expect(await spends(tok, shareUnlockAfterTimelock(investor), UNTIL - 1)).toBe(false);
    expect(await spends(tok, shareUnlockAfterTimelock(investor), UNTIL)).toBe(true);
    expect(await spends(tok, shareUnlockAfterTimelock(director), UNTIL + 1)).toBe(false);
    expect(await spends(tok, multisigUnlock([sig(director)], true))).toBe(false);
  });
});
