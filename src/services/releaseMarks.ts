/**
 * This device's own word on which payments may go out (task 54 scope item 2; review rounds 3 and 4).
 *
 * A payment signed and withheld (noSend) is held: nothing a backup says may send it. Only this device's own action
 * releases it, and the record is kept here, on this device only (never in a backup, never synced, whichever store is
 * active):
 *  - `held`: txids this device signed noSend (a one-step createAction, or a two-step one finished by signAction, as
 *    every site's goes through the permissions manager);
 *  - `released`: txids this device let go: a createAction / signAction naming them in sendWith (or spending their
 *    change through noSendChange in a payment that goes out), the user's "Send now" on a held payment (that same
 *    sendWith), and every payment this device built that is not noSend. A mark is held in flight while its call runs
 *    and kept only when the call succeeds (review round 4, item 3);
 *  - `owners`: who made each payment (its originator). A site may name in sendWith / noSendChange only payments it
 *    made itself; the wallet (the admin originator, or a call with none) may name any (review round 4, item 2).
 * services/beefAncestors.ts guardPostBeef refuses a broadcast carrying a held payment without a release.
 * A wiped or restored device starts with none: a payment it gets back from a backup is held until the user releases it.
 */
import { Transaction } from '@bsv/sdk';

export type ReleaseRecord = {
  released: string[];
  held?: string[];
  owners?: [string, string][];
  seen?: string[];
  /** Written by round 3 builds; read and dropped. */
  armed?: string[];
};
/** One transaction this device's signer handed to storage (watchSigned). */
export type Signed = { txid: string; rawTx?: number[]; reference?: string };

export type ReleaseKV = { load: () => Promise<ReleaseRecord | null>; save: (r: ReleaseRecord) => Promise<void> };

export type ReleaseMarks = {
  /** Read the kept record (call once at open; marks made before it finishes are kept too). */
  hydrate: () => Promise<void>;
  release: (txids: Iterable<string>) => Promise<void>;
  /** Released now: kept, or in flight in a call still running. */
  released: (txid: string) => boolean;
  /**
   * Count these released while `run` runs; keep them only if it succeeds, or if it throws an error `keep` accepts (one
   * thrown after the action reached storage).
   */
  inFlight: <T>(txids: string[], run: () => Promise<T>, keep?: (e: unknown) => boolean) => Promise<T>;
  hold: (txid: string, owner?: string) => Promise<void>;
  /** Signed noSend on this device (not yet released). */
  heldHere: (txid: string) => boolean;
  setOwner: (txid: string, owner: string) => Promise<void>;
  /** The originator that made it on this device, if any. */
  owner: (txid: string) => string | undefined;
  /** Any record of it here (owner, held or released). */
  known: (txid: string) => boolean;
  /** This device's signer handed it to storage (watchSigned): in memory, for matching a call's own result. */
  noteSigned: (txid: string, o?: { rawTx?: ArrayLike<number>; reference?: string }) => void;
  /** A counter for noteSigned; signedSince(n) lists what was signed after it was n (with its bytes and reference). */
  signedSeq: () => number;
  signedSince: (seq: number) => Signed[];
  /** The network was seen to have it (in a block or the mempool): kept, for Held payments' Send now. */
  markSeen: (txid: string) => Promise<void>;
  seen: (txid: string) => boolean;
};

/** The most kept of each kind (oldest dropped first): far more than a wallet's pending payments ever are. */
export const MAX_MARKS = 5_000;
const TXID = /^[0-9a-f]{64}$/;
const norm = (t: string) => String(t ?? '').toLowerCase();

export function createReleaseMarks(kv?: ReleaseKV): ReleaseMarks {
  const released = new Set<string>();
  const held = new Set<string>();
  const owners = new Map<string, string>();
  const seenOnNetwork = new Set<string>();
  const flying = new Map<string, number>();
  const signed: (Signed & { seq: number })[] = [];
  let seq = 0;
  let saving = Promise.resolve();
  const trim = <K>(s: { size: number; delete: (k: K) => boolean; keys: () => IterableIterator<K> }) => {
    while (s.size > MAX_MARKS) s.delete(s.keys().next().value as K);
  };
  const save = () => {
    if (!kv) return Promise.resolve();
    const r: ReleaseRecord = {
      released: [...released],
      held: [...held],
      owners: [...owners],
      seen: [...seenOnNetwork],
    };
    saving = saving.then(() => kv.save(r)).catch(() => undefined);
    return saving;
  };
  const marks: ReleaseMarks = {
    hydrate: async () => {
      const r = await kv?.load().catch(() => null);
      for (const t of r?.released ?? []) if (TXID.test(norm(t))) released.add(norm(t));
      for (const t of r?.held ?? []) if (TXID.test(norm(t))) held.add(norm(t));
      for (const [t, o] of r?.owners ?? []) if (TXID.test(norm(t)) && typeof o === 'string') owners.set(norm(t), o);
      for (const t of r?.seen ?? []) if (TXID.test(norm(t))) seenOnNetwork.add(norm(t));
    },
    release: async (txids) => {
      let n = 0;
      for (const t of txids)
        if (TXID.test(norm(t)) && !released.has(norm(t))) {
          released.add(norm(t));
          n++;
        }
      if (!n) return;
      trim(released);
      await save();
    },
    released: (txid) => released.has(norm(txid)) || (flying.get(norm(txid)) ?? 0) > 0,
    inFlight: async (txids, run, keep) => {
      const ids = txids.map(norm).filter((t) => TXID.test(t));
      for (const t of ids) flying.set(t, (flying.get(t) ?? 0) + 1);
      try {
        const r = await run();
        await marks.release(ids);
        return r;
      } catch (e) {
        if (keep?.(e)) await marks.release(ids);
        throw e;
      } finally {
        for (const t of ids) {
          const n = (flying.get(t) ?? 1) - 1;
          if (n > 0) flying.set(t, n);
          else flying.delete(t);
        }
      }
    },
    hold: async (txid, owner) => {
      if (!TXID.test(norm(txid))) return;
      held.add(norm(txid));
      trim(held);
      // Never another maker over the one recorded (review round 6, c).
      if (owner !== undefined && !owners.has(norm(txid))) owners.set(norm(txid), owner);
      trim(owners);
      await save();
    },
    heldHere: (txid) => held.has(norm(txid)) && !marks.released(txid),
    setOwner: async (txid, owner) => {
      // Never another maker over the one recorded (review round 6, c).
      if (!TXID.test(norm(txid)) || owners.has(norm(txid))) return;
      owners.set(norm(txid), owner);
      trim(owners);
      await save();
    },
    owner: (txid) => owners.get(norm(txid)),
    known: (txid) => owners.has(norm(txid)) || held.has(norm(txid)) || released.has(norm(txid)),
    noteSigned: (txid, o = {}) => {
      if (!TXID.test(norm(txid))) return;
      signed.push({
        seq: ++seq,
        txid: norm(txid),
        rawTx: o.rawTx ? Array.from(o.rawTx) : undefined,
        reference: o.reference,
      });
      if (signed.length > 200) signed.shift();
    },
    signedSeq: () => seq,
    signedSince: (n) =>
      signed.filter((x) => x.seq > n).map(({ txid, rawTx, reference }) => ({ txid, rawTx, reference })),
    markSeen: async (txid) => {
      if (!TXID.test(norm(txid)) || seenOnNetwork.has(norm(txid))) return;
      seenOnNetwork.add(norm(txid));
      trim(seenOnNetwork);
      await save();
    },
    seen: (txid) => seenOnNetwork.has(norm(txid)),
  };
  return marks;
}

type ActionArgs = {
  reference?: string;
  inputs?: { outpoint?: string }[];
  outputs?: { lockingScript?: string; satoshis?: number }[];
  options?: {
    noSend?: boolean;
    signAndProcess?: boolean;
    sendWith?: string[];
    noSendChange?: (string | { txid?: string })[];
  };
};
type ActionResult = { txid?: string; signableTransaction?: { reference?: string } } | undefined;

const outpointTxid = (p: string | { txid?: string }) =>
  typeof p === 'string' ? p.split('.')[0] : String(p?.txid ?? '');

/** The txids an action's options let go: sendWith, and noSendChange's when the action itself goes out. */
export function releasedBy(args: ActionArgs | undefined): string[] {
  const o = args?.options;
  const out = [...(o?.sendWith ?? [])];
  if (!o?.noSend) for (const p of o?.noSendChange ?? []) out.push(outpointTxid(p));
  return out.filter(Boolean);
}

/** Every txid an action names in sendWith or noSendChange (whatever it does with them). */
const namedBy = (args: ActionArgs | undefined) => [
  ...(args?.options?.sendWith ?? []),
  ...(args?.options?.noSendChange ?? []).map(outpointTxid),
];

/** What a site is told when it names a payment it didn't make. */
export const NOT_YOURS = 'That payment was not made by this site, so it can’t send or spend it';

/**
 * Wrap the wallet's createAction and signAction (in place) so this device's own actions make its records: the
 * payments they release (in flight while the call runs, kept only on success), each payment's maker, and each noSend
 * payment as held. A site (any originator but `admin`; a call with none is the wallet's own) may name in sendWith or
 * noSendChange only payments it made: anything else is refused before the call. Install it inside the spending kill
 * switch (guardSpending), so a paused wallet marks nothing.
 */
export function markReleases<T extends object>(wallet: T, marks: ReleaseMarks, o: { admin?: string } = {}): T {
  const w = wallet as Record<string, unknown>;
  /** A two-step action's noSend choice and maker, by its reference, until signAction finishes it. */
  const pending = new Map<string, { noSend: boolean; owner: string }>();
  const ownerOf = (originator: unknown) => (typeof originator === 'string' && originator ? originator : '');
  const isSite = (owner: string) => owner !== '' && owner !== o.admin;
  for (const method of ['createAction', 'signAction'] as const) {
    const original = w[method];
    if (typeof original !== 'function') continue;
    w[method] = async (args: ActionArgs, originator?: unknown, ...rest: unknown[]) => {
      const owner = ownerOf(originator);
      if (isSite(owner)) for (const t of namedBy(args)) if (marks.owner(t) !== owner) throw new Error(NOT_YOURS);
      let r: ActionResult;
      const since = marks.signedSeq();
      /**
       * The txid of this very call, when it threw after reaching storage: a WERR_REVIEW_ACTIONS ("Undelayed createAction
       * or signAction results require review") naming the one transaction this device's signer handed to storage
       * during the call (watchSigned), and of which this device has no record yet. A remote store can send that error
       * with any txid (review round 6, c): one it names that this call didn't sign here is never recorded.
       */
      const ownReview = (e: unknown): string | undefined => {
        const err = e as { name?: unknown; code?: unknown; txid?: unknown } | null;
        if (err?.name !== 'WERR_REVIEW_ACTIONS' && err?.code !== 'WERR_REVIEW_ACTIONS') return undefined;
        const txid = norm(String(err?.txid ?? ''));
        if (!TXID.test(txid) || marks.known(txid)) return undefined;
        // Signed here during this call, and signed FOR this call (round 6 follow-up: another call running at the same
        // time, the wallet's own, may have signed it): its bytes carry this createAction's outputs and inputs, or, for
        // a signAction, it went to storage under this call's reference.
        const s = marks.signedSince(since).find((x) => x.txid === txid);
        return s && signedForCall(method, args, s) ? txid : undefined;
      };
      try {
        r = await marks.inFlight(
          releasedBy(args),
          async () =>
            (original as (...a: unknown[]) => Promise<ActionResult>).apply(wallet, [args, originator, ...rest]),
          (e) => !!ownReview(e),
        );
      } catch (e) {
        // Thrown after this call's own transaction reached storage: its records are kept as for a success (round 5,
        // item 3), only for that transaction and only when it has none yet (round 6, c).
        const txid = ownReview(e);
        if (txid) await record(method, args, owner, { txid });
        throw e;
      }
      await record(method, args, owner, r);
      return r;
    };
  }
  /** This device's records of one action's result: its maker, and held (noSend) or released. */
  async function record(method: 'createAction' | 'signAction', args: ActionArgs, owner: string, r: ActionResult) {
    if (method === 'createAction') {
      const noSend = !!args?.options?.noSend;
      if (r?.txid) {
        await marks.setOwner(r.txid, owner);
        if (noSend) await marks.hold(r.txid, owner);
        else await marks.release([r.txid]);
      } else if (r?.signableTransaction?.reference) pending.set(r.signableTransaction.reference, { noSend, owner });
    } else if (r?.txid) {
      // signAction finishes a two-step createAction (every site's, through the permissions manager): its noSend
      // choice and maker were noted by reference. One not noted (made before this open) is never released by it.
      const p = args?.reference ? pending.get(args.reference) : undefined;
      if (args?.reference) pending.delete(args.reference);
      if (p) {
        await marks.setOwner(r.txid, p.owner);
        if (p.noSend) await marks.hold(r.txid, p.owner);
        else if (!args?.options?.noSend) await marks.release([r.txid]);
      }
    }
  }
  return wallet;
}

/**
 * Is this signed transaction the one `args` asked for? A createAction's: every output it names (script and amount)
 * and every input it names are in the bytes, and it names at least one of them. A signAction's: storage got it under
 * this call's reference.
 */
export function signedForCall(method: 'createAction' | 'signAction', args: ActionArgs | undefined, s: Signed): boolean {
  if (method === 'signAction') return !!args?.reference && s.reference === args.reference;
  const outs = args?.outputs ?? [];
  const ins = args?.inputs ?? [];
  if (!outs.length && !ins.length) return false;
  let tx: Transaction;
  try {
    if (!s.rawTx?.length) return false;
    tx = Transaction.fromBinary(s.rawTx);
  } catch {
    return false;
  }
  const left = tx.outputs.map((x) => `${x.lockingScript.toHex().toLowerCase()}:${x.satoshis}`);
  for (const o of outs) {
    const i = left.indexOf(`${String(o?.lockingScript ?? '').toLowerCase()}:${o?.satoshis}`);
    if (i < 0) return false;
    left.splice(i, 1);
  }
  const spent = new Set(
    tx.inputs.map(
      (x) => `${(x.sourceTXID ?? x.sourceTransaction?.id('hex') ?? '').toLowerCase()}.${x.sourceOutputIndex}`,
    ),
  );
  return ins.every((i) =>
    spent.has(
      String(i?.outpoint ?? '')
        .toLowerCase()
        .replace('_', '.'),
    ),
  );
}

type ProcessArgs = { isNewTx?: boolean; txid?: string; rawTx?: ArrayLike<number>; reference?: string };
const SIGNED = Symbol.for('bwx.releaseMarks.signed');

/**
 * Wrap the storage manager's processAction (in place): every new transaction this device's signer hands to storage
 * is noted (its bytes checked against its txid) before storage answers, so a call that then throws can tell its own
 * transaction from one a remote store names (markReleases). Idempotent; false without processAction.
 */
export function watchSigned(storage: unknown, marks: ReleaseMarks): boolean {
  const s = storage as
    | ({ processAction?: (a: ProcessArgs, ...r: unknown[]) => Promise<unknown> } & {
        [SIGNED]?: true;
      })
    | null;
  if (!s || typeof s.processAction !== 'function') return false;
  if (s[SIGNED]) return true;
  const original = s.processAction.bind(s);
  s.processAction = async (a: ProcessArgs, ...r: unknown[]) => {
    if (a?.isNewTx && a.txid && a.rawTx?.length) {
      try {
        if (Transaction.fromBinary(Array.from(a.rawTx)).id('hex') === norm(a.txid))
          marks.noteSigned(a.txid, { rawTx: a.rawTx, reference: a.reference });
      } catch {
        // bytes that aren't a transaction: not noted
      }
    }
    return original(a, ...r);
  };
  s[SIGNED] = true;
  return true;
}
