/**
 * Labels on the spend sheet (TokenBlaster Assault playtest, 25 Oct 2026). A createAction carrying a label the site
 * had not been granted showed a label sheet first, then the spend sheet: two sheets for one payment. A label is
 * metadata, not spending, so it now shows as a line on that payment's own sheet ("Labels: tokenblaster"), and the
 * payment shows exactly one sheet.
 *
 * Rules:
 *  - Only for a payment that is certain to reach the spend check: the site sends outputs worth something and no
 *    inputs of its own, so the wallet funds it and the net spend is above zero.
 *  - The label is let through for THIS action only; no label grant is stored, so the next payment shows it again.
 *  - If the payment's sheet did not open (an envelope or an earlier grant answered it), the label still asks on its
 *    own sheet before anything is signed. Nothing is ever applied without the user seeing it.
 *  - Per action: a label is deferred only while its action is the site's only one running, and goes on the sheet of
 *    that action's own spend (matched by its outputs). Any other label asks on its own sheet.
 */
import { routesToModule } from './pModuleSpendGate';
import { permissionSite } from './permissionSite';
import { lineItemsMatch } from './spendRecipients';

/** The toolbox's "as much as is left" output amount. */
const MAX_POSSIBLE_SATOSHIS = 0x775f05a073fff;

export type LabelRun = {
  /** Labels waiting to be shown on this action's spend sheet. */
  labels: string[];
  /** The spend sheet opened with them on it. */
  shown: boolean;
  /** May defer its labels: a certain wallet-funded payment, not routed to a permission module. */
  eligible: boolean;
  /** Its output amounts, to find its spend request by line items (spendRecipients.ts lineItemsMatch). */
  sats: (number | undefined)[];
};

/**
 * Per action, never per site (review of fix/sheet-recipients, 6 Nov 2026): every createAction of a site has its own
 * run, keyed by the manager's site key (permissionSite.ts, hostname only). A label is deferred only while its action
 * is the site's ONLY one running, so the label call is certainly that action's; the labels go on the sheet of the
 * spend request whose line items are that action's outputs, and nowhere else.
 */
const runs = new Map<string, LabelRun[]>();

/** The site's only running action (background.ts and tests); undefined when none or several run. */
export const labelRunFor = (originator: string | undefined): LabelRun | undefined => {
  const list = originator ? runs.get(permissionSite(originator)) : undefined;
  return list?.length === 1 ? list[0] : undefined;
};

type SpendLike = { spending?: { lineItems?: unknown }; lineItems?: unknown };

/** The run whose deferred labels belong to this spend: its outputs are the spend's line items. */
const pendingFor = (originator: string | undefined, spend: SpendLike | undefined): LabelRun | undefined => {
  const list = originator ? (runs.get(permissionSite(originator)) ?? []) : [];
  const items = spend?.spending?.lineItems ?? spend?.lineItems;
  const found = list.filter((r) => r.labels.length > 0 && !r.shown && lineItemsMatch(r.sats, items));
  return found.length === 1 ? found[0] : undefined;
};

/** The spend sheet for this request is about to open: put its own action's pending labels on it. */
export const takeLabelsForSheet = (originator: string | undefined, request?: SpendLike): string[] => {
  const run = pendingFor(originator, request);
  if (!run) return [];
  run.shown = true;
  return [...run.labels];
};

type Output = { satoshis?: unknown; basket?: unknown };
type CreateArgs = { labels?: unknown; outputs?: Output[]; inputs?: unknown[] };

/** Will the manager certainly ask for a spend? Wallet-funded (no site inputs) and paying something. */
export const certainSpend = (args: CreateArgs | undefined): boolean => {
  if (!args || (Array.isArray(args.inputs) && args.inputs.length > 0)) return false;
  const total = (args.outputs ?? []).reduce((s, o) => s + (typeof o?.satoshis === 'number' ? o.satoshis : 0), 0);
  return total > 0;
};

type LabelArgs = { originator?: string; label: string; reason?: string; seekPermission?: boolean; usageType?: string };
type SpendArgs = { originator?: string; satoshis: number; lineItems?: unknown };
type Fn<A, R> = (a: A) => Promise<R>;

export type LabelGuardDeps = {
  adminOriginator: string;
  /** Unused: runs are keyed with permissionSite (the manager's own form). Kept for callers. */
  normalize?: (o: string) => string;
};

/**
 * Wrap the permissions manager: createAction marks the site's run, ensureLabelAccess defers a label that would ask
 * (onto the spend sheet), and ensureSpendingAuthorization asks for any deferred label the spend sheet did not show.
 */
export function guardLabelsOnSpend<T extends object>(manager: T, deps: LabelGuardDeps): T {
  const m = manager as Record<string, unknown>;
  const create = m.createAction as ((args: CreateArgs, originator?: string) => Promise<unknown>) | undefined;
  const label = m.ensureLabelAccess as Fn<LabelArgs, boolean> | undefined;
  const spend = m.ensureSpendingAuthorization as Fn<SpendArgs, boolean> | undefined;
  const has = m.hasProtocolPermission as Fn<Record<string, unknown>, boolean> | undefined;
  if (typeof create !== 'function' || typeof label !== 'function' || typeof spend !== 'function') return manager;
  const config = (m.config ?? {}) as { seekPermissionWhenApplyingActionLabels?: boolean };

  m.createAction = async (args: CreateArgs, originator?: string) => {
    const site = originator && originator !== deps.adminOriginator ? permissionSite(originator) : '';
    if (!site) return create.call(manager, args, originator);
    const outputs = Array.isArray(args?.outputs) ? args.outputs : [];
    const mine: LabelRun = {
      labels: [],
      shown: false,
      eligible: Array.isArray(args?.labels) && args.labels.length > 0 && certainSpend(args) && !routesToModule(args),
      sats: outputs.map((o) =>
        typeof o?.satoshis === 'number' && o.satoshis !== MAX_POSSIBLE_SATOSHIS ? o.satoshis : undefined,
      ),
    };
    runs.set(site, [...(runs.get(site) ?? []), mine]);
    try {
      return await create.call(manager, args, originator);
    } finally {
      const left = (runs.get(site) ?? []).filter((r) => r !== mine);
      if (left.length) runs.set(site, left);
      else runs.delete(site);
    }
  };

  m.ensureLabelAccess = async (args: LabelArgs) => {
    const site = args?.originator ? permissionSite(args.originator) : '';
    // Only while the site has exactly one action running is this label call certainly that action's.
    const run = labelRunFor(site);
    if (
      !run ||
      !run.eligible ||
      run.shown ||
      args.usageType !== 'apply' ||
      config.seekPermissionWhenApplyingActionLabels === false ||
      typeof args.label !== 'string' ||
      // Admin-only labels are refused by the manager itself: never deferred past that check.
      args.label.startsWith('admin') ||
      args.label.startsWith('p ')
    )
      return label.call(manager, args);
    // Already granted: nothing to show.
    const granted =
      typeof has === 'function'
        ? await has
            .call(manager, {
              originator: site,
              privileged: false,
              protocolID: [1, `action label ${args.label}`],
              counterparty: 'self',
            })
            .catch(() => false)
        : false;
    if (granted) return label.call(manager, args);
    if (!run.labels.includes(args.label)) run.labels.push(args.label);
    return true;
  };

  m.ensureSpendingAuthorization = async (args: SpendArgs) => {
    const ok = await spend.call(manager, args);
    // This spend's own action (by its line items); with no line items, the site's only action, if any.
    const run =
      pendingFor(args?.originator, args) ??
      (Array.isArray(args?.lineItems) ? undefined : labelRunFor(args?.originator));
    if (run && !run.shown && run.labels.length > 0) {
      // The payment did not reach a sheet: the labels ask on their own, before anything is signed.
      const pending = run.labels.splice(0);
      run.shown = true;
      for (const l of pending) await label.call(manager, { originator: args.originator, label: l, usageType: 'apply' });
    }
    return ok;
  };
  return manager;
}
