import { Beef } from '@bsv/sdk';

/**
 * The 1Sat APIs and our Market use `txid_vout` outpoints, but buyBsv21 and
 * buyOrdinal pass the outpoint straight into createAction's `inputs`, and the
 * wallet (wallet-toolbox) only parses `txid.vout`. With an underscore the
 * whole string is taken as the txid, so the listing's BEEF (which is fine)
 * never matches and createAction fails with "inputBEEF ... possibly known
 * <txid>_0, beef BEEF with 0 BUMPS and 0 Transactions".
 */
export const walletOutpoint = (outpoint: string): string => {
  const m = /^([0-9a-fA-F]{64})[._](\d+)$/.exec(outpoint.trim());
  return m ? `${m[1].toLowerCase()}.${m[2]}` : outpoint;
};

/**
 * Pass to buyBsv21 / buyOrdinal. apiContext's wallet is the background wallet
 * wrapped by the 1Sat permission module, which finishes every createAction
 * itself and only unlocks inputs named in `p <scheme> input …` labels.
 * Without this flag the actions run their local pipeline, add no input label
 * for the listing, the module signs without the OrdLock purchase unlock, and
 * the wallet rejects the tx ("inputs[0].unlockScript … OP_PICK …"). With it,
 * the actions add the listing's input label and leave finishing to the module.
 */
export const MODULE_FINISHES = { usePermissionModule: true } as const;

/**
 * The actions declare a fixed unlockingScriptLength for the listing input
 * (1402 BSV-21, 1368 ordinals), but the OrdLock purchase unlock carries every
 * output after the first two, including the wallet's change outputs, so the
 * real script can be far longer and the wallet rejects it ("unlockingScript
 * length 3388 exceeds expected length 1402"). Declaring more is safe (it only
 * funds a slightly larger fee), so compute an upper bound:
 * push(ser(out0)) + push(ser(out2..) + change) + push(preimage) + OP_0.
 */
const MAX_CHANGE_OUTPUTS = 8; // wallet-toolbox DEFAULT_MANAGED_CHANGE_MAX_OUTPUTS_PER_ACTION
const P2PKH_OUTPUT_BYTES = 34;
const SLACK = 64;

const varIntSize = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : n <= 0xffffffff ? 5 : 9);
const pushSize = (n: number) => n + (n < 0x4c ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5);
const serOutput = (scriptHexLen: number) => 8 + varIntSize(scriptHexLen / 2) + scriptHexLen / 2;

type CreateArgs = {
  inputBEEF?: number[] | Uint8Array;
  inputs?: Array<{ outpoint: string; unlockingScriptLength?: number }>;
  outputs?: Array<{ lockingScript: string }>;
};

/** Upper bound for the purchase unlock of `outpoint` given these args, or undefined if unknown. */
export const purchaseUnlockBound = (args: CreateArgs, outpoint: string): number | undefined => {
  const [txid, vout] = outpoint.split('.');
  const outs = args.outputs ?? [];
  if (!args.inputBEEF || outs.length < 2) return undefined;
  let lockLen: number;
  try {
    const out = Beef.fromBinary(Array.from(args.inputBEEF)).findTxid(txid)?.tx?.outputs[Number(vout)];
    if (!out) return undefined;
    lockLen = out.lockingScript.toBinary().length;
  } catch {
    return undefined;
  }
  const first = serOutput(outs[0].lockingScript.length);
  const rest =
    outs.slice(2).reduce((n, o) => n + serOutput(o.lockingScript.length), 0) + MAX_CHANGE_OUTPUTS * P2PKH_OUTPUT_BYTES;
  const preimage = 4 + 32 + 32 + 36 + varIntSize(lockLen) + lockLen + 8 + 4 + 32 + 4 + 4;
  return pushSize(first) + pushSize(rest) + pushSize(preimage) + 1 + SLACK;
};

/** Raise the declared unlockingScriptLength for `outpoint` (txid.vout) to the computed bound when larger. */
export const withUnlockRoom = <A extends CreateArgs>(args: A, outpoint: string): A => {
  const bound = purchaseUnlockBound(args, outpoint);
  if (bound === undefined) return args;
  return {
    ...args,
    inputs: args.inputs?.map((i) =>
      i.outpoint === outpoint && (i.unlockingScriptLength ?? 0) < bound ? { ...i, unlockingScriptLength: bound } : i,
    ),
  };
};

type WalletLike = { createAction: (args: never, originator?: string) => Promise<unknown> };

/** A context whose wallet applies withUnlockRoom to every createAction. */
export const purchaseContext = <C extends { wallet: W }, W extends WalletLike>(ctx: C, outpoint: string): C => {
  const wallet = new Proxy(ctx.wallet, {
    get(target, prop, receiver) {
      if (prop === 'createAction')
        return (args: CreateArgs, originator?: string) =>
          target.createAction(withUnlockRoom(args, outpoint) as never, originator);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { wallet });
};
