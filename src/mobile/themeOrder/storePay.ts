/**
 * Store payments: the wallet broadcasts them itself, and only after their rows are backed up and the Store knows the
 * txid (P0, 3 Nov 2026; review 4 Nov 2026).
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
 *  2. remember it in this device's outbox (txid, quote, the signed BEEF). The write is checked: if it can't be saved,
 *     nothing is sent;
 *  3. back up: push the new rows to the wallet's encrypted remote backup (background STORE_BACKUP_BEFORE_SEND →
 *     services/deviceSync.ts backupBeforeSend). If that fails the payment is NOT sent: it stays unsent, the buyer is
 *     told plainly, and it is sent once a backup works (Store open, or Pay again);
 *  4. tell the Store first (claim intent): the server checks the payment against the quote and records its txid,
 *     without posting it anywhere. From then on the claim doesn't depend on this device: the server re-checks it on
 *     its own. If the Store can't be reached the payment is not sent; if it refuses, the payment is released unsent;
 *  5. broadcast through the wallet (services/unsentGuard.ts sendThroughWallet): AtomicBEEF with every unmined ancestor,
 *     the toolbox's retries and proofs. A refusal is believed only after the chain says, over ~30 s of retries, that
 *     it doesn't have the payment, and even then the entry is KEPT ("refused so far") and re-checked on later Store
 *     opens, because a refused re-send can be one the network already has;
 *  6. claim: the server re-posts it and answers paid only once the network has it (else 202 pending).
 * Nothing here ever aborts a payment that may have reached the network.
 */
import { Utils } from '@bsv/sdk';
import {
  chainHasSeen,
  chainLookups,
  chainMayHave,
  chainVerdict,
  releaseLookups,
  sendThroughWallet,
  type ChainLookup,
  type UnsentWallet,
} from '../../services/unsentGuard';

export type StorePayKind = 'buy' | 'order';
export type OutboxState = 'signed' | 'sending' | 'sent' | 'pending' | 'refused';

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
  /** When the network (as far as the chain could tell) refused it. */
  refusedAt?: number;
  /**
   * When the claim intent was first attempted (the BEEF then left this device for the Store). `null`: never attempted,
   * written by this version, so the payment exists only on this device. Absent: written before 10 Nov 2026, unknown
   * (an intent may have reached the Store even though no answer came back).
   */
  intentAt?: number | null;
};

export type Outbox = {
  all: () => OutboxEntry[];
  /** Throws when the entry could not be saved (callers before a broadcast must not go on). */
  put: (e: OutboxEntry) => void;
  drop: (txid: string) => void;
};

/** Kept at most this long; the server honours a matching payment whenever it is claimed. */
export const OUTBOX_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/** A refused entry is re-checked on Store opens for at least this long before it may be cleared. */
export const REFUSED_KEEP_MS = 24 * 60 * 60 * 1000;
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

/** This device's outbox for one identity (localStorage). Reads never throw; a write that didn't stick throws. */
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
    const s = store();
    if (!s) throw new Error('this device has no storage for the Store outbox');
    s.setItem(key, JSON.stringify(list.slice(-MAX_ENTRIES)));
  };
  return {
    all: read,
    put: (e) => {
      write([...read().filter((x) => x.txid !== e.txid), { ...e }]);
      const back = read().find((x) => x.txid === e.txid);
      if (!back || back.state !== e.state) throw new Error('the Store outbox did not keep the payment');
    },
    drop: (txid) => {
      try {
        write(read().filter((x) => x.txid !== txid));
      } catch {
        /* nothing to lose: the entry was being removed */
      }
    },
  };
};

/** A write that may fail without harm (after the broadcast: the wallet and the server both hold the payment). */
export const softPut = (outbox: Outbox, e: OutboxEntry, log?: (m: string) => void) => {
  try {
    outbox.put(e);
  } catch (err) {
    log?.(`[bwx-store] ${e.txid}: outbox not updated (${err instanceof Error ? err.message : String(err)})`);
  }
};

export type BackupAnswer = { ok: true } | { ok: false; error: string };
/** The Store's answer to a claim intent: recorded, refused (4xx: never send it), or unreachable. */
export type IntentAnswer = { ok: true } | { ok: false; refused: boolean; error: string; code?: string };

export type StorePayDeps = {
  /** Push the wallet's rows to its encrypted remote backup; ok only when it went through (or there is nothing to do). */
  backup: () => Promise<BackupAnswer>;
  /** Tell the Store the txid before broadcasting (claim with intent). Absent: no intent step (tests of other parts). */
  intent?: (e: OutboxEntry) => Promise<IntentAnswer>;
  /** Release a payment that never left the device (or only reached our own Store, which refused it). */
  releaseUnsent?: (txid: string) => Promise<void>;
  /** The wallet's status for an action: 'failed', 'nosend', 'unproven'…, or undefined when storage has no such action. */
  actionStatus?: (txid: string) => Promise<string | undefined>;
  /**
   * Has the Store heard of this payment? (api.ts storeHeardOf: a claim with no rawtx, which records nothing.) Asked
   * before releasing an entry written before intentAt existed. Absent: such entries are never released here.
   */
  storeHeardOf?: (e: OutboxEntry) => Promise<'yes' | 'no' | 'unclear'>;
  /**
   * Tell the wallet's broadcaster wrapper this txid may already be on the network, before re-posting a payment that was
   * 'sending' when the app died (services/refusalRecheck.ts markMayBeOut; 06c M1).
   */
  markMayBeOut?: (txid: string) => Promise<void>;
  outbox: Outbox;
  /** One-snapshot chain lookups for "has the network got it?" (WhatsOnChain + ARC). */
  lookups?: ChainLookup[];
  /** Lookups for the retried "is it really not there?" check before an entry is ever cleared. */
  releaseLookups?: ChainLookup[];
  /** Retry delays for that check (~30 s by default). */
  recheckDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  now?: () => number;
};

export const STORE_PAY_MESSAGES = {
  // Owner, 10 Nov 2026: twice told "nothing was paid" while the unsent payment kept ~$1 of his balance locked. A
  // payment that could not be backed up is now released at once (backup_failed_released). Only when the chain can't be
  // asked (offline) is it kept, and then the next Store open releases it; it is never sent without a new Pay.
  backup_failed:
    "Your wallet couldn't save its backup, so the payment was not sent. Nothing was paid. The amount is held for now and comes back to your balance the next time you open the Store, or tap Pay to try again.",
  backup_failed_released:
    "Your wallet couldn't save its backup, so the payment was not sent. Nothing was paid and your balance is back. Try again in a moment.",
  outbox_failed: "This device couldn't save the payment, so it was not sent. Nothing was paid. Try again in a moment.",
  store_unreachable:
    "The Store couldn't be reached, so the payment has not been sent. Nothing was paid. It goes out once the Store answers: open the Store again, or tap Pay to try now.",
  intent_refused: 'The Store did not accept this payment, so it was not sent. Nothing was paid.',
  refused_so_far:
    "The network has refused the payment so far. It's kept: if it turns up on the network it is claimed automatically, and nothing more is taken.",
  cleared: 'An earlier payment for this was never sent and has been cleared. Nothing was paid.',
  refused_cleared:
    'An earlier payment for this was refused by the network and never reached it, so it has been cleared. Nothing was paid.',
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

const storeError = (code: keyof typeof STORE_PAY_MESSAGES, sent: boolean, message?: string) =>
  new StorePayError(message ?? STORE_PAY_MESSAGES[code], code, sent);

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

/** Save a fresh payment in the outbox before anything else; if that fails, release it (it never left the device). */
export async function recordNewPayment(entry: OutboxEntry, deps: StorePayDeps): Promise<void> {
  try {
    deps.outbox.put(entry);
  } catch (e) {
    deps.log?.(
      `[bwx-store] ${entry.txid}: outbox write failed (${e instanceof Error ? e.message : String(e)}); not sent`,
    );
    await deps.releaseUnsent?.(entry.txid).catch(() => undefined);
    throw storeError('outbox_failed', false);
  }
}

/**
 * Is this entry dead: storage has no live action for it (failed or gone) AND the chain, over ~30 s of retries, says it
 * isn't there? Only then may it be cleared (review 4 Nov 2026, F3).
 */
async function deadEntry(entry: OutboxEntry, deps: StorePayDeps): Promise<boolean> {
  if (!deps.actionStatus) return false;
  const status = await deps.actionStatus(entry.txid).catch(() => 'unknown');
  if (status !== undefined && status !== 'failed') return false;
  const v = await chainVerdict(entry.txid, deps.releaseLookups ?? releaseLookups(), {
    delaysMs: deps.recheckDelaysMs,
    sleep: deps.sleep,
  });
  return v === 'missing';
}

/** A Store open leaves a never-sent entry this young alone: a Pay may be backing it up right now (60 s limit). */
export const UNSENT_RELEASE_MIN_AGE_MS = 3 * 60_000;

/** Signed, never told the Store, never posted: its BEEF exists only on this device (intentAt null, this version). */
export const neverLeftDevice = (e: OutboxEntry): boolean => e.state === 'signed' && e.intentAt === null;
/** Signed and never posted, but written before intentAt existed: the Store may have been told. */
const intentUnknown = (e: OutboxEntry): boolean => e.state === 'signed' && e.intentAt === undefined;

export type UnsentRelease =
  /** The wallet released it (abortAction): its coins are spendable again, the entry is gone. */
  | 'released'
  /** The wallet no longer holds it as unsent (released before, or gone): the entry is gone. */
  | 'cleared'
  /** Kept as it was: something could not be shown safe. */
  | 'kept';

/**
 * Release a Store payment that never left this device (10 Nov 2026: the owner's two payments whose backup failed kept
 * ~$1 each locked, out of History, with nothing to free them but a 24 h expiry). Released only when ALL hold:
 *  - the outbox entry is 'signed' and the Store was never told (intentAt null), or, for an entry written before
 *    intentAt existed, the Store says it has never heard of this txid;
 *  - the wallet holds it as 'nosend' (not sending / unproven / completed);
 *  - every chain lookup says it isn't there: one snapshot (`retryWindow: false`, used right after signing, when the
 *    BEEF has never left the device), or every lookup on every retry over ~30 s (`retryWindow: true`, Store open);
 *  - just before the release, the entry is still there and still never told (a Pay running meanwhile wins).
 * The release is the toolbox's abortAction ('nosend' → 'failed': inputs spendable again; the change rows are kept,
 * marked unspendable, so recoverByTxid can still restore them if the tx ever appears). The entry is dropped only after
 * the wallet confirms it no longer holds the payment as unsent. Nothing is built, signed or broadcast. Never throws.
 */
export async function releaseNeverSent(
  wallet: Pick<UnsentWallet, 'abortAction'>,
  entry: OutboxEntry,
  deps: StorePayDeps,
  o: { retryWindow: boolean },
): Promise<UnsentRelease> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const txid = entry.txid;
  const keep = (why: string): UnsentRelease => {
    log(`[bwx-store] ${txid}: unsent payment kept, not released (${why})`);
    return 'kept';
  };
  try {
    if (!neverLeftDevice(entry) && !intentUnknown(entry)) return keep('it may have reached the Store');
    if (!deps.actionStatus) return keep("the wallet's status for it can't be read");
    const status = await deps.actionStatus(txid).catch(() => 'unknown');
    // listActions leaves 'failed' out: undefined is "released before, or older than the recent actions read".
    if (status !== 'nosend' && status !== undefined && status !== 'failed')
      return keep(`the wallet holds it as ${status}`);
    const lookups = deps.releaseLookups ?? releaseLookups();
    const missing = o.retryWindow
      ? (await chainVerdict(txid, lookups, { delaysMs: deps.recheckDelaysMs, sleep: deps.sleep })) === 'missing'
      : !(await chainMayHave(txid, lookups));
    if (!missing) return keep('the chain may have it, or could not be asked');
    if (intentUnknown(entry)) {
      const heard = deps.storeHeardOf ? await deps.storeHeardOf(entry).catch(() => 'unclear' as const) : 'unclear';
      if (heard !== 'no') return keep(`written before intents were recorded and the Store answered "${heard}"`);
    }
    const now = deps.outbox.all().find((x) => x.txid === txid);
    if (!now || (!neverLeftDevice(now) && !intentUnknown(now))) return keep('a Pay changed it meanwhile');
    if (status !== 'nosend') {
      deps.outbox.drop(txid);
      log(`[bwx-store] ${txid}: never sent and no longer held by the wallet as unsent; cleared`);
      return 'cleared';
    }
    const r = (await wallet.abortAction({ reference: txid })) as { aborted?: boolean } | undefined;
    if (r && r.aborted === false) return keep('the wallet would not release it (the network may know it)');
    const after = await deps.actionStatus(txid).catch(() => 'unknown');
    if (after === 'nosend' || after === 'unknown') return keep(`still ${after} after the release`);
    deps.outbox.drop(txid);
    log(`[bwx-store] ${txid}: never sent (the Store was never told, the chain has no copy); released, coins back`);
    return 'released';
  } catch (e) {
    return keep(`release failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Back up, tell the Store, then broadcast an outbox entry; or re-check one the network refused before. Resolves 'sent'
 * (the broadcaster took it, or the chain has it) or 'pending' (no verdict yet, the wallet keeps retrying). Throws
 * StorePayError: backup_failed / store_unreachable / outbox_failed (nothing sent, entry kept), intent_refused (nothing
 * sent, released), refused_so_far (kept, re-checked later), cleared (dead entry removed), not_sent (kept).
 */
export async function sendStorePayment(
  wallet: UnsentWallet,
  entry: OutboxEntry,
  deps: StorePayDeps,
): Promise<'sent' | 'pending'> {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const lookups = deps.lookups ?? chainLookups();
  const now = (deps.now ?? Date.now)();

  if (entry.state === 'refused') {
    // Refused before: never re-sent blindly and never dropped on one look. The chain decides, on every Store open.
    if (await chainHasSeen(entry.txid, lookups)) {
      log(`[bwx-store] ${entry.txid}: refused earlier, but the network has it now`);
      softPut(deps.outbox, { ...entry, state: 'sent' }, log);
      return 'sent';
    }
    if (now - (entry.refusedAt ?? entry.at) > REFUSED_KEEP_MS && (await deadEntry(entry, deps))) {
      log(`[bwx-store] ${entry.txid}: refused, failed in the wallet and still not on chain after a day; cleared`);
      deps.outbox.drop(entry.txid);
      throw storeError('refused_cleared', false);
    }
    throw storeError('refused_so_far', true);
  }

  if (entry.state === 'signed') {
    // Released meanwhile (unsentExpiry's deadline, Repair Sync, a Store open): never back it up, tell the Store about
    // it or send it. A Store told about a released payment would refuse the next one for this item for an hour.
    if (await deadEntry(entry, deps)) {
      log(`[bwx-store] ${entry.txid}: never sent and the wallet no longer holds it; cleared`);
      deps.outbox.drop(entry.txid);
      throw storeError('cleared', false);
    }
    const inOutbox = () => deps.outbox.all().some((x) => x.txid === entry.txid);
    const keptBefore = inOutbox();
    const b = await deps.backup().catch((e: unknown): BackupAnswer => ({ ok: false, error: String(e) }));
    if (!b.ok) {
      log(`[bwx-store] ${entry.txid}: backup failed (${b.error}); not sent`);
      // Nothing has left this device: give the coins back now instead of holding them for a later send (10 Nov 2026).
      const r = await releaseNeverSent(wallet, entry, deps, { retryWindow: false });
      if (r !== 'kept') throw storeError('backup_failed_released', false);
      throw storeError('backup_failed', false);
    }
    // A Store open (or another Pay) may have released it while the backup ran.
    if (keptBefore && !inOutbox()) {
      log(`[bwx-store] ${entry.txid}: released while its backup ran; not sent`);
      throw storeError('cleared', false);
    }
    if (deps.intent) {
      // Recorded BEFORE the BEEF leaves for the Store: from here this payment is never released as "never sent".
      if (!entry.intentAt) {
        entry = { ...entry, intentAt: now };
        try {
          deps.outbox.put(entry);
        } catch (e) {
          log(
            `[bwx-store] ${entry.txid}: outbox write failed (${e instanceof Error ? e.message : String(e)}); not sent`,
          );
          throw storeError('outbox_failed', false);
        }
      }
      const i = await deps
        .intent(entry)
        .catch((e: unknown): IntentAnswer => ({ ok: false, refused: false, error: String(e) }));
      if (!i.ok && i.refused) {
        log(`[bwx-store] ${entry.txid}: the Store refused it before any broadcast (${i.code ?? i.error}); released`);
        deps.outbox.drop(entry.txid);
        await deps.releaseUnsent?.(entry.txid).catch(() => undefined);
        throw storeError('intent_refused', false, i.error || STORE_PAY_MESSAGES.intent_refused);
      }
      if (!i.ok) {
        log(`[bwx-store] ${entry.txid}: the Store couldn't be reached (${i.error}); not sent, kept unsent`);
        throw storeError('store_unreachable', false);
      }
    }
  }
  // A payment that was already 'sending' when the app died may be out (06c M1): its refusal must not free the coin.
  if (entry.state === 'sending')
    await Promise.resolve(deps.markMayBeOut?.(entry.txid)).catch((e: unknown) =>
      log(`[bwx-store] ${entry.txid}: could not mark it as maybe out (${e instanceof Error ? e.message : String(e)})`),
    );
  // Recorded before the broadcast: from here a restart re-sends and re-claims this txid, never a new payment.
  try {
    deps.outbox.put({ ...entry, state: 'sending' });
  } catch (e) {
    log(`[bwx-store] ${entry.txid}: outbox write failed (${e instanceof Error ? e.message : String(e)}); not sent`);
    throw storeError('outbox_failed', false);
  }
  const h = await sendThroughWallet(wallet, entry.txid, { log });
  if (h === 'sent' || h === 'pending') {
    // No verdict yet: it may already be out, and SendWaiting will re-post it later (final check, LOW).
    if (h === 'pending' && entry.state !== 'sending')
      await Promise.resolve(deps.markMayBeOut?.(entry.txid)).catch(() => undefined);
    softPut(deps.outbox, { ...entry, state: 'sent' }, log);
    return h;
  }
  // Refused, or no answer: the chain decides. If it has the payment, it went out.
  if (await chainHasSeen(entry.txid, lookups)) {
    log(`[bwx-store] ${entry.txid}: wallet said ${h}, but the network has it`);
    softPut(deps.outbox, { ...entry, state: 'sent' }, log);
    return 'sent';
  }
  if (h === 'refused') {
    // Kept, never dropped here: a re-send the network already has can be answered "refused" (review F1).
    log(`[bwx-store] ${entry.txid}: refused and not seen yet; kept, re-checked on later Store opens`);
    softPut(deps.outbox, { ...entry, state: 'refused', refusedAt: now }, log);
    throw storeError('refused_so_far', true);
  }
  // Nothing was posted. If the wallet has no live action for it and the chain doesn't have it, it is dead: clear it.
  if (await deadEntry(entry, deps)) {
    log(`[bwx-store] ${entry.txid}: no live action in the wallet and not on chain; cleared`);
    deps.outbox.drop(entry.txid);
    throw storeError('cleared', false);
  }
  log(`[bwx-store] ${entry.txid}: could not be sent now; kept to send again`);
  throw storeError('not_sent', true);
}

/** Entries older than OUTBOX_KEEP_MS are dropped (the wallet still holds their rows; the server holds the txid). */
export function pruneOutbox(outbox: Outbox, now = Date.now()): OutboxEntry[] {
  const live: OutboxEntry[] = [];
  for (const e of outbox.all()) {
    if (now - e.at > OUTBOX_KEEP_MS) outbox.drop(e.txid);
    else live.push(e);
  }
  return live;
}

/** Store memos: OP_FALSE OP_RETURN "bwx-theme-buy" | "bwx-theme-order" <quote id> (site/lib/themeBuys.js, themeOrders.js). */
export function storeMemo(scriptHex: string): { kind: StorePayKind; quoteId: string } | null {
  const tag = (t: string) => Utils.toHex(Utils.toArray(t, 'utf8'));
  const buy = `006a0d${tag('bwx-theme-buy')}20`;
  const order = `006a0f${tag('bwx-theme-order')}20`;
  const h = scriptHex.toLowerCase();
  const rest = h.startsWith(buy) ? h.slice(buy.length) : h.startsWith(order) ? h.slice(order.length) : null;
  if (rest === null || rest.length !== 64) return null;
  const quoteId = Utils.toUTF8(Utils.toArray(rest, 'hex'));
  if (!/^[0-9a-f]{32}$/.test(quoteId)) return null;
  return { kind: h.startsWith(buy) ? 'buy' : 'order', quoteId };
}
