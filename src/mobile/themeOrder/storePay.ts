/**
 * Store payments: the wallet broadcasts them itself, and only after their rows are backed up (P0, 3 Nov 2026).
 *
 * Before: the Store signed with noSend and our server broadcast the payment. The owner's $1 test on his phone (one coin
 * of about $1.17, tx 5916dd14…) showed what that did: the toolbox held the payment only in memory, a reload dropped
 * it, and the change, whose random BRC-29 derivation lived nowhere else, was lost; the server had marked it paid on
 * ARC's ANNOUNCED_TO_NETWORK. On 25 Oct the 28.67 BSV change of 877d2505… was lost the same way.
 *
 * Now, for every Store payment (theme buys, theme editions):
 *  1. sign: createAction with noSend. With action batches in 'legacy' mode (services/actionBatchMode.ts) the payment
 *     is written to storage at once as an unsent ('nosend') row: inputs locked, change rows with their derivations.
 *     Nothing can broadcast a nosend row behind our back (the Monitor's SendWaiting only posts unsent/sending);
 *  2. remember it in this device's outbox (txid, quote, the signed BEEF), so a restart can finish it;
 *  3. back up: push the new rows to the wallet's encrypted remote backup (background STORE_BACKUP_BEFORE_SEND →
 *     services/deviceSync.ts backupBeforeSend). If that fails the payment is NOT sent: it stays unsent, the buyer is
 *     told plainly, and it is sent once a backup works (Store open, or Pay again). unsentExpiry releases it after its
 *     deadline if it is never sent;
 *  4. broadcast through the wallet (services/unsentGuard.ts sendThroughWallet): AtomicBEEF with every unmined ancestor,
 *     the toolbox's retries and proofs. A refusal is believed only after the chain says it doesn't have the payment;
 *  5. claim: the server checks the outputs and memo against the quote, records the txid, may re-post it, and answers
 *     paid only once the network has it (else 202 pending: Store › owned rechecks).
 * Nothing here ever aborts a payment.
 */
import { Utils } from '@bsv/sdk';
import {
  chainHasSeen,
  chainLookups,
  sendThroughWallet,
  type ChainLookup,
  type UnsentWallet,
} from '../../services/unsentGuard';

export type StorePayKind = 'buy' | 'order';
export type OutboxState = 'signed' | 'sending' | 'sent' | 'pending';

export type OutboxEntry = {
  kind: StorePayKind;
  quoteId: string;
  txid: string;
  /** The AtomicBEEF hex createAction returned: the claim's rawtx (with its ancestors). */
  beefHex: string;
  /** What a new purchase of the same thing resumes: the pack for a theme buy, the quote for an edition. */
  key: string;
  label?: string;
  state: OutboxState;
  at: number;
  claimedAt?: number;
};

export type Outbox = {
  all: () => OutboxEntry[];
  put: (e: OutboxEntry) => void;
  drop: (txid: string) => void;
};

/** Kept at most this long; the server honours a matching payment whenever it is claimed. */
export const OUTBOX_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20;
const TXID = /^[0-9a-f]{64}$/i;

export const memoryOutbox = (): Outbox => {
  const m = new Map<string, OutboxEntry>();
  return {
    all: () => [...m.values()],
    put: (e) => void m.set(e.txid, { ...e }),
    drop: (txid) => void m.delete(txid),
  };
};

type KV = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };

/** This device's outbox for one identity (localStorage; every access guarded: a blocked store just keeps nothing). */
export const localOutbox = (identityKey: string, kv?: KV): Outbox => {
  const key = `bwx-store-outbox:${identityKey}`;
  const store = (): KV | null => {
    try {
      return kv ?? (globalThis as { localStorage?: KV }).localStorage ?? null;
    } catch {
      return null;
    }
  };
  const read = (): OutboxEntry[] => {
    try {
      const raw = store()?.getItem(key);
      const list = raw ? (JSON.parse(raw) as OutboxEntry[]) : [];
      return Array.isArray(list) ? list.filter((e) => e && TXID.test(e.txid)) : [];
    } catch {
      return [];
    }
  };
  const write = (list: OutboxEntry[]) => {
    try {
      store()?.setItem(key, JSON.stringify(list.slice(-MAX_ENTRIES)));
    } catch {
      /* full or blocked: the payment's rows are in the wallet regardless */
    }
  };
  return {
    all: read,
    put: (e) => write([...read().filter((x) => x.txid !== e.txid), { ...e }]),
    drop: (txid) => write(read().filter((x) => x.txid !== txid)),
  };
};

export type BackupAnswer = { ok: true } | { ok: false; error: string };

export type StorePayDeps = {
  /** Push the wallet's rows to its encrypted remote backup; ok only when it went through (or there is nothing to do). */
  backup: () => Promise<BackupAnswer>;
  outbox: Outbox;
  /** Chain lookups for re-checking a refusal (WhatsOnChain + ARC). */
  lookups?: ChainLookup[];
  log?: (m: string) => void;
  now?: () => number;
};

export const STORE_PAY_MESSAGES = {
  backup_failed:
    "Your wallet couldn't save its backup, so the payment has not been sent. Nothing was paid. It goes out once the backup works: open the Store again, or tap Pay to try now.",
  not_accepted: 'The network refused the payment. Nothing was paid, and your coins are back in your balance.',
  not_sent:
    "The payment is saved in your wallet but couldn't be sent just now. It goes out when you're back online. Nothing will be paid twice.",
} as const;

export class StorePayError extends Error {
  constructor(
    message: string,
    readonly code: keyof typeof STORE_PAY_MESSAGES,
    /** True when money may already have left the wallet. */
    readonly sent: boolean,
  ) {
    super(message);
  }
}

type SignWallet = {
  createAction: (args: {
    description: string;
    outputs: unknown[];
    options: { noSend: true; randomizeOutputs: false };
  }) => Promise<{ txid?: string; tx?: number[] }>;
};

/** Sign a Store payment without sending it. With legacy action batches its rows are in storage when this returns. */
export async function signStorePayment(
  wallet: SignWallet,
  args: { description: string; outputs: unknown[] },
): Promise<{ txid: string; beefHex: string }> {
  const r = await wallet.createAction({
    description: args.description,
    outputs: args.outputs,
    options: { noSend: true, randomizeOutputs: false },
  });
  if (!r.tx || !r.txid) throw new Error('The wallet did not return the payment');
  return { txid: r.txid, beefHex: Utils.toHex(r.tx) };
}

/**
 * Back up, then broadcast, an outbox entry. Resolves 'sent' (the broadcaster took it) or 'pending' (no verdict yet,
 * the wallet keeps retrying). Throws StorePayError: 'backup_failed' (nothing sent, entry kept), 'not_accepted' (the
 * network refused it and doesn't have it: nothing paid, inputs back, entry dropped), 'not_sent' (couldn't send now,
 * entry kept).
 */
export async function sendStorePayment(
  wallet: UnsentWallet,
  entry: OutboxEntry,
  deps: StorePayDeps,
): Promise<'sent' | 'pending'> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const lookups = deps.lookups ?? chainLookups();
  if (entry.state === 'signed') {
    const b = await deps.backup().catch((e: unknown): BackupAnswer => ({ ok: false, error: String(e) }));
    if (!b.ok) {
      log(`[bwx-store] ${entry.txid}: backup failed (${b.error}); not sent, kept unsent`);
      throw new StorePayError(STORE_PAY_MESSAGES.backup_failed, 'backup_failed', false);
    }
  }
  // Recorded before the broadcast: from here a restart re-sends and re-claims this txid, never a new payment.
  deps.outbox.put({ ...entry, state: 'sending' });
  const h = await sendThroughWallet(wallet, entry.txid, { log });
  if (h === 'sent' || h === 'pending') {
    deps.outbox.put({ ...entry, state: 'sent' });
    return h;
  }
  // Refused, or no answer: the chain decides. If it has the payment, it went out.
  if (await chainHasSeen(entry.txid, lookups)) {
    log(`[bwx-store] ${entry.txid}: wallet said ${h}, but the network has it`);
    deps.outbox.put({ ...entry, state: 'sent' });
    return 'sent';
  }
  if (h === 'refused') {
    log(`[bwx-store] ${entry.txid}: refused by the network and not on chain; nothing paid`);
    deps.outbox.drop(entry.txid);
    throw new StorePayError(STORE_PAY_MESSAGES.not_accepted, 'not_accepted', false);
  }
  log(`[bwx-store] ${entry.txid}: could not be sent now; kept to send again`);
  throw new StorePayError(STORE_PAY_MESSAGES.not_sent, 'not_sent', true);
}

/** Entries older than OUTBOX_KEEP_MS are dropped (the wallet still holds their rows). */
export function pruneOutbox(outbox: Outbox, now = Date.now()): OutboxEntry[] {
  const live: OutboxEntry[] = [];
  for (const e of outbox.all()) {
    if (now - e.at > OUTBOX_KEEP_MS) outbox.drop(e.txid);
    else live.push(e);
  }
  return live;
}
