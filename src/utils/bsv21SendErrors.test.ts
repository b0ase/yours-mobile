import { describe, expect, test } from 'bun:test';
import { LockingScript, P2PKH, PrivateKey, Script, Spend, Utils } from '@bsv/sdk';
import { OVERLAY_ISSUES, bsv21ErrorMessage, isEmptyUnlockError } from './bsv21SendErrors';

describe('BSV-21 send error messages', () => {
  test('a token details lookup failure is "could not reach", never "unknown token"', () => {
    expect(OVERLAY_ISSUES['token-not-found']).toBe('unreachable');
    expect(bsv21ErrorMessage('token-not-found', 'TERANODE')).toBe(
      "Couldn't reach the token indexer. Nothing was sent. Try again.",
    );
  });

  test('overlay-validation-failed has its own message', () => {
    expect(bsv21ErrorMessage('overlay-validation-failed', 'TERANODE')).toContain(
      "Couldn't check your TERANODE with the token indexer",
    );
  });

  test('the other overlay issues keep their prompts; unknown errors fall through', () => {
    expect(OVERLAY_ISSUES['token-not-active']).toBe('not-active');
    expect(OVERLAY_ISSUES['tokens-queued']).toBe('queued');
    expect(OVERLAY_ISSUES['insufficient-valid-tokens']).toBe('not-valid');
    expect(bsv21ErrorMessage('funding-amount-changed', 'X')).toContain('changed its price');
    expect(bsv21ErrorMessage('something-else', 'X')).toBeUndefined();
  });
});

describe('F-3: empty unlock on a BSV-21 output', () => {
  // A BSV-21 transfer output: inscription envelope (8 chunks) then P2PKH, so OP_DUP sits at PC 8.
  const bsv21Lock = () => {
    const json = Utils.toHex(
      Utils.toArray(JSON.stringify({ p: 'bsv-20', op: 'transfer', id: 'a'.repeat(64) + '_0', amt: '1' }), 'utf8'),
    );
    const ct = Utils.toHex(Utils.toArray('application/bsv-20', 'utf8'));
    const env = Script.fromASM(`OP_0 OP_IF 6f7264 OP_1 ${ct} OP_0 ${json} OP_ENDIF`);
    const p2pkh = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
    return new LockingScript([...env.chunks, ...p2pkh.chunks]);
  };

  test('an empty unlocking script fails at PC 8 with the reported error, and is recognised', () => {
    const spend = new Spend({
      sourceTXID: 'b'.repeat(64),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript: bsv21Lock(),
      transactionVersion: 1,
      otherInputs: [],
      outputs: [],
      inputIndex: 0,
      unlockingScript: new Script(),
      inputSequence: 0xffffffff,
      lockTime: 0,
    });
    let message = '';
    try {
      spend.validate();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain('OP_DUP requires at least one item to be on the stack');
    expect(message).toContain('PC: 8');
    expect(
      isEmptyUnlockError(`The inputs[0].unlockScript parameter must be valid. Script evaluation error: ${message}`),
    ).toBe(true);
  });

  test('other errors are not mistaken for an empty unlock', () => {
    expect(isEmptyUnlockError('insufficient-valid-tokens')).toBe(false);
    expect(isEmptyUnlockError(new Error('The inputs[0].unlockScript parameter must be valid. OP_PICK'))).toBe(false);
    expect(isEmptyUnlockError(undefined)).toBe(false);
  });
});
