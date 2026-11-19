/**
 * This device's own word on which payments may go out (task 54 scope item 2; review round 3, F1 and F2).
 *
 * A payment signed and withheld (noSend) is held: nothing a backup says may send it. Only this device's own action
 * releases it, and the release is kept here, on this device only (never in a backup, never synced):
 *  - `released`: txids this device let go: the user's "Send now" on a held payment, a createAction / signAction naming
 *    them in sendWith (or spending their change through noSendChange in a payment that goes out), and every payment
 *    this device built that is not noSend. services/beefAncestors.ts guardPostBeef refuses a broadcast carrying a
 *    held transaction (noSend here) without one.
 *  - `armed`: txids of BRC-177 expiring noSend actions this device created itself; only those may ever post a reclaim
 *    (services/reclaimGuard.ts).
 * A wiped or restored device starts with none: a payment it gets back from a backup is held until the user releases it.
 */
import { hasBrc177NoSendExpiryLabel } from '@bsv/wallet-toolbox-client';

export type ReleaseRecord = { released: string[]; armed: string[] };
export type ReleaseKV = { load: () => Promise<ReleaseRecord | null>; save: (r: ReleaseRecord) => Promise<void> };

export type ReleaseMarks = {
  /** Read the kept record (call once at open; marks made before it finishes are kept too). */
  hydrate: () => Promise<void>;
  release: (txids: Iterable<string>) => Promise<void>;
  released: (txid: string) => boolean;
  arm: (txid: string) => Promise<void>;
  armed: (txid: string) => boolean;
};

/** The most kept of each kind (oldest dropped first): far more than a wallet's pending payments ever are. */
export const MAX_MARKS = 5_000;
const TXID = /^[0-9a-f]{64}$/;

export function createReleaseMarks(kv?: ReleaseKV): ReleaseMarks {
  const released = new Set<string>();
  const armed = new Set<string>();
  let saving = Promise.resolve();
  const trim = (s: Set<string>) => {
    while (s.size > MAX_MARKS) s.delete(s.values().next().value as string);
  };
  const save = () => {
    if (!kv) return Promise.resolve();
    const r = { released: [...released], armed: [...armed] };
    saving = saving.then(() => kv.save(r)).catch(() => undefined);
    return saving;
  };
  const norm = (t: string) => String(t ?? '').toLowerCase();
  return {
    hydrate: async () => {
      const r = await kv?.load().catch(() => null);
      for (const t of r?.released ?? []) if (TXID.test(norm(t))) released.add(norm(t));
      for (const t of r?.armed ?? []) if (TXID.test(norm(t))) armed.add(norm(t));
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
    released: (txid) => released.has(norm(txid)),
    arm: async (txid) => {
      if (!TXID.test(norm(txid))) return;
      armed.add(norm(txid));
      trim(armed);
      await save();
    },
    armed: (txid) => armed.has(norm(txid)),
  };
}

type ActionArgs = {
  labels?: string[];
  options?: { noSend?: boolean; sendWith?: string[]; noSendChange?: string[] };
};
type ActionResult = { txid?: string } | undefined;

/** The txids an action's options let go: sendWith, and noSendChange's when the action itself goes out. */
export function releasedBy(args: ActionArgs | undefined): string[] {
  const o = args?.options;
  const out = [...(o?.sendWith ?? [])];
  if (!o?.noSend) for (const p of o?.noSendChange ?? []) out.push(String(p).split('.')[0]);
  return out;
}

/**
 * Wrap the wallet's createAction and signAction (in place) so this device's own actions make its marks: what they
 * release before they run (the broadcast happens inside), the payment itself once built when it is not noSend, and a
 * BRC-177 expiring action as armed. Install it inside the spending kill switch (guardSpending), so a paused wallet
 * marks nothing.
 */
export function markReleases<T extends object>(wallet: T, marks: ReleaseMarks): T {
  const w = wallet as Record<string, unknown>;
  for (const method of ['createAction', 'signAction'] as const) {
    const original = w[method];
    if (typeof original !== 'function') continue;
    w[method] = async (args: ActionArgs, ...rest: unknown[]) => {
      await marks.release(releasedBy(args));
      const r = (await (original as (...a: unknown[]) => Promise<ActionResult>).apply(wallet, [args, ...rest])) as
        | ActionResult
        | undefined;
      // signAction can't tell whether its createAction was noSend (a two-step noSend, e.g. a Store payment): only what
      // its sendWith names is released, never the payment it signs.
      const txid = method === 'createAction' ? r?.txid : undefined;
      if (txid) {
        if (!args?.options?.noSend) await marks.release([txid]);
        if (hasBrc177NoSendExpiryLabel(args?.labels)) await marks.arm(txid);
      }
      return r;
    };
  }
  return wallet;
}
