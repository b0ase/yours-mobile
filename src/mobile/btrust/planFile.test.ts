import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { parsePlan } from './checkin';
import { aboutBlocks, planStatus, type InheritancePlan } from './inheritance';
import { planCode, planFileName, planJson, planLabel, withFunding } from './planFile';

const pub = () => PrivateKey.fromRandom().toPublicKey().toString();
const plan: InheritancePlan = {
  v: 1,
  ownerPubKey: pub(),
  heirs: [
    { name: 'Alice Secret', pubKey: pub() },
    { name: 'Bob', pubKey: pub() },
    { name: 'Cy', pubKey: pub() },
  ],
  heirsHeight: 971_641,
  leadHeight: 971_644,
};

describe('plan files', () => {
  test('code is 6 hex from the lock script, stable, and ignores names and funding fields', () => {
    const code = planCode(plan);
    expect(code).toMatch(/^[0-9a-f]{6}$/);
    expect(planCode({ ...plan, heirs: plan.heirs.map((h) => ({ ...h, name: 'X' })) })).toBe(code);
    expect(planCode(withFunding(plan, { slot: 2, fundingTxid: 'ab'.repeat(32), vout: 0 }))).toBe(code);
    expect(planCode({ ...plan, heirsHeight: 971_642 })).not.toBe(code);
    expect(planLabel(plan)).toBe(`Plan ${code}`);
  });

  test('filename: date + code, -TEST for test plans, never heir names', () => {
    const at = new Date('2026-10-18T12:00:00Z');
    expect(planFileName(plan, at)).toBe(`btrust-plan-2026-10-18-${planCode(plan)}.json`);
    expect(planFileName({ ...plan, test: true }, at)).toBe(`btrust-plan-2026-10-18-${planCode(plan)}-TEST.json`);
    for (const h of plan.heirs) expect(planFileName(plan, at)).not.toContain(h.name.split(' ')[0]);
  });

  test('funding fields are written and round-trip; old files without them still load', () => {
    const full = withFunding(plan, { slot: 3, fundingTxid: 'cd'.repeat(32), vout: 0, createdAt: 123 });
    const back = parsePlan(planJson(full));
    expect([back.slot, back.fundingTxid, back.vout, back.createdAt]).toEqual([3, 'cd'.repeat(32), 0, 123]);
    const old = parsePlan(JSON.stringify(plan));
    expect(old.slot).toBeUndefined();
    expect(planCode(old)).toBe(planCode(plan));
    expect(() => withFunding(plan, { slot: 0, fundingTxid: 'nope', vout: 0 })).toThrow();
  });
});

describe('timing text from the real block delta (10 min a block)', () => {
  test('test-mode heights read in minutes and hours', () => {
    expect(aboutBlocks(3)).toBe('about 30 min');
    expect(aboutBlocks(6)).toBe('about 1 hour');
    expect(aboutBlocks(18)).toBe('about 3 hours');
    expect(aboutBlocks(144)).toBe('about 1 day');
    expect(aboutBlocks(52_601)).toBe('about 366 days');
    expect(planStatus(plan, 971_638)).toContain('in about 30 min unless');
  });
});
