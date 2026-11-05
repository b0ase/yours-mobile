/**
 * A manual re-tap must not pay twice (third review 17c, M2/M3; fourth review 17d, M2/L1/L5).
 *
 * When Send is confirmed, BEFORE the request goes out, the Send page notes the recipient AS THE PERSON TYPED IT, on
 * this device, for an hour. The note is dropped when the payment succeeds or is proven not sent; anything else (it
 * may have gone out, it went out but the payee's host didn't confirm it, the request hung and the app was killed or
 * the page reloaded) keeps it. Sending to that recipient again first shows, in the confirm sheet: "Your earlier payment
 * of X to Y may already have gone out (sent HH:MM). Send another anyway?", with Cancel as the default.
 *
 * Keyed on what the person typed (on phones the name box's input, not the address it resolved to: a paymail host
 * without P2P gives a fresh address per lookup), never on chain data (WhatsOnChain lags) and never on the exact sats
 * (a dollar amount is re-priced every minute). Kept in chrome.storage.local, so it survives an app kill or reload.
 * Every storage call has a time limit: a store that hangs never blocks a send, and the sheet then says it couldn't
 * check. Only the wallet's own Send page reads or writes it: sites, pots, subscriptions and agents never pass through
 * it. Pure apart from the storage it is given.
 */

export const UNCERTAIN_SEND_WINDOW_MS = 60 * 60 * 1000;
export const UNCERTAIN_SENDS_KEY = 'bwxUncertainSends';

export type UncertainSend = { recipient: string; amount: string; at: number };
type State = Record<string, Record<string, UncertainSend>>;

export interface KV {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

/** How long the Send page waits on the device store before going on without it (17d L5). */
export const UNCERTAIN_SENDS_TIME_LIMIT_MS = 1_500;

/** The confirm sheet's line when the store couldn't be read in time. */
export const EARLIER_UNKNOWN_MESSAGE =
  "We couldn't check for an earlier payment to this recipient. If you sent one in the last hour, check History before sending again.";

/**
 * The recipient as typed, normalised: trimmed; a paymail or $name is case-insensitive, an address is not; `$bob`,
 * `$bob@bwalletx.com` and `bob@bwalletx.com` are the same person (a $name is name@bwalletx.com).
 */
export const recipientKey = (recipient: string): string => {
  const t = recipient.trim();
  if (!/@|^\$/.test(t)) return t;
  const k = t.toLowerCase().replace(/^\$/, '');
  return k.includes('@') ? k : `${k}@bwalletx.com`;
};

const TIMED_OUT = Symbol('timed out');
const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMED_OUT), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

/** Pure: does this outcome leave the payment's fate open (it may have gone out)? */
export const outcomeIsUncertain = (info: { moneyMoved: string }): boolean => info.moneyMoved !== 'no';

/** The time an earlier attempt was sent, as the confirm sheet says it ("sent 14:05"). */
export const sentAtLabel = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function createUncertainSends(kv: KV, now: () => number = Date.now, limitMs = UNCERTAIN_SENDS_TIME_LIMIT_MS) {
  /** The state, or null when the store can't be read (in time). */
  const load = async (): Promise<State | null> => {
    try {
      const got = await within(kv.get(UNCERTAIN_SENDS_KEY), limitMs);
      if (got === TIMED_OUT) return null;
      const s = (got[UNCERTAIN_SENDS_KEY] as State | undefined) ?? {};
      const t = now();
      for (const acct of Object.values(s))
        for (const [k, e] of Object.entries(acct ?? {}))
          if (!e || t - e.at > UNCERTAIN_SEND_WINDOW_MS || t < e.at) delete acct[k];
      return s;
    } catch {
      return null;
    }
  };
  const write = async (s: State) => {
    try {
      await within(kv.set({ [UNCERTAIN_SENDS_KEY]: s }), limitMs);
    } catch {
      /* storage unavailable: the reminder is lost, nothing else */
    }
  };
  /** Earlier sends to any of these recipients, and whether the store could be read in time at all. */
  const check = async (
    account: string,
    recipients: string[],
  ): Promise<{ earlier: UncertainSend[]; unavailable: boolean }> => {
    if (!account) return { earlier: [], unavailable: false };
    const s = await load();
    if (!s) return { earlier: [], unavailable: true };
    const mine = s[account] ?? {};
    const earlier = [...new Set(recipients.map(recipientKey))]
      .map((k) => mine[k])
      .filter((e): e is UncertainSend => !!e);
    return { earlier, unavailable: false };
  };
  return {
    /**
     * Note these recipients for this account: called when Send is confirmed, before the request goes out. Never
     * throws; gives up after the time limit (the send goes ahead).
     */
    async note(account: string, items: { recipient: string; amount: string }[]): Promise<void> {
      if (!account || !items.length) return;
      const s = await load();
      if (!s) return; // can't merge with what is there: writing would drop other reminders
      const mine = (s[account] ??= {});
      for (const i of items)
        mine[recipientKey(i.recipient)] = { recipient: i.recipient.trim(), amount: i.amount, at: now() };
      await write(s);
    },
    /** Earlier sends to any of these recipients, still inside the window. Never throws. */
    pending: async (account: string, recipients: string[]): Promise<UncertainSend[]> =>
      (await check(account, recipients)).earlier,
    /** pending(), and whether the store could be read in time (the sheet says so when it couldn't). Never throws. */
    check,
    /** The payment succeeded or is proven not sent: forget these recipients. Never throws. */
    async clear(account: string, recipients: string[]): Promise<void> {
      if (!account) return;
      const s = await load();
      if (!s) return;
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
