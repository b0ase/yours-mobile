import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, type PublicKey, Transaction } from '@bsv/sdk';
import {
  LIMITS,
  NON_FINAL,
  PresignStore,
  SCAM_TOKEN_ID,
  SIGHASH,
  buildCreation,
  buildRefund,
  checkClaim,
  checkLimits,
  checkTokenBalance,
  claimSkeleton,
  claimUnlock,
  classifyBroadcastError,
  decodeSlot,
  finishClaim,
  memoryKV,
  nextRefundHeight,
  payerSlotKeys,
  presignSlot,
  runDueRefunds,
  serviceSlotKeys,
  signInput,
  slotKeyId,
  slotLockingScript,
  tokenOf,
  verifyInput,
  verifyInputSig,
  verifyTx,
  withTransfer,
  type StoredSet,
} from './index';

// Synthetic keys only. Nothing here touches a real key or the network.
const payerRoot = PrivateKey.fromRandom();
const serviceRoot = PrivateKey.fromRandom();
const payerId = payerRoot.toPublicKey();
const serviceId = serviceRoot.toPublicKey();
const feeKey = PrivateKey.fromRandom();
const recipient = PrivateKey.fromRandom().toAddress();
const other = PrivateKey.fromRandom().toAddress();
const payerAddr = payerRoot.toAddress();
const H = 970_000;
const T = H + 1008;
const SCAM = (amt: bigint) => ({ id: SCAM_TOKEN_ID, amt });

let n = 0;
function fund(key: PrivateKey, satoshis: number, token?: bigint): Transaction {
  const src = new Transaction();
  src.addInput({
    sourceTXID: (++n).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScript: new P2PKH().lock(other),
  });
  const lock = new P2PKH().lock(key.toAddress());
  src.addOutput({ lockingScript: token ? withTransfer(lock, SCAM(token)) : lock, satoshis });
  return src;
}
const spend = (key: PrivateKey, src: Transaction, token?: bigint) => ({
  sourceTransaction: src,
  sourceOutputIndex: 0,
  unlock: new P2PKH().unlock(key),
  token: token ? SCAM(token) : undefined,
});

function keysFor(setId: string, i: number) {
  const pay = payerSlotKeys(payerRoot, serviceId, setId, i);
  const svc = serviceSlotKeys(serviceRoot, payerId, setId, i);
  return { ...pay, Spriv: svc.S, Ppub: svc.P };
}
const slotOf = (setId: string, i: number, until: number, token?: bigint, satoshis = 1) => {
  const k = keysFor(setId, i);
  return {
    S: k.S,
    P: k.P.toPublicKey(),
    R: k.R.toPublicKey(),
    until,
    token: token ? SCAM(token) : undefined,
    satoshis,
  };
};

async function tokenSet() {
  const payer = payerRoot;
  const tokSrc = fund(payer, 1, 3n);
  const satSrc = fund(payer, 5000);
  const c = await buildCreation({
    inputs: [spend(payer, tokSrc, 3n), spend(payer, satSrc)],
    slots: [slotOf('proof', 0, T, 1n), slotOf('proof', 1, H + 3, 1n)],
    changeAddress: payerAddr,
    feeSatPerKb: 100,
  });
  return c;
}

describe('keys (BRC-42)', () => {
  test('payer and service derive the same P and S', () => {
    const k = keysFor('set1', 3);
    expect(k.P.toPublicKey().toString()).toBe(k.Ppub.toString());
    expect(k.Spriv.toPublicKey().toString()).toBe(k.S.toString());
  });
  test('each slot gets fresh keys; R is separate from P', () => {
    const a = keysFor('set1', 0);
    const b = keysFor('set1', 1);
    expect(a.P.toPublicKey().toString()).not.toBe(b.P.toPublicKey().toString());
    expect(a.S.toString()).not.toBe(b.S.toString());
    expect(a.R.toPublicKey().toString()).not.toBe(a.P.toPublicKey().toString());
  });
  test('ids are validated', () => {
    expect(() => slotKeyId('bad:id', 0)).toThrow();
    expect(() => slotKeyId('ok', -1)).toThrow();
    expect(slotKeyId('ok', 2)).toBe('ok:2');
  });
});

describe('slot script', () => {
  test('round-trips, with and without a token envelope', () => {
    const s = slotOf('a', 0, T);
    const plain = decodeSlot(slotLockingScript(s));
    expect(plain).toMatchObject({ S: s.S.toString(), P: s.P.toString(), refundAddress: s.R.toAddress(), until: T });
    expect(plain?.token).toBeUndefined();
    const tok = decodeSlot(slotLockingScript({ ...s, token: SCAM(1n) }));
    expect(tok?.token).toEqual(SCAM(1n));
    expect(tok?.until).toBe(T);
  });
  test('refuses timestamps and silly heights', () => {
    expect(() => slotLockingScript({ ...slotOf('a', 0, T), until: 600_000_000 })).toThrow();
    expect(() => slotLockingScript({ ...slotOf('a', 0, T), until: 0 })).toThrow();
  });
  test('a P2PKH is not a slot', () => {
    expect(decodeSlot(new P2PKH().lock(other))).toBeNull();
  });
});

describe('creation (§8.2 TX0)', () => {
  test('3 SCAM in → 2 slots + 1 token change + BSV change; nothing burned', async () => {
    const { tx, slotVouts } = await tokenSet();
    expect(slotVouts).toEqual([0, 1]);
    expect(tokenOf(tx.outputs[2].lockingScript)).toEqual(SCAM(1n));
    expect(tx.outputs[2].lockingScript.toHex().endsWith(new P2PKH().lock(payerAddr).toHex())).toBe(true);
    expect(checkTokenBalance(tx)).toEqual({ ok: true });
    expect(verifyTx(tx)).toEqual({ ok: true });
    expect(tx.getFee()).toBeLessThan(1000);
  });
  test('refuses slots that need more tokens than the inputs carry', async () => {
    const src = fund(payerRoot, 1, 1n);
    await expect(
      buildCreation({
        inputs: [spend(payerRoot, src, 1n), spend(payerRoot, fund(payerRoot, 5000))],
        slots: [slotOf('x', 0, T, 1n), slotOf('x', 1, T, 1n)],
        changeAddress: payerAddr,
      }),
    ).rejects.toThrow('slots need 2');
  });
  test('the balance check catches a burn', async () => {
    const { tx } = await tokenSet();
    tx.outputs.splice(2, 1);
    expect(checkTokenBalance(tx).ok).toBe(false);
  });
});

async function claim(scope: 0xc2 | 0xc3, signedOut: string, finalOut: string, lockTime = 0, finalLockTime = lockTime) {
  const { tx: c } = await tokenSet();
  const k = keysFor('proof', 0);
  const slot = { sourceTransaction: c, sourceOutputIndex: 0 };
  const out = (a: string) => [{ lockingScript: withTransfer(new P2PKH().lock(a), SCAM(1n)), satoshis: 1 }];
  const sigP = presignSlot(k.P, { slot, outputs: out(signedOut), lockTime }, scope);
  const fee = fund(feeKey, 2000);
  return finishClaim({
    slot,
    outputs: out(finalOut),
    lockTime: finalLockTime,
    sigP,
    S: k.Spriv,
    feeInputs: [spend(feeKey, fee)],
    changeAddress: feeKey.toAddress(),
  });
}

describe('claim (§8.2 TX1)', () => {
  test('NONE|ACP pre-sig survives an output change; claim is valid and pays the recipient', async () => {
    const tx = await claim(SIGHASH.NONE_ACP, other, recipient);
    expect(verifyTx(tx)).toEqual({ ok: true });
    expect(checkClaim(tx, recipient)).toEqual({ ok: true });
    expect(checkClaim(tx, other).ok).toBe(false);
  });
  test('SINGLE|ACP pins output 0: a different payee fails (TX1-neg)', async () => {
    const bad = await claim(SIGHASH.SINGLE_ACP, other, recipient);
    expect(verifyInput(bad, 0).ok).toBe(false);
    const good = await claim(SIGHASH.SINGLE_ACP, recipient, recipient);
    expect(verifyTx(good)).toEqual({ ok: true });
  });
  test('the pre-sig binds nLockTime (subscription periods cannot be shifted)', async () => {
    const ok = await claim(SIGHASH.SINGLE_ACP, recipient, recipient, H + 144);
    expect(verifyInput(ok, 0).ok).toBe(true);
    const moved = await claim(SIGHASH.SINGLE_ACP, recipient, recipient, H + 144, H + 10);
    expect(verifyInput(moved, 0).ok).toBe(false);
  });
  test('payer alone cannot claim (no service signature)', async () => {
    const { tx: c } = await tokenSet();
    const k = keysFor('proof', 0);
    const tx = claimSkeleton({
      slot: { sourceTransaction: c, sourceOutputIndex: 0 },
      outputs: [{ lockingScript: new P2PKH().lock(payerAddr), satoshis: 1 }],
    });
    const sigP = signInput(k.P, tx, 0, SIGHASH.ALL);
    const fake = signInput(k.P, tx, 0, SIGHASH.ALL);
    tx.inputs[0].unlockingScript = claimUnlock(sigP, fake);
    expect(verifyInput(tx, 0).ok).toBe(false);
  });
  test('service alone cannot claim without the payer pre-sig', async () => {
    const { tx: c } = await tokenSet();
    const k = keysFor('proof', 0);
    const tx = claimSkeleton({
      slot: { sourceTransaction: c, sourceOutputIndex: 0 },
      outputs: [{ lockingScript: new P2PKH().lock(other), satoshis: 1 }],
    });
    const sigS = signInput(k.Spriv, tx, 0, SIGHASH.ALL);
    tx.inputs[0].unlockingScript = claimUnlock(signInput(k.Spriv, tx, 0, SIGHASH.ALL), sigS);
    expect(verifyInput(tx, 0).ok).toBe(false);
  });
  test('pre-sigs can be verified before they are stored', async () => {
    const { tx: c } = await tokenSet();
    const k = keysFor('proof', 0);
    const args = { slot: { sourceTransaction: c, sourceOutputIndex: 0 }, outputs: [] };
    const sigP = presignSlot(k.P, args, SIGHASH.NONE_ACP);
    const skel = claimSkeleton(args);
    expect(verifyInputSig(k.Ppub, sigP, skel, 0)).toBe(true);
    expect(verifyInputSig(k.S as PublicKey, sigP, skel, 0)).toBe(false);
  });
  test('SINGLE without a matching output is refused', async () => {
    const { tx: c } = await tokenSet();
    const k = keysFor('proof', 0);
    expect(() =>
      presignSlot(k.P, { slot: { sourceTransaction: c, sourceOutputIndex: 0 }, outputs: [] }, SIGHASH.SINGLE_ACP),
    ).toThrow();
  });
  test('a token claim that drops the inscription is caught before broadcast', async () => {
    const { tx: c } = await tokenSet();
    const k = keysFor('proof', 0);
    const slot = { sourceTransaction: c, sourceOutputIndex: 0 };
    const sigP = presignSlot(k.P, { slot, outputs: [] }, SIGHASH.NONE_ACP);
    const tx = await finishClaim({
      slot,
      outputs: [{ lockingScript: new P2PKH().lock(recipient), satoshis: 1 }],
      sigP,
      S: k.Spriv,
      feeInputs: [spend(feeKey, fund(feeKey, 2000))],
      changeAddress: feeKey.toAddress(),
    });
    expect(verifyTx(tx).ok).toBe(true); // the script cannot see it…
    expect(checkClaim(tx, recipient).ok).toBe(false); // …so the service check must
  });
});

async function refund(opts: { until?: number; R?: PrivateKey; seq?: number } = {}) {
  const { tx: c } = await tokenSet();
  const k = keysFor('proof', 1);
  const tx = await buildRefund({
    slot: { sourceTransaction: c, sourceOutputIndex: 1 },
    R: opts.R ?? k.R,
    until: opts.until ?? H + 3,
    toAddress: payerAddr,
    token: SCAM(1n),
    feeInputs: [spend(payerRoot, fund(payerRoot, 3000))],
  });
  if (opts.seq !== undefined) {
    tx.inputs[0].sequence = opts.seq;
    tx.inputs[0].unlockingScript = undefined;
    await tx.sign();
  }
  return tx;
}

describe('refund (§8.2 TX2/TX3)', () => {
  test('payer alone refunds at T, seed keys only, token comes back', async () => {
    const tx = await refund();
    expect(tx.lockTime).toBe(H + 3);
    expect(tx.inputs[0].sequence).toBe(NON_FINAL);
    expect(verifyTx(tx)).toEqual({ ok: true });
    expect(checkTokenBalance(tx)).toEqual({ ok: true });
    expect(tokenOf(tx.outputs[0].lockingScript)).toEqual(SCAM(1n));
  });
  test('TX2b: nLockTime T−1 fails the covenant', async () => {
    expect(verifyInput(await refund({ until: H + 2 }), 0).ok).toBe(false);
  });
  test('a final sequence cannot dodge nLockTime', async () => {
    expect(verifyInput(await refund({ seq: 0xffffffff }), 0).ok).toBe(false);
  });
  test('a wrong refund key fails, even after T', async () => {
    expect(verifyInput(await refund({ R: PrivateKey.fromRandom(), until: H + 100 }), 0).ok).toBe(false);
  });
  test('the claim key P cannot use the refund branch', async () => {
    expect(verifyInput(await refund({ R: keysFor('proof', 1).P, until: H + 100 }), 0).ok).toBe(false);
  });
  test('a plain-sats slot refunds without a fee input', async () => {
    const s = slotOf('sats', 0, T, undefined, 20_000);
    const { tx: c } = await buildCreation({
      inputs: [spend(payerRoot, fund(payerRoot, 30_000))],
      slots: [s],
      changeAddress: payerAddr,
    });
    const r = await buildRefund({
      slot: { sourceTransaction: c, sourceOutputIndex: 0 },
      R: keysFor('sats', 0).R,
      until: T,
      toAddress: payerAddr,
    });
    expect(verifyTx(r)).toEqual({ ok: true });
    expect(r.outputs[0].satoshis).toBeGreaterThan(19_000);
  });
});

describe('limits (§4.4)', () => {
  const base = {
    scope: SIGHASH.NONE_ACP,
    slots: 10,
    usdValue: 1,
    usdOpenElsewhere: 0,
    createdHeight: H,
    until: H + LIMITS.defaultDeadlineBlocks,
    reserveSats: 1000,
  };
  test('defaults pass', () => expect(checkLimits(base)).toEqual({ ok: true }));
  test('caps', () => {
    expect(checkLimits({ ...base, slots: 51 }).ok).toBe(false);
    expect(checkLimits({ ...base, until: H + 30 * 144 + 1 }).ok).toBe(false);
    expect(checkLimits({ ...base, usdValue: 15, usdOpenElsewhere: 6 }).ok).toBe(false);
    expect(checkLimits({ ...base, reserveSats: 999 }).ok).toBe(false);
    expect(checkLimits({ ...base, until: H + 6 }).ok).toBe(false);
  });
  test('SINGLE sets are not held to the NONE caps', () => {
    expect(checkLimits({ ...base, scope: SIGHASH.SINGLE_ACP, slots: 200, until: H + 365 * 144 }).ok).toBe(true);
  });
});

function storedSet(over: Partial<StoredSet> = {}): StoredSet {
  return {
    id: 's1',
    kind: 'named-invite',
    scope: 0xc2,
    servicePubHex: serviceId.toString(),
    createdHeight: H,
    until: T,
    autoReturn: true,
    scriptVersion: 1,
    slots: [
      { index: 0, satoshis: 1, lockingScriptHex: '', outpoint: 'aa.0', state: 'open' },
      { index: 1, satoshis: 1, lockingScriptHex: '', outpoint: 'aa.1', state: 'claimed' },
      { index: 2, satoshis: 1, lockingScriptHex: '', state: 'open' },
    ],
    ...over,
  };
}

describe('store', () => {
  test('persists and enforces transitions', async () => {
    const st = new PresignStore(memoryKV());
    await st.put(storedSet());
    await st.update('s1', 0, 'claiming');
    await expect(st.update('s1', 1, 'open')).rejects.toThrow('cannot go');
    await st.update('s1', 0, 'claimed', { claimTxid: 'bb' });
    expect((await st.get('s1'))?.slots[0]).toMatchObject({ state: 'claimed', claimTxid: 'bb' });
    expect((await st.openSlots()).map((x) => x.slot.index)).toEqual([2]);
  });
  test('survives corrupt storage', async () => {
    const kv = memoryKV();
    await kv.set('presign:sets:v1', '{nope');
    expect(await new PresignStore(kv).all()).toEqual([]);
  });
});

describe('refund broadcaster', () => {
  const fakeTx = (hex: string) => ({ toHex: () => hex, id: () => `id-${hex}` }) as unknown as Transaction;

  test('waits before T, builds once, retries the same tx, then marks refunded', async () => {
    const st = new PresignStore(memoryKV());
    await st.put(storedSet());
    let builds = 0;
    const sent: string[] = [];
    const buildRefund = async () => fakeTx(`raw${++builds}`);
    const early = await runDueRefunds({
      store: st,
      tipHeight: T - 1,
      buildRefund,
      broadcast: async () => ({ ok: true }),
    });
    expect(early.waiting).toEqual(['s1:0']);
    expect(builds).toBe(0);
    const flaky = await runDueRefunds({
      store: st,
      tipHeight: T,
      buildRefund,
      broadcast: async (h) => (sent.push(h), { ok: false, message: 'ECONNRESET' }),
    });
    expect(flaky.failed).toHaveLength(1);
    expect((await st.get('s1'))?.slots[0].state).toBe('refunding');
    const done = await runDueRefunds({
      store: st,
      tipHeight: T + 1,
      buildRefund,
      broadcast: async (h) => (sent.push(h), { ok: true, txid: 'tx' }),
    });
    expect(done.refunded).toEqual(['s1:0']);
    expect(builds).toBe(1);
    expect(sent).toEqual(['raw1', 'raw1']);
    expect((await st.get('s1'))?.slots[0]).toMatchObject({ state: 'refunded', refundTxid: 'tx' });
  });
  test('a slot claimed first is marked spent, not retried forever', async () => {
    const st = new PresignStore(memoryKV());
    await st.put(storedSet());
    const r = await runDueRefunds({
      store: st,
      tipHeight: T,
      buildRefund: async () => fakeTx('r'),
      broadcast: async () => ({ ok: false, message: 'Missing inputs' }),
    });
    expect(r.spent).toEqual(['s1:0']);
  });
  test('auto-return off: only the manual button refunds', async () => {
    const st = new PresignStore(memoryKV());
    await st.put(storedSet({ autoReturn: false }));
    const args = {
      store: st,
      tipHeight: T,
      buildRefund: async () => fakeTx('r'),
      broadcast: async () => ({ ok: true }),
    };
    expect((await runDueRefunds(args)).refunded).toEqual([]);
    expect(await nextRefundHeight(st)).toBeNull();
    expect((await runDueRefunds({ ...args, manual: true })).refunded).toEqual(['s1:0']);
  });
  test('classifies endpoint errors', () => {
    expect(classifyBroadcastError('txn-already-known')).toBe('known');
    expect(classifyBroadcastError('258: txn-mempool-conflict')).toBe('spent');
    expect(classifyBroadcastError('64: non-final')).toBe('non-final');
    expect(classifyBroadcastError('timeout')).toBe('retry');
  });
});
