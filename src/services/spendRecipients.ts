/**
 * Where a site's payment goes, on its sheet (b-Aware 26 Oct 2026, N3-3; earlier fzsusanto report). In BRC-100 the site
 * builds its own transaction, so the sheet showed only the amount. createAction's outputs are read here while the
 * action runs, and the spend sheet lists each one: its address (an exact P2PKH, or the exact P2PKH lock under a 1Sat
 * ordinal or token envelope), "data" for OP_RETURN, or "a custom script".
 *
 * Bound to the request, never to the site (b-Aware 6 Nov 2026, 0xrard #1, and its review). The list used to be kept
 * per site, and a second concurrent createAction from the same site found the first one's list: its sheet named the
 * merchant while its outputs paid someone else. Now:
 *  - every createAction is its own run (its outputs, their recipients and a hash of scripts + sats), keyed by the
 *    manager's own site key (permissionSite.ts: hostname only, so "shop.example:8443" is "shop.example");
 *  - a spending request is matched to the run whose outputs ARE its line items (the toolbox builds them from that
 *    action's own outputs, in order: computeNetSpend), and bound to it by requestID, once;
 *  - two runs a sheet could not tell apart (same output amounts, different scripts or labels) never run at once: the
 *    later one waits until the earlier has finished, so a match is never a guess;
 *  - an action routed to a permission module runs alone on its site. BRC-177 nosend: its line items are the site's
 *    own outputs, and its prefunding request (no line items) is the site's only run, so both list them. An asset
 *    module rewrites the outputs: the spend gate notes what it really sends (noteModuleOutputs) and that is listed;
 *  - Allow is checked again (spendApprovalMatches): the list and hash on the request must be its bound run's;
 *  - a run that never ends stops holding its site after SPEND_RUN_HOLD_MS, or when the wallet closes
 *    (releaseSpendRuns). A released run is never shown, and until its action ends any request that could be its
 *    own is refused unless every possible owner pays the same outputs.
 * A request that matches no run gets no list (background.ts then refuses it: a paying sheet always lists its payees);
 * one matching runs with different payees is refused.
 */
import { Hash, Utils } from '@bsv/sdk';
import { permissionSite } from './permissionSite';

export type Recipient = { to: string; satoshis: number };

/** The toolbox's "as much as is left" output amount (resolved from the transaction, so it matches any amount). */
const MAX_POSSIBLE_SATOSHIS = 0x775f05a073fff;
/** The line the toolbox appends after the site's outputs when storage charges for the action. */
const SERVICE_CHARGE = 'Storage service charge';
/**
 * A run older than this no longer holds its site. Sheets no longer expire (BRC-219), so a sheet left open past this
 * while the same site starts a conflicting payment loses its run: its Allow then fails spendApprovalMatches and is
 * refused (never paid). Fail-safe; see the BRC-219 notes in services/promptLiveness.ts.
 */
export const SPEND_RUN_HOLD_MS = 180_000;

/** background.ts: a paying sheet always lists its payees; a payment the wallet cannot tie to its outputs is refused. */
export const NO_PAYEES_REFUSAL =
  "bWalletX couldn't read where this payment goes, so it was not shown or paid. Ask the site to try again.";

export const RECIPIENTS_REFUSAL =
  'Two payments from this site are waiting with the same amounts but different payees, so the wallet cannot show ' +
  'where this one goes. Nothing was paid. Try again.';

type Run = {
  site: string;
  /** Output amounts in order; undefined for a "max" output (any amount). */
  sats: (number | undefined)[];
  recipients: Recipient[];
  hash: string;
  labelsKey: string;
  /** Routed to a permission module: runs alone on its site. */
  solo: boolean;
  /** An asset module rewrites the outputs: nothing is listed until the spend gate notes what it sends. */
  asset: boolean;
  noted: boolean;
  /** The request bound to this run's spend (line items), and to a BRC-177 prefunding (none). */
  fullID?: string;
  preID?: string;
  startedAt: number;
  released: boolean;
  done: Promise<void>;
  finish: () => void;
};

const runs = new Map<string, Run[]>();
const bound = new Map<string, Run>();
/** Runs released (timeout, wallet closed) whose createAction has not ended yet: they block nothing, match nothing. */
const ghosts = new Map<string, Set<Run>>();

// ── Payees ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const EXACT_P2PKH = /^76a914([0-9a-f]{40})88ac$/;

/**
 * Where an OP_FALSE OP_IF "ord" … OP_ENDIF envelope ends (hex offset), or -1. Inside it only pushes and small
 * numbers are allowed, so the envelope is data and nothing else.
 */
const envelopeEnd = (hex: string): number => {
  const b = Utils.toArray(hex, 'hex');
  if (b[0] !== 0x00 || b[1] !== 0x63 || b[2] !== 0x03 || b[3] !== 0x6f || b[4] !== 0x72 || b[5] !== 0x64) return -1;
  let i = 6;
  while (i < b.length) {
    const op = b[i++];
    if (op === 0x68) return i * 2;
    let len = 0;
    if (op >= 0x01 && op <= 0x4b) len = op;
    else if (op === 0x4c) len = b[i++];
    else if (op === 0x4d) {
      len = b[i] | (b[i + 1] << 8);
      i += 2;
    } else if (op === 0x4e) {
      len = (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
      i += 4;
    } else if (op === 0x00 || op === 0x4f || (op >= 0x51 && op <= 0x60)) continue;
    else return -1; // an opcode inside the envelope
    if (len === undefined || Number.isNaN(len) || i + len > b.length) return -1;
    i += len;
  }
  return -1;
};

/**
 * A short description of a locking script's payee. An address is named only for a script that pays exactly that
 * address (review of 0xrard: "<attacker P2PKH> OP_RETURN <merchant P2PKH>" was shown as the merchant).
 */
export const describeLockingScript = (hex: unknown): string => {
  if (typeof hex !== 'string' || !/^([0-9a-f]{2})*$/i.test(hex)) return 'a custom script';
  const h = hex.toLowerCase();
  if (/^(00)?6a/.test(h)) return 'data (OP_RETURN)';
  const exact = EXACT_P2PKH.exec(h);
  if (exact) return Utils.toBase58Check(Utils.toArray(exact[1], 'hex'), [0]);
  const end = envelopeEnd(h);
  const lock = end > 0 ? EXACT_P2PKH.exec(h.slice(end)) : null;
  if (lock) return `${Utils.toBase58Check(Utils.toArray(lock[1], 'hex'), [0])} (token or ordinal)`;
  return 'a custom script';
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

// ── Matching ────────────────────────────────────────────────────────────────────────────────────────────────────────

const sameAmount = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined || a === b;

/**
 * Are these line items exactly outputs with these amounts (plus an optional storage charge line)? Shared with
 * labelsOnSpend.ts, which matches its own runs the same way.
 */
export const lineItemsMatch = (sats: (number | undefined)[], lineItems: unknown): boolean => {
  if (!Array.isArray(lineItems)) return false;
  const outs = (lineItems as LineItem[]).filter((l) => l?.type === 'output');
  const n = sats.length;
  if (outs.length !== n && !(outs.length === n + 1 && outs[n]?.description === SERVICE_CHARGE)) return false;
  for (let i = 0; i < n; i++) {
    const s = outs[i]?.satoshis;
    if (typeof s !== 'number' || !sameAmount(sats[i], s)) return false;
  }
  return true;
};

/** Could one run's spend line items also be read as the other's? (Amounts agree on the common part.) */
const lookAlike = (a: Run, b: Run): boolean => {
  const n = Math.min(a.sats.length, b.sats.length);
  for (let i = 0; i < n; i++) if (!sameAmount(a.sats[i], b.sats[i])) return false;
  return true;
};

/** Must `b` wait for `a` (already running) before it starts? */
const conflicts = (a: Run, b: Run): boolean =>
  a.solo || b.solo || ((a.hash !== b.hash || a.labelsKey !== b.labelsKey) && lookAlike(a, b));

/** The toolbox's BRC-177 prefunding amount (index.client.mjs brc177PreflightSatoshis). */
const preflightSats = (run: Run) =>
  Math.max(
    1,
    run.sats.reduce<number>((s, x) => s + (x ?? 0), 0),
  );

/** Which of the run's requests this is: its spend ('full'), its BRC-177 prefunding ('pre'), or neither. */
const matchKind = (run: Run, request: SpendRequestLike): 'full' | 'pre' | null =>
  run.released ? null : outputsKind(run, request);

/** As matchKind, also for a released run (a ghost: its action may still raise a request). */
const outputsKind = (run: Run, request: SpendRequestLike): 'full' | 'pre' | null => {
  if (run.asset && !run.noted) return null;
  const items = request.spending?.lineItems;
  if (Array.isArray(items)) return lineItemsMatch(run.sats, items) ? 'full' : null;
  // No line items: only the BRC-177 prefunding, raised for the site's only (module-routed) run.
  return run.solo && !run.asset && request.spending?.satoshis === preflightSats(run) ? 'pre' : null;
};

const slotFree = (run: Run, kind: 'full' | 'pre') => (kind === 'full' ? !run.fullID : !run.preID);
const boundTo = (run: Run, requestID: string) => run.fullID === requestID || run.preID === requestID;

export type SheetRecipients = { recipients: Recipient[]; hash: string } | { refuse: string } | null;

const listOf = (run: Run) => ({ recipients: run.recipients.map((x) => ({ ...x })), hash: run.hash });

/**
 * The outputs of THIS spending request's action, for its sheet, bound to the request. null when no running action of
 * the site matches it (no list); `refuse` when the match is not certain. `site` is normalised here.
 */
export const recipientsForSheet = (site: string, request: SpendRequestLike): SheetRecipients => {
  const key = permissionSite(site);
  if (!key || !request?.requestID) return null;
  const already = bound.get(request.requestID);
  if (already) return boundTo(already, request.requestID) && matchKind(already, request) ? listOf(already) : null;
  const found = (runs.get(key) ?? [])
    .map((r) => ({ r, kind: matchKind(r, request) }))
    .filter((c): c is { r: Run; kind: 'full' | 'pre' } => !!c.kind && slotFree(c.r, c.kind));
  // A released run whose action is still going could be this request's own: if it might be, and its payees differ
  // (or nothing live matches), the wallet cannot say where this goes.
  const ghostHashes = [...(ghosts.get(key) ?? [])].filter((g) => outputsKind(g, request)).map((g) => g.hash);
  if (found.length === 0) return ghostHashes.length ? { refuse: RECIPIENTS_REFUSAL } : null;
  if ([...found.map((c) => c.r.hash), ...ghostHashes].some((h) => h !== found[0].r.hash))
    return { refuse: RECIPIENTS_REFUSAL };
  const { r: run, kind } = found[0];
  if (kind === 'full') run.fullID = request.requestID;
  else run.preID = request.requestID;
  bound.set(request.requestID, run);
  return listOf(run);
};

/**
 * Checked when the person taps Allow: the list shown on this request is its own bound action's outputs. A request that
 * showed no list passes (nothing was claimed; background.ts never shows a paying one); one that showed a list passes
 * only while it is still bound to the running action with that hash, the same recipients, and line items that are
 * still that action's outputs.
 */
export const spendApprovalMatches = (request: SpendRequestLike): boolean => {
  if (request.type !== undefined && request.type !== 'spending') return true;
  const shown = request.recipients;
  if (!shown?.length && request.recipientsHash === undefined) return true;
  const run = bound.get(request.requestID);
  if (!run || !boundTo(run, request.requestID) || !matchKind(run, request)) return false;
  if (request.recipientsHash !== run.hash) return false;
  if (!shown || shown.length !== run.recipients.length) return false;
  return shown.every((x, i) => x.to === run.recipients[i].to && x.satoshis === run.recipients[i].satoshis);
};

/**
 * pModuleSpendGate.ts: what an asset module really sends, just before its spend check. The site's module-routed run is
 * alone on its site (solo), so it is that one.
 */
export const noteModuleOutputs = (originator: unknown, outputs: Output[] | undefined): void => {
  const run = (runs.get(permissionSite(originator)) ?? []).find((r) => r.asset && !r.released);
  if (!run || !Array.isArray(outputs)) return;
  run.sats = outputs.map(satsOf);
  run.recipients = recipientsOf(outputs);
  run.hash = outputsHash(outputs);
  run.noted = true;
};

/** The run stops holding its site and is never shown again. Until its action ends it stays a ghost. */
const release = (run: Run) => {
  if (run.released) return;
  run.released = true;
  const left = (runs.get(run.site) ?? []).filter((r) => r !== run);
  if (left.length) runs.set(run.site, left);
  else runs.delete(run.site);
  for (const id of [run.fullID, run.preID]) if (id && bound.get(id) === run) bound.delete(id);
  ghosts.set(run.site, (ghosts.get(run.site) ?? new Set()).add(run));
  run.finish();
};

/** Its createAction ended. */
const end = (run: Run) => {
  release(run);
  const g = ghosts.get(run.site);
  g?.delete(run);
  if (g && g.size === 0) ghosts.delete(run.site);
};

/** The wallet closed (background.ts dropWalletContext): every running action stops holding its site. */
export const releaseSpendRuns = (): void => {
  for (const list of [...runs.values()]) for (const r of list) release(r);
};

/** The second word of a module label or basket ("p nosend expiry …" → "nosend"). */
const moduleSchemes = (args: CreateArgs): string[] => {
  const labels = Array.isArray(args?.labels) ? (args.labels as unknown[]) : [];
  const baskets = (Array.isArray(args?.outputs) ? args.outputs : []).map((o) => (o as { basket?: unknown })?.basket);
  return [...labels, ...baskets]
    .filter((x): x is string => typeof x === 'string' && x.startsWith('p '))
    .map((x) => x.split(' ')[1] ?? '');
};

export function guardSpendRecipients<T extends object>(
  manager: T,
  deps: { adminOriginator: string; normalize?: (o: string) => string; holdMs?: number },
): T {
  const m = manager as Record<string, unknown>;
  const create = m.createAction as ((args: CreateArgs, originator?: string) => Promise<unknown>) | undefined;
  if (typeof create !== 'function') return manager;
  const holdMs = deps.holdMs ?? SPEND_RUN_HOLD_MS;
  m.createAction = async (args: CreateArgs, originator?: string) => {
    // The manager's own key (hostname only): its requests carry this form.
    const site = originator && originator !== deps.adminOriginator ? permissionSite(originator) : '';
    if (!site) return create.call(manager, args, originator);
    const outputs = Array.isArray(args?.outputs) ? args.outputs : [];
    // Routed to a permission module (pModuleSpendGate.ts routesToModule: a "p …" label or basket).
    const schemes = moduleSchemes(args);
    const solo = schemes.length > 0;
    // Read now: the manager encrypts descriptions and modules may rewrite outputs in place.
    let finish: () => void = () => undefined;
    const run: Run = {
      site,
      sats: outputs.map(satsOf),
      recipients: recipientsOf(outputs),
      hash: outputsHash(outputs),
      labelsKey: JSON.stringify(Array.isArray(args?.labels) ? [...(args.labels as unknown[])].map(String).sort() : []),
      solo,
      asset: schemes.some((s) => s !== 'nosend'),
      noted: false,
      startedAt: 0,
      released: false,
      done: new Promise<void>((r) => {
        finish = r;
      }),
      finish: () => finish(),
    };
    // Wait for every running action of this site that a sheet could confuse with this one. Checked and joined in
    // the same turn, so two callers never both find the way clear. A run held past holdMs is dropped.
    for (;;) {
      const now = Date.now();
      for (const r of runs.get(site) ?? []) if (now - r.startedAt > holdMs) release(r);
      const blocking = (runs.get(site) ?? []).filter((r) => conflicts(r, run));
      if (blocking.length === 0) break;
      const oldest = Math.min(...blocking.map((r) => r.startedAt));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ...blocking.map((r) => r.done),
        new Promise<void>((r) => {
          timer = setTimeout(r, Math.max(1, oldest + holdMs - now + 1));
        }),
      ]);
      clearTimeout(timer);
    }
    run.startedAt = Date.now();
    runs.set(site, [...(runs.get(site) ?? []), run]);
    try {
      return await create.call(manager, args, originator);
    } finally {
      end(run);
    }
  };
  return manager;
}
