/**
 * Token rooms — the pure part (unit-tested in tokenRooms.test.ts).
 *
 * Owner's model: chatrooms are TOKEN ROOMS ONLY. One room per BSV-21 token or 1Sat collection
 * the wallet holds; it appears when you hold ≥ the room minimum and goes when you don't. "You buy
 * a token, it adds to your chatrooms, you chat." An invite is the room token, sent.
 *
 * The server (bit-sign) is the system of record and enforces the gate on every read/post; the
 * wallet's view here only decides what to SHOW. See docs/TOKEN-ROOMS.md.
 */
import type { ChatRoom } from './messages';

export type TokenKind = 'bsv21' | 'coll';

/** A token the wallet holds, as the Chat list needs it. */
export interface Holding {
  kind: TokenKind;
  /** txid_vout (token origin / collection origin). */
  id: string;
  symbol: string;
  dec: number;
  /** Raw (unscaled) amount held; for a collection, the item count. */
  amountRaw: string;
  icon?: string | null;
}

/** The gate as bit-sign describes it (room metadata.tokenGate, or a 403 body's `gate`). */
export interface TokenGate {
  key: string;
  symbol: string;
  dec: number;
  minRaw: string;
}

/** Server's answer to GET /rooms/token-gated?key= */
export interface TokenRoomLookup {
  key: string;
  room: { ticker: string; name: string | null; members: number } | null;
  gate?: TokenGate;
  heldRaw?: string | null;
  member?: boolean;
}

export type EntryStatus =
  /** You're in: open the conversation. */
  | 'member'
  /** A room exists and you hold enough; opening it joins you (the server admits holders). */
  | 'join'
  /** No room for this token yet: opening it creates it. */
  | 'start';

export interface TokenRoomEntry {
  key: string;
  holding: Holding;
  status: EntryStatus;
  /** Present for member / join. */
  room: ChatRoom | null;
  gate: TokenGate;
  members: number | null;
}

const OUTPOINT = /^([0-9a-f]{64})[._](\d{1,6})$/i;

export const normOutpoint = (s: string): string | null => {
  const m = (s || '').trim().match(OUTPOINT);
  return m ? `${m[1].toLowerCase()}_${m[2]}` : null;
};

export const tokenKey = (kind: TokenKind, id: string): string | null => {
  const o = normOutpoint(id);
  return o ? `${kind}:${o}` : null;
};

export const parseTokenKey = (key: string): { kind: TokenKind; id: string } | null => {
  const i = (key || '').indexOf(':');
  const kind = key.slice(0, i);
  if (i <= 0 || (kind !== 'bsv21' && kind !== 'coll')) return null;
  const id = normOutpoint(key.slice(i + 1));
  return id ? { kind, id } : null;
};

// ── amounts (raw strings, BigInt) ──
export const atLeast = (raw: string | null | undefined, min: string): boolean => {
  try {
    return BigInt(raw || '0') >= BigInt(min || '1');
  } catch {
    return false;
  }
};

export const defaultMinRaw = (dec: number): string =>
  (BigInt(10) ** BigInt(Number.isInteger(dec) && dec > 0 && dec <= 18 ? dec : 0)).toString();

export function formatRaw(raw: string, dec: number): string {
  let n: bigint;
  try {
    n = BigInt(raw || '0');
  } catch {
    return '0';
  }
  if (dec <= 0) return n.toString();
  const s = n.toString().padStart(dec + 1, '0');
  const frac = s.slice(-dec).replace(/0+$/, '');
  return frac ? `${s.slice(0, -dec)}.${frac}` : s.slice(0, -dec);
}

/** "1 $FILM" / "2 items" */
export const amountLabel = (raw: string, gate: Pick<TokenGate, 'key' | 'symbol' | 'dec'>): string => {
  if (gate.key.startsWith('coll:')) {
    const n = formatRaw(raw, 0);
    return `${n} ${n === '1' ? 'item' : 'items'}`;
  }
  return `${formatRaw(raw, gate.dec)} $${gate.symbol}`;
};

/** The locked-room line: "Hold 1 $FILM to join". */
export const holdLine = (gate: TokenGate): string =>
  gate.key.startsWith('coll:')
    ? `Hold ${amountLabel(gate.minRaw, gate)} from ${gate.symbol} to join`
    : `Hold ${amountLabel(gate.minRaw, gate)} to join`;

// ── reading server shapes ──
type RawGate = { key?: unknown; symbol?: unknown; dec?: unknown; minAmountRaw?: unknown; min_raw?: unknown };

const asGate = (g: RawGate | null | undefined): TokenGate | null => {
  if (!g || typeof g.key !== 'string' || !parseTokenKey(g.key)) return null;
  const minRaw = typeof g.minAmountRaw === 'string' ? g.minAmountRaw : typeof g.min_raw === 'string' ? g.min_raw : '1';
  return {
    key: g.key,
    symbol: typeof g.symbol === 'string' && g.symbol ? g.symbol : 'TOKEN',
    dec: Number(g.dec) || 0,
    minRaw: /^\d+$/.test(minRaw) ? minRaw : '1',
  };
};

/** The token gate on a room from GET /rooms (metadata.tokenGate), if it is a token room. */
export const gateOfRoom = (room: ChatRoom): TokenGate | null =>
  asGate((room.metadata as { tokenGate?: RawGate } | null | undefined)?.tokenGate);

export interface GateRefusal {
  message: string;
  gate: TokenGate;
  heldRaw: string | null;
  room: { ticker: string; name: string | null; members: number } | null;
}

/** A 403 body from a gated room (`token_gated: true`), or null for any other error. */
export const parseGateRefusal = (data: unknown): GateRefusal | null => {
  if (!data || typeof data !== 'object') return null;
  const d = data as { token_gated?: unknown; gate?: RawGate; error?: unknown; held_raw?: unknown; room?: unknown };
  if (d.token_gated !== true) return null;
  const gate = asGate(d.gate);
  if (!gate) return null;
  const r = d.room as { ticker?: unknown; name?: unknown; members?: unknown } | undefined;
  return {
    message: typeof d.error === 'string' ? d.error : holdLine(gate),
    gate,
    heldRaw: typeof d.held_raw === 'string' ? d.held_raw : null,
    room:
      r && typeof r.ticker === 'string'
        ? { ticker: r.ticker, name: typeof r.name === 'string' ? r.name : null, members: Number(r.members) || 0 }
        : null,
  };
};

export const parseLookup = (data: unknown): TokenRoomLookup | null => {
  if (!data || typeof data !== 'object') return null;
  const d = data as { key?: unknown; room?: unknown; gate?: RawGate; held_raw?: unknown; member?: unknown };
  if (typeof d.key !== 'string') return null;
  const r = d.room as { ticker?: unknown; name?: unknown; members?: unknown } | null | undefined;
  return {
    key: d.key,
    room:
      r && typeof r.ticker === 'string'
        ? { ticker: r.ticker, name: typeof r.name === 'string' ? r.name : null, members: Number(r.members) || 0 }
        : null,
    gate: asGate(d.gate) ?? undefined,
    heldRaw: typeof d.held_raw === 'string' ? d.held_raw : null,
    member: d.member === true,
  };
};

/**
 * The Chat list: one entry per held token, joined with bit-sign's token rooms.
 *
 * - Only TOKEN rooms; DMs and other bChat rooms are not shown (owner decision).
 * - A held token appears only if the holding meets the room minimum (the room's, when one
 *   exists; otherwise the default of one whole token / one item).
 * - Member rooms whose token the wallet no longer holds enough of disappear (the server
 *   revokes on the next request anyway).
 * - `lookups` (GET token-gated per key) fill in rooms you are not yet a member of.
 */
export function buildTokenRoomList(
  holdings: Holding[],
  myRooms: ChatRoom[],
  lookups: Record<string, TokenRoomLookup | undefined> = {},
): TokenRoomEntry[] {
  const roomByKey = new Map<string, ChatRoom>();
  for (const r of myRooms) {
    const g = gateOfRoom(r);
    if (g) roomByKey.set(g.key, r);
  }
  const out: TokenRoomEntry[] = [];
  const seen = new Set<string>();
  for (const h of holdings) {
    const key = tokenKey(h.kind, h.id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const mine = roomByKey.get(key) ?? null;
    const look = lookups[key];
    const gate: TokenGate = (mine && gateOfRoom(mine)) ||
      look?.gate || {
        key,
        symbol: h.symbol,
        dec: h.kind === 'coll' ? 0 : h.dec,
        minRaw: h.kind === 'coll' ? '1' : defaultMinRaw(h.dec),
      };
    if (!atLeast(h.amountRaw, gate.minRaw)) continue;
    if (mine) {
      out.push({ key, holding: h, status: 'member', room: mine, gate, members: mine.party_count ?? null });
    } else if (look?.room) {
      const room: ChatRoom = { id: look.room.ticker, ticker: look.room.ticker, name: look.room.name, party_count: look.room.members };
      out.push({ key, holding: h, status: look.member ? 'member' : 'join', room, gate, members: look.room.members });
    } else {
      out.push({ key, holding: h, status: 'start', room: null, gate, members: null });
    }
  }
  const t = (e: TokenRoomEntry) => Date.parse(e.room?.last_message?.created_at ?? e.room?.updated_at ?? '') || 0;
  return out.sort((a, b) => t(b) - t(a) || a.gate.symbol.localeCompare(b.gate.symbol));
}

// ── wallet keys to prove ──

export interface Derivation {
  protocolID: [0 | 1 | 2, string];
  keyID: string;
  counterparty: string;
}

/** The derivation a wallet output's customInstructions records, if any. */
export const derivationOf = (customInstructions: string | undefined): Derivation | null => {
  if (!customInstructions) return null;
  try {
    const o = JSON.parse(customInstructions) as Partial<Derivation>;
    if (!Array.isArray(o.protocolID) || typeof o.keyID !== 'string' || !o.keyID) return null;
    const [level, name] = o.protocolID as [number, string];
    if (![0, 1, 2].includes(level) || typeof name !== 'string') return null;
    return { protocolID: [level as 0 | 1 | 2, name], keyID: o.keyID, counterparty: o.counterparty || 'self' };
  } catch {
    return null;
  }
};

/** Distinct derivations, capped (each costs one signature). */
export const uniqueDerivations = (list: (Derivation | null)[], cap = 25): Derivation[] => {
  const seen = new Set<string>();
  const out: Derivation[] = [];
  for (const d of list) {
    if (!d) continue;
    const k = JSON.stringify([d.protocolID, d.keyID, d.counterparty]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
    if (out.length >= cap) break;
  }
  return out;
};

/** Must match bit-sign's addressProofMessage. */
export const addressProofMessage = (handle: string, ts: number) => `bitcoinchat.online address proof: $${handle}: ${ts}`;

/** Invite input: "$alice" / "alice" → handle; a base58 address → address. */
export const parseInvitee = (input: string): { handle: string } | { address: string } | null => {
  const s = (input || '').trim();
  if (/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) return { address: s };
  const h = s.replace(/^\$/, '');
  return /^[\w.-]{1,64}$/.test(h) ? { handle: h.toLowerCase() } : null;
};
