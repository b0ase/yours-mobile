/**
 * Space pages, room pages and invite links (docs/BSPACES-PLAN.md, "Invite links and tickets"), the
 * pure half: which URLs open what, and the shapes of bit-sign's public reads.
 *
 *   Named Space (permanent) https://<host>/s/<ticker>  → the room, where its live Space docks
 *   Space episode           https://<host>/s/<ticker>/<slug>
 *   Space page (old/private) https://<host>/s/<slug>   bwalletx://space/<slug>
 *   Invite (ephemeral)      https://<host>/i/<code>    bwalletx://invite/<code>
 *   Room page (permanent)   https://<host>/r/<ticker>  bwalletx://room/<ticker>[?buy=1]
 *   Room itself             https://<host>/room/<ref>[?invite=<token>]  bwalletx://room/<ref>?invite=<token>
 *     <ref> is the ticker, or the clean address of a room without one (`r_7kq2m9ab`, optionally after a
 *     slug: bit-sign lib/room-ref.ts). `invite` is a one-use join link (bit-sign lib/invite-link-rules.ts):
 *     whoever opens it signed in becomes a member (POST rooms/<ref>/claim).
 *
 * <host> is bchatx.com (the planned base), bwalletx.com, bit-sign.online or bitcoinchat.online.
 */

const CODE = /^[a-hjkmnp-z2-9]{10}$/;
const TICKER = /^[A-Za-z0-9_-]{1,32}$/;
/** A room without a real ticker: `r_` + 8 base-36 chars, optionally after a slug of its name. */
const ROOM_REF = /^(?:[A-Za-z0-9-]{1,80}-)?r_[0-9a-z]{8}$/i;
/** bit-sign's invite-link token (24 random bytes, base64url). */
const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const WEB_HOSTS = new Set([
  ...['bchatx.com', 'bwalletx.com', 'bit-sign.online', 'bitcoinchat.online'].flatMap((h) => [h, `www.${h}`]),
  'chat.bwalletx.com',
]);

export const isSpaceInviteCode = (s: string) => CODE.test(s);
export const isSpaceSlug = isSpaceInviteCode;
export const isRoomTicker = (s: string) => TICKER.test(s);
/** A ticker or a clean room address (what /room/<ref> takes). */
export const isRoomRef = (s: string) => TICKER.test(s) || ROOM_REF.test(s);

export type AppLink =
  | { kind: 'space'; slug: string }
  | { kind: 'invite'; code: string }
  | { kind: 'room'; ticker: string; buy: boolean; invite?: string };

const roomLink = (ticker: string, u: URL): AppLink => {
  const invite = u.searchParams.get('invite') ?? '';
  return {
    kind: 'room',
    ticker,
    buy: u.searchParams.get('buy') === '1',
    ...(INVITE_TOKEN.test(invite) ? { invite } : {}),
  };
};

/** What a link opens, or null when it is none of ours. */
export const parseAppLink = (url: string | null | undefined): AppLink | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    let kind = '';
    let arg = '';
    if (u.protocol === 'bwalletx:') {
      // bwalletx://space/<slug>: host "space", path "/<slug>".
      kind = u.host;
      arg = u.pathname.replace(/^\/+|\/+$/g, '');
    } else if (u.protocol === 'https:' && WEB_HOSTS.has(u.host)) {
      // Named Space episode: /s/<ticker>/<slug> opens that Space's page.
      const ep = u.pathname.match(/^\/s\/([^/]+)\/([^/]+)\/?$/);
      if (ep && isRoomTicker(decodeURIComponent(ep[1])) && isSpaceSlug(decodeURIComponent(ep[2]))) {
        return { kind: 'space', slug: decodeURIComponent(ep[2]) };
      }
      const m = u.pathname.match(/^\/([sir]|room)\/([^/]+)\/?$/);
      if (!m) return null;
      kind = { s: 'space', i: 'invite', r: 'room', room: 'room' }[m[1]] ?? '';
      arg = m[2];
      // /room/<ref> is the room itself (not the /r/ public page): any ref, but never the New room page, and a
      // GitHub-held position (?gh=) needs the web's GitHub proof, so it stays a web link.
      if (m[1] === 'room') {
        const ref = decodeURIComponent(arg);
        if (!isRoomRef(ref) || ref.toLowerCase() === 'new' || u.searchParams.has('gh')) return null;
        return roomLink(ref, u);
      }
    } else return null;
    arg = decodeURIComponent(arg);
    if (kind === 'space' && isSpaceSlug(arg)) return { kind, slug: arg };
    // Named Space (owner, 9 Oct 2026): /s/<ticker> is the room's permanent Space address → open the room.
    if (kind === 'space' && u.protocol === 'https:' && isRoomTicker(arg))
      return { kind: 'room', ticker: arg.toUpperCase(), buy: false };
    if (kind === 'invite' && isSpaceInviteCode(arg)) return { kind, code: arg };
    if (kind === 'room' && (u.protocol === 'bwalletx:' ? isRoomRef(arg) : isRoomTicker(arg))) return roomLink(arg, u);
    return null;
  } catch {
    return null;
  }
};

/**
 * A bChatX page link this build could not open in the app (a Space link without Spaces, a sub-page of a room,
 * a link that failed to parse): its path, so the app shows it in bChatX's own frame rather than dropping a link
 * the phone handed us. Only the paths the app claims (/r/, /i/, /room/, /s/); never /i/x/ (X invites have their
 * own routing, and their key is in the fragment).
 */
export const bchatxDoorPath = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !WEB_HOSTS.has(u.host) || u.username || u.password) return null;
    if (!/^\/(r|i|room|s)\/[^/]/.test(u.pathname) || /^\/i\/x\//.test(u.pathname)) return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
};

/** A link to open: one the app parses, or a bChatX page shown in the bChatX frame. */
export type PendingLink = AppLink | { kind: 'door'; path: string };

/**
 * What a link opens in this build: the parsed link, or (a Space page without Spaces, a room sub-page, anything
 * else on the paths the app claims) the bChatX page in the frame. Null for links that aren't ours.
 */
export const appLinkFor = (url: string | null | undefined, spaces: boolean): PendingLink | null => {
  const link = parseAppLink(url);
  if (link?.kind === 'space' && !spaces) return { kind: 'door', path: `/s/${link.slug}` };
  if (link) return link;
  const path = bchatxDoorPath(url);
  return path ? { kind: 'door', path } : null;
};

export type InviteEntry =
  | { kind: 'free' | 'members'; line: string }
  | { kind: 'token'; symbol: string; amount: string; mode: 'hold' | 'burn'; usd: number | null; line: string };

export interface PublicGate {
  key: string;
  kind: 'bsv21' | 'coll' | null;
  id: string | null;
  symbol: string;
}

interface PageBase {
  url: string;
  ticker: string;
  roomName: string;
  title: string;
  live: boolean;
  statusLine: string;
  entry: InviteEntry;
  gate: PublicGate | null;
}

export interface SpacePage extends PageBase {
  kind: 'space';
  slug: string;
  host: string | null;
  /** The host's chosen display name (bit-sign #95 `host_name`); null before it deploys. */
  hostName?: string | null;
}

export interface RoomPage extends PageBase {
  kind: 'room';
  members: number | null;
  host: null;
}

export type InviteState = 'ok' | 'expired' | 'revoked' | 'used_up';

export interface SpaceInvite {
  code: string;
  url: string;
  state: InviteState;
  expiresAt: string | null;
  target: SpacePage | RoomPage;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

const entryOf = (raw: unknown): InviteEntry => {
  const e = obj(raw) ?? {};
  const line = str(e.line) || 'Members only';
  return e.kind === 'token'
    ? {
        kind: 'token',
        symbol: str(e.symbol),
        amount: str(e.amount) || '1',
        mode: e.mode === 'burn' ? 'burn' : 'hold',
        usd: typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd > 0 ? e.usd : null,
        line,
      }
    : { kind: e.kind === 'free' ? 'free' : 'members', line };
};

const pageOf = (d: Record<string, unknown>): SpacePage | RoomPage | null => {
  const ticker = str(d.ticker);
  if (!ticker) return null;
  const status = obj(d.status) ?? {};
  const g = obj(d.gate);
  const gkind = g?.kind === 'bsv21' || g?.kind === 'coll' ? g.kind : null;
  const base: PageBase = {
    url: str(d.url),
    ticker,
    roomName: str(d.room_name) || `$${ticker}`,
    title: str(d.title) || str(d.room_name) || `$${ticker}`,
    live: status.state === 'live',
    statusLine: str(status.line),
    entry: entryOf(d.entry),
    gate: g && str(g.key) ? { key: str(g.key), kind: gkind, id: str(g.id) || null, symbol: str(g.symbol) } : null,
  };
  if (d.kind === 'space') {
    const slug = str(d.slug);
    return isSpaceSlug(slug)
      ? { ...base, kind: 'space', slug, host: str(d.host) || null, hostName: str(d.host_name) || null }
      : null;
  }
  if (d.kind === 'room')
    return { ...base, kind: 'room', members: typeof d.members === 'number' ? d.members : null, host: null };
  return null;
};

/** `{ page }` from GET space-pages/<slug> or room-pages/<ticker>. */
export const parsePage = (data: unknown): SpacePage | RoomPage | null => {
  const d = obj(obj(data)?.page);
  return d ? pageOf(d) : null;
};

/** `{ invite }` from the invite GET / use / create. */
export const parseSpaceInvite = (data: unknown): SpaceInvite | null => {
  const d = obj(obj(data)?.invite);
  if (!d) return null;
  const code = str(d.code);
  const target = obj(d.target);
  const page = target ? pageOf(target) : null;
  if (!isSpaceInviteCode(code) || !page) return null;
  const state = (['ok', 'expired', 'revoked', 'used_up'] as const).find((s) => s === d.state) ?? 'expired';
  return { code, url: str(d.url), state, expiresAt: str(d.expires_at) || null, target: page };
};

export interface ManagedInvite {
  code: string;
  url: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  state: InviteState;
}

/** `{ invites }` from the host's list. */
export const parseManagedInvites = (data: unknown): ManagedInvite[] => {
  const list = obj(data)?.invites;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const r = obj(raw);
    const code = str(r?.code);
    if (!r || !isSpaceInviteCode(code)) return [];
    const state = (['ok', 'expired', 'revoked', 'used_up'] as const).find((s) => s === r.state) ?? 'expired';
    return [
      {
        code,
        url: str(r.url),
        createdBy: str(r.created_by),
        createdAt: str(r.created_at),
        expiresAt: str(r.expires_at) || null,
        maxUses: typeof r.max_uses === 'number' ? r.max_uses : null,
        uses: typeof r.uses === 'number' ? r.uses : 0,
        state,
      },
    ];
  });
};

export const EXPIRY_CHOICES = [
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['never', 'Never'],
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number][0];
export const DEFAULT_EXPIRY: ExpiryChoice = '7d';

/** "" or a whole number 1..100000; anything else is null (refuse). */
export const parseMaxUses = (s: string): number | '' | null => {
  const t = s.trim();
  if (!t) return '';
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : null;
};

export const STATE_LINE: Record<InviteState, string> = {
  ok: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  used_up: 'Used up',
};

/** "3 / 10 uses" or "3 uses". */
export const usesLine = (i: Pick<ManagedInvite, 'uses' | 'maxUses'>) =>
  i.maxUses != null ? `${i.uses} / ${i.maxUses} uses` : `${i.uses} ${i.uses === 1 ? 'use' : 'uses'}`;

/** The text that goes with a shared link. */
export const inviteShareText = (inv: { title: string; live: boolean; url: string }) =>
  `${inv.live ? 'Live now: ' : ''}${inv.title}\n${inv.url}`;
