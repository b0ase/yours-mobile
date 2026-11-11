/**
 * What one wallet action really did to the balance, for History.
 *
 * P0 report (owner, 11 Nov 2026, iPhone): he sent 1¢ to his own paymail (boase@bwalletx.com, the same identity key as
 * the sending wallet). The balance was right: it dropped by 1¢ + fee on send, and rose by 1¢ when the paymail inbox
 * collect took the payment in, so it ended down by the fee only (src/incident/selfSendPaymail.test.ts). What was wrong
 * was History. The inbox collect's internalizeAction finds the txid already stored (the send) and MERGES: the payment
 * output moves into the 'default' basket as wallet change, but the toolbox never updates the action's `satoshis`
 * (internalizeAction's merge path skips findOrInsertTargetTransaction). So listActions keeps reporting −(1¢ + fee),
 * History shows "sent 1¢" to an address that is the wallet's own, and History's total no longer matches the balance.
 *
 * The fix here: for an outgoing action, add back the value of its caller-made outputs that now sit in 'default'. A
 * caller-made output always has an outputDescription (createAction requires 5 to 50 bytes); wallet-managed change never
 * has one (the toolbox's canonical change metadata is outputDescription ""). An output of a payment you sent to someone
 * else is in no basket. So a described output in 'default' is a payment the wallet sent to itself and took back.
 * Only 'default': outputs a site puts in other baskets (e.g. 1sat-deposit funding for a purchase) are left as they were.
 *
 * Guard: an action this wallet funded can't leave the balance higher than before, so if adding back would make the net
 * positive (e.g. a toolbox that one day does update `satoshis` on a merge) the reported figure is used unchanged.
 */

type ActionOutput = { satoshis?: number; basket?: string; outputDescription?: string };
export type ActionLike = { satoshis?: number; isOutgoing?: boolean; outputs?: ActionOutput[] };

/** Satoshis of an outgoing action's own (described) outputs that came back into the wallet's 'default' basket. */
export const returnedToSelfSats = (a: ActionLike): number => {
  if (!a.isOutgoing) return 0;
  let back = 0;
  for (const o of a.outputs ?? [])
    if (o.basket === 'default' && (o.outputDescription ?? '').trim() !== '' && Number.isSafeInteger(o.satoshis))
      back += o.satoshis as number;
  return back;
};

/** The action's net effect on the balance (listActions `satoshis`, corrected for a payment to self). */
export const actionNetSats = (a: ActionLike): number | undefined => {
  if (typeof a.satoshis !== 'number') return undefined;
  if (!a.isOutgoing || a.satoshis >= 0) return a.satoshis;
  const back = returnedToSelfSats(a);
  if (back <= 0) return a.satoshis;
  const net = a.satoshis + back;
  return net <= 0 ? net : a.satoshis;
};
