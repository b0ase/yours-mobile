import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { claimPath, countdown, heirIndex, parsePlan } from './checkin';
import type { InheritancePlan } from './inheritance';

const pub = () => PrivateKey.fromRandom().toPublicKey().toString();
const plan: InheritancePlan = {
  v: 1,
  ownerPubKey: pub(),
  heirs: [
    { name: 'A', pubKey: pub() },
    { name: 'B', pubKey: pub() },
    { name: 'C', pubKey: pub() },
  ],
  heirsHeight: 1_000_000,
  leadHeight: 1_030_000,
};

describe('bTrust check-in helpers', () => {
  test('countdown tones and days', () => {
    expect(countdown(plan, 900_000).tone).toBe('ok');
    expect(countdown(plan, 1_000_000 - 144 * 10).heirsDays).toBe(10);
    expect(countdown(plan, 1_000_000 - 144 * 10).tone).toBe('soon');
    const open = countdown(plan, 1_000_001);
    expect(open.tone).toBe('open');
    expect(open.heirsBlocks).toBe(0);
    expect(open.leadBlocks).toBe(29_999);
  });

  test('claim path by height', () => {
    expect(claimPath(plan, 999_999)).toBe('none');
    expect(claimPath(plan, 1_000_000)).toBe('heirs');
    expect(claimPath(plan, 1_030_000)).toBe('lead');
  });

  test('parsePlan validates and rejects junk', () => {
    expect(parsePlan(JSON.stringify(plan)).heirsHeight).toBe(1_000_000);
    expect(() => parsePlan('nope')).toThrow('not a bTrust plan');
    expect(() => parsePlan(JSON.stringify({ ...plan, heirs: plan.heirs.slice(0, 2) }))).toThrow();
  });

  test('heirIndex finds the seat', () => {
    expect(heirIndex(plan, plan.heirs[1].pubKey)).toBe(1);
    expect(heirIndex(plan, pub())).toBe(-1);
  });
});
