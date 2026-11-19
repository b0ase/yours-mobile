/**
 * Queued sends that never reach the network: give up on them and give the money back.
 *
 * vexvoid.com, 12 Oct 2026: a big video mint (36582df1…) was signed, the broadcaster gave no verdict, and the
 * toolbox queued it ('sending'). The Monitor's SendWaiting task retries such a send every few minutes, forever,
 * and its inputs stay locked. That one did land (mined in block 970724), but a send that never will would keep
 * the user's money locked with no way out: abortAction refuses a 'sending' action.
 *
 * Here, after GIVE_UP_MS, a queued send the network has no copy of is cancelled: its proven-tx request is marked
 * 'invalid' (SendWaiting stops), and the action is marked failed, which releases its inputs. A send the network
 * already has, or whose status can't be read cleanly, is never touched (knownOnChain fails closed). A permanent
 * rejection is already failed by the toolbox itself (OneSatServices REJECTED -> invalidTx), inputs released.
 *
 * A copy of another device's payment (change write-ahead, services/changeWriteAhead.ts: transaction 'sending', proof
 * request 'nosend'): this device never sends it and the toolbox counts no attempts on a 'nosend' request (its proof
 * task, CheckNoSends, never does), so the attempts rule could never pass and a payment whose broadcast never landed
 * (its device lost before its next push) stayed 'sending' on a restored copy for ever: inputs locked, change counted
 * (re-review of 18c93dd9). Such a copy is judged by age alone, NOSEND_COPY_GIVE_UP_MS (7 days); the network check is
 * the same, so one the network has, or may have, is never released.
 *
 * The repeat guard (repeatGuard.ts) is unchanged: its window (1 h) ends long before GIVE_UP_MS, so a cancel here
 * can't let a site build an identical second payment while the first is still going out.
 */
import { OP, Transaction, Utils } from '@bsv/sdk';

/** How long a queued send may stay unconfirmed before the wallet gives up on it. */
export const GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** Never give up on a send the wallet has tried fewer times than this (a wallet that was closed for a day). */
export const MIN_ATTEMPTS = 6;
/**
 * How old another device's payment, held here as a 'nosend' copy, must be before this device gives up on it (when
 * the network has no copy). Much longer than GIVE_UP_MS on purpose (final check of 5f0a845b): the copy's cancel fails
 * the payment and frees its inputs here, but the device that made it keeps its own request and may still be sending
 * it (its SendWaiting does not look at the transaction's status), so a release while that device is alive could tell
 * the user "nothing was paid" shortly before it lands. Whenever the sending device is in use its own rule (GIVE_UP_MS
 * and MIN_ATTEMPTS) settles the payment first; this is only for a copy whose sending device is gone (wiped, lost).
 */
export const NOSEND_COPY_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;

export type QueuedSend = {
  transactionId: number;
  txid: string;
  createdAt: number;
  /** The proven-tx request's broadcast attempts (0 when unknown). */
  attempts: number;
  /** The proven-tx request's status ('nosend': a copy of another device's payment, never sent from here). */
  reqStatus?: string;
  description?: string;
  satoshis?: number;
  /**
   * What the payment pays, read from its own signed bytes (never a backup's description or amount: review round 3,
   * d): every output that is not this wallet's, as an address (or "a script"), and their total.
   */
  recipients?: Recipient[];
  amountSats?: number;
  /** This device queued it itself (services/releaseMarks.ts): not one restored from a backup. */
  queuedHere?: boolean;
};

export type Recipient = { to: string; sats: number };

/**
 * The outputs of `rawTx` that pay someone else: every output `isOurs` doesn't claim, shown as its P2PKH address or
 * "a script". Undefined when the bytes don't parse.
 */
export async function decodePayment(
  rawTx: ArrayLike<number> | null | undefined,
  isOurs: (vout: number, scriptHex: string) => boolean | Promise<boolean>,
): Promise<{ recipients: Recipient[]; amountSats: number } | undefined> {
  if (!rawTx?.length) return undefined;
  let tx: Transaction;
  try {
    tx = Transaction.fromBinary(Array.from(rawTx));
  } catch {
    return undefined;
  }
  const recipients: Recipient[] = [];
  for (const [vout, out] of tx.outputs.entries()) {
    const script = out.lockingScript.toHex().toLowerCase();
    if (await isOurs(vout, script)) continue;
    const chunks = out.lockingScript.chunks;
    const p2pkh =
      chunks.length === 5 &&
      chunks[0].op === OP.OP_DUP &&
      chunks[1].op === OP.OP_HASH160 &&
      chunks[2].data?.length === 20 &&
      chunks[3].op === OP.OP_EQUALVERIFY &&
      chunks[4].op === OP.OP_CHECKSIG;
    recipients.push({
      to: p2pkh ? Utils.toBase58Check(chunks[2].data!, [0x00]) : 'a script',
      sats: out.satoshis ?? 0,
    });
  }
  return { recipients, amountSats: recipients.reduce((n, r) => n + r.sats, 0) };
}

type Bytes = ArrayLike<number>;
/** The store reads listQueuedSends needs (a StorageProvider: StorageIdb). */
export type QueueStore = {
  findTransactions(a: { partial: Record<string, unknown>; noRawTx?: boolean }): Promise<
    {
      transactionId: number;
      txid?: string | null;
      created_at: Date | string;
      description?: string;
      satoshis?: number;
    }[]
  >;
  findProvenTxReqs(a: {
    partial: Record<string, unknown>;
  }): Promise<{ status?: string; attempts?: number; rawTx?: Bytes | null }[]>;
  findOutputs(a: { partial: Record<string, unknown> }): Promise<{ vout?: number }[]>;
};
/**
 * Is this output row's script (hex) one this wallet's own keys derive (inboundSync walletOwnership)? A backup's
 * change / basket flags never decide it (review round 4, item 4).
 */
export type OwnsOutput = (row: never, scriptHex: string) => Promise<boolean>;

/**
 * Outgoing payments in status 'sending' with their request's attempts and status, and what each pays, read from its
 * own bytes (the request's rawTx): an output is the wallet's only when `owns` says this wallet's keys derive its
 * script (without `owns`, none is). `released`: this device's own marks (services/releaseMarks.ts), for `queuedHere`.
 */
export async function listQueuedSends(
  sp: QueueStore,
  released?: (txid: string) => boolean,
  owns?: OwnsOutput,
): Promise<QueuedSend[]> {
  const out: QueuedSend[] = [];
  for (const t of await sp.findTransactions({ partial: { status: 'sending', isOutgoing: true }, noRawTx: true })) {
    if (!t.txid) continue;
    const [req] = await sp.findProvenTxReqs({ partial: { txid: t.txid } });
    const rows = await sp.findOutputs({ partial: { transactionId: t.transactionId } });
    const paid = await decodePayment(req?.rawTx, async (vout, script) => {
      const row = rows.find((o) => o.vout === vout);
      return !!row && !!owns && (await owns(row as never, script).catch(() => false));
    });
    out.push({
      transactionId: t.transactionId,
      txid: t.txid,
      createdAt: new Date(t.created_at).getTime(),
      attempts: req?.attempts ?? 0,
      reqStatus: req?.status,
      description: t.description,
      satoshis: t.satoshis,
      ...(paid ?? {}),
      queuedHere: released ? released(t.txid) : undefined,
    });
  }
  return out;
}

export type StuckVerdict = 'wait' | 'give-up';

/** Pure: should the wallet give up on this queued send now? (Chain state is checked separately, after.) */
export function stuckVerdict(s: Pick<QueuedSend, 'createdAt' | 'attempts' | 'reqStatus'>, now: number): StuckVerdict {
  if (!Number.isFinite(s.createdAt)) return 'wait';
  const age = now - s.createdAt;
  // A copy never sent from here has no attempts to count: its age alone, a week (the network check still follows).
  if (s.reqStatus === 'nosend') return age >= NOSEND_COPY_GIVE_UP_MS ? 'give-up' : 'wait';
  return age >= GIVE_UP_MS && s.attempts >= MIN_ATTEMPTS ? 'give-up' : 'wait';
}

export type ReleaseDeps = {
  /** Outgoing actions in status 'sending' with their request's attempts (read only). */
  listQueued: () => Promise<QueuedSend[]>;
  /** True when the network has (or may have) this txid. Must fail closed: an error counts as known. */
  knownOnChain: (txid: string) => Promise<boolean>;
  /** Stop retrying and release the inputs: request -> 'invalid', action -> 'failed'. */
  cancel: (s: QueuedSend) => Promise<void>;
  /**
   * False when the active store can't be read directly (a remote WalletStorageProvider, e.g. 1Sat storage while
   * the switch to this device is pending). The review is skipped, not failed: the remote runs its own monitor.
   */
  available?: () => boolean;
  now?: () => number;
  log?: (msg: string) => void;
};

export type ReleaseReport = {
  queued: number;
  released: QueuedSend[];
  kept: string[];
  error?: string;
  skipped?: string;
};

export async function releaseStuckSends(deps: ReleaseDeps): Promise<ReleaseReport> {
  const now = (deps.now ?? Date.now)();
  const log = deps.log ?? ((m: string) => console.log(m));
  const report: ReleaseReport = { queued: 0, released: [], kept: [] };
  if (deps.available && !deps.available()) {
    report.skipped = 'active storage is remote';
    return report;
  }
  try {
    const queued = (await deps.listQueued()).filter((s) => /^[0-9a-f]{64}$/i.test(s.txid));
    report.queued = queued.length;
    for (const s of queued) {
      if (stuckVerdict(s, now) === 'wait') continue;
      let known = true;
      try {
        known = await deps.knownOnChain(s.txid);
      } catch {
        known = true;
      }
      if (known) {
        report.kept.push(s.txid);
        continue;
      }
      try {
        await deps.cancel(s);
        report.released.push(s);
        log(
          s.reqStatus === 'nosend'
            ? `[stuckSends] gave up on ${s.txid}, another device's payment the network never had; inputs released`
            : `[stuckSends] gave up on ${s.txid} after ${s.attempts} attempts; inputs released`,
        );
      } catch (e) {
        console.warn('[stuckSends] cancel failed for', s.txid, e);
      }
    }
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    console.error('[stuckSends] failed:', e);
  }
  return report;
}

/** What the user is told, in plain words. */
export function releasedMessage(released: Pick<QueuedSend, 'description'>[]): string {
  const n = released.length;
  const what = n === 1 && released[0].description ? `"${released[0].description.slice(0, 60)}"` : `${n} payments`;
  return (
    `${what} never reached the network, so your wallet cancelled ${n === 1 ? 'it' : 'them'}. ` +
    `Nothing was paid, and the money is spendable again.`
  );
}

// ─── By hand: send a queued payment now, or cancel one the network never got (24 Oct 2026) ───

export type UnsentDeps = Pick<ReleaseDeps, 'listQueued' | 'knownOnChain' | 'cancel' | 'available'> & {
  /** Run the Monitor's SendWaiting now (it re-posts every queued send). */
  sendWaiting: () => Promise<unknown>;
  /**
   * Post one payment this device holds as 'nosend' (createAction with sendWith: `sendHeld`). SendWaiting never posts
   * such a request, so without this a held payment can only be cancelled.
   */
  sendWith?: (txid: string) => Promise<unknown>;
  /** Throws while spending is paused (the kill switch: assertNotPaused('spending')). */
  assertSpending?: () => Promise<void>;
};

/** A queued payment this device holds back: restored from a backup, or a copy of another device's. */
export const isHeld = (s: Pick<QueuedSend, 'reqStatus'>): boolean => s.reqStatus === 'nosend';

/**
 * The wallet's own broadcast of one held payment, by its txid (BRC-100 createAction with sendWith and nothing new):
 * only ever called from resolveUnsent, on the user's "Send now".
 */
export const sendHeld =
  (wallet: { createAction: (args: never) => Promise<unknown> }) =>
  (txid: string): Promise<unknown> =>
    wallet.createAction({
      description: 'Send a held payment',
      options: { sendWith: [txid], acceptDelayedBroadcast: false },
    } as never);

/** A held payment's Send now without the confirmation sheet's yes. */
export const NEEDS_CONFIRMATION = 'Confirm the payment first';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type UnsentOutcome =
  | { ok: true; txid: string; result: 'network-may-have-it' | 'still-queued' | 'cancelled' }
  | { ok: false; txid: string; error: string };

/**
 * The bvideox.com mint b6963e8c… (24 Oct 2026) was queued ('sending'), answered as sent, and never posted; its
 * inputs stay locked until it goes out or is given up on (24 h and 6 attempts, above). This lets the wallet's own
 * screen act on ONE queued send now:
 *  - 'send': run SendWaiting (re-posts it), then report whether the network has (or may have) it. A payment held here
 *    as 'nosend' (restored from a backup: services/inboundSync.ts admits every request new to the device that way, so
 *    a queued send came back held and would only ever be cancelled, a week on) is posted by itself instead
 *    (deps.sendWith), and only while spending is not paused. Never run without the user asking.
 *  - 'cancel': only when the network has no copy (knownOnChain fails closed: any doubt keeps it). Then the request
 *    is marked 'invalid' and the action 'failed', which releases its inputs: the same cancel the 24 h review does.
 * Only sends in the queued list are touched; anything else is refused.
 */
export async function resolveUnsent(
  deps: UnsentDeps,
  txid: string,
  how: 'send' | 'cancel',
  opts: { confirmed?: boolean } = {},
): Promise<UnsentOutcome> {
  if (!/^[0-9a-f]{64}$/i.test(txid)) return { ok: false, txid, error: 'Not a transaction id' };
  if (deps.available && !deps.available()) return { ok: false, txid, error: 'This account’s storage is remote' };
  const known = async () => {
    try {
      return await deps.knownOnChain(txid);
    } catch {
      return true;
    }
  };
  const queued = (await deps.listQueued()).find((s) => s.txid.toLowerCase() === txid.toLowerCase());
  if (!queued) return { ok: false, txid, error: 'That payment is not waiting to send' };
  if (how === 'send' && isHeld(queued)) {
    if (!deps.sendWith) return { ok: false, txid, error: 'This payment can’t be sent from here' };
    // Only after the user saw what it pays, read from its own bytes, and confirmed it (review round 3, d).
    if (!opts.confirmed) return { ok: false, txid, error: NEEDS_CONFIRMATION };
    try {
      await deps.assertSpending?.();
    } catch (e) {
      return { ok: false, txid, error: errText(e) || 'Payments are paused' };
    }
    try {
      await deps.sendWith(queued.txid);
    } catch (e) {
      if (!(await known())) return { ok: false, txid, error: `It was not sent: ${errText(e)}` };
    }
    return { ok: true, txid, result: (await known()) ? 'network-may-have-it' : 'still-queued' };
  }
  if (how === 'send') {
    await deps.sendWaiting().catch(() => undefined);
    return { ok: true, txid, result: (await known()) ? 'network-may-have-it' : 'still-queued' };
  }
  if (await known()) return { ok: false, txid, error: 'The network may already have it, so it is kept' };
  await deps.cancel(queued);
  return { ok: true, txid, result: 'cancelled' };
}

/** What the user is told after a Send now / Cancel choice (components/HeldPayments.tsx), in plain words. */
export function unsentOutcomeText(o: UnsentOutcome | undefined, error?: string): string {
  if (!o) return error || 'That didn’t work. Try again.';
  if (!o.ok) return o.error;
  if (o.result === 'cancelled') return 'Cancelled. Nothing was paid, and the money is spendable again.';
  if (o.result === 'network-may-have-it') return 'Sent.';
  return 'Not on the network yet. Try again in a few minutes.';
}
