/**
 * bit-sign room X invites: every server call for the Invites screen and the claim screen.
 *
 * Shapes as agreed with bit-sign on 15 Oct 2026. TODO(x-invites): the server side is not deployed
 * until the owner OKs its migration; confirm the final URLs below once it is live. Until then every
 * call 404s, the host list answers "not a host", and the Invites entry stays hidden.
 *
 * Keys never go to the server: request bodies are built field by field here (only x_handle,
 * funded_address, txids and the funding BEEF), never by spreading a local record.
 */
import { ChatApiError } from './api';

export type XInviteStatus = 'open' | 'verified' | 'swept' | 'revoked';
const STATUSES: readonly XInviteStatus[] = ['open', 'verified', 'swept', 'revoked'];

export interface HostInvite {
  code: string;
  x_handle: string;
  status: XInviteStatus;
  claimed_by: string | null;
  created_at: string | null;
}

export interface CreatedInvite {
  code: string;
  x_handle: string;
  funded_address: string;
  /** "https://www.bchatx.com/i/x/<code>"; the wallet appends #k=<WIF>. */
  url_base: string;
}

export interface PublicInvite {
  room: { ticker: string; name: string | null; icon: string | null };
  x_handle: string;
  status: XInviteStatus;
}

/** What the module needs from the bChat client: one authenticated (or public) JSON call. */
export type Caller = (
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  auth?: boolean,
) => Promise<unknown>;

// TODO(x-invites): final URLs, once bit-sign deploys them.
const roomPath = (ticker: string) => `/api/bitsign/rooms/${encodeURIComponent(ticker.replace(/^\$/, ''))}/x-invites`;
const codePath = (code: string) => `/api/bitsign/x-invites/${encodeURIComponent(code)}`;
const publicPath = (code: string) => `/api/public/x-invites/${encodeURIComponent(code)}`;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const status = (v: unknown): XInviteStatus => (STATUSES.includes(v as XInviteStatus) ? (v as XInviteStatus) : 'open');

export function parseHostInvites(v: unknown): HostInvite[] {
  const list = (v as { invites?: unknown })?.invites;
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => x as Record<string, unknown>)
    .filter((x) => str(x.code))
    .map((x) => ({
      code: str(x.code),
      x_handle: str(x.x_handle).replace(/^@/, ''),
      status: status(x.status),
      claimed_by: str(x.claimed_by) || null,
      created_at: str(x.created_at) || null,
    }));
}

export function parseCreated(v: unknown): CreatedInvite[] {
  const list = (v as { invites?: unknown })?.invites;
  if (!Array.isArray(list)) throw new Error('The server did not return the invites');
  return list.map((x) => {
    const o = x as Record<string, unknown>;
    const c = {
      code: str(o.code),
      x_handle: str(o.x_handle).replace(/^@/, '').toLowerCase(),
      funded_address: str(o.funded_address),
      url_base: str(o.url_base),
    };
    if (!c.code || !c.funded_address || !/^https:\/\//.test(c.url_base)) throw new Error('Bad invite from the server');
    return c;
  });
}

export function parsePublicInvite(v: unknown): PublicInvite | null {
  const o = v as Record<string, unknown> | null;
  const r = o?.room as Record<string, unknown> | undefined;
  if (!o || !r || !str(r.ticker)) return null;
  return {
    room: { ticker: str(r.ticker), name: str(r.name) || null, icon: str(r.icon) || null },
    x_handle: str(o.x_handle).replace(/^@/, ''),
    status: status(o.status),
  };
}

/** The bodies sent to bit-sign. Exported so tests can prove no key is ever in them. */
export const createBody = (
  invites: ReadonlyArray<{ x_handle: string; funded_address: string }>,
  funding_txid: string,
  beef: string,
) => ({
  invites: invites.map((i) => ({ x_handle: i.x_handle, funded_address: i.funded_address })),
  funding_txid,
  beef,
});
export const sweptBody = (txid: string) => ({ txid });
export const revokeBody = (sweep_txid?: string | null) => (sweep_txid ? { sweep_txid } : {});

export class InvitesApi {
  constructor(private readonly call: Caller) {}

  /** The host's list; null when this user is not a host here (403) or the server has no such route (404). */
  async list(ticker: string): Promise<HostInvite[] | null> {
    try {
      return parseHostInvites(await this.call('GET', roomPath(ticker)));
    } catch (e) {
      if (e instanceof ChatApiError && (e.status === 403 || e.status === 404 || e.status === 401)) return null;
      throw e;
    }
  }

  async create(
    ticker: string,
    invites: ReadonlyArray<{ x_handle: string; funded_address: string }>,
    funding_txid: string,
    beef: string,
  ): Promise<CreatedInvite[]> {
    return parseCreated(await this.call('POST', roomPath(ticker), createBody(invites, funding_txid, beef)));
  }

  async revoke(ticker: string, code: string, sweep_txid?: string | null): Promise<void> {
    await this.call('POST', `${roomPath(ticker)}/${encodeURIComponent(code)}/revoke`, revokeBody(sweep_txid));
  }

  async lookup(code: string): Promise<PublicInvite | null> {
    return parsePublicInvite(await this.call('GET', publicPath(code), undefined, false));
  }

  /** Signed in; bit-sign checks the account's linked X is the invited handle. */
  async verify(code: string): Promise<{ ok: boolean }> {
    const r = (await this.call('POST', `${codePath(code)}/verify`, {})) as { ok?: unknown };
    return { ok: r?.ok === true };
  }

  async swept(code: string, txid: string): Promise<void> {
    await this.call('POST', `${codePath(code)}/swept`, sweptBody(txid));
  }
}
