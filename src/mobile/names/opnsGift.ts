import { destinationFor, TOKENS_UNSUPPORTED, type Resolved } from './names';
import type { OwnedForSale } from './opnsSell';

/**
 * Gift OpNS names (owner, 13 Oct 2026): send one or more owned names to a $handle, paymail or address.
 *
 * A name is a 1-sat ordinal, so it only ever goes to an ORDINALS destination: an address typed as-is, or a
 * paymail's ordinal-receive address (the 1Sat `ordAddress` capability; bWalletX paymails answer it from the
 * alias's stored ord_address). A paymail with only a P2P / payment destination is refused, the same rule as
 * NFT sends (names.ts destinationFor 'token'): a BSV payment address may not keep 1-sat outputs apart.
 *
 * A listed name is taken off sale first (cancelOpnsListing), then sent (sendOpns), all under ONE approval.
 */

export const GIFT_NO_ORD_DESTINATION =
  "This recipient can't receive names. Ask them for a bWalletX $handle, a paymail that takes ordinals, or a 1… address.";

/** The ordinals address to send a name to, or why not. */
export const giftDestination = (r: Resolved): { ok: true; to: string } | { ok: false; error: string } => {
  const d = destinationFor(r, 'token');
  if (!d.ok && d.error === TOKENS_UNSUPPORTED) return { ok: false, error: GIFT_NO_ORD_DESTINATION };
  return d;
};

/** Who the status line names: "$b0ase", "boase@handcash.io" or a short address. */
export const giftRecipientLabel = (r: Pick<Resolved, 'input' | 'via'>, to: string) =>
  r.via === 'address' ? `${to.slice(0, 6)}…${to.slice(-4)}` : r.input;

export type GiftStatus = 'pending' | 'cancelling' | 'sending' | 'done' | 'error';
export type GiftItem = {
  name: string;
  id: string;
  /** Listed for sale when the gift was approved: the listing is cancelled before the send. */
  listed: boolean;
  status: GiftStatus;
  cancelTxid?: string;
  txid?: string;
  note?: string;
};

export const newGiftBatch = (names: OwnedForSale[]): GiftItem[] =>
  names.map((n) => ({ name: n.name, id: n.id, listed: n.listedSats !== null, status: 'pending' }));

export type GiftDeps = {
  /** Cancels a listing; returns the txid or throws. */
  cancel: (id: string) => Promise<string>;
  /** The basket id of the name now (a cancelled listing is a new output); falls back to the old id. */
  idAfterCancel: (name: string) => Promise<string | undefined>;
  /** Sends the name to an ordinals address; returns the txid or throws. */
  send: (id: string, address: string) => Promise<string>;
  onUpdate: (items: GiftItem[]) => void;
};

export type GiftResult = { stopped: 'finished' | 'cancelled' | 'error'; error?: string; items: GiftItem[] };

/**
 * Gifts each name in order: cancel the listing if there is one, then send. A wallet error stops the run with
 * that name marked, so nothing after it is sent and the user sees exactly where it stopped.
 */
export const runGiftBatch = async (
  deps: GiftDeps,
  start: GiftItem[],
  to: string,
  signal?: AbortSignal,
): Promise<GiftResult> => {
  let items = start;
  const set = (i: number, patch: Partial<GiftItem>) => {
    items = items.map((it, j) => (j === i ? { ...it, ...patch } : it));
    deps.onUpdate(items);
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.status === 'done') continue;
    if (signal?.aborted) return { stopped: 'cancelled', items };
    try {
      let id = it.id;
      if (it.listed && !it.cancelTxid) {
        set(i, { status: 'cancelling', note: undefined });
        const cancelTxid = await deps.cancel(id);
        id = (await deps.idAfterCancel(it.name)) ?? id;
        set(i, { cancelTxid, id });
      }
      set(i, { status: 'sending', note: undefined });
      const txid = await deps.send(id, to);
      set(i, { status: 'done', txid });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set(i, { status: 'error', note: msg });
      return { stopped: 'error', error: msg, items };
    }
  }
  return { stopped: 'finished', items };
};

/** Names still to show under Owned names: a gifted name leaves at once, before the wallet list refreshes. */
export const withoutGifted = (owned: OwnedForSale[], gifted: ReadonlySet<string>) =>
  owned.filter((o) => !gifted.has(o.name));
