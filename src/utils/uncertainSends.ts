/**
 * A manual re-tap must not pay twice (third review 17c, M2/M3).
 *
 * After a send whose outcome is uncertain (the page was told it may have gone out, or that it went out but the payee's
 * host didn't confirm it), the Send page remembers the recipient AS THE PERSON TYPED IT, on this device, for an hour.
 * Sending to that recipient again first shows, in the confirm sheet: "Your earlier payment of X to Y may already have
 * gone out (sent HH:MM). Send another anyway?", with Cancel as the default.
 *
 * Keyed on what the person typed, never on chain data (WhatsOnChain lags) and never on the exact sats (a dollar amount
 * is re-priced every minute; a $name payee gets a fresh address every time). Kept in chrome.storage.local, so it
 * survives an app kill or reload. Only the wallet's own Send page reads or writes it: sites, pots, subscriptions and
 * agents never pass through it. Pure apart from the storage it is given.
 */

export const UNCERTAIN_SEND_WINDOW_MS = 60 * 60 * 1000;
export const UNCERTAIN_SENDS_KEY = 'bwxUncertainSends';

export type UncertainSend = { recipient: string; amount: string; at: number };
type State = Record<string, Record<string, UncertainSend>>;

export interface KV {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

/** The recipient as typed, normalised: trimmed; a paymail or $name is case-insensitive, an address is not. */
export const recipientKey = (recipient: string): string => {
  const t = recipient.trim();
  return /@|^\$/.test(t) ? t.toLowerCase() : t;
};

/** Pure: does this outcome leave the payment's fate open (it may have gone out)? */
export const outcomeIsUncertain = (info: { moneyMoved: string }): boolean => info.moneyMoved !== 'no';

/** The time an earlier attempt was sent, as the confirm sheet says it ("sent 14:05"). */
export const sentAtLabel = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function createUncertainSends(kv: KV, now: () => number = Date.now) {
  const read = async (): Promise<State> => {
    try {
      const s = ((await kv.get(UNCERTAIN_SENDS_KEY))[UNCERTAIN_SENDS_KEY] as State | undefined) ?? {};
      const t = now();
      for (const acct of Object.values(s))
        for (const [k, e] of Object.entries(acct ?? {}))
          if (!e || t - e.at > UNCERTAIN_SEND_WINDOW_MS || t < e.at) delete acct[k];
      return s;
    } catch {
      return {};
    }
  };
  const write = async (s: State) => {
    try {
      await kv.set({ [UNCERTAIN_SENDS_KEY]: s });
    } catch {
      /* storage unavailable: the reminder is lost, nothing else */
    }
  };
  return {
    /** Remember these recipients of an uncertain send for this account. Never throws. */
    async note(account: string, items: { recipient: string; amount: string }[]): Promise<void> {
      if (!account || !items.length) return;
      const s = await read();
      const mine = (s[account] ??= {});
      for (const i of items)
        mine[recipientKey(i.recipient)] = { recipient: i.recipient.trim(), amount: i.amount, at: now() };
      await write(s);
    },
    /** Earlier uncertain sends to any of these recipients, still inside the window. Never throws. */
    async pending(account: string, recipients: string[]): Promise<UncertainSend[]> {
      if (!account) return [];
      const mine = (await read())[account] ?? {};
      return [...new Set(recipients.map(recipientKey))].map((k) => mine[k]).filter((e): e is UncertainSend => !!e);
    },
    /** The person chose to send anyway: forget these recipients. Never throws. */
    async clear(account: string, recipients: string[]): Promise<void> {
      if (!account) return;
      const s = await read();
      for (const k of recipients.map(recipientKey)) delete s[account]?.[k];
      await write(s);
    },
  };
}

export type UncertainSends = ReturnType<typeof createUncertainSends>;

/** chrome.storage.local (the extension pages and the phone's page both have it); a no-op store where it is missing. */
export const deviceKV = (): KV => {
  const local = (globalThis as { chrome?: { storage?: { local?: KV } } }).chrome?.storage?.local;
  return local && typeof local.get === 'function'
    ? { get: (k) => local.get(k), set: (i) => local.set(i) }
    : { get: async () => ({}), set: async () => undefined };
};
