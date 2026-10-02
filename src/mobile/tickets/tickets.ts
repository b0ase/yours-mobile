import validate from 'bitcoin-address-validation';
import { LockingScript, OP, Utils } from '@bsv/sdk';
import { safety, type SafetyFilter } from '../market/safety';
import { MAP_PREFIX, cleanSupply, validateSupply } from '../names/personalToken';
import { mintFeeFor, txFeeSats } from '../mint/mint';

/**
 * Tickets: a ticket gets you into a room. Send one to invite someone.
 *
 * A ticket is a fungible BSV-21 token (fixed supply, 0 decimals) minted from the MINT card's
 * "Start a room" option. Its holders' room is opened in bit-sign on mint (gate: hold 1). Event
 * date and price are optional extras for tickets that are also used for an event. Tickets are
 * ACCESS passes: never describe them as investments.
 *
 * Tagging + discovery (see docs/TICKETS.md):
 *  - On chain: the deploy tx carries a 0-sat MAP OP_RETURN `app=bWallet type=ticket name= ticker=`
 *    (+ optional date / price) + the room policy `min entry [spend per to]`. It is a permanent public marker.
 *  - The 1Sat indexer cannot filter by MAP (txo/search has no MAP keys, /bsv21/tokens carries only
 *    sym/icon), so the Market finds tickets through a bit-sign registry (GET /api/bitsign/tickets)
 *    plus the tickets this device minted (localStorage), merged.
 *
 * Pure helpers + localStorage. Nothing here signs or broadcasts.
 */

export const TICKET_COPY = 'A ticket gets you into a room. Send one to invite someone.';
export const TICKET_DECIMALS = 0;
export const TICKET_MIN = '1';
export const TICKET_PURPOSE = 'ticket';
export const DEFAULT_TICKET_SUPPLY = '100';
/** Deploy inscription (~250 B with an outpoint icon) + the MAP output. */
export const TICKET_DEPLOY_BYTES = 450;
export const MAX_ICON_BYTES = 512 * 1024;

/**
 * Room access rule (bChat protocol SPEC §7.2–7.3, room-policy). The token itself is neutral; the
 * ROOM decides how it is used:
 *  - `min`: how many tokens confer entry (whole tokens in the form, raw units on chain);
 *  - `entry hold` (default): holding `min` is membership (bit-sign's token-room gate does this);
 *  - `entry spend`: holding `min` lets you in, and you pay `spend` raw units `per` entry / message /
 *    minute / hour / day, `to` burn (default) / owner / an address.
 * bit-sign's gate has no spend check yet: the creator can set and record a spend rule, but it is
 * not enforced ("coming soon") and the room works as `hold` until it is.
 * Recorded in the ticket MAP tag with the spec's keys: `min entry [spend per to]`.
 */
export type EntryRule = 'hold' | 'spend';
export type SpendPer = 'entry' | 'message' | 'minute' | 'hour' | 'day';
export type SpendTo = 'burn' | 'owner' | 'address';
export const ENTRY_RULES: EntryRule[] = ['hold', 'spend'];
export const SPEND_PERS: SpendPer[] = ['entry', 'message', 'minute', 'hour', 'day'];
export const SPEND_TOS: SpendTo[] = ['burn', 'owner', 'address'];
export const ENTRY_LABEL: Record<EntryRule, string> = { hold: 'Hold', spend: 'Spend' };
export const SPEND_TO_LABEL: Record<SpendTo, string> = { burn: 'Burn', owner: 'Me (owner)', address: 'An address' };
/** Flip when bit-sign's token-room gate enforces spend rooms (SPEC §7.3). */
export const SPEND_ENTRY_SUPPORTED = false;
export const SPEND_NOT_ENFORCED =
  "Spend rules are recorded on chain, but bit-sign doesn't enforce them yet (coming soon): the room works as Hold for now.";

/** Whole tokens → raw units. */
export const toRaw = (whole: string, decimals: number) =>
  (BigInt((whole || '').trim().replace(/[,_\s]/g, '') || '0') * 10n ** BigInt(decimals)).toString();

const isWhole = (s: string) => /^\d+$/.test((s || '').trim().replace(/[,_\s]/g, ''));

export interface TicketForm {
  /** Room name, e.g. "Night Owls". */
  name: string;
  ticker: string;
  supply: string;
  /** Description / founding note; posted as the room's first message too. */
  description: string;
  /** Optional, YYYY-MM-DD. */
  eventDate: string;
  /** Optional asking price per ticket, in sats (shown; listing itself is a separate step). */
  priceSats: string;
  /** Tokens needed to enter (whole tokens). */
  minTokens: string;
  /** Room access rule. */
  entry: EntryRule;
  /** Spend rooms: whole tokens paid per `spendPer`, sent `spendTo`. */
  spendAmount: string;
  spendPer: SpendPer;
  spendTo: SpendTo;
  spendAddress: string;
}

export const emptyTicketForm = (): TicketForm => ({
  name: '',
  ticker: '',
  supply: DEFAULT_TICKET_SUPPLY,
  description: '',
  eventDate: '',
  priceSats: '',
  minTokens: '1',
  entry: 'hold',
  spendAmount: '1',
  spendPer: 'entry',
  spendTo: 'burn',
  spendAddress: '',
});

/** "Night Owls" → "NIGHTOWLS"; also cleans a typed ticker. */
export const suggestTicker = (s: string) =>
  (s || '')
    .toUpperCase()
    .replace(/^\$/, '')
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 16);

export const isTicker = (s: string) => /^[A-Z0-9_-]{1,32}$/.test(s);
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export const TICKET_BLOCKED = "This can't be minted in bWallet.";

export function validateTicket(f: TicketForm, s: SafetyFilter = safety()): string | null {
  const name = f.name.trim();
  if (!name) return 'Name the room.';
  if (name.length > 64) return 'Keep the room name under 64 characters.';
  const t = f.ticker.trim().replace(/^\$/, '');
  if (!t) return 'Add a ticker.';
  if (!isTicker(t)) return 'Ticker: capital letters, digits, - or _ only (max 32).';
  const bad = validateSupply(f.supply);
  if (bad) return bad;
  if (f.description.length > 1000) return 'Keep the description under 1000 characters.';
  if (f.eventDate.trim() && !isDate(f.eventDate.trim())) return 'Pick a valid date.';
  const p = f.priceSats.trim().replace(/[,_\s]/g, '');
  if (p && (!/^\d+$/.test(p) || BigInt(p) < 1n || BigInt(p) > 21n * 10n ** 14n))
    return 'Price is a whole number of sats.';
  if (!isWhole(f.minTokens) || BigInt(f.minTokens.trim().replace(/[,_\s]/g, '')) < 1n)
    return 'Tokens needed to enter is a whole number, at least 1.';
  if (BigInt(f.minTokens.trim().replace(/[,_\s]/g, '')) > BigInt(cleanSupply(f.supply)))
    return 'Tokens needed to enter can’t be more than the supply.';
  if (!ENTRY_RULES.includes(f.entry)) return 'Pick an entry rule.';
  if (f.entry === 'spend') {
    if (!isWhole(f.spendAmount) || BigInt(f.spendAmount.trim().replace(/[,_\s]/g, '')) < 1n)
      return 'Spend amount is a whole number, at least 1.';
    if (!SPEND_PERS.includes(f.spendPer)) return 'Pick what the spend is per.';
    if (!SPEND_TOS.includes(f.spendTo)) return 'Pick where spent tokens go.';
    if (f.spendTo === 'address' && !validate(f.spendAddress.trim())) return 'Enter a valid BSV address.';
  }
  if (s.check({ ids: [], texts: [name, t, f.description] }).blocked) return TICKET_BLOCKED;
  return null;
}

export const cleanTicket = (f: TicketForm) => ({
  name: f.name.trim(),
  ticker: f.ticker.trim().replace(/^\$/, ''),
  supply: cleanSupply(f.supply),
  description: f.description.trim(),
  eventDate: f.eventDate.trim() || null,
  priceSats: f.priceSats.trim() ? Number(f.priceSats.replace(/[,_\s]/g, '')) : null,
  min: toRaw(f.minTokens, TICKET_DECIMALS),
  entry: f.entry,
  spend:
    f.entry === 'spend'
      ? {
          amount: toRaw(f.spendAmount, TICKET_DECIMALS),
          per: f.spendPer,
          to: f.spendTo === 'address' ? f.spendAddress.trim() : f.spendTo,
        }
      : null,
});

// ── on-chain MAP marker (an extra 0-sat OP_RETURN on the deploy tx) ──

export function ticketMapFields(f: TicketForm): string[] {
  const c = cleanTicket(f);
  const out = ['app', 'bWallet', 'type', 'ticket', 'name', c.name.slice(0, 64), 'ticker', c.ticker];
  if (c.eventDate) out.push('date', c.eventDate);
  if (c.priceSats) out.push('price', String(c.priceSats));
  out.push('min', c.min, 'entry', c.entry);
  if (c.spend) out.push('spend', c.spend.amount, 'per', c.spend.per, 'to', c.spend.to);
  return out;
}

export function ticketMapScript(f: TicketForm): LockingScript {
  const s = new LockingScript();
  s.writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  for (const part of [MAP_PREFIX, 'SET', ...ticketMapFields(f)]) s.writeBin(Utils.toArray(part, 'utf8'));
  return s;
}

// ── cost (same 1% mint fee rule as Mint media: mint.ts) ──

export type TicketCost = {
  networkSats: number;
  feeSats: number;
  totalSats: number;
  usd: number | null;
  txCount: number;
};

/** Icon inscription (when an image is picked) + the deploy tx. The 1% fee rides on the deploy. */
export function ticketCost(
  iconBytes: number,
  satsPerKb: number,
  usdPerBsv = 0,
  feeAddress?: string,
  deployBytes = TICKET_DEPLOY_BYTES,
): TicketCost {
  const icon = iconBytes > 0 ? txFeeSats(iconBytes, satsPerKb) : 0;
  const networkSats = icon + txFeeSats(deployBytes, satsPerKb);
  const feeSats = mintFeeFor(networkSats, feeAddress);
  // No indexing at mint: the room / listing is set up later (tokens/roomSetup.ts).
  const totalSats = networkSats + feeSats;
  return {
    networkSats,
    feeSats,
    totalSats,
    usd: usdPerBsv > 0 ? (totalSats / 1e8) * usdPerBsv : null,
    txCount: iconBytes > 0 ? 2 : 1,
  };
}

// ── the ticket record (registry row / local) ──

export interface Ticket {
  tokenId: string;
  ticker: string;
  name: string;
  description: string | null;
  /** Icon inscription outpoint (txid_vout), if any. */
  icon: string | null;
  eventDate: string | null;
  priceSats: number | null;
  supply: string | null;
  /** Tokens needed to enter, raw units (null = 1). */
  min: string | null;
  roomTicker: string | null;
  createdAt: number;
}

const OUTPOINT = /^([0-9a-f]{64})[._](\d{1,6})$/i;
const normId = (s: unknown): string | null => {
  const m = typeof s === 'string' ? s.trim().match(OUTPOINT) : null;
  return m ? `${m[1].toLowerCase()}_${m[2]}` : null;
};
const str = (v: unknown, max = 1000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** One registry row (snake_case from bit-sign, or camelCase from local storage). Null if unusable. */
export function parseTicket(raw: unknown): Ticket | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tokenId = normId(r.token_id ?? r.tokenId);
  const ticker = str(r.ticker, 32)?.replace(/^\$/, '').toUpperCase() ?? null;
  if (!tokenId || !ticker || !isTicker(ticker)) return null;
  const date = str(r.event_date ?? r.eventDate, 10);
  const price = Number(r.price_sats ?? r.priceSats);
  const created = r.created_at ?? r.createdAt;
  const supply = str(r.supply, 20);
  const min = str(r.min, 24);
  return {
    tokenId,
    ticker,
    name: str(r.name, 64) ?? `$${ticker}`,
    description: str(r.description),
    icon: normId(r.icon),
    eventDate: date && isDate(date) ? date : null,
    priceSats: Number.isFinite(price) && price > 0 ? Math.floor(price) : null,
    supply: supply && /^\d+$/.test(supply) ? supply : null,
    min: min && /^\d+$/.test(min) && min !== '0' ? min : null,
    roomTicker: str(r.room_ticker ?? r.roomTicker, 64),
    createdAt: typeof created === 'number' ? created : Date.parse(String(created ?? '')) || 0,
  };
}

export const parseTicketList = (data: unknown): Ticket[] => {
  const rows = Array.isArray(data) ? data : (data as { tickets?: unknown } | null)?.tickets;
  return Array.isArray(rows) ? rows.map(parseTicket).filter((t): t is Ticket => !!t) : [];
};

/** The registry POST body. */
export const ticketRegistration = (t: Ticket) => ({
  token_id: t.tokenId,
  ticker: t.ticker,
  name: t.name,
  description: t.description,
  icon: t.icon,
  event_date: t.eventDate,
  price_sats: t.priceSats,
  supply: t.supply,
  min: t.min,
  room_ticker: t.roomTicker,
});

/**
 * Market list: registry + this device's tickets, deduped by token id (the registry row wins but
 * keeps a local room ticker), safety-filtered, upcoming events first, then newest.
 */
export function mergeTickets(
  registry: Ticket[],
  local: Ticket[],
  s: SafetyFilter = safety(),
  now = Date.now(),
): Ticket[] {
  const by = new Map<string, Ticket>();
  for (const t of local) by.set(t.tokenId, t);
  for (const t of registry) {
    const l = by.get(t.tokenId);
    by.set(t.tokenId, { ...t, roomTicker: t.roomTicker ?? l?.roomTicker ?? null, icon: t.icon ?? l?.icon ?? null });
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const rank = (t: Ticket) => (t.eventDate && t.eventDate >= today ? 0 : 1);
  return [...by.values()]
    .filter((t) => !s.check({ ids: [t.tokenId, t.icon], texts: [t.name, t.ticker, t.description] }).blocked)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (rank(a) === 0 ? (a.eventDate ?? '').localeCompare(b.eventDate ?? '') : 0) ||
        b.createdAt - a.createdAt,
    );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sat 12 Oct 2026" / "Ended 12 Oct 2026"; null without a date. */
export function eventLabel(date: string | null, now = Date.now()): string | null {
  if (!date || !isDate(date)) return null;
  const d = new Date(`${date}T00:00:00Z`);
  // Built by hand: Intl output differs between engines (WebView vs test runner).
  const label = `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return date < new Date(now).toISOString().slice(0, 10) ? `Ended ${label}` : label;
}

/** The room's first message: the founding note (or a default welcome). */
export const foundingMessage = (t: Pick<Ticket, 'name' | 'ticker' | 'description' | 'eventDate'>) => {
  const lines = [`Welcome to ${t.name}. ${TICKET_COPY}`];
  if (t.description) lines.push('', t.description);
  const ev = eventLabel(t.eventDate);
  if (ev) lines.push('', `Event: ${ev}`);
  return lines.join('\n');
};

// ── local storage: tickets this device minted ──

const KEY = 'bwallet.tickets.mine';
const EVENT = 'bwallet-tickets-changed';

export function localTickets(): Ticket[] {
  try {
    return parseTicketList(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    return [];
  }
}

export function saveLocalTicket(t: Ticket) {
  try {
    const rest = localTickets().filter((x) => x.tokenId !== t.tokenId);
    localStorage.setItem(KEY, JSON.stringify([t, ...rest].slice(0, 200)));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // storage unavailable: the registry still lists it
  }
}

export const onTicketsChanged = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};
