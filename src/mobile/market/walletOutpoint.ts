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
 * Room for the OrdLock purchase unlock. The actions declare a fixed
 * unlockingScriptLength (1402 for BSV-21), but the purchase unlock carries
 * every output after the first two — including the wallet's change outputs,
 * which can be many — so the real script can be far longer and the wallet
 * rejects it ("unlockingScript length 3388 exceeds expected length 1402").
 */
export const PURCHASE_UNLOCK_ROOM = 20_000;

type CreateArgs = { inputs?: Array<{ outpoint: string; unlockingScriptLength?: number }> };
type WalletLike = { createAction: (args: never, originator?: string) => Promise<unknown> };

/** Raise the declared unlockingScriptLength for `outpoint` (txid.vout) to PURCHASE_UNLOCK_ROOM. */
export const withUnlockRoom = <A extends CreateArgs>(args: A, outpoint: string): A => ({
  ...args,
  inputs: args.inputs?.map((i) =>
    i.outpoint === outpoint && (i.unlockingScriptLength ?? 0) < PURCHASE_UNLOCK_ROOM
      ? { ...i, unlockingScriptLength: PURCHASE_UNLOCK_ROOM }
      : i,
  ),
});

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
