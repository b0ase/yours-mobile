import { describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Transaction, Utils } from '@bsv/sdk';
import { BTRUST_PROTOCOL, checkIn, inheritanceLock, type InheritancePlan } from './inheritance';
import {
  buildHeirsClaim,
  finishHeirsClaim,
  heirSignature,
  heirSigner,
  ownerSigner,
  signCheckIn,
  signLeadClaim,
  verifyInputSignature,
  verifySpend,
} from './sign';
import { beaconAddress, ownerKeyID, planFromScript } from './derive';

// Seed-derived keys exactly as the wallet derives them (ProtoWallet = BRC-100 createSignature / getPublicKey).
const ownerRoot = PrivateKey.fromRandom();
const heirRoots = [PrivateKey.fromRandom(), PrivateKey.fromRandom(), PrivateKey.fromRandom()];
const ownerWallet = new ProtoWallet(ownerRoot);
const heirWallets = heirRoots.map((k) => new ProtoWallet(k));
const stranger = new ProtoWallet(PrivateKey.fromRandom());
const pubOf = (root: PrivateKey, keyID: string) =>
  new KeyDeriver(root).derivePublicKey(BTRUST_PROTOCOL, keyID, 'self', true).toString();

const H = 1_000_000;
const L = 1_030_000;
const plan: InheritancePlan = {
  v: 1,
  ownerPubKey: pubOf(ownerRoot, ownerKeyID(0)),
  heirs: heirRoots.map((k, i) => ({ name: `Heir ${i + 1}`, pubKey: pubOf(k, 'heir') })),
  heirsHeight: H,
  leadHeight: L,
};
const payTo = PrivateKey.fromRandom().toAddress();

function fundingTx(p = plan, sats = 100_000) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(payTo),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript: new P2PKH().lock(payTo), satoshis: 5 });
  src.addOutput({ lockingScript: inheritanceLock(p), satoshis: sats });
  return src;
}

/** Re-parse a signed tx (as a co-signer or broadcaster would) with its source attached. */
function reload(tx: Transaction, src: Transaction) {
  const copy = Transaction.fromHex(tx.toHex());
  copy.inputs[0].sourceTransaction = src;
  return copy;
}

describe('check-in signing', () => {
  test('owner wallet signs a check-in that verifies and re-locks under the later plan', async () => {
    const src = fundingTx();
    const next = checkIn(plan, 1_100_000);
    const tx = await signCheckIn({ lockTx: src, vout: 1, plan, next, owner: await ownerSigner(ownerWallet) });
    expect(verifySpend(tx)).toBe(true);
    expect(verifySpend(reload(tx, src))).toBe(true);
    expect(planFromScript(tx.outputs[0].lockingScript)?.heirsHeight).toBe(next.heirsHeight);
    expect(tx.outputs[1].lockingScript.toHex()).toBe(new P2PKH().lock(beaconAddress(plan.ownerPubKey)).toHex());
    expect(tx.outputs[0].satoshis! + tx.outputs[1].satoshis!).toBeLessThan(100_000);
    expect(100_000 - tx.outputs[0].satoshis! - 1).toBeLessThan(1000);
  });

  test('tampered check-in data is rejected', async () => {
    const src = fundingTx();
    const tx = await signCheckIn({
      lockTx: src,
      vout: 1,
      plan,
      next: checkIn(plan, 1_100_000),
      owner: await ownerSigner(ownerWallet),
    });
    const moved = reload(tx, src);
    moved.outputs[0].lockingScript = new P2PKH().lock(payTo);
    expect(verifySpend(moved)).toBe(false);
    const more = reload(tx, src);
    more.outputs[0].satoshis = more.outputs[0].satoshis! + 1;
    expect(verifySpend(more)).toBe(false);
    const later = reload(tx, src);
    later.outputs[0].lockingScript = inheritanceLock(checkIn(plan, 1_200_000));
    expect(verifySpend(later)).toBe(false);
  });

  test('refuses the wrong wallet, wrong output, or changed heirs', async () => {
    const src = fundingTx();
    const next = checkIn(plan, 1_100_000);
    await expect(
      signCheckIn({ lockTx: src, vout: 1, plan, next, owner: await ownerSigner(stranger) }),
    ).rejects.toThrow();
    await expect(
      signCheckIn({ lockTx: src, vout: 1, plan, next, owner: await ownerSigner(ownerWallet, 1) }),
    ).rejects.toThrow();
    await expect(
      signCheckIn({ lockTx: src, vout: 0, plan, next, owner: await ownerSigner(ownerWallet) }),
    ).rejects.toThrow();
    const swapped = { ...next, heirs: [next.heirs[1], next.heirs[0], next.heirs[2]] };
    await expect(
      signCheckIn({ lockTx: src, vout: 1, plan, next: swapped, owner: await ownerSigner(ownerWallet) }),
    ).rejects.toThrow();
  });
});

describe('lead heir claim', () => {
  test('lead heir wallet signs a claim that verifies at the lead height', async () => {
    const src = fundingTx();
    const tx = await signLeadClaim({
      lockTx: src,
      vout: 1,
      plan,
      lead: await heirSigner(heirWallets[0]),
      payTo,
      height: L,
    });
    expect(verifySpend(reload(tx, src))).toBe(true);
    const moved = reload(tx, src);
    moved.outputs[0].lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    expect(verifySpend(moved)).toBe(false);
  });
  test('refuses too early or the wrong heir', async () => {
    const src = fundingTx();
    const lead = await heirSigner(heirWallets[0]);
    await expect(signLeadClaim({ lockTx: src, vout: 1, plan, lead, payTo, height: L - 1 })).rejects.toThrow();
    const other = await heirSigner(heirWallets[1]);
    await expect(signLeadClaim({ lockTx: src, vout: 1, plan, lead: other, payTo, height: L })).rejects.toThrow();
  });
});

describe('two heirs claim', () => {
  test('heirs sign on separate devices; the claim verifies', async () => {
    const src = fundingTx();
    const draft = buildHeirsClaim({ lockTx: src, vout: 1, plan, payTo, height: H });
    // Heir 3 signs first, heir 2 on another device from the shared hex.
    const a = await heirSignature(draft, plan, await heirSigner(heirWallets[2]));
    const shared = reload(draft, src);
    const b = await heirSignature(shared, plan, await heirSigner(heirWallets[1]));
    expect(verifyInputSignature(shared, 0, plan.heirs[2].pubKey, a.sig)).toBe(true);
    const tx = await finishHeirsClaim(shared, plan, [a, b]);
    expect(verifySpend(reload(tx, src))).toBe(true);
  });

  test('rejects a tampered claim, a forged seat, one heir twice, a stranger, or too early', async () => {
    const src = fundingTx();
    const draft = buildHeirsClaim({ lockTx: src, vout: 1, plan, payTo, height: H });
    const a = await heirSignature(draft, plan, await heirSigner(heirWallets[0]));
    const b = await heirSignature(draft, plan, await heirSigner(heirWallets[1]));

    const tampered = reload(draft, src);
    tampered.outputs[0].lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    expect(verifyInputSignature(tampered, 0, plan.heirs[0].pubKey, a.sig)).toBe(false);
    await expect(finishHeirsClaim(tampered, plan, [a, b])).rejects.toThrow('does not match');

    const flipped = [...a.sig];
    flipped[10] ^= 1;
    await expect(finishHeirsClaim(reload(draft, src), plan, [{ seat: 0, sig: flipped }, b])).rejects.toThrow();
    await expect(finishHeirsClaim(reload(draft, src), plan, [{ seat: 2, sig: a.sig }, b])).rejects.toThrow();
    await expect(finishHeirsClaim(reload(draft, src), plan, [a, a])).rejects.toThrow('two different heirs');
    await expect(heirSignature(draft, plan, await heirSigner(stranger))).rejects.toThrow('not in this plan');
    expect(() => buildHeirsClaim({ lockTx: src, vout: 1, plan, payTo, height: H - 1 })).toThrow();
  });
});

test('signatures are deterministic over the same data (RFC 6979)', async () => {
  const src = fundingTx();
  const draft = buildHeirsClaim({ lockTx: src, vout: 1, plan, payTo, height: H });
  const s = await heirSigner(heirWallets[0]);
  expect(Utils.toHex((await heirSignature(draft, plan, s)).sig)).toBe(
    Utils.toHex((await heirSignature(draft, plan, s)).sig),
  );
});
