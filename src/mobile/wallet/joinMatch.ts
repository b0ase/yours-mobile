import type { Contact } from '../chat/contacts';

/**
 * Contacts auto-match (roadmap: "Contacts auto-match to paymails as friends join", /invite). An address-book
 * contact that carries an X handle (@mike), a HandCash/bChat handle ($mike) or an email-like name
 * (mike@gmail.com) but no paymail is checked against bWalletX paymail resolution: mike@bwalletx.com.
 *
 * Private by design: one lookup per name, never a bulk upload of the list; each contact at most once a day;
 * a few per run. No server push yet, so the caller runs this on open and on a timer.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Lookups per run (runs are minutes apart, so a long list trickles through over the day). */
export const BATCH = 5;
export const STORE_KEY = 'bwallet.contactJoin.v1';

export interface JoinEntry {
  /** Last time this name was looked up (ms). */
  checkedAt: number;
  /** The bWalletX paymail when the name resolved to a real user. */
  paymail?: string;
  /** True once the owner dismissed the "joined" notice. */
  seen?: boolean;
}
/** Keyed by the candidate name, so the same person reached by two sources is looked up once. */
export type JoinState = Record<string, JoinEntry>;

const ALIAS = /^[a-z0-9_.-]{1,50}$/;

/** The bWalletX alias to try for a contact, or null when it has a paymail already or nothing usable. */
export const candidateName = (c: Contact): string | null => {
  if (c.paymail) return null;
  const pick = (s: string | null | undefined) => {
    const v = (s || '').trim().toLowerCase();
    return ALIAS.test(v) && !/^[.-]|[.-]$/.test(v) ? v : null;
  };
  if (c.handle) return pick(c.handle);
  const n = (c.name || '').trim().toLowerCase();
  const x = n.match(/^[@$]([a-z0-9_.-]{1,50})$/); // @x handle or $handcash handle
  if (x) return pick(x[1]);
  const e = n.match(/^([a-z0-9._+-]{1,64})@[a-z0-9-]+(\.[a-z0-9-]+)+$/); // email-like
  if (e) return pick(e[1].split('+')[0]);
  return null;
};

/** Names due a lookup now: never checked or last checked a day ago, not already matched; at most `batch`. */
export const dueNames = (contacts: Contact[], state: JoinState, now: number, batch = BATCH): string[] => {
  const out: string[] = [];
  for (const c of contacts) {
    const n = candidateName(c);
    if (!n || out.includes(n)) continue;
    const e = state[n];
    if (e?.paymail) continue;
    if (e && now - e.checkedAt < DAY_MS) continue;
    out.push(n);
    if (out.length >= batch) break;
  }
  return out;
};

/** Looks up a name; resolves the bWalletX paymail when it is a real user, null when not (or on error). */
export type LookupName = (name: string) => Promise<string | null>;

/** One run: looks up each due name in turn (one request at a time) and returns the new state. */
export const runJoinChecks = async (
  contacts: Contact[],
  state: JoinState,
  lookup: LookupName,
  now: number,
  batch = BATCH,
): Promise<JoinState> => {
  const next: JoinState = { ...state };
  for (const n of dueNames(contacts, state, now, batch)) {
    let paymail: string | null = null;
    try {
      paymail = await lookup(n);
    } catch {
      paymail = null;
    }
    next[n] = paymail ? { checkedAt: now, paymail } : { checkedAt: now };
  }
  return next;
};

/** Contacts with any matched paymail attached (Pay then works); others untouched. */
export const withJoined = (contacts: Contact[], state: JoinState): Contact[] =>
  contacts.map((c) => {
    const n = candidateName(c);
    const p = n ? state[n]?.paymail : undefined;
    return p ? { ...c, paymail: p } : c;
  });

export interface JoinNotice {
  name: string;
  /** Contact's display name. */
  who: string;
  paymail: string;
}

/** "Mike joined: $mike" notices not yet dismissed. */
export const joinNotices = (contacts: Contact[], state: JoinState): JoinNotice[] => {
  const out: JoinNotice[] = [];
  for (const c of contacts) {
    const n = candidateName(c);
    const e = n ? state[n] : undefined;
    if (!n || !e?.paymail || e.seen || out.some((x) => x.name === n)) continue;
    out.push({ name: n, who: c.name.replace(/^[@$]/, '') || n, paymail: e.paymail });
  }
  return out;
};

export const markSeen = (state: JoinState, name: string): JoinState =>
  state[name] ? { ...state, [name]: { ...state[name], seen: true } } : state;

/** "$mike" for a bWalletX paymail. */
export const handleOf = (paymail: string) => `$${paymail.split('@')[0]}`;

export const loadJoinState = (): JoinState => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' ? (v as JoinState) : {};
  } catch {
    return {};
  }
};

export const saveJoinState = (s: JoinState) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: checks just repeat */
  }
};
