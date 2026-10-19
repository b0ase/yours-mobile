/**
 * Test wallets for phone to phone (directPay.test.ts, directPay.loopback.test.ts). Real keys, signatures and
 * encryption (ProtoWallet); createAction builds a real AtomicBEEF offline (a coinbase-style parent proven by a
 * single-leaf MerklePath), and internalizeAction / abortAction only record their calls. Never used by the app.
 */
import {
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Transaction,
  UnlockingScript,
  LockingScript,
  type CreateActionArgs,
  type InternalizeActionArgs,
} from '@bsv/sdk';

export function makeTestWallet() {
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const calls = {
    internalize: [] as InternalizeActionArgs[],
    created: [] as CreateActionArgs[],
    aborted: [] as string[],
    broadcast: [] as string[],
  };
  const wallet = Object.assign(proto, {
    internalizeAction: async (args: InternalizeActionArgs) => {
      calls.internalize.push(args);
      return { accepted: true as const };
    },
    createAction: async (args: CreateActionArgs) => {
      calls.created.push(args);
      if (args.options?.sendWith) {
        calls.broadcast.push(...args.options.sendWith);
        return {};
      }
      const out = args.outputs?.[0];
      if (!out) throw new Error('no outputs');
      const funding = PrivateKey.fromRandom().toPublicKey();
      const parent = new Transaction();
      parent.addInput({
        sourceTXID: '00'.repeat(32),
        sourceOutputIndex: 0xffffffff,
        unlockingScript: new UnlockingScript(),
      });
      parent.addOutput({ lockingScript: new P2PKH().lock(funding.toHash()), satoshis: out.satoshis + 1000 });
      parent.merklePath = MerklePath.fromCoinbaseTxidAndHeight(parent.id('hex'), 1);
      const child = new Transaction();
      child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() });
      child.addOutput({ lockingScript: LockingScript.fromHex(out.lockingScript), satoshis: out.satoshis });
      return { tx: child.toAtomicBEEF(), txid: child.id('hex') };
    },
    abortAction: async (args: { reference: string }) => {
      calls.aborted.push(args.reference);
      return { aborted: true as const };
    },
  });
  return { wallet, calls };
}

export const memoryKV = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
