/**
 * What one wallet action really did to the balance, for History.
 *
 * P0 report (owner, 11 Nov 2026, iPhone): he sent 1¢ to his own paymail (boase@bwalletx.com, the same identity key as
 * the sending wallet). The balance was right: it dropped by 1¢ + fee on send, and rose by 1¢ when the paymail inbox
 * collect took the payment in, so it ended down by the fee only (src/incident/selfSendPaymail.test.ts). History was
 * wrong, two ways:
 *  - The device that sent it collects it: internalizeAction finds the txid already stored and MERGES (the payment output
 *    moves into 'default' as wallet change), but the toolbox never updates the action's `satoshis`, so it still says
 *    −(1¢ + fee): "sent 1¢" to an address that is the wallet's own.
 *  - Another device on the same key (the extension, a second phone) collects it first, before it has the send: it
 *    records a NEW incoming action, +1¢, and device sync (the toolbox's mergeOrdinaryTransactionProperties) can carry
 *    that record to every copy: "received 1¢" (src/incident/selfSendTwoDevices.test.ts).
 *
 * Which actions: the paymail inbox collect labels every action it touches 'paymail' (mobile/names/paymail.ts, merged or
 * new), and only a payment this wallet funded spends this wallet's own coins (listActions `inputs` lists exactly the
 * wallet's outputs the transaction spent). A 'paymail' action with inputs is therefore a payment to self, identified by
 * the inbox's own record of that output and by the coins it spent, not by any output's description.
 *
 * Its real effect, straight from storage: what this wallet holds from the transaction (its outputs in 'default') minus
 * the coins it spent (the inputs' sourceSatoshis). On the device that sent and collected it that is −fee. On a device
 * that has not yet taken in part of it (change still waiting for admission) it is what that device's balance did.
 * Guard: a payment this wallet funded can't leave it richer, so a positive figure falls back to the reported one.
 * Everything else is reported as listActions gives it.
 */

type ActionOutput = { satoshis?: number; basket?: string };
type ActionInput = { sourceSatoshis?: number };
export type ActionLike = {
  satoshis?: number;
  labels?: string[];
  outputs?: ActionOutput[];
  inputs?: ActionInput[];
};

/** The label collectPaymailInbox / restorePaymailHistory put on every action they take a payment into. */
export const PAYMAIL_LABEL = 'paymail';

/** listActions arguments for the actions that can be a payment to self (a small, labelled set). */
export const SELF_PAY_QUERY = {
  labels: [PAYMAIL_LABEL],
  includeLabels: true,
  includeInputs: true,
  includeOutputs: true,
};

const isSats = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** A paymail payment this wallet paid to itself: taken in by the inbox collect, and it spends this wallet's coins. */
export const isSelfPay = (a: ActionLike): boolean =>
  !!a.labels?.includes(PAYMAIL_LABEL) &&
  !!a.inputs?.length &&
  a.inputs.every((i) => isSats(i.sourceSatoshis)) &&
  Array.isArray(a.outputs);

/** The action's net effect on the balance (listActions `satoshis`, corrected for a payment to self). */
export const actionNetSats = (a: ActionLike): number | undefined => {
  if (typeof a.satoshis !== 'number') return undefined;
  if (!isSelfPay(a)) return a.satoshis;
  const held = (a.outputs ?? []).reduce(
    (s, o) => s + (o.basket === 'default' && isSats(o.satoshis) ? o.satoshis : 0),
    0,
  );
  const spent = (a.inputs ?? []).reduce((s, i) => s + (i.sourceSatoshis as number), 0);
  const net = held - spent;
  return net <= 0 ? net : a.satoshis;
};
