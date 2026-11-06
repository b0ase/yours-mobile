/**
 * Where a site's payment goes, on its sheet (b-Aware 26 Oct 2026, N3-3; earlier fzsusanto report). In BRC-100 the site
 * builds its own transaction, so the sheet showed only the amount. createAction's outputs are read here while the
 * action runs, and the spend sheet lists each one: its address (P2PKH, or the owner address of a 1Sat ordinal or
 * token output), "data" for OP_RETURN, or "a custom script".
 *
 * Bound to the request, never to the site (b-Aware 6 Nov 2026, 0xrard #1). The list used to be kept per site, and a
 * second concurrent createAction from the same site found the first one's list: its sheet named the merchant while
 * its outputs paid someone else. Now:
 *  - every createAction is its own run (its outputs, their recipients and a hash of scripts + sats);
 *  - a spending request is matched to the run whose outputs ARE its line items (the toolbox builds them from that
 *    action's own outputs, in order: computeNetSpend), and bound to it by requestID, once;
 *  - two runs a sheet could not tell apart (same output amounts, different scripts) never run at once: the later one
 *    waits until the earlier has finished, so a match is never a guess. An action routed to a permission module
 *    (whose line items are the module's, not the site's) runs alone and its sheet gets no list;
 *  - Allow is checked again (spendApprovalMatches): the list and hash on the request must be its bound run's.
 * A request that matches no run gets no list; one matching runs with different payees is refused.
 */
import { Hash, Utils } from '@bsv/sdk';
import { routesToModule } from './pModuleSpendGate';

export type Recipient = { to: string; satoshis: number };

/** The toolbox's "as much as is left" output amount (resolved from the transaction, so it matches any amount). */
const MAX_POSSIBLE_SATOSHIS = 0x775f05a073fff;
/** The line the toolbox appends after the site's outputs when storage charges for the action. */
const SERVICE_CHARGE = 'Storage service charge';

export const RECIPIENTS_REFUSAL =
  'Two payments from this site are waiting with the same amounts but different payees, so the wallet cannot show ' +
  'where this one goes. Nothing was paid. Try again.';

type Run = {
  site: string;
  /** Output amounts in order; undefined for a "max" output (any amount). */
  sats: (number | undefined)[];
  recipients: Recipient[];
  hash: string;
  /** Routed to a permission module: its spend's line items are not the site's outputs. Runs alone, no list. */
  opaque: boolean;
  requestID?: string;
  done: Promise<void>;
};

const runs = new Map<string, Run[]>();
const bound = new Map<string, Run>();

const P2PKH = /76a914([0-9a-f]{40})88ac$/i;

/** A short description of a locking script's payee. */
export const describeLockingScript = (hex: unknown): string => {
  if (typeof hex !== 'string' || !/^[0-9a-f]*$/i.test(hex)) return 'a custom script';
  if (/^(00)?6a/i.test(hex)) return 'data (OP_RETURN)';
  const m = P2PKH.exec(hex);
  if (!m) return 'a custom script';
  const address = Utils.toBase58Check(Utils.toArray(m[1], 'hex'), [0]);
  // Exactly P2PKH, or P2PKH after an inscription envelope (1Sat ordinal / token).
  return hex.length === 50 ? address : `${address} (token or ordinal)`;
};

type Output = { lockingScript?: unknown; satoshis?: unknown };
type CreateArgs = { outputs?: Output[]; labels?: unknown };
type LineItem = { type?: unknown; description?: unknown; satoshis?: unknown };

/** The request fields read here (a toolbox spending PermissionRequest, plus what the background attached). */
export type SpendRequestLike = {
  requestID: string;
  type?: string;
  spending?: { satoshis?: number; lineItems?: LineItem[] };
  recipients?: Recipient[];
  recipientsHash?: string;
};

const satsOf = (o: Output): number | undefined =>
  typeof o?.satoshis === 'number' && o.satoshis !== MAX_POSSIBLE_SATOSHIS ? o.satoshis : undefined;

/** sha256 over every output's locking script and amount, in order. */
export const outputsHash = (outputs: Output[]): string =>
  Utils.toHex(
    Hash.sha256(
      Utils.toArray(
        JSON.stringify(
          outputs.map((o) => [
            typeof o?.lockingScript === 'string' ? o.lockingScript.toLowerCase() : '',
            typeof o?.satoshis === 'number' ? o.satoshis : null,
          ]),
        ),
        'utf8',
      ),
    ),
  );

const recipientsOf = (outputs: Output[]): Recipient[] =>
  outputs.map((o) => ({
    to: describeLockingScript(o?.lockingScript),
    satoshis: typeof o?.satoshis === 'number' ? o.satoshis : 0,
  }));

const sameAmount = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined || a === b;

/** Could one run's spend line items also be read as the other's? (Amounts agree on the common part.) */
const lookAlike = (a: Run, b: Run): boolean => {
  const n = Math.min(a.sats.length, b.sats.length);
  for (let i = 0; i < n; i++) if (!sameAmount(a.sats[i], b.sats[i])) return false;
  return true;
};

/** Must `b` wait for `a` (already running) before it starts? */
const conflicts = (a: Run, b: Run): boolean => a.opaque || b.opaque || (a.hash !== b.hash && lookAlike(a, b));

/** Are this request's line items exactly the outputs of this run (plus an optional storage charge line)? */
const matches = (run: Run, request: SpendRequestLike): boolean => {
  if (run.opaque) return false;
  const items = request.spending?.lineItems;
  if (!Array.isArray(items)) return false;
  const outs = items.filter((l) => l?.type === 'output');
  const n = run.sats.length;
  if (outs.length !== n && !(outs.length === n + 1 && outs[n]?.description === SERVICE_CHARGE)) return false;
  for (let i = 0; i < n; i++) {
    const s = outs[i]?.satoshis;
    if (typeof s !== 'number' || !sameAmount(run.sats[i], s)) return false;
  }
  return true;
};

export type SheetRecipients = { recipients: Recipient[]; hash: string } | { refuse: string } | null;

/**
 * The outputs of THIS spending request's action, for its sheet, bound to the request. null when no running action of
 * the site matches it (no list is shown); `refuse` when the match is not certain.
 */
export const recipientsForSheet = (site: string, request: SpendRequestLike): SheetRecipients => {
  if (!site || !request?.requestID) return null;
  const already = bound.get(request.requestID);
  if (already) return { recipients: already.recipients.map((x) => ({ ...x })), hash: already.hash };
  const candidates = (runs.get(site) ?? []).filter((r) => !r.requestID && matches(r, request));
  if (candidates.length === 0) return null;
  if (candidates.some((c) => c.hash !== candidates[0].hash)) return { refuse: RECIPIENTS_REFUSAL };
  const run = candidates[0];
  run.requestID = request.requestID;
  bound.set(request.requestID, run);
  return { recipients: run.recipients.map((x) => ({ ...x })), hash: run.hash };
};

/**
 * Checked when the person taps Allow: the list shown on this request is its own bound action's outputs. A request that
 * showed no list passes (nothing was claimed); one that showed a list passes only while it is still bound to the
 * running action with that hash, the same recipients, and line items that are still that action's outputs.
 */
export const spendApprovalMatches = (request: SpendRequestLike): boolean => {
  if (request.type !== undefined && request.type !== 'spending') return true;
  const shown = request.recipients;
  if (!shown?.length && !request.recipientsHash) return true;
  const run = bound.get(request.requestID);
  if (!run || run.requestID !== request.requestID) return false;
  if (request.recipientsHash !== run.hash) return false;
  if (!matches(run, request)) return false;
  if (!shown || shown.length !== run.recipients.length) return false;
  return shown.every((x, i) => x.to === run.recipients[i].to && x.satoshis === run.recipients[i].satoshis);
};

export function guardSpendRecipients<T extends object>(
  manager: T,
  deps: { adminOriginator: string; normalize: (o: string) => string },
): T {
  const m = manager as Record<string, unknown>;
  const create = m.createAction as ((args: CreateArgs, originator?: string) => Promise<unknown>) | undefined;
  if (typeof create !== 'function') return manager;
  m.createAction = async (args: CreateArgs, originator?: string) => {
    const site = originator && originator !== deps.adminOriginator ? deps.normalize(originator) : '';
    const outputs = Array.isArray(args?.outputs) ? args.outputs : [];
    const opaque = routesToModule(args);
    if (!site || (!outputs.length && !opaque)) return create.call(manager, args, originator);
    // Read now: the manager encrypts descriptions and modules may rewrite outputs in place.
    let finish: () => void = () => undefined;
    const run: Run = {
      site,
      sats: outputs.map(satsOf),
      recipients: recipientsOf(outputs),
      hash: outputsHash(outputs),
      opaque,
      done: new Promise<void>((r) => {
        finish = r;
      }),
    };
    // Wait for every running action of this site that a sheet could confuse with this one. Checked and joined in
    // the same turn, so two callers never both find the way clear.
    for (;;) {
      const blocking = (runs.get(site) ?? []).filter((r) => conflicts(r, run));
      if (blocking.length === 0) break;
      await Promise.all(blocking.map((r) => r.done));
    }
    runs.set(site, [...(runs.get(site) ?? []), run]);
    try {
      return await create.call(manager, args, originator);
    } finally {
      const left = (runs.get(site) ?? []).filter((r) => r !== run);
      if (left.length) runs.set(site, left);
      else runs.delete(site);
      if (run.requestID && bound.get(run.requestID) === run) bound.delete(run.requestID);
      finish();
    }
  };
  return manager;
}
