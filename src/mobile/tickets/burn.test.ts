import { describe, expect, test } from 'bun:test';
import { BSV21 } from '@1sat/templates';
import { LockingScript, P2PKH, PrivateKey, Script, Spend, Transaction, UnlockingScript } from '@bsv/sdk';
import { buildTicketBurnOutputs, burnedRawInScripts } from './burn';

const TOKEN = `${'ab'.repeat(32)}_0`;
const key = PrivateKey.fromRandom();
const myLock = new P2PKH().lock(key.toAddress());

/** A fake parent tx holding `amt` tickets at vout 0, locked to `key`. */
function parentWithTickets(amt: bigint): Transaction {
  const parent = new Transaction();
  parent.addOutput({
    lockingScript: BSV21.transfer(TOKEN, amt).lock(myLock),
    satoshis: 1,
  });
  parent.addOutput({ lockingScript: myLock, satoshis: 10_000 });
  return parent;
}

/** Can an empty unlocking script spend this locking script? */
function spendableWithEmptyUnlock(lock: LockingScript): boolean {
  const spend = new Spend({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    sourceSatoshis: 1,
    lockingScript: lock,
    transactionVersion: 1,
    otherInputs: [],
    outputs: [],
    inputIndex: 0,
    unlockingScript: new UnlockingScript([]),
    inputSequence: 0xffffffff,
    lockTime: 0,
  });
  try {
    return spend.validate();
  } catch {
    return false;
  }
}

describe('buildTicketBurnOutputs (method A: op burn)', () => {
  test('burn output decodes as a BSV-21 burn with no owner suffix', () => {
    const outs = buildTicketBurnOutputs({
      tokenId: TOKEN,
      burnRaw: 1n,
      inputRaw: 3n,
      changeLockingScript: myLock,
    });
    expect(outs.map((o) => o.role)).toEqual(['burn', 'change']);
    const burn = BSV21.decode(Script.fromHex(outs[0].lockingScript))!;
    expect(burn.isBurn()).toBe(true);
    expect(burn.getTokenId()).toBe(TOKEN);
    expect(burn.getAmount()).toBe(1n);
    const json = JSON.parse(Buffer.from(burn.getInscription().file.content).toString());
    expect(json).toEqual({ p: 'bsv-20', op: 'burn', id: TOKEN, amt: '1' });
    const change = BSV21.decode(Script.fromHex(outs[1].lockingScript))!;
    expect(change.isTransfer()).toBe(true);
    expect(change.getAmount()).toBe(2n);
  });

  test('burn output is unspendable (interpreter)', () => {
    const [burn] = buildTicketBurnOutputs({
      tokenId: TOKEN,
      burnRaw: 1n,
      inputRaw: 1n,
    });
    expect(spendableWithEmptyUnlock(LockingScript.fromHex(burn.lockingScript))).toBe(false);
  });

  test('adds overlay fee per token output and a MAP entry tag', () => {
    const outs = buildTicketBurnOutputs({
      tokenId: TOKEN,
      burnRaw: 1n,
      inputRaw: 2n,
      changeLockingScript: myLock,
      overlayFee: { address: key.toAddress(), perOutput: 1000 },
      entry: { channel: `bsv21:${TOKEN}`, handle: 'alice' },
    });
    expect(outs.map((o) => o.role)).toEqual(['burn', 'change', 'overlay-fee', 'entry-map']);
    expect(outs[2].satoshis).toBe(2000);
    const map = Script.fromHex(outs[3].lockingScript);
    expect(map.toHex()).toStartWith('006a'); // OP_FALSE OP_RETURN
    expect(Buffer.from(map.toBinary()).toString('latin1')).toContain('room-entry');
  });

  test('rejects bad amounts', () => {
    expect(() => buildTicketBurnOutputs({ tokenId: TOKEN, burnRaw: 0n, inputRaw: 1n })).toThrow();
    expect(() => buildTicketBurnOutputs({ tokenId: TOKEN, burnRaw: 2n, inputRaw: 1n })).toThrow('insufficient');
    expect(() => buildTicketBurnOutputs({ tokenId: TOKEN, burnRaw: 1n, inputRaw: 2n })).toThrow('changeLockingScript');
  });
});

describe('method B: transfer to OP_FALSE OP_RETURN', () => {
  test('decodes as transfer and counts as burned only for method B', () => {
    const [out] = buildTicketBurnOutputs({
      tokenId: TOKEN,
      burnRaw: 5n,
      inputRaw: 5n,
      method: 'unspendable-transfer',
    });
    const s = Script.fromHex(out.lockingScript);
    expect(BSV21.decode(s)!.isTransfer()).toBe(true);
    expect(spendableWithEmptyUnlock(LockingScript.fromHex(out.lockingScript))).toBe(false);
    expect(burnedRawInScripts(TOKEN, [s], 'unspendable-transfer')).toBe(5n);
    expect(burnedRawInScripts(TOKEN, [s], 'op-burn')).toBe(0n);
  });
});

describe('full signed tx (never broadcast)', () => {
  test('spends ticket UTXO, burns 1, returns change; round-trips through hex', async () => {
    const parent = parentWithTickets(3n);
    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: parent,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    });
    tx.addInput({
      sourceTransaction: parent,
      sourceOutputIndex: 1,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    });
    for (const o of buildTicketBurnOutputs({
      tokenId: TOKEN,
      burnRaw: 1n,
      inputRaw: 3n,
      changeLockingScript: myLock,
      entry: { channel: `bsv21:${TOKEN}`, handle: 'alice' },
    })) {
      tx.addOutput({
        lockingScript: LockingScript.fromHex(o.lockingScript),
        satoshis: o.satoshis,
      });
    }
    tx.addOutput({ lockingScript: myLock, change: true });
    await tx.fee();
    await tx.sign();

    const parsed = Transaction.fromHex(tx.toHex());
    const scripts = parsed.outputs.map((o) => o.lockingScript);
    expect(burnedRawInScripts(TOKEN, scripts)).toBe(1n);
    // Conservation: in 3 = burn 1 + change 2.
    const change = scripts
      .map((s) => BSV21.decode(s))
      .filter((t) => t?.isTransfer())
      .reduce((a, t) => a + t!.getAmount(), 0n);
    expect(change).toBe(2n);
    // Input owner = signer's address (what bit-sign checks against the handle).
    const unlock = parsed.inputs[0].unlockingScript!.chunks;
    const pub = unlock[1].data!;
    expect(Buffer.from(pub).toString('hex')).toBe(key.toPublicKey().toString());
  });
});
