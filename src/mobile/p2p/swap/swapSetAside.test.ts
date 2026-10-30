import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Beef, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { tokenReceiveScript, type SwapTerms } from './swap';

// The send itself is stubbed: these tests are about what offerSwap asks for and how it finds the result.
type SendInput = { tokenId: string; recipients: { amount: string; destination: Record<string, unknown> }[] };
const sends: SendInput[] = [];
let sendTx: (input: SendInput) => { txid: string; tx: number[] };
mock.module('../../../services/tokenSpendGuard', () => ({
  guardedSendBsv21: { execute: async (_ctx: unknown, input: SendInput) => (sends.push(input), sendTx(input)) },
}));
mock.module('../../config/killSwitch', () => ({ assertNotPaused: async () => undefined }));

const { offerSwap, setAsideDestination, setAsideTiming, _resetSetAsides, SWAP_TIMED_OUT } =
  await import('./swapActions');

const TOKEN = `${'cd'.repeat(32)}_0`;
const key = PrivateKey.fromRandom();
const pub = key.toPublicKey().toString();
const terms = (ref = 'c1'): SwapTerms => ({
  ref,
  docHash: 'ab'.repeat(32),
  tokenId: TOKEN,
  amount: '100',
  priceSats: 1000,
});

/** A wallet whose token basket never shows the set-aside output (the owner's case: listOutputs finds nothing). */
const ctxFor = () =>
  ({
    wallet: {
      getPublicKey: async () => ({ publicKey: pub }),
      listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
      createSignature: async (a: { hashToDirectlySign?: number[]; data?: number[] }) => ({
        signature: key.sign(a.hashToDirectlySign ?? a.data ?? [1]).toDER() as number[],
      }),
      relinquishOutput: async () => ({ relinquished: true }),
    },
    services: {
      bsv21: {
        getTokenDetails: async () => ({ status: { is_active: true, fee_per_output: 0 }, token: { sym: 'T', dec: 0 } }),
        getOutputStatus: async () => [],
      },
    },
  }) as unknown as OneSatContext;

beforeEach(() => {
  sends.length = 0;
  _resetSetAsides();
  setAsideTiming.pollMs = 1;
  sendTx = (input) => {
    const lock = String(input.recipients[0].destination.lockingScript);
    const tx = new Transaction();
    // Change first, set-aside second: the finder must not assume an output index.
    tx.addOutput({ lockingScript: tokenReceiveScript(TOKEN, 900n, key.toAddress()), satoshis: 1 });
    tx.addOutput({ lockingScript: tokenReceiveScript(TOKEN, 100n, key.toAddress()), satoshis: 1 });
    expect(tx.outputs[1].lockingScript.toHex().includes(lock)).toBe(true);
    const beef = new Beef();
    beef.mergeTransaction(tx);
    return { txid: tx.id('hex'), tx: beef.toBinaryAtomic(tx.id('hex')) };
  };
});

const run = (ref = 'c1', ask: () => Promise<boolean | 'expired'> = async () => true) =>
  offerSwap(ctxFor(), { terms: terms(ref), quote: { rate: 50, source: 'test' }, ask });

describe('swap offer set-aside (owner 30 Oct 2026: "set-aside tokens are not in the wallet yet", every retry)', () => {
  test('the self-send names counterparty self, so sendBsv21 files it in the token basket with its key', async () => {
    const d = await setAsideDestination(ctxFor(), TOKEN, 'c1');
    expect(d.customInstructions.counterparty).toBe('self');
    expect(d.keyID).toBe(`${TOKEN}-setaside-c1`);
    expect(Utils.toArray(d.lockingScript, 'hex').length).toBe(25);
  });

  test('the offer is built from the send result, even when the wallet listing never shows the output', async () => {
    const offer = await run();
    expect(sends.length).toBe(1);
    expect(sends[0].recipients[0].destination.customInstructions).toMatchObject({ counterparty: 'self' });
    expect(Transaction.fromHex(offer.partialTx).inputs[0].sourceOutputIndex).toBe(1);
  });

  test('a retry of the same contract reuses the set-aside output: never a second send to self', async () => {
    await run().catch(() => undefined);
    await run().catch(() => undefined);
    expect(sends.length).toBe(1);
  });

  test('an unanswered sheet says timed out, not declined, and sends nothing', async () => {
    await expect(run('c2', async () => 'expired')).rejects.toThrow(SWAP_TIMED_OUT);
    await expect(run('c3', async () => false)).rejects.toThrow('you declined');
    expect(sends.length).toBe(0);
  });
});
