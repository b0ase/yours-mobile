/**
 * bit-sign wallet-calls client.
 *
 * Auth: the wallet proves its BRC-100 IDENTITY KEY by signing
 *   bwallet-calls|v1|session|identityKey=<k>|nonce=<hex>|timestamp=<ms>
 * with createSignature(protocol [2,'bwallet calls'], keyID '1', counterparty 'anyone') — the
 * same construction as the KYC certificate request — and gets a 12 h bearer back. Calls are
 * keyed by identity key (what a paymail's pki / an OpNS idKey resolves to), not by a bChat
 * handle, so a bWallet user with no handle can still be called.
 */
import { Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import { BCHAT_ORIGIN, ChatApiError, type Http, type HttpResponse } from '../chat/api';
import type { ServerCall } from './machine';

export const CALL_SIGN_PROTOCOL: [2, string] = [2, 'bwallet calls'];
export const CALL_SIGN_KEY_ID = '1';

export const sessionProofMessage = (identityKey: string, timestamp: number, nonce: string) =>
  ['bwallet-calls', 'v1', 'session', `identityKey=${identityKey}`, `nonce=${nonce}`, `timestamp=${timestamp}`].join(
    '|',
  );

/** What signing needs from the wallet. */
export interface CallSigner {
  identityKey: () => Promise<string>;
  /** Hex BRC-43 signature over `message` by the identity key, counterparty 'anyone'. */
  sign: (message: string) => Promise<string>;
}

export const walletCallSigner = (ctx: OneSatContext): CallSigner => ({
  identityKey: async () => (await ctx.wallet.getPublicKey({ identityKey: true })).publicKey.toLowerCase(),
  sign: async (message) => {
    const { signature } = await ctx.wallet.createSignature({
      data: Utils.toArray(message, 'utf8'),
      protocolID: CALL_SIGN_PROTOCOL,
      keyID: CALL_SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return Utils.toHex(signature);
  },
});

export interface CallSession {
  token: string;
  identityKey: string;
  expiresAt: string;
}

const KEY = 'bwallet.calls.session';

export const loadCallSession = (identityKey: string, now = Date.now()): CallSession | null => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as CallSession | null;
    if (!s?.token || s.identityKey !== identityKey || Date.parse(s.expiresAt) - 60_000 < now) return null;
    return s;
  } catch {
    return null;
  }
};

export const saveCallSession = (s: CallSession | null) => {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
};

const randomHex = (bytes: number) => {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
};

const errorOf = (data: unknown, fallback: string) =>
  (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
    ? (data as { error: string }).error
    : '') || fallback;

export interface BlockEntry {
  key: string;
  label: string | null;
  created_at: string;
}

export interface Friend {
  key: string;
  name: string;
  avatar: string | null;
}

export class CallsClient {
  private session: CallSession | null = null;

  constructor(
    private readonly http: Http,
    private readonly signer: CallSigner,
    private readonly origin = BCHAT_ORIGIN,
    private readonly store = { load: loadCallSession, save: saveCallSession },
    private readonly now = () => Date.now(),
  ) {}

  get identityKey() {
    return this.session?.identityKey ?? null;
  }

  /** Reuse a stored session for this key, else sign a fresh proof. */
  async signIn(force = false): Promise<CallSession> {
    const identityKey = await this.signer.identityKey();
    if (!force) {
      const stored = this.store.load(identityKey, this.now());
      if (stored) return (this.session = stored);
    }
    const timestamp = this.now();
    const nonce = randomHex(16);
    const signature = await this.signer.sign(sessionProofMessage(identityKey, timestamp, nonce));
    const res = await this.raw(
      'POST',
      '/api/bitsign/wallet-calls/session',
      { identity_key: identityKey, timestamp, nonce, signature },
      false,
    );
    if (res.status !== 200)
      throw new ChatApiError(errorOf(res.data, 'Could not open a calls session'), res.status, res.data);
    const d = res.data as { token: string; identity_key: string; expires_at: string };
    this.session = { token: d.token, identityKey: d.identity_key, expiresAt: d.expires_at };
    this.store.save(this.session);
    return this.session;
  }

  private async raw(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    auth = true,
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (auth && this.session) headers.Authorization = `Bearer ${this.session.token}`;
    try {
      return await this.http({ method, url: `${this.origin}${path}`, headers, body });
    } catch (e) {
      throw new ChatApiError(e instanceof Error ? e.message : 'Network error', 0);
    }
  }

  /** Authenticated call; one transparent re-sign on 401 (expired or rotated secret). */
  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    if (!this.session) await this.signIn();
    let res = await this.raw(method, path, body);
    if (res.status === 401) {
      await this.signIn(true);
      res = await this.raw(method, path, body);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ChatApiError(errorOf(res.data, `Calls error ${res.status}`), res.status, res.data);
    }
    return res.data as T;
  }

  list() {
    return this.call<{ incoming: ServerCall[]; recent: ServerCall[] }>('GET', '/api/bitsign/wallet-calls');
  }

  async place(calleeKey: string, labels: { caller?: string; callee?: string }) {
    const r = await this.call<{ call: ServerCall }>('POST', '/api/bitsign/wallet-calls', {
      callee_key: calleeKey,
      caller_label: labels.caller,
      callee_label: labels.callee,
    });
    return r.call;
  }

  async get(id: string) {
    return (await this.call<{ call: ServerCall }>('GET', `/api/bitsign/wallet-calls/${encodeURIComponent(id)}`)).call;
  }

  async act(id: string, action: 'accept' | 'decline' | 'cancel' | 'end') {
    return (
      await this.call<{ call: ServerCall }>('POST', `/api/bitsign/wallet-calls/${encodeURIComponent(id)}`, { action })
    ).call;
  }

  token(id: string) {
    return this.call<{ token: string; url: string; room: string }>(
      'POST',
      `/api/bitsign/wallet-calls/${encodeURIComponent(id)}/token`,
    );
  }

  async blocks() {
    return (await this.call<{ blocks: BlockEntry[] }>('GET', '/api/bitsign/wallet-calls/blocks')).blocks;
  }

  async block(key: string, label?: string) {
    await this.call('POST', '/api/bitsign/wallet-calls/blocks', { key, label });
  }

  async unblock(key: string) {
    await this.call('DELETE', `/api/bitsign/wallet-calls/blocks?key=${encodeURIComponent(key)}`);
  }

  async friends(): Promise<Friend[]> {
    const r = await this.call<{ friends: Friend[] }>('GET', '/api/bitsign/wallet-calls/friends');
    return r.friends.map(({ key, name, avatar }) => ({ key, name, avatar }));
  }

  async saveFriend(f: Friend) {
    await this.call('POST', '/api/bitsign/wallet-calls/friends', {
      key: f.key,
      name: f.name,
      avatar: f.avatar ?? undefined,
    });
  }

  async removeFriend(key: string) {
    await this.call('DELETE', `/api/bitsign/wallet-calls/friends?key=${encodeURIComponent(key)}`);
  }
}
