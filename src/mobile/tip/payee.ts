import { APP_NAME } from '../storeBuild';
import {
  NOT_VERIFIED_NOTE,
  UNSIGNED_NOTE,
  VIA_LABEL,
  destinationCheck,
  destinationFor,
  externalLabel,
  forwardLabel,
  parseRecipient,
  resolveRecipient,
  type Resolved,
} from '../names/names';
import { normName, type TipRecipient, type TipRoute } from './tip';

/**
 * Where a tip goes, as the tip sheet shows it (b-Aware rows 84, 348, 351, 234; cluster baware:unverified-payee).
 * PURE apart from previewPayee's resolver.
 *
 * - The sheet shows the verified $handle, the full paymail or the address, never only the caller's display name.
 * - `check` carries the "not verified" state onto the sheet; sendTip pays with requireVerified unless the sheet
 *   showed NOT_VERIFIED_NOTE.
 * - At send time the name is resolved again; payeeChanged refuses when it no longer matches what was shown.
 */

/** verified: the host lets us check the address against the key. unverified: it does not (note shown).
 *  address: a plain address, shown in full. key: BRC-29 to an identity key. */
export type PayeeCheck = 'verified' | 'unverified' | 'address' | 'key';

export type TipPayee = {
  route: TipRoute;
  /** First line: "$alice", "alice@handcash.io", the address, or "Wallet key 02ab…cdef". */
  shown: string;
  /** Second line: the paymail / address the money goes to, and how. */
  detail: string;
  check: PayeeCheck;
  /** Warnings and proofs to show under it (NOT_VERIFIED_NOTE, UNSIGNED_NOTE, forwards). */
  notes: string[];
  /** The resolver's answer at preview time (paymail routes): what send time must find again. */
  resolved?: Pick<Resolved, 'target' | 'targetKind' | 'via' | 'pubkey' | 'forwardsTo' | 'external'>;
};

export const PAYEE_CHANGED = `This name now points somewhere else than when you opened the tip. Nothing was sent. Open the tip again to see where it goes.`;

export const ADDRESS_NOTE = `Paid straight to this address. ${APP_NAME} can't check who owns it.`;

const shortHex = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

/** The sheet's payee for a route; paymail routes need the resolver's answer `r`. */
export const payeeFromResolved = (route: TipRoute, r?: Resolved): TipPayee => {
  if (route.kind === 'identity')
    return {
      route,
      shown: `Wallet key ${shortHex(route.to)}`,
      detail: `${route.to} · paid to their wallet key, with a message`,
      check: 'key',
      notes: [],
    };
  if (route.kind === 'address' || !r)
    return { route, shown: route.to, detail: VIA_LABEL.address, check: 'address', notes: [ADDRESS_NOTE] };

  const dc = destinationCheck(r, 'bsv');
  const check: PayeeCheck = dc ?? 'address';
  const notes: string[] = [];
  const alias = r.targetKind === 'paymail' ? r.target.split('@')[0] : '';
  // Only a name on our own host (checked against its signed binding) is shown as a $handle.
  const shown = r.external
    ? r.input.replace(/^\$/, '').toLowerCase()
    : alias && check === 'verified'
      ? `$${alias.toLowerCase()}`
      : r.input;
  const via = VIA_LABEL[r.via];
  const detail =
    r.targetKind === 'address'
      ? `${r.target} · ${via}`
      : r.external
        ? (externalLabel(r) ?? r.target)
        : `${r.target} · ${via}`;
  if (check === 'unverified') notes.push(NOT_VERIFIED_NOTE);
  if (check === 'address') notes.push(ADDRESS_NOTE);
  if (r.nameBinding === 'unsigned') notes.push(UNSIGNED_NOTE);
  const fw = forwardLabel(r, 'bsv');
  if (fw) notes.push(fw);
  return {
    route,
    shown,
    detail,
    check,
    notes,
    resolved: {
      target: r.target,
      targetKind: r.targetKind,
      via: r.via,
      pubkey: r.pubkey,
      forwardsTo: r.forwardsTo,
      external: r.external,
    },
  };
};

export type Resolve = (to: string) => Promise<Resolved>;
export const defaultResolve: Resolve = (to) => resolveRecipient((u, i) => fetch(u, i), parseRecipient(to));

/** Resolve a tip route for the sheet. Refusals (bad binding, changed key…) come back as errors, never payees. */
export const previewPayee = async (
  route: TipRoute,
  resolve: Resolve = defaultResolve,
): Promise<{ ok: true; payee: TipPayee } | { ok: false; error: string }> => {
  if (route.kind !== 'paymail') return { ok: true, payee: payeeFromResolved(route) };
  try {
    const r = await resolve(route.to);
    const d = destinationFor(r, 'bsv');
    if (!d.ok) return { ok: false, error: d.error };
    return { ok: true, payee: payeeFromResolved(route, r) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
};

const lc = (s: string | undefined) => (s ?? '').toLowerCase();

/**
 * null when the send-time answer `r` is the payee the sheet showed; else PAYEE_CHANGED.
 * A host-served address (paymail-address) may rotate, so its target is not compared: sendTip pays the shown one.
 */
export const payeeChanged = (shown: TipPayee, r: Resolved): string | null => {
  const s = shown.resolved;
  if (!s) return PAYEE_CHANGED;
  if (s.via !== r.via || s.targetKind !== r.targetKind) return PAYEE_CHANGED;
  if (lc(s.pubkey) !== lc(r.pubkey) || lc(s.forwardsTo) !== lc(r.forwardsTo) || lc(s.external) !== lc(r.external))
    return PAYEE_CHANGED;
  if (r.via !== 'paymail-address' && lc(s.target) !== lc(r.target)) return PAYEE_CHANGED;
  const now = destinationCheck(r, 'bsv') ?? 'address';
  if (shown.check === 'verified' && now !== 'verified') return PAYEE_CHANGED;
  return null;
};

const NOT_VERIFIED = ' (not verified)';
const looksLikeName = (s: string) => /^\$/.test(s) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * The name the sheet and toast use. A caller's "$alice" (or "alice@…") is only shown bare when the payee the
 * wallet resolved IS that name; otherwise it is the payee's own claim, so it is marked (row 351).
 */
export const tipName = (to: TipRecipient, payee: TipPayee): string => {
  const name = to.name.trim();
  if (!looksLikeName(name) || name.endsWith(NOT_VERIFIED)) return name;
  const proven =
    payee.route.kind === 'paymail' &&
    payee.check !== 'address' &&
    !!payee.resolved &&
    payee.resolved.targetKind === 'paymail' &&
    normName(name) === normName(payee.resolved.target);
  return proven ? name : `${name}${NOT_VERIFIED}`;
};
