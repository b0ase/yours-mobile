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

export type ReleaseRecord = {
  released: string[];
  held?: string[];
  owners?: [string, string][];
  /** Written by round 3 builds; read and dropped. */
  armed?: string[];
};
export type ReleaseKV = { load: () => Promise<ReleaseRecord | null>; save: (r: ReleaseRecord) => Promise<void> };

export type ReleaseMarks = {
  /** Read the kept record (call once at open; marks made before it finishes are kept too). */
  hydrate: () => Promise<void>;
  release: (txids: Iterable<string>) => Promise<void>;
  /** Released now: kept, or in flight in a call still running. */
  released: (txid: string) => boolean;
  /** Count these released while `run` runs; keep them only if it succeeds. */
  inFlight: <T>(txids: string[], run: () => Promise<T>) => Promise<T>;
  hold: (txid: string, owner?: string) => Promise<void>;
  /** Signed noSend on this device (not yet released). */
  heldHere: (txid: string) => boolean;
  setOwner: (txid: string, owner: string) => Promise<void>;
  /** The originator that made it on this device, if any. */
  owner: (txid: string) => string | undefined;
};

/** The most kept of each kind (oldest dropped first): far more than a wallet's pending payments ever are. */
export const MAX_MARKS = 5_000;
const TXID = /^[0-9a-f]{64}$/;
const norm = (t: string) => String(t ?? '').toLowerCase();

export function createReleaseMarks(kv?: ReleaseKV): ReleaseMarks {
  const released = new Set<string>();
  const held = new Set<string>();
  const owners = new Map<string, string>();
  const flying = new Map<string, number>();
  let saving = Promise.resolve();
  const trim = <K>(s: { size: number; delete: (k: K) => boolean; keys: () => IterableIterator<K> }) => {
    while (s.size > MAX_MARKS) s.delete(s.keys().next().value as K);
  };
  const save = () => {
    if (!kv) return Promise.resolve();
    const r: ReleaseRecord = { released: [...released], held: [...held], owners: [...owners] };
    saving = saving.then(() => kv.save(r)).catch(() => undefined);
    return saving;
  };
  const marks: ReleaseMarks = {
    hydrate: async () => {
      const r = await kv?.load().catch(() => null);
      for (const t of r?.released ?? []) if (TXID.test(norm(t))) released.add(norm(t));
      for (const t of r?.held ?? []) if (TXID.test(norm(t))) held.add(norm(t));
      for (const [t, o] of r?.owners ?? []) if (TXID.test(norm(t)) && typeof o === 'string') owners.set(norm(t), o);
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
    inFlight: async (txids, run) => {
      const ids = txids.map(norm).filter((t) => TXID.test(t));
      for (const t of ids) flying.set(t, (flying.get(t) ?? 0) + 1);
      try {
        const r = await run();
        await marks.release(ids);
        return r;
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
      if (owner !== undefined) owners.set(norm(txid), owner);
      trim(owners);
      await save();
    },
    heldHere: (txid) => held.has(norm(txid)) && !marks.released(txid),
    setOwner: async (txid, owner) => {
      if (!TXID.test(norm(txid)) || owners.get(norm(txid)) === owner) return;
      owners.set(norm(txid), owner);
      trim(owners);
      await save();
    },
    owner: (txid) => owners.get(norm(txid)),
  };
  return marks;
}

type ActionArgs = {
  reference?: string;
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
      const r = await marks.inFlight(releasedBy(args), async () =>
        (original as (...a: unknown[]) => Promise<ActionResult>).apply(wallet, [args, originator, ...rest]),
      );
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
      return r;
    };
  }
  return wallet;
}
