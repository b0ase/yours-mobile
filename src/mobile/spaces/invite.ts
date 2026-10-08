/**
 * Space invite links (docs/BSPACES-PLAN.md, "Invite links and tickets"), the pure half: which URLs
 * are invites, and the shape of bit-sign's public invite (GET /api/bitsign/space-invites/<code>).
 *
 * Links: https://bwalletx.com/s/<code> (and the bit-sign / bChat hosts that serve /s/ today), or
 * the app's own bwalletx://space/<code>.
 */

const CODE = /^[a-hjkmnp-z2-9]{10}$/;
const WEB_HOSTS = new Set([
  'bwalletx.com',
  'www.bwalletx.com',
  'bit-sign.online',
  'www.bit-sign.online',
  'bitcoinchat.online',
  'www.bitcoinchat.online',
]);

export const isSpaceInviteCode = (s: string) => CODE.test(s);

/** The invite code in a link, or null when the link is not a Space invite. */
export const spaceInviteCode = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    let code = '';
    if (u.protocol === 'bwalletx:') {
      // bwalletx://space/<code>: host "space", path "/<code>".
      if (u.host !== 'space') return null;
      code = u.pathname.replace(/^\/+/, '');
    } else if (u.protocol === 'https:' && WEB_HOSTS.has(u.host)) {
      const m = u.pathname.match(/^\/s\/([^/]+)\/?$/);
      code = m?.[1] ?? '';
    } else return null;
    return isSpaceInviteCode(code) ? code : null;
  } catch {
    return null;
  }
};

export type InviteEntry =
  | { kind: 'free' | 'members'; line: string }
  | { kind: 'token'; symbol: string; amount: string; mode: 'hold' | 'burn'; usd: number | null; line: string };

export interface SpaceInvite {
  code: string;
  url: string;
  ticker: string;
  roomName: string;
  title: string;
  host: string | null;
  live: boolean;
  statusLine: string;
  entry: InviteEntry;
  gate: { key: string; kind: 'bsv21' | 'coll' | null; id: string | null; symbol: string } | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const parseSpaceInvite = (data: unknown): SpaceInvite | null => {
  const d = (data as { invite?: Record<string, unknown> } | null)?.invite;
  if (!d || typeof d !== 'object') return null;
  const code = str(d.code);
  const ticker = str(d.ticker);
  if (!isSpaceInviteCode(code) || !ticker) return null;
  const status = (d.status ?? {}) as { state?: unknown; line?: unknown };
  const e = (d.entry ?? {}) as Record<string, unknown>;
  const line = str(e.line) || 'Members only';
  const entry: InviteEntry =
    e.kind === 'token'
      ? {
          kind: 'token',
          symbol: str(e.symbol),
          amount: str(e.amount) || '1',
          mode: e.mode === 'burn' ? 'burn' : 'hold',
          usd: typeof e.usd === 'number' && Number.isFinite(e.usd) && e.usd > 0 ? e.usd : null,
          line,
        }
      : { kind: e.kind === 'free' ? 'free' : 'members', line };
  const g = d.gate as Record<string, unknown> | null | undefined;
  const kind = g?.kind === 'bsv21' || g?.kind === 'coll' ? g.kind : null;
  return {
    code,
    url: str(d.url),
    ticker,
    roomName: str(d.room_name) || `$${ticker}`,
    title: str(d.title) || str(d.room_name) || `$${ticker}`,
    host: str(d.host) || null,
    live: status.state === 'live',
    statusLine: str(status.line),
    entry,
    gate: g && str(g.key) ? { key: str(g.key), kind, id: str(g.id) || null, symbol: str(g.symbol) } : null,
  };
};

/** The text that goes with a shared link. */
export const inviteShareText = (inv: Pick<SpaceInvite, 'title' | 'live' | 'url'>) =>
  `${inv.live ? 'Live now: ' : ''}${inv.title}\n${inv.url}`;
