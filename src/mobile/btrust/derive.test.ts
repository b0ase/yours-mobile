import { describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Transaction } from '@bsv/sdk';
import { BTRUST_PROTOCOL, checkIn, inheritanceLock, type InheritancePlan } from './inheritance';
import {
  beaconAddress,
  beaconScript,
  ownerKeyID,
  planFromScript,
  scanForLocks,
  type ChainReader,
  type OwnerKeys,
} from './derive';
import { ownerSigner, signCheckIn } from './sign';

const root = PrivateKey.fromRandom();
const wallet = new ProtoWallet(root);
// Seed-only: keys come straight from the root key (what a restored phrase gives), no plan file, no server.
const keys: OwnerKeys = async (keyID) =>
  new KeyDeriver(root).derivePublicKey(BTRUST_PROTOCOL, keyID, 'self', true).toString();
const heirKeys = [0, 1, 2].map(() => PrivateKey.fromRandom().toPublicKey().toString());
const planFor = async (slot: number, h = 1_000_000): Promise<InheritancePlan> => ({
  v: 1,
  ownerPubKey: await keys(ownerKeyID(slot)),
  heirs: heirKeys.map((pubKey, i) => ({ name: `Heir ${i + 1}`, pubKey })),
  heirsHeight: h,
  leadHeight: h + 30_000,
});

/** A fake chain: transactions indexed by every P2PKH address they pay. */
function fakeChain(txs: Transaction[], spentSet = new Set<string>()): ChainReader & { calls: string[] } {
  const calls: string[] = [];
  const byId = new Map(txs.map((t) => [t.id('hex'), t]));
  return {
    calls,
    history: async (address) => {
      calls.push(address);
      const p2 = new P2PKH().lock(address).toHex();
      return txs.filter((t) => t.outputs.some((o) => o.lockingScript.toHex() === p2)).map((t) => t.id('hex'));
    },
    rawTx: async (txid) => byId.get(txid)!.toHex(),
    spent: async (txid, vouts) => new Set(vouts.filter((v) => spentSet.has(`${txid}:${v}`))),
  };
}

function fund(plan: InheritancePlan, sats = 50_000) {
  const t = new Transaction();
  t.addInput({
    sourceTXID: PrivateKey.fromRandom().toHex(),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  t.addOutput({ lockingScript: inheritanceLock(plan), satoshis: sats });
  t.addOutput({ lockingScript: beaconScript(plan.ownerPubKey), satoshis: 1 });
  return t;
}

describe('derivation', () => {
  test('slot 0 is the key bTrust has always used (keyID "owner"), later slots differ', async () => {
    const legacy = (await wallet.getPublicKey({ protocolID: BTRUST_PROTOCOL, keyID: 'owner', counterparty: 'self' }))
      .publicKey;
    expect(await keys(ownerKeyID(0))).toBe(legacy);
    expect(ownerKeyID(3)).toBe('owner 3');
    expect(await keys(ownerKeyID(1))).not.toBe(legacy);
    expect(() => ownerKeyID(-1)).toThrow();
  });
  test('the same seed gives the same keys (wallet and bare key deriver agree)', async () => {
    const w = (await wallet.getPublicKey({ protocolID: BTRUST_PROTOCOL, keyID: 'owner 2', counterparty: 'self' }))
      .publicKey;
    expect(await keys('owner 2')).toBe(w);
    expect((await ownerSigner(wallet, 2)).pubKey).toBe(w);
  });
});

describe('planFromScript', () => {
  test('rebuilds the plan byte-for-byte from the lock script', async () => {
    const plan = await planFor(0);
    const got = planFromScript(inheritanceLock(plan));
    expect(got).toEqual(plan);
    expect(planFromScript(inheritanceLock(plan), ['Ann', 'Bob', 'Cy'])?.heirs[1].name).toBe('Bob');
  });
  test('returns null for anything else', async () => {
    expect(planFromScript(new P2PKH().lock(PrivateKey.fromRandom().toAddress()))).toBeNull();
    const s = inheritanceLock(await planFor(0));
    s.chunks.splice(6, 1);
    expect(planFromScript(s)).toBeNull();
  });
});

describe('seed-only scan', () => {
  test('finds locks in slots 0 and 2 (with a gap), marks spent ones, follows check-ins', async () => {
    const p0 = await planFor(0);
    const p2 = await planFor(2, 1_200_000);
    const f0 = fund(p0);
    const f2 = fund(p2);
    // Owner checks in on slot 0: the old lock is spent, the new one carries a beacon to the same slot.
    const ci = await signCheckIn({
      lockTx: f0,
      vout: 0,
      plan: p0,
      next: checkIn(p0, 1_050_000),
      owner: await ownerSigner(wallet),
    });
    const chain = fakeChain([f0, f2, ci], new Set([`${f0.id('hex')}:0`]));
    const { locks, nextSlot } = await scanForLocks(keys, chain, { gapLimit: 3 });
    expect(locks.map((l) => [l.slot, l.spent])).toEqual([
      [0, true],
      [0, false],
      [2, false],
    ]);
    expect(locks[1].plan.heirsHeight).toBe(1_050_000 + 52_601);
    expect(locks[2].plan).toEqual(p2);
    expect(nextSlot).toBe(3);
    // slots 0..5 scanned: stops after 3 empty slots in a row (3, 4, 5).
    expect(chain.calls.length).toBe(6);
    expect(chain.calls[0]).toBe(beaconAddress(p0.ownerPubKey));
  });

  test('a lock beyond the gap limit is not reached; an empty seed costs gapLimit lookups', async () => {
    const far = fund(await planFor(8));
    const chain = fakeChain([far]);
    const r = await scanForLocks(keys, chain, { gapLimit: 5 });
    expect(r.locks).toEqual([]);
    expect(r.nextSlot).toBe(0);
    expect(chain.calls.length).toBe(5);
    expect((await scanForLocks(keys, fakeChain([far]), { gapLimit: 10 })).locks.length).toBe(1);
  });

  test('ignores other owners’ locks paid alongside our beacon', async () => {
    const p0 = await planFor(0);
    const t = fund(p0);
    const other = { ...p0, ownerPubKey: PrivateKey.fromRandom().toPublicKey().toString() };
    t.addOutput({ lockingScript: inheritanceLock(other), satoshis: 999 });
    const { locks } = await scanForLocks(keys, fakeChain([t]));
    expect(locks.length).toBe(1);
    expect(locks[0].vout).toBe(0);
  });
});

test('an heir finds the live lock from the plan file alone', async () => {
  const { findPlanLock } = await import('./derive');
  const p0 = await planFor(0);
  const f0 = fund(p0);
  expect((await findPlanLock(p0, fakeChain([f0])))?.vout).toBe(0);
  expect(await findPlanLock(p0, fakeChain([f0], new Set([`${f0.id('hex')}:0`])))).toBeNull();
  expect(await findPlanLock({ ...p0, heirsHeight: 999_999 }, fakeChain([f0]))).toBeNull();
});
