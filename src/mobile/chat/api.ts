/**
 * bChat API client for the native Chat tab.
 *
 * Auth: the wallet signs bChat's own wallet-login challenge (BSM over
 * "bitcoinchat.online wallet login: <nonce>", kind 'yours') with its BRC-100
 * identity key — the same proof bChat's web "Yours" button asks for — and
 * keeps the session token /verify returns. Every call then sends it as
 * `Authorization: Bearer`, which bit-sign's resolveUserHandle accepts.
 *
 * Transport: on device, requests go through CapacitorHttp (native networking),
 * so the WebView's capacitor:// origin never meets CORS. In a browser it falls
 * back to fetch. Both are behind an injectable `Http` for tests.
 */
import { CapacitorHttp } from '@capacitor/core';
import type { ChatMessage, ChatRoom } from './messages';

import type { BchatContact } from './contacts';

export const BCHAT_ORIGIN = 'https://www.bitcoinchat.online';

export type HttpResponse = { status: number; data: unknown };
export type Http = (req: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}) => Promise<HttpResponse>;

const nativeHttp: Http = async ({ method, url, headers, body }) => {
  const res = await CapacitorHttp.request({
    method,
    url,
    headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
    data: body,
    responseType: 'json',
  });
  return { status: res.status, data: res.data };
};

const fetchHttp: Http = async ({ method, url, headers, body }) => {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'omit',
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, data };
};

export const defaultHttp = (native: boolean): Http => (native ? nativeHttp : fetchHttp);

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The response body, for structured refusals (a token room's `token_gated` 403). */
    readonly data: unknown = null,
  ) {
    super(message);
  }
}

/** What signing needs from the wallet: its identity address and a BSM signer. */
export interface ChatSigner {
  address: () => Promise<string>;
  sign: (message: string) => Promise<{ address: string; pubKey: string; sig: string }>;
}

export interface ChatSession {
  token: string;
  handle: string;
  address: string;
}

export interface MessagePage {
  messages: ChatMessage[];
  /** null when the server predates paging (no has_more field). */
  hasMore: boolean | null;
}

const errorOf = (data: unknown, fallback: string) =>
  (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
    ? (data as { error: string }).error
    : '') || fallback;

export class BchatClient {
  constructor(
    private readonly http: Http,
    private session: ChatSession | null = null,
    private readonly origin = BCHAT_ORIGIN,
  ) {}

  get handle() {
    return this.session?.handle ?? null;
  }

  get current() {
    return this.session;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth) {
      if (!this.session) throw new ChatApiError('Not signed in to bChat', 401);
      headers.Authorization = `Bearer ${this.session.token}`;
    }
    let res: HttpResponse;
    try {
      res = await this.http({ method, url: `${this.origin}${path}`, headers, body });
    } catch (e) {
      throw new ChatApiError(e instanceof Error ? e.message : 'Network error', 0);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ChatApiError(errorOf(res.data, `bChat error ${res.status}`), res.status, res.data);
    }
    return res.data as T;
  }

  /** Challenge → wallet BSM signature → verify. Returns (and keeps) the session. */
  async signIn(signer: ChatSigner): Promise<ChatSession> {
    let address = await signer.address();
    for (let attempt = 0; attempt < 2; attempt++) {
      const ch = await this.call<{ nonce: string; message: string }>(
        'POST',
        '/api/bitsign/auth/wallet/challenge',
        { address, kind: 'yours' },
        false,
      );
      const signed = await signer.sign(ch.message);
      // The nonce is bound to the address it was issued for; if the wallet
      // signed with a different key, ask again for that one.
      if (signed.address !== address) {
        address = signed.address;
        continue;
      }
      const v = await this.call<{ token?: string; handle?: string; needs_handle?: boolean; error?: string }>(
        'POST',
        '/api/bitsign/auth/wallet/verify',
        // intent=sign-in: sign in as this wallet's owner, ignoring any stale cookie session in the
        // native cookie jar (bit-sign PR #41). Older servers ignore the field.
        {
          address,
          kind: 'yours',
          nonce: ch.nonce,
          pubkey_hex: signed.pubKey,
          signature: signed.sig,
          intent: 'sign-in',
        },
        false,
      );
      if (!v.token || !v.handle) {
        throw new ChatApiError(
          v.needs_handle ? 'Choose a bChat handle at bitcoinchat.online first.' : 'bChat sign-in failed',
          401,
        );
      }
      this.session = { token: v.token, handle: v.handle, address };
      return this.session;
    }
    throw new ChatApiError('The wallet signed with an unexpected key', 401);
  }

  /**
   * Take the wallet's verified paymail name as the bChat handle (bit-sign
   * POST /api/bitsign/auth/wallet/paymail-handle). Only a provisional `yours-*`
   * handle is replaced server-side. Keeps the fresh session the server returns.
   */
  async claimPaymailHandle(proof: {
    paymail: string;
    identity_key: string;
    timestamp: number;
    signature: string;
  }): Promise<ChatSession> {
    const r = await this.call<{ token?: string; handle?: string; renamed?: boolean }>(
      'POST',
      '/api/bitsign/auth/wallet/paymail-handle',
      proof,
    );
    if (!this.session || !r.handle) throw new ChatApiError('bChat handle update failed', 500);
    this.session = { ...this.session, handle: r.handle, token: r.token || this.session.token };
    return this.session;
  }

  signOut() {
    this.session = null;
  }

  async rooms(): Promise<ChatRoom[]> {
    const r = await this.call<{ rooms?: ChatRoom[] }>('GET', '/api/bitsign/rooms');
    return r.rooms ?? [];
  }

  private static path(ticker: string) {
    return `/api/bitsign/rooms/${encodeURIComponent(ticker.replace(/^\$/, ''))}`;
  }

  /**
   * Newest page (or the page before `before`). Uses the paging params added on
   * bit-sign's feat/native-chat-api branch; against a server without them the
   * response has no has_more and is the OLDEST 200, so the caller catches up
   * with `since` (see latestPage).
   */
  async page(ticker: string, opts: { before?: string; limit?: number } = {}): Promise<MessagePage> {
    const q = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.before) q.set('before', opts.before);
    else q.set('latest', '1');
    const r = await this.call<{ messages?: ChatMessage[]; has_more?: boolean }>(
      'GET',
      `${BchatClient.path(ticker)}/messages?${q}`,
    );
    return { messages: r.messages ?? [], hasMore: typeof r.has_more === 'boolean' ? r.has_more : null };
  }

  async since(ticker: string, sinceIso: string): Promise<ChatMessage[]> {
    const r = await this.call<{ messages?: ChatMessage[] }>(
      'GET',
      `${BchatClient.path(ticker)}/messages?since=${encodeURIComponent(sinceIso)}`,
    );
    return r.messages ?? [];
  }

  /**
   * Open a conversation at its end. With paging support that is one call; on
   * an older server, page forward with `since` (200 per call, capped) until
   * caught up, keeping the tail.
   */
  async latestPage(ticker: string, limit = 50): Promise<MessagePage> {
    const first = await this.page(ticker, { limit });
    if (first.hasMore !== null) return first;
    let all = first.messages;
    let batch = first.messages;
    for (let i = 0; i < 10 && batch.length >= 200; i++) {
      batch = await this.since(ticker, batch[batch.length - 1].created_at);
      all = all.concat(batch);
    }
    return { messages: all.slice(-Math.max(limit, 200)), hasMore: null };
  }

  async send(ticker: string, body: string): Promise<ChatMessage | null> {
    const r = await this.call<{ message?: ChatMessage }>('POST', `${BchatClient.path(ticker)}/messages`, { body });
    return r.message ?? null;
  }

  async markRead(ticker: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/read`, {});
  }

  // ── Token rooms (docs/TOKEN-ROOMS.md) ──

  /** Is there a room for this token key, and am I in it? (GET never joins.) */
  async tokenRoom(key: string): Promise<unknown> {
    return this.call('GET', `/api/bitsign/rooms/token-gated?key=${encodeURIComponent(key)}`);
  }

  /** Create (or open) the token's room. The server re-checks the holding. Returns its ticker. */
  async startTokenRoom(
    key: string,
    opts: { name?: string; min?: string; purpose?: string; personal_name?: string } = {},
  ): Promise<string> {
    const r = await this.call<{ ticker: string }>('POST', '/api/bitsign/rooms/token-gated', { key, ...opts });
    return r.ticker;
  }

  /** Ticket registry (bit-sign, docs/TICKETS.md): public list of tickets minted in bWallet. */
  async tickets(): Promise<unknown> {
    return this.call('GET', '/api/bitsign/tickets', undefined, false);
  }

  /** Ticket registry: announce a ticket you just minted (the server re-checks the deploy). */
  async registerTicket(body: Record<string, unknown>): Promise<void> {
    await this.call('POST', '/api/bitsign/tickets', body);
  }

  /** The token id bound to a personal name ("boase"), or null. For the "$BOASE ✓" check. */
  async personalToken(name: string): Promise<{ tokenId: string | null; ticker: string | null }> {
    const r = await this.call<{ token_id?: string | null; ticker?: string | null }>(
      'GET',
      `/api/bitsign/rooms/token-gated?name=${encodeURIComponent(name)}`,
    );
    return { tokenId: r.token_id ?? null, ticker: r.ticker ?? null };
  }

  /** Room admin: the ban list. */
  async bans(ticker: string): Promise<{ handle: string | null; address: string | null; reason: string | null }[]> {
    const r = await this.call<{ bans?: { handle: string | null; address: string | null; reason: string | null }[] }>(
      'GET',
      `${BchatClient.path(ticker)}/bans`,
    );
    return r.bans ?? [];
  }

  /** Room admin: ban a $handle or an address (membership = holds the token AND not banned). */
  async ban(ticker: string, target: string, reason?: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/bans`, { target, reason });
  }

  async unban(ticker: string, target: string): Promise<void> {
    await this.call('DELETE', `${BchatClient.path(ticker)}/bans`, { target });
  }

  /** Room admin: change the membership minimum (whole tokens). */
  async setTokenRoomMinimum(ticker: string, min: string): Promise<void> {
    await this.call('PATCH', '/api/bitsign/rooms/token-gated', { ticker, min });
  }

  /** Link wallet keys to the account: each proof is a DER signature over `message` by that key. */
  async proveAddresses(
    message: string,
    proofs: { pubkey_hex: string; signature: string; role: 'receive' | 'token' }[],
  ): Promise<{ accepted: string[] }> {
    const r = await this.call<{ accepted?: string[] }>('POST', '/api/bitsign/wallet/addresses', { message, proofs });
    return { accepted: r.accepted ?? [] };
  }

  /** Collection rooms: name the items held so the server can verify them. */
  async proveItems(key: string, outpoints: string[]): Promise<number> {
    const r = await this.call<{ accepted?: number }>('POST', '/api/bitsign/wallet/holdings', { key, outpoints });
    return r.accepted ?? 0;
  }

  /** Where to send this room's token to invite $handle (members only). */
  async inviteAddress(ticker: string, handle: string): Promise<string> {
    const r = await this.call<{ address: string }>(
      'GET',
      `${BchatClient.path(ticker)}/invite-address?handle=${encodeURIComponent(handle)}`,
    );
    return r.address;
  }

  // ── Bounties paid on merge (bit-sign feat/bounty-payouts; src/mobile/chat/bounties.ts) ──

  async bounties(ticker: string): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/bounty`);
  }

  /** Claim by linking the PR. `agentLabel` names an agent acting for this handle. */
  async claimBounty(ticker: string, no: number, prUrl: string, agentLabel?: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/bounty/${no}/claim-pr`, {
      pr_url: prUrl.trim(),
      ...(agentLabel?.trim() ? { agent_label: agentLabel.trim() } : {}),
    });
  }

  /** Admin / treasury holder: the transfer spec this wallet performs. */
  async bountyPayoutSpec(ticker: string, no: number): Promise<unknown> {
    return this.call('GET', `${BchatClient.path(ticker)}/bounty/${no}/payout`);
  }

  /** After the wallet broadcast: record the txid (server marks the bounty paid, once). */
  async confirmBountyPayout(ticker: string, no: number, txid: string): Promise<void> {
    await this.call('POST', `${BchatClient.path(ticker)}/bounty/${no}/payout`, { txid });
  }

  // ── bCredits (bit-sign feat/credits; src/mobile/credits) ──

  /** Balance + public $BCREDIT config (token id, treasury, price). */
  async credits(): Promise<unknown> {
    return this.call('GET', '/api/bitsign/credits');
  }

  async creditLedger(limit = 50): Promise<unknown> {
    return this.call('GET', `/api/bitsign/credits/ledger?limit=${limit}`);
  }

  /** After the wallet sent $BCREDIT to the treasury: bit-sign verifies the tx and credits once. */
  async depositCredits(txid: string): Promise<unknown> {
    return this.call('POST', '/api/bitsign/credits/deposit', { txid });
  }

  // ── Verified identity (src/mobile/kyc) ──

  /** Ask bit-sign for a BRC-52 KYC certificate for this identity key (needs approved Veriff). */
  async kycWalletCert(body: { identity_key: string; timestamp: string; signature: string }): Promise<unknown> {
    const r = await this.call<{ certificate?: unknown }>('POST', '/api/bitsign/kyc/wallet-cert', body);
    return r.certificate ?? null;
  }

  /** bit-sign's current investor statements (server-supplied text). */
  async investorSelfCertOptions(): Promise<{ value?: unknown; label?: unknown; statement?: unknown }[]> {
    const r = await this.call<{ options?: { value?: unknown; label?: unknown; statement?: unknown }[] }>(
      'GET',
      '/api/bitsign/investor-self-cert',
    );
    return r.options ?? [];
  }

  /** Record an identity-key-signed self-certification. */
  async investorSelfCertWallet(body: {
    cert_type: string;
    statement_sha256: string;
    identity_key: string;
    timestamp: string;
    signature: string;
  }): Promise<void> {
    await this.call('POST', '/api/bitsign/investor-self-cert/wallet', body);
  }

  /** Share-offer audit event / register interest (identity-key signed). */
  async shareOfferEvent(body: {
    kind: 'view' | 'interest' | 'qualification';
    offer_ids: string[];
    identity_key: string;
    timestamp: string;
    signature: string;
  }): Promise<void> {
    await this.call('POST', '/api/bitsign/share-offers/events', body);
  }

  /**
   * The b agent's PAID endpoints (agent/paid.ts): price, quote, and the answer to a paid message.
   * Limited to /api/bitsign/agent/. The free composer chat (/api/bitsign/compose) is no longer used.
   */
  async agentCall(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!path.startsWith('/api/bitsign/agent/')) throw new Error('Not a b agent endpoint');
    return this.call(method, path, body);
  }

  /** bChat address book (bit-sign /api/bitsign/me/contacts), synced across devices. */
  async contacts(): Promise<BchatContact[]> {
    const r = await this.call<{ contacts?: BchatContact[] }>('GET', '/api/bitsign/me/contacts');
    return r.contacts ?? [];
  }

  async addContact(identifier: string, name?: string): Promise<void> {
    await this.call('POST', '/api/bitsign/me/contacts', { identifier: identifier.trim().replace(/^\$/, ''), name });
  }

  async removeContact(id: string): Promise<void> {
    await this.call('DELETE', `/api/bitsign/me/contacts?id=${encodeURIComponent(id)}`);
  }

  // ── Safety and account (bit-sign feat/store-fixes; src/mobile/ugc, src/mobile/account) ──

  /** Handles this account has blocked (bit-sign /api/bitsign/me/blocks). */
  async blocks(): Promise<string[]> {
    const r = await this.call<{ blocked?: string[] }>('GET', '/api/bitsign/me/blocks');
    return r.blocked ?? [];
  }

  /** Block $handle: the server refuses DMs between you both. */
  async block(handle: string): Promise<void> {
    await this.call('POST', '/api/bitsign/me/blocks', { handle: handle.trim().replace(/^\$/, '') });
  }

  async unblock(handle: string): Promise<void> {
    await this.call('DELETE', '/api/bitsign/me/blocks', { handle: handle.trim().replace(/^\$/, '') });
  }

  /** Feed bookmarks synced across this account's devices (bit-sign /api/bitsign/me/bookmarks). */
  async bookmarks<P extends { txid: string }>(): Promise<P[]> {
    const r = await this.call<{ bookmarks?: { post?: P }[] }>('GET', '/api/bitsign/me/bookmarks');
    return (r.bookmarks ?? []).map((b) => b.post).filter((p): p is P => !!p && typeof p.txid === 'string');
  }

  async addBookmark(post: { txid: string }): Promise<void> {
    await this.call('POST', '/api/bitsign/me/bookmarks', { post });
  }

  async removeBookmark(txid: string): Promise<void> {
    await this.call('DELETE', '/api/bitsign/me/bookmarks', { txid });
  }

  /** Delete this bChat account (identity-key signed; see src/mobile/account/deleteAccount.ts). */
  async deleteAccount(body: {
    identity_key: string;
    timestamp: string;
    signature: string;
    confirm: 'DELETE';
  }): Promise<{ status?: string; retained?: string[]; note?: string }> {
    return this.call('POST', '/api/bitsign/account/delete', body);
  }

  /** Open (or find) the 1:1 room with $handle (Chat › DMs). Returns its ticker. */
  async openDirect(handle: string): Promise<string> {
    const r = await this.call<{ ticker: string }>('POST', '/api/bitsign/rooms/direct', {
      handle: handle.trim().replace(/^\$/, ''),
    });
    return r.ticker;
  }

  // ── Open rooms: no token to hold (docs/TOKEN-ROOMS.md › Open rooms) ──

  /** Public open rooms (raw; parsed by parsePublicRooms). */
  async openRooms(q = ''): Promise<unknown> {
    return this.call('GET', `/api/bitsign/rooms/open${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  }

  async createOpenRoom(body: {
    name: string;
    description?: string;
    visibility: 'public' | 'invite';
  }): Promise<{ ticker: string; name: string; invite_code: string | null }> {
    return this.call('POST', '/api/bitsign/rooms/open', body);
  }

  /** Join by invite code / link, or a public room by ticker. */
  async joinOpenRoom(by: { code: string } | { ticker: string }): Promise<{ ticker: string; name: string }> {
    return this.call('POST', '/api/bitsign/rooms/open/join', by);
  }

  /** The room card: description, role, members, and (owner / moderators) the invite code. */
  async openRoomCard(ticker: string): Promise<unknown> {
    return this.call('GET', `/api/bitsign/rooms/open/${encodeURIComponent(ticker.replace(/^\$/, ''))}`);
  }

  async openRoomAction(
    ticker: string,
    action: 'leave' | 'remove' | 'add' | 'delete_message' | 'close' | 'mod' | 'unmod' | 'rotate_code',
    extra: { handle?: string; message_id?: string } = {},
  ): Promise<{ invite_code?: string }> {
    return this.call('POST', `/api/bitsign/rooms/open/${encodeURIComponent(ticker.replace(/^\$/, ''))}`, {
      action,
      ...extra,
    });
  }
}

// ── Session persistence (per wallet identity) ──
const KEY = 'bwallet.bchat.session';

export const loadSession = (address?: string): ChatSession | null => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as ChatSession | null;
    if (!s?.token || !s.handle) return null;
    if (address && s.address !== address) return null;
    return s;
  } catch {
    return null;
  }
};

export const saveSession = (s: ChatSession | null) => {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
};
