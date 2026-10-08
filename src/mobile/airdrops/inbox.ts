/**
 * Airdrops inbox (owner, 8 Oct 2026): tokens and NFTs that arrived without the user doing anything.
 *
 * Unsolicited = a History v2 row (wallet/historyEvents.ts) of type 'transfer-in': a 1-sat token or NFT output
 * paid to one of our addresses by a tx we did not fund, with no action record of our own (a purchase, mint,
 * launch, recovery or swap always has one). Pure and persisted per account in localStorage.
 */
import type { Asset } from '../wallet/historyEvents';
import type { HistoryRow } from '../wallet/txHistory';

export type AirdropItem = {
  /** `txid:assetId`, stable across reloads. */
  key: string;
  txid: string;
  time: number;
  asset: Asset;
  /** Who it's from: the token id for a token (one issuer per deploy), else the sending address. */
  issuer: string;
  from: string;
  /** The issuer's note, read from an OP_RETURN in the same tx (note.ts). Plain text, ≤280 chars. */
  note?: string;
};

export type InboxState = {
  /** Unix ms the inbox was last opened; items newer than this count toward the badge. */
  seenAt: number;
  kept: string[];
  hidden: string[];
  hiddenIssuers: string[];
  /** Only show airdrops from issuers whose airdrops you kept before. */
  onlyKnown: boolean;
};
export const emptyInbox = (): InboxState => ({ seenAt: 0, kept: [], hidden: [], hiddenIssuers: [], onlyKnown: false });

/** True for a token or NFT that arrived unsolicited (see top). `hasLocal`: the wallet has an action record for the tx. */
export const isUnsolicited = (row: Pick<HistoryRow, 'type' | 'asset' | 'direction'>, hasLocal: boolean) =>
  !!row.asset && row.type === 'transfer-in' && !hasLocal && row.direction !== 'out';

export const toItems = (rows: HistoryRow[], hasLocal: (txid: string) => boolean): AirdropItem[] => {
  const seen = new Set<string>();
  const out: AirdropItem[] = [];
  for (const r of rows) {
    if (!r.asset || !isUnsolicited(r, hasLocal(r.txid))) continue;
    const key = `${r.txid}:${r.asset.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const issuer = r.asset.kind === 'token' && r.asset.id ? r.asset.id : r.counterparty || r.asset.id;
    out.push({ key, txid: r.txid, time: r.time, asset: r.asset, issuer, from: r.counterparty });
  }
  return out.sort((a, b) => b.time - a.time);
};

/** Items still in the inbox: not kept, not hidden, issuer not hidden, and (onlyKnown) from a known issuer. */
export const visibleItems = (items: AirdropItem[], s: InboxState): AirdropItem[] => {
  const kept = new Set(s.kept);
  const hidden = new Set(s.hidden);
  const badIssuers = new Set(s.hiddenIssuers);
  const knownIssuers = new Set(items.filter((i) => kept.has(i.key)).map((i) => i.issuer));
  return items.filter(
    (i) =>
      !kept.has(i.key) &&
      !hidden.has(i.key) &&
      !badIssuers.has(i.issuer) &&
      (!s.onlyKnown || knownIssuers.has(i.issuer)),
  );
};

/** Badge: visible items that arrived after the inbox was last opened. */
export const badgeCount = (items: AirdropItem[], s: InboxState) =>
  visibleItems(items, s).filter((i) => i.time > s.seenAt).length;

export const keep = (s: InboxState, key: string): InboxState => ({ ...s, kept: [...new Set([...s.kept, key])] });
/** Hide one item and every future item from its issuer. */
export const hide = (s: InboxState, item: Pick<AirdropItem, 'key' | 'issuer'>): InboxState => ({
  ...s,
  hidden: [...new Set([...s.hidden, item.key])],
  hiddenIssuers: [...new Set([...s.hiddenIssuers, item.issuer])],
});
export const markSeen = (s: InboxState, now = Date.now()): InboxState => ({ ...s, seenAt: now });

// ─── Persistence ─────────────────────────────────────────────────────────────

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): Store | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
const stateKey = (account: string) => `bw-airdrops:${account}`;
const itemsKey = (account: string) => `bw-airdrops-items:${account}`;

export const loadInbox = (account: string, st: Store | null = store()): InboxState => {
  try {
    const j = JSON.parse(st?.getItem(stateKey(account)) ?? 'null') as Partial<InboxState> | null;
    return { ...emptyInbox(), ...(j ?? {}) };
  } catch {
    return emptyInbox();
  }
};
export const saveInbox = (account: string, s: InboxState, st: Store | null = store()) => {
  try {
    st?.setItem(stateKey(account), JSON.stringify(s));
  } catch {
    /* storage full or blocked: the inbox still works this session */
  }
  emit();
};
export const loadItems = (account: string, st: Store | null = store()): { items: AirdropItem[]; at: number } => {
  try {
    const j = JSON.parse(st?.getItem(itemsKey(account)) ?? 'null') as { items: AirdropItem[]; at: number } | null;
    return j && Array.isArray(j.items) ? j : { items: [], at: 0 };
  } catch {
    return { items: [], at: 0 };
  }
};
export const saveItems = (account: string, items: AirdropItem[], at: number, st: Store | null = store()) => {
  try {
    st?.setItem(itemsKey(account), JSON.stringify({ items: items.slice(0, 500), at }));
  } catch {
    /* ignore */
  }
  emit();
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const subscribeInbox = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
