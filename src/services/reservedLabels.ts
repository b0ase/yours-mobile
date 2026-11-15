/**
 * Action labels that belong to the wallet itself (bMail review, 15 Nov 2026, N1). bMail keeps the account's record of
 * what each postage stamp paid for as labels on the stamp's transaction (labels whose first word is bmail:
 * mobile/bmail/client.ts stampRecord), and the wallet syncs them between devices. A site that could write such a
 * label could make an old stamp read as paying for a new letter, or make an honest stamp read as used; a site that
 * could list by one could read who paid the user.
 *
 * The permissions manager upstream reserves only labels starting "admin" and "p ". Every other label is a normal
 * permission request ([1, 'action label <label>']), so one approved sheet would have let a site write these. Here a
 * reserved label is refused to every originator other than the wallet's own, before any prompt, on every wallet
 * method that takes labels (createAction, internalizeAction, listActions), and no grant for one is stored or honoured.
 */

/** Bumped whenever RESERVED_LABEL_PREFIXES changes (reservedLabels.test.ts pins the list against it). */
export const RESERVED_LABELS_VERSION = 1;

/**
 * Label prefixes only the wallet itself may write or list by. A label is compared as the toolbox stores it: trimmed
 * and lower-cased. Each entry is a first word; the label is reserved when it is that word alone or starts with it
 * followed by white space.
 */
export const RESERVED_LABEL_PREFIXES: readonly string[] = ['bmail'];

export const RESERVED_LABEL_REFUSAL = 'This label is reserved for bWalletX itself';

const norm = (label: unknown): string => (typeof label === 'string' ? label.trim().toLowerCase() : '');

export const isReservedLabel = (label: unknown): boolean => {
  const l = norm(label);
  return RESERVED_LABEL_PREFIXES.some((p) => l === p || (l.startsWith(p) && /\s/.test(l.charAt(p.length))));
};

/** The manager asks for a label as protocol [1, 'action label <label>']: is this such a request for a reserved one? */
export const isReservedLabelProtocol = (protocolID: unknown): boolean => {
  if (!Array.isArray(protocolID) || typeof protocolID[1] !== 'string') return false;
  const name = protocolID[1].trim().toLowerCase();
  return name.startsWith('action label') && isReservedLabel(name.slice('action label'.length));
};

/** Wallet methods whose args carry action labels. */
export const LABEL_METHODS: readonly string[] = ['createAction', 'internalizeAction', 'listActions'];

/**
 * Why an outside caller's wallet call must be refused, or null. `labels` that is not a list, or holds something that
 * is not text, is left to the wallet's own validation (it writes no label).
 */
export const reservedLabelRefusal = (method: string, args: unknown): string | null => {
  if (!LABEL_METHODS.includes(method) || !args || typeof args !== 'object') return null;
  const labels = (args as { labels?: unknown }).labels;
  if (!Array.isArray(labels)) return null;
  const bad = labels.find(isReservedLabel);
  return bad === undefined ? null : `${RESERVED_LABEL_REFUSAL}: "${String(bad).trim().slice(0, 40)}"`;
};

/** Grouped (BRC-73) protocol entries an outside app may be granted: reserved labels are dropped. */
export const withoutReservedLabels = <T extends { protocolID?: unknown }>(items: T[] | undefined): T[] =>
  (items ?? []).filter((p) => !isReservedLabelProtocol(p.protocolID));

type LabelGrantStore = {
  listGrants(filter?: {
    type?: 'protocol';
  }): Promise<{ key: { type: string; originator: string; protocolLevel?: number; protocolName?: string } }[]>;
  deleteGrant(key: never): Promise<void>;
};

/**
 * Remove every stored grant an outside originator holds for a reserved label (upgrade migration; safe to run on
 * every unlock). Returns how many were removed.
 */
export const revokeReservedLabelGrants = async (store: LabelGrantStore, adminOriginator: string) => {
  const grants = await store.listGrants({ type: 'protocol' });
  let removed = 0;
  for (const g of grants) {
    const k = g.key;
    if (k.type !== 'protocol' || k.originator === adminOriginator) continue;
    if (!isReservedLabelProtocol([k.protocolLevel, k.protocolName])) continue;
    await store.deleteGrant(k as never);
    removed++;
  }
  return removed;
};

/**
 * Inside the permissions manager: refuse reserved labels for outside originators on the three label methods, in
 * ensureLabelAccess and ensureProtocolPermission (whatever path reached the manager, before any stored grant or
 * prompt), and drop them from grouped grants.
 */
export function guardReservedLabels<T extends object>(manager: T, adminOriginator: string): T {
  const m = manager as Record<string, unknown>;
  const isOutside = (originator: unknown) => originator !== adminOriginator;
  for (const method of LABEL_METHODS) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      if (isOutside(originator)) {
        const refusal = reservedLabelRefusal(method, args);
        if (refusal) throw new Error(refusal);
      }
      return (original as (a: unknown, o?: string) => Promise<unknown>).call(manager, args, originator);
    };
  }
  const label = m.ensureLabelAccess;
  if (typeof label === 'function') {
    m.ensureLabelAccess = async (args: { originator?: string; label?: unknown }) => {
      if (isOutside(args?.originator) && isReservedLabel(args?.label))
        throw new Error(`${RESERVED_LABEL_REFUSAL}: "${String(args.label).trim().slice(0, 40)}"`);
      return (label as (a: unknown) => Promise<boolean>).call(manager, args);
    };
  }
  const protocol = m.ensureProtocolPermission;
  if (typeof protocol === 'function') {
    m.ensureProtocolPermission = async (args: { originator?: string; protocolID?: unknown }) => {
      if (isOutside(args?.originator) && isReservedLabelProtocol(args?.protocolID))
        throw new Error(RESERVED_LABEL_REFUSAL);
      return (protocol as (a: unknown) => Promise<boolean>).call(manager, args);
    };
  }
  const grouped = m.grantGroupedPermission;
  if (typeof grouped === 'function') {
    m.grantGroupedPermission = async (params: { granted?: { protocolPermissions?: { protocolID?: unknown }[] } }) => {
      if (params?.granted?.protocolPermissions)
        params = {
          ...params,
          granted: {
            ...params.granted,
            protocolPermissions: withoutReservedLabels(params.granted.protocolPermissions),
          },
        };
      return (grouped as (p: unknown) => Promise<void>).call(manager, params);
    };
  }
  return manager;
}
