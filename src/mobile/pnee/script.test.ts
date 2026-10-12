import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hash, LockingScript, PrivateKey, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import {
  KIT,
  PNEE,
  burnReceiptScript,
  isVaultScript,
  preimage,
  serializeOutputs,
  sighashDigest,
  tokenScript,
  tokenState,
  tokenUnlock,
  vaultScript,
  vaultState,
  vaultUnlock,
  type PriceProof,
  type VaultConfig,
} from './script';

const dir = join(import.meta.dir, 'kit');
const sha = (f: string) =>
  createHash('sha256')
    .update(readFileSync(join(dir, f)))
    .digest('hex');
const V = JSON.parse(readFileSync(join(dir, 'pnee-vectors.json'), 'utf8'));
/** The kit's throwaway test keys: sha256('bwalletx-bond kit vector: <label>') (no key material in the files). */
const labelKey = (label: string) =>
  PrivateKey.fromHex(createHash('sha256').update(`bwalletx-bond kit vector: ${label}`).digest('hex'));

const cfg: VaultConfig = {
  owner: V.ownerPub,
  issuer: V.issuerPub,
  oracles: V.oracles.map((n: string) => BigInt(n)),
  openTs: BigInt(V.openTs),
};
const ownerKey = labelKey(V.keyLabels.owner);
const issuerKey = labelKey(V.keyLabels.issuer);
const tx = (h: string) => Transaction.fromHex(h);

/** Our own signature for input `i`: ECDSA over hash256(preimage), as the wallet's hashToDirectlySign does. */
const sign = (key: PrivateKey, t: Transaction, i: number, sats: number, script: string) =>
  key.sign(Hash.sha256(preimage(t, i, sats, script))).toDER() as number[];

/** Run input 0 of `t` (spending `prev` output) through the @bsv/sdk interpreter. */
function runs(t: Transaction, prevScript: string, prevSats: number, prevTxid: string) {
  const input = t.inputs[0];
  const spend = new Spend({
    sourceTXID: prevTxid,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: prevSats,
    lockingScript: LockingScript.fromHex(prevScript),
    transactionVersion: t.version,
    otherInputs: t.inputs.slice(1),
    outputs: t.outputs,
    unlockingScript: input.unlockingScript!,
    inputSequence: input.sequence ?? 0xffffffff,
    inputIndex: 0,
    lockTime: t.lockTime,
    memoryLimit: 100_000_000,
  });
  return spend.validate();
}

/**
 * Our unlocking script equals sCrypt's except for the signature pushes (sCrypt's bsv library picks another ECDSA
 * nonce), and with ours in place the transaction passes the interpreter.
 */
function matches(t: Transaction, ours: UnlockingScript, sigChunks: number[]) {
  const theirs = t.inputs[0].unlockingScript!.chunks;
  expect(ours.chunks.length).toBe(theirs.length);
  ours.chunks.forEach((c, k) => {
    if (sigChunks.includes(k)) expect(c.data?.length ?? 0).toBeGreaterThan(69);
    else expect(Utils.toHex(c.data ?? [c.op])).toBe(Utils.toHex(theirs[k].data ?? [theirs[k].op]));
  });
  t.inputs[0].unlockingScript = ours;
}

const proofOf = (p: (typeof V)['mint']['price']): PriceProof => ({
  ts: BigInt(p.ts),
  prices: p.signed.map((s: { priceCents: number }) => BigInt(s.priceCents)),
  idx: p.signed.map((s: { signer: number }) => BigInt(s.signer)),
  sigs: p.signed.map((s: { s: string }) => BigInt(s.s)),
  paddings: p.signed.map((s: { padding: string }) => s.padding),
});

describe('PNEE kit (pinned copy of bwalletx-bond `pnpm kit`)', () => {
  test('kit and vectors are the pinned files', () => {
    expect(sha('pnee-kit.json')).toBe('d3973bc056330cfaf49b9dfcc63fc6716b78d6210c6ddfe9583785963b132a6f');
    expect(sha('pnee-vectors.json')).toBe('a20c92f6a594b2d51bce59fb7f2cc71c3e7b31d54c3fc2acb6cb1e5320fc7876');
    expect(V.kitMd5).toEqual({ vault: KIT.vault.md5, token: KIT.token.md5 });
  });

  test('the PNEE deployment: 1¢ units, mint up to 10x, liquidation below 150% at 10%, no fee', () => {
    expect(PNEE.unitCents).toBe(1n);
    expect(PNEE.minRatioPct).toBe(1000n);
    expect(PNEE.liqRatioPct).toBe(150n);
    expect(PNEE.liqDiscountPct).toBe(10n);
    expect(PNEE.feeBps).toBe(0n);
  });
});

describe('vault script', () => {
  test('the genesis script equals the one sCrypt deployed', () => {
    expect(vaultScript(cfg)).toBe(V.vaultScript);
    expect(tx(V.deployTx).outputs[0].lockingScript.toHex()).toBe(V.vaultScript);
    expect(isVaultScript(V.vaultScript, cfg)).toBe(true);
    expect(isVaultScript(V.vaultScript, { ...cfg, owner: V.issuerPub })).toBe(false);
  });

  test('genesis state reads as debt 0 since openTs', () => {
    expect(vaultState(V.vaultScript, cfg.openTs)).toEqual({
      genesis: true,
      debt: 0n,
      lastTs: cfg.openTs,
      feeCents: 0n,
      feeTs: cfg.openTs,
    });
  });

  test('state after topUp and mint round-trips byte for byte', () => {
    for (const name of ['topUp', 'mint'] as const) {
      const out = tx(V[name].tx).outputs[0].lockingScript.toHex();
      const s = vaultState(out, cfg.openTs);
      const { genesis: _g, ...state } = s;
      expect(vaultScript(cfg, state)).toBe(out);
    }
    expect(vaultState(tx(V.mint.tx).outputs[0].lockingScript.toHex(), cfg.openTs).debt).toBe(50n);
  });
});

describe('PNEE token script', () => {
  test('the mint output is a token for exactly the minted amount, held by the owner', () => {
    const out = tx(V.mint.tx).outputs[1].lockingScript.toHex();
    expect(tokenState(out)).toEqual({ holder: V.ownerPub, amount: 50n });
    expect(tokenScript(V.ownerPub, 50n)).toBe(out);
  });

  test('a send splits amount-conserving: 20 to the recipient, 30 back', () => {
    const t = tx(V.send.tx);
    expect(tokenState(t.outputs[0].lockingScript.toHex())).toEqual({ holder: V.issuerPub, amount: 20n });
    expect(tokenState(t.outputs[1].lockingScript.toHex())).toEqual({ holder: V.ownerPub, amount: 30n });
  });

  test('anything else is not a PNEE', () => {
    expect(tokenState(V.vaultScript)).toBeNull();
    expect(tokenState('76a914' + '00'.repeat(20) + '88ac')).toBeNull();
  });
});

describe('unlocking scripts match sCrypt and pass the interpreter', () => {
  const deploy = tx(V.deployTx);
  const topUp = tx(V.topUp.tx);
  const mint = tx(V.mint.tx);
  const send = tx(V.send.tx);
  const burn = tx(V.burn.tx);
  const close = tx(V.close.tx);

  test('restOutputs = the outputs after the fixed ones', () => {
    expect(serializeOutputs(topUp.outputs.slice(1))).toBe(V.topUp.restOutputs);
    expect(serializeOutputs(mint.outputs.slice(2))).toBe(V.mint.restOutputs);
    expect(serializeOutputs(close.outputs.slice(1))).toBe(V.close.restOutputs);
  });

  test('topUp', () => {
    const pre = preimage(topUp, 0, deploy.outputs[0].satoshis!, V.vaultScript);
    expect(Utils.toHex(pre)).toBe(Utils.toHex(topUp.inputs[0].unlockingScript!.chunks[3].data!));
    expect(Utils.toHex(sighashDigest(pre))).toBe(Utils.toHex(Hash.sha256(Hash.sha256(pre))));
    const sig = sign(ownerKey, topUp, 0, deploy.outputs[0].satoshis!, V.vaultScript);
    const u = vaultUnlock.topUp(sig, BigInt(V.topUp.addSats), serializeOutputs(topUp.outputs.slice(1)), pre);
    matches(topUp, u, [0]);
    expect(runs(topUp, V.vaultScript, deploy.outputs[0].satoshis!, deploy.id('hex'))).toBe(true);
  });

  test('mint', () => {
    const prev = topUp.outputs[0];
    const s = prev.lockingScript.toHex();
    const pre = preimage(mint, 0, prev.satoshis!, s);
    const sig = sign(ownerKey, mint, 0, prev.satoshis!, s);
    const u = vaultUnlock.mint(sig, 50n, proofOf(V.mint.price), serializeOutputs(mint.outputs.slice(2)), pre);
    matches(mint, u, [0]);
    expect(runs(mint, s, prev.satoshis!, topUp.id('hex'))).toBe(true);
  });

  test('mint with one more PNEE than 10x allows fails in the interpreter', () => {
    const prev = topUp.outputs[0];
    const s = prev.lockingScript.toHex();
    // 11,000,000 sats at $50.00 = $5.50: 55 PNEEs at most. Ask for 56: rebuild outputs for 56 and re-sign.
    const t = tx(V.mint.tx);
    const st = vaultState(t.outputs[0].lockingScript.toHex(), cfg.openTs);
    const { genesis: _g, ...state } = st;
    t.outputs[0].lockingScript = LockingScript.fromHex(vaultScript(cfg, { ...state, debt: 56n }));
    t.outputs[1].lockingScript = LockingScript.fromHex(tokenScript(V.ownerPub, 56n));
    const pre = preimage(t, 0, prev.satoshis!, s);
    const sig = sign(ownerKey, t, 0, prev.satoshis!, s);
    t.inputs[0].unlockingScript = vaultUnlock.mint(
      sig,
      56n,
      proofOf(V.mint.price),
      serializeOutputs(t.outputs.slice(2)),
      pre,
    );
    expect(() => runs(t, s, prev.satoshis!, topUp.id('hex'))).toThrow();
  });

  test('token send', () => {
    const prev = mint.outputs[1];
    const s = prev.lockingScript.toHex();
    const pre = preimage(send, 0, 1, s);
    const sig = sign(ownerKey, send, 0, 1, s);
    const u = tokenUnlock.transfer(sig, V.issuerPub, 20n, serializeOutputs(send.outputs.slice(2)), pre);
    matches(send, u, [0]);
    expect(runs(send, s, 1, mint.id('hex'))).toBe(true);
  });

  test('token burn', () => {
    const prev = send.outputs[1];
    const s = prev.lockingScript.toHex();
    const pre = preimage(burn, 0, 1, s);
    const sig = sign(ownerKey, burn, 0, 1, s);
    matches(burn, tokenUnlock.burn(sig, pre), [0]);
    expect(runs(burn, s, 1, send.id('hex'))).toBe(true);
  });

  test('close: the receipt burns exactly the minted 50; owner and issuer sign', () => {
    const prev = mint.outputs[0];
    const s = prev.lockingScript.toHex();
    expect(close.outputs[0].lockingScript.toHex()).toBe(burnReceiptScript(mint.id('hex'), 0, 50n));
    const pre = preimage(close, 0, prev.satoshis!, s);
    const o = sign(ownerKey, close, 0, prev.satoshis!, s);
    const i = sign(issuerKey, close, 0, prev.satoshis!, s);
    const u = vaultUnlock.close(o, i, 50n, serializeOutputs(close.outputs.slice(1)), pre);
    matches(close, u, [0, 1]);
    expect(runs(close, s, prev.satoshis!, mint.id('hex'))).toBe(true);
  });

  test('close burning 49 of 50 fails in the interpreter', () => {
    const prev = mint.outputs[0];
    const s = prev.lockingScript.toHex();
    const t = tx(V.close.tx);
    t.outputs[0].lockingScript = LockingScript.fromHex(burnReceiptScript(mint.id('hex'), 0, 49n));
    const pre = preimage(t, 0, prev.satoshis!, s);
    t.inputs[0].unlockingScript = vaultUnlock.close(
      sign(ownerKey, t, 0, prev.satoshis!, s),
      sign(issuerKey, t, 0, prev.satoshis!, s),
      49n,
      serializeOutputs(t.outputs.slice(1)),
      pre,
    );
    expect(() => runs(t, s, prev.satoshis!, mint.id('hex'))).toThrow();
  });

  test('unlocking scripts parse back', () => {
    expect(UnlockingScript.fromHex(close.inputs[0].unlockingScript!.toHex()).chunks.length).toBe(6);
    expect(Utils.toHex(Utils.toArray('ok', 'utf8'))).toBe('6f6b');
  });
});
