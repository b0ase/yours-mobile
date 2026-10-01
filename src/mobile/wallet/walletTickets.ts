/**
 * Wallet → Tickets: the pure part (unit-tested in walletTickets.test.ts).
 *
 * A "ticket" here is any BSV-21 token this wallet holds that gets you into a token-gated room
 * (docs/TICKETS.md, docs/TOKEN-ROOMS.md). The wallet knows a token is a room ticket when:
 *
 * 1. it is the account's own personal $NAME token (names/personalToken.ts, local link);
 * 2. it is a minted ticket: bit-sign's ticket registry or this device's minted tickets
 *    (tickets/tickets.ts `mergeTickets`);
 * 3. it is another name's personal token we have learned (`knownPersonal`);
 * 4. bit-sign says a room exists for it (GET /rooms/token-gated?key=bsv21:<id>).
 *
 * Collections (1Sat NFTs) also gate rooms but are shown under NFTs, not here.
 * Tickets stay in the Tokens list too (they are ordinary tokens: sending one is an invite);
 * there they carry a "Ticket" mark (`ticketMark`).
 */
import type { Holding, TokenRoomLookup } from '../chat/tokenRooms';
import { amountLabel, atLeast, formatRaw, normOutpoint, tokenKey } from '../chat/tokenRooms';
import type { Ticket } from '../tickets/tickets';

export type TicketSource = 'personal' | 'ticket' | 'named' | 'room';

export interface WalletTicket {
  /** `bsv21:<id>` — the room key Chat opens. */
  key: string;
  tokenId: string;
  symbol: string;
  /** Room name. */
  name: string;
  /** Icon: outpoint or URL (resolve before use), if any. */
  icon: string | null;
  heldRaw: string;
  dec: number;
  /** Tokens needed to enter, raw units. */
  minRaw: string;
  /** bit-sign enforces holding only; spend rules are recorded but not enforced yet (TICKETS.md). */
  entry: 'hold';
  canEnter: boolean;
  source: TicketSource;
  roomTicker: string | null;
  members: number | null;
}

export interface TicketInputs {
  holdings: Holding[];
  /** Registry + local minted tickets (already merged / safety-filtered). */
  tickets?: Ticket[];
  /** The account's own personal-token link. */
  personal?: { name: string; tokenId: string; ticker?: string; roomTicker?: string | null } | null;
  /** Other names' personal tokens learned from bit-sign. */
  known?: { name: string; tokenId: string }[];
  lookups?: Record<string, TokenRoomLookup | undefined>;
}

const RANK: Record<TicketSource, number> = { personal: 0, ticket: 1, named: 2, room: 3 };

export function buildWalletTickets({
  holdings,
  tickets = [],
  personal = null,
  known = [],
  lookups = {},
}: TicketInputs): WalletTicket[] {
  const ticketBy = new Map(tickets.map((t) => [t.tokenId, t]));
  const knownBy = new Map<string, string>();
  for (const k of known) {
    const id = normOutpoint(k.tokenId);
    if (id) knownBy.set(id, k.name);
  }
  const ownId = personal ? normOutpoint(personal.tokenId) : null;
  const out: WalletTicket[] = [];
  const seen = new Set<string>();

  for (const h of holdings) {
    if (h.kind !== 'bsv21') continue;
    const id = normOutpoint(h.id);
    const key = id && tokenKey('bsv21', id);
    if (!id || !key || seen.has(id)) continue;
    const look = lookups[key];
    const t = ticketBy.get(id);
    const base = {
      key,
      tokenId: id,
      symbol: h.symbol,
      icon: h.icon ?? null,
      heldRaw: h.amountRaw,
      dec: h.dec,
      entry: 'hold' as const,
      roomTicker: look?.room?.ticker ?? null,
      members: look?.room ? look.room.members : null,
    };
    let row: WalletTicket | null = null;
    const min = (fallback: string) => look?.gate?.minRaw ?? fallback;
    if (id === ownId && personal) {
      const m = min('1');
      row = {
        ...base,
        name: look?.room?.name || `$${personal.name.toUpperCase()}`,
        minRaw: m,
        source: 'personal',
        roomTicker: base.roomTicker ?? personal.roomTicker ?? null,
        canEnter: false,
      };
    } else if (t) {
      row = {
        ...base,
        name: t.name,
        icon: t.icon ?? base.icon,
        minRaw: min(t.min ?? '1'),
        source: 'ticket',
        roomTicker: base.roomTicker ?? t.roomTicker,
        canEnter: false,
      };
    } else if (knownBy.has(id) || look?.personal) {
      const n = knownBy.get(id) ?? look!.personal!.name;
      row = {
        ...base,
        name: look?.room?.name || `$${n.toUpperCase()}`,
        minRaw: min('1'),
        source: 'named',
        canEnter: false,
      };
    } else if (look?.room) {
      row = {
        ...base,
        name: look.room.name || `$${h.symbol}`,
        minRaw: min('1'),
        source: 'room',
        canEnter: false,
      };
    }
    if (!row) continue;
    row.canEnter = atLeast(row.heldRaw, row.minRaw);
    seen.add(id);
    out.push(row);
  }
  return out.sort((a, b) => RANK[a.source] - RANK[b.source] || a.name.localeCompare(b.name));
}

/** Held tokens not yet known to be tickets: the ones worth asking bit-sign about. */
export const tokensToLookUp = (holdings: Holding[], known: WalletTicket[], cap = 40): string[] => {
  const have = new Set(known.map((k) => k.key));
  const out: string[] = [];
  for (const h of holdings) {
    const k = h.kind === 'bsv21' ? tokenKey('bsv21', h.id) : null;
    if (k && !have.has(k) && !out.includes(k)) out.push(k);
    if (out.length >= cap) break;
  }
  return out;
};

/** "Hold 1 $FILM to enter". */
export const entryLine = (t: Pick<WalletTicket, 'key' | 'symbol' | 'dec' | 'minRaw'>) =>
  `Hold ${amountLabel(t.minRaw, t)} to enter`;

/** "3 held". */
export const heldLine = (t: Pick<WalletTicket, 'heldRaw' | 'dec'>) => `${formatRaw(t.heldRaw, t.dec)} held`;

export const SOURCE_LABEL: Record<TicketSource, string> = {
  personal: 'Your token',
  ticket: 'Ticket',
  named: 'Personal room',
  room: 'Token room',
};

// ── the Tokens-list mark: ids of held tickets, remembered across launches ──

const IDS_KEY = 'bwallet.tickets.heldIds';

export const rememberTicketIds = (ids: string[]) => {
  try {
    localStorage.setItem(IDS_KEY, JSON.stringify(ids.slice(0, 500)));
  } catch {
    /* storage unavailable */
  }
};

export const rememberedTicketIds = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(IDS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/** Token-list label: "FILM" → "FILM · Ticket" when `id` is a known ticket. */
export const ticketMark = (label: string, id: string | undefined, ids: Iterable<string>): string => {
  const n = id ? normOutpoint(id) : null;
  if (!n) return label;
  for (const x of ids) if (normOutpoint(x) === n) return `${label} · Ticket`;
  return label;
};
