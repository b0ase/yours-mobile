import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { P2PKH, PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk';
import { checkIn, inheritanceLock, planHeights, type InheritancePlan } from './inheritance';
import { fundingMismatch } from './fund';
import { ownerSigner, signWithdraw, verifySpend } from './sign';
import { ownerKeyID } from './derive';

const page = readFileSync(new URL('./BTrustPage.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('./CheckInPanel.tsx', import.meta.url), 'utf8');
const H = 971_638;

describe('the TEST banner and the plan heights come from one flag', () => {
  test('the page shows the banner and builds heights from the same TEST_TIMINGS', () => {
    expect(page).toContain('{TEST_TIMINGS && <TestBanner />}');
    expect(page).toContain('...planHeights(height, months, TEST_TIMINGS)');
    expect(page).toContain('testMode={TEST_TIMINGS}');
    expect(page).not.toMatch(/blocksForMonths\(/);
  });
  test('test mode: 3 blocks, then 3 more; real mode: months', () => {
    expect(planHeights(H, 12, true)).toEqual({ heirsHeight: H + 3, leadHeight: H + 6 });
    expect(planHeights(H, 12, false).heirsHeight).toBe(H + 52_601);
  });
  test('the check-in preview never rewrites the plan on screen (that is how a test plan got real dates)', () => {
    expect(panel).not.toContain('onPreview(next)');
  });
});

const pub = () => PrivateKey.fromRandom().toPublicKey().toString();
const base = (owner: string, test?: true): InheritancePlan => ({
  v: 1,
  ownerPubKey: owner,
  heirs: [
    { name: 'A', pubKey: pub() },
    { name: 'B', pubKey: pub() },
    { name: 'C', pubKey: pub() },
  ],
  ...planHeights(H, 12, !!test),
  ...(test ? { test } : {}),
});

describe('a test plan stays a test plan', () => {
  test('checking in a test plan keeps test timings', () => {
    const next = checkIn(base(pub(), true), H + 10);
    expect(next.heirsHeight).toBe(H + 13);
    expect(next.leadHeight).toBe(H + 16);
  });
  test('funding refuses a plan whose dates do not match the mode', () => {
    const real = base(pub());
    const testPlan = base(pub(), true);
    expect(fundingMismatch(testPlan, H, true)).toBe('');
    expect(fundingMismatch(real, H, false)).toBe('');
    // The owner's case: TEST banner on, plan with 12-month dates.
    expect(fundingMismatch({ ...testPlan, ...planHeights(H, 12, false) }, H, true)).toContain('real dates');
    expect(fundingMismatch(real, H, true)).not.toBe('');
    expect(fundingMismatch(testPlan, H, false)).not.toBe('');
  });
});

describe('owner withdraw (cancel the lock)', () => {
  const root = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(root);
  const lockFor = async () => {
    const owner = await ownerSigner(wallet, 0);
    const plan = base(owner.pubKey);
    const src = new Transaction();
    src.addInput({
      sourceTXID: '22'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    });
    src.addOutput({ lockingScript: inheritanceLock(plan), satoshis: 10_000 });
    return { owner, plan, src };
  };
  test('moves the coins to the wallet address at any time, and verifies', async () => {
    const { owner, plan, src } = await lockFor();
    const to = PrivateKey.fromRandom().toAddress();
    const tx = await signWithdraw({ lockTx: src, vout: 0, plan, owner, payTo: to });
    expect(verifySpend(tx)).toBe(true);
    expect(tx.outputs.length).toBe(1);
    expect(tx.outputs[0].lockingScript.toHex()).toBe(new P2PKH().lock(to).toHex());
    expect(10_000 - tx.outputs[0].satoshis!).toBeLessThan(100);
    expect(ownerKeyID(0)).toBe('owner');
  });
  test('tampered destination or amount fails; another wallet cannot', async () => {
    const { owner, plan, src } = await lockFor();
    const tx = await signWithdraw({ lockTx: src, vout: 0, plan, owner, payTo: PrivateKey.fromRandom().toAddress() });
    const moved = Transaction.fromHex(tx.toHex());
    moved.inputs[0].sourceTransaction = src;
    moved.outputs[0].lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    expect(verifySpend(moved)).toBe(false);
    const other = await ownerSigner(new ProtoWallet(PrivateKey.fromRandom()), 0);
    await expect(
      signWithdraw({ lockTx: src, vout: 0, plan, owner: other, payTo: PrivateKey.fromRandom().toAddress() }),
    ).rejects.toThrow();
  });
});
