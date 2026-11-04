/**
 * Asset permission modules go through the wallet's spend gate (b-Aware D-L, Dony Dwi Prastiyo, 25 Oct 2026).
 *
 * BRC-111: a createAction label, or an output basket, starting "p <scheme> " hands the action to that scheme's
 * permission module (@1sat/permission-module: 1sat, bsv21, opns, lock; services/initWallet.ts). The module shows its
 * own sheet, built from the request before anything is funded, and then, in its createAction onResponse, finishes the
 * transaction ITSELF on the base wallet: it unlocks the inputs it resolved and calls signAction, which broadcasts. The
 * permissions manager reaches its spend check (ensureSpendingAuthorization: the pay sheet, envelopes, the month's spend
 * ledger, the labels line) and its output check only when the signable transaction comes back to it, and after a
 * module it never does. So one "p" label let a site skip every wallet-level spend guard, and
 * "p <scheme> input id <key>" had the module load and sign the wallet's own ordinals, tokens, names and locks.
 *
 * For every originator but the wallet's own:
 *  1. A site may not name wallet-held assets for a module to load ("p <scheme> input id <key>", exactly as the
 *     module's own parser reads it), nor hand the module resolved spends of its own (`__pendingResolvedSpends`: an
 *     outpoint plus a record naming the key to sign with). Refused before anything is built. A site sells the wallet's
 *     tokens only through the sell sheet in siteTokens.ts.
 *  2. Before a module finishes, the transaction it is about to sign gets the checks a site's payment gets without one:
 *     the requested outputs must be in it (the manager's verifyRequestedOutputsPresent), and what it takes from the
 *     wallet (outputs + fee - the inputs the site named itself: the manager's computeNetSpend) goes to
 *     ensureSpendingAuthorization as the instance has it, with every guard installed on it. Refused, or any check
 *     failing: the action is aborted on the base wallet and nothing is signed.
 * Buying from an outside listing ("p 1sat input <outpoint>") keeps working, behind the module's sheet and the pay sheet.
 *
 * The toolbox is pinned and patched (pnpm); this wraps the manager instance, as the other guards do, and leaves the
 * toolbox untouched. If the manager ever lacks a method the gate needs, every site action routed to a module is
 * refused instead of let through unchecked.
 */
import { Transaction } from '@bsv/sdk';
import { parseOneInputLabel } from '@1sat/types';

export const HELD_ASSET_REFUSAL =
  "A site can't name your wallet's own ordinals, tokens, names or locks for bWalletX to sign";
export const MODULE_GATE_UNAVAILABLE = "bWalletX couldn't check this payment, so it was refused";

/** @1sat/actions PENDING_RESOLVED_SPENDS_KEY (pipeline/spendTargets.js; not exported from the package root). */
const PENDING_RESOLVED_SPENDS = '__pendingResolvedSpends';

type Output = { lockingScript?: string; satoshis?: number; basket?: unknown };
type CreateArgs = {
  labels?: unknown;
  inputs?: { outpoint?: unknown }[];
  outputs?: Output[];
  description?: unknown;
};
type ModuleRequest = { method: string; args: unknown; originator?: string };
type ModuleContext = { method: string; originator?: string };
type PModule = {
  onRequest(req: ModuleRequest): Promise<{ args: unknown }>;
  onResponse(res: unknown, ctx: ModuleContext): Promise<unknown>;
};
type SignableResult = { signableTransaction?: { tx?: number[]; reference?: string } };
type SpendArgs = { originator?: string; satoshis: number; lineItems?: unknown[]; reason?: string };
type Manager = {
  createAction?: (args: unknown, originator?: string) => Promise<unknown>;
  callCreateActionWithPModules?: (
    args: unknown,
    modules: Map<string, PModule>,
    originator?: string,
  ) => Promise<unknown>;
  verifyRequestedOutputsPresent?: (tx: Transaction, args: unknown) => Map<number, number>;
  computeNetSpend?: (
    tx: Transaction,
    args: unknown,
    inputDescriptions: Record<number, string>,
    outputDescriptions: Record<number, string>,
    resolved: Map<number, number>,
  ) => { netSpent: number; lineItems: unknown[] };
  ensureSpendingAuthorization?: (args: SpendArgs) => Promise<boolean>;
  maybeDecryptMetadata?: (ciphertext: string) => Promise<string>;
  underlying?: { abortAction?: (args: { reference: string }) => Promise<unknown> };
};

/** Pure: does a request name wallet-held assets for a module to load, or bring resolved spends of its own? */
export const namesHeldAssets = (args: unknown): boolean => {
  if (!args || typeof args !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(args, PENDING_RESOLVED_SPENDS)) return true;
  const labels = (args as CreateArgs).labels;
  return Array.isArray(labels) && labels.some((l) => typeof l === 'string' && parseOneInputLabel(l)?.kind === 'id');
};

/** Pure: would the manager hand this request to a permission module ("p " label or "p " output basket)? */
export const routesToModule = (args: unknown): boolean => {
  if (!args || typeof args !== 'object') return false;
  const a = args as CreateArgs;
  const labels = Array.isArray(a.labels) ? a.labels : [];
  const outputs = Array.isArray(a.outputs) ? a.outputs : [];
  return (
    labels.some((l) => typeof l === 'string' && l.startsWith('p ')) ||
    outputs.some((o) => typeof o?.basket === 'string' && o.basket.startsWith('p '))
  );
};

export function guardPModuleSpends<T extends object>(manager: T, deps: { adminOriginator: string }): T {
  const m = manager as T & Manager;
  const outside = (originator?: string) => originator !== deps.adminOriginator;
  const call = m.callCreateActionWithPModules;
  const able =
    typeof call === 'function' &&
    typeof m.verifyRequestedOutputsPresent === 'function' &&
    typeof m.computeNetSpend === 'function' &&
    typeof m.ensureSpendingAuthorization === 'function' &&
    typeof m.underlying?.abortAction === 'function';

  const create = m.createAction;
  if (typeof create === 'function')
    m.createAction = async (args: unknown, originator?: string) => {
      if (outside(originator)) {
        if (namesHeldAssets(args)) throw new Error(HELD_ASSET_REFUSAL);
        if (!able && routesToModule(args)) throw new Error(MODULE_GATE_UNAVAILABLE);
      }
      return create.call(manager, args, originator);
    };
  if (!able) return manager;

  m.callCreateActionWithPModules = async (finalArgs: unknown, modules: Map<string, PModule>, originator?: string) => {
    if (!outside(originator) || !(modules instanceof Map) || modules.size === 0)
      return call.call(manager, finalArgs, modules, originator);
    if (namesHeldAssets(finalArgs)) throw new Error(HELD_ASSET_REFUSAL);
    const asked = (finalArgs ?? {}) as CreateArgs;
    // What actually goes to the base wallet's createAction: the last module's transformed request.
    let sent: CreateArgs = asked;
    let gated = false;

    const gate = async (res: SignableResult) => {
      const { tx: atomic, reference } = res.signableTransaction ?? {};
      try {
        if (!atomic || !reference) throw new Error(MODULE_GATE_UNAVAILABLE);
        const tx = Transaction.fromAtomicBEEF(Array.from(atomic));
        // Storage built what was asked for (the same check the manager makes without a module).
        const resolved = m.verifyRequestedOutputsPresent!(tx, sent);
        // Only inputs the site named itself count as its own money; anything a module added is the wallet's.
        const { netSpent, lineItems } = m.computeNetSpend!(
          tx,
          { inputs: asked.inputs ?? [], outputs: sent.outputs ?? [] },
          {},
          {},
          resolved,
        );
        if (netSpent > 0) {
          const ok = await m.ensureSpendingAuthorization!({
            originator,
            satoshis: netSpent,
            lineItems,
            reason: await plainDescription(m, asked.description),
          });
          if (!ok) throw new Error('This payment was not approved');
        }
      } catch (err) {
        if (reference) await Promise.resolve(m.underlying!.abortAction!({ reference })).catch(() => undefined);
        throw err;
      }
    };

    const gatedModules = new Map<string, PModule>();
    for (const [scheme, mod] of modules)
      gatedModules.set(scheme, {
        onRequest: async (req) => {
          const r = await mod.onRequest(req);
          if (req.method === 'createAction' && r?.args && typeof r.args === 'object') sent = r.args as CreateArgs;
          return r;
        },
        onResponse: async (res, ctx) => {
          // The first module to see the signable transaction is the one that would finish it: gate it there, once.
          if (ctx?.method === 'createAction' && !gated && (res as SignableResult)?.signableTransaction) {
            gated = true;
            await gate(res as SignableResult);
          }
          return mod.onResponse(res, ctx);
        },
      });
    return call.call(manager, finalArgs, gatedModules, originator);
  };
  return manager;
}

/** The site's description for the sheet: the manager encrypts it in place before the modules run. */
async function plainDescription(m: Manager, description: unknown): Promise<string | undefined> {
  if (typeof description !== 'string') return undefined;
  if (typeof m.maybeDecryptMetadata !== 'function') return description;
  // The manager's own decrypt answers the input unchanged when it isn't its ciphertext.
  return m.maybeDecryptMetadata(description).catch(() => description);
}
