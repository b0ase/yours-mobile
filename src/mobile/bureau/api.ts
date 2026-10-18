import { BCHAT_ORIGIN, type Http } from '../chat/api';

/**
 * Read-only client for the documents people already hold on bit-sign (the Bureau's "From bit-sign" folder).
 * New agreements live in bMail (agreement.ts); this only lists and opens the old vault so nothing is stranded.
 *
 * Auth (the same session every bWalletX bit-sign call uses, chat/api.ts BchatClient.signIn): the wallet's
 * BRC-100 identity key signs bit-sign's single-use wallet-login challenge, bit-sign returns its own signed
 * session token, and every call here sends it as `Authorization: Bearer`. bit-sign's `resolveUserHandle`
 * verifies that token locally (lib/auth.ts handleFromBearer → verifySession) before it would ever ask
 * HandCash, so no HandCash or "Sign in with bit-sign" account is involved.
 *
 * Transport is injected (`Http` for JSON, `BytesFetch` for document bytes) so tests can check the exact
 * request shape. A 401 gets one fresh sign-in and one retry, never more.
 */
export const BITSIGN_ORIGIN = BCHAT_ORIGIN;

export class BureauError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BureauError';
  }
}

export type BytesResponse = { status: number; mime: string; bytes: Uint8Array };
export type BytesFetch = (url: string, headers: Record<string, string>) => Promise<BytesResponse>;

export interface BureauDeps {
  http: Http;
  bytes: BytesFetch;
  /** The current session token (signs in with the wallet if there is none). */
  token: () => Promise<string>;
  /** Drop the session and sign in again; returns the new token. */
  refresh: () => Promise<string>;
  origin?: string;
}

/** One vault row (bit_sign_signatures), as GET /api/bitsign/signatures returns it. */
export type VaultItem = {
  id: string;
  signature_type: string;
  created_at: string;
  deleted_at?: string | null;
  txid?: string | null;
  seal_txid?: string | null;
  wallet_signed?: boolean;
  metadata?: Record<string, unknown> | null;
};

export type Grant = {
  id: string;
  document_id: string;
  grantor_handle: string;
  grantee_handle: string;
  created_at: string;
  signature_type?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** What the viewer can do with a document's bytes. */
export type DocContent =
  | { kind: 'pdf'; bytes: Uint8Array }
  | { kind: 'html'; html: string }
  | { kind: 'image'; bytes: Uint8Array; mime: string }
  | { kind: 'text'; text: string }
  | { kind: 'encrypted'; reason: string }
  | { kind: 'empty'; reason: string }
  | { kind: 'other'; mime: string };

const errorText = (data: unknown, fallback: string) => {
  const e = (data as { error?: unknown } | null)?.error;
  return typeof e === 'string' && e ? e.slice(0, 300) : fallback;
};
const codeOf = (data: unknown) => {
  const c = (data as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
};
const asRecord = (data: unknown): Record<string, unknown> =>
  data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

/** Pure: how to show these bytes. bit-sign's preview serves a real Content-Type; the PDF magic covers a missing one. */
export const classifyBytes = (bytes: Uint8Array, mimeIn: string): DocContent => {
  const mime = (mimeIn || '').split(';')[0].trim().toLowerCase();
  if (mime === 'application/pdf' || PDF_MAGIC.every((b, i) => bytes[i] === b)) return { kind: 'pdf', bytes };
  if (mime.includes('json')) {
    try {
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { encryption_version?: number };
      if (body?.encryption_version && body.encryption_version >= 2) {
        return {
          kind: 'encrypted',
          reason: 'This document is end-to-end encrypted with a bit-sign passphrase key.',
        };
      }
    } catch {
      /* not the encrypted shape */
    }
  }
  if (mime === 'text/html') return { kind: 'html', html: new TextDecoder().decode(bytes) };
  if (mime.startsWith('image/')) return { kind: 'image', bytes, mime };
  if (mime.startsWith('text/') || mime.includes('json')) return { kind: 'text', text: new TextDecoder().decode(bytes) };
  return { kind: 'other', mime: mime || 'unknown' };
};

export class BureauClient {
  private readonly origin: string;
  constructor(private readonly deps: BureauDeps) {
    this.origin = deps.origin ?? BITSIGN_ORIGIN;
  }

  /** JSON call with the bearer; one re-sign-in on 401. Returns the raw response (never throws on status). */
  private async raw(method: 'GET', path: string) {
    const send = async (token: string) => {
      try {
        return await this.deps.http({
          method,
          url: `${this.origin}${path}`,
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        });
      } catch (e) {
        throw new BureauError(e instanceof Error ? e.message : 'Network error', 0);
      }
    };
    let res = await send(await this.deps.token());
    if (res.status === 401) res = await send(await this.deps.refresh());
    return res;
  }

  private async json<T>(method: 'GET', path: string): Promise<T> {
    const res = await this.raw(method, path);
    if (res.status < 200 || res.status >= 300) {
      throw new BureauError(
        errorText(res.data, `bit-sign error ${res.status}`),
        res.status,
        codeOf(res.data),
        asRecord(res.data),
      );
    }
    return res.data as T;
  }

  async vault(): Promise<VaultItem[]> {
    return arr<VaultItem>((await this.json<{ signatures?: unknown }>('GET', '/api/bitsign/signatures'))?.signatures);
  }

  async sharedWithMe(): Promise<Grant[]> {
    return arr<Grant>((await this.json<{ grants?: unknown }>('GET', '/api/bitsign/shared-with-me'))?.grants);
  }

  /** A document's bytes, decrypted server-side where bit-sign can (member-gated), classified for the viewer. */
  async preview(id: string): Promise<DocContent> {
    const url = `${this.origin}/api/bitsign/signatures/${encodeURIComponent(id)}/preview`;
    const get = async (token: string) => {
      try {
        return await this.deps.bytes(url, { Authorization: `Bearer ${token}` });
      } catch (e) {
        throw new BureauError(e instanceof Error ? e.message : 'Network error', 0);
      }
    };
    let res = await get(await this.deps.token());
    if (res.status === 401) res = await get(await this.deps.refresh());
    if (res.status < 200 || res.status >= 300) {
      let reason = '';
      try {
        reason = String((JSON.parse(new TextDecoder().decode(res.bytes)) as { error?: unknown })?.error ?? '');
      } catch {
        /* not JSON */
      }
      // "No data stored" is a state (an attestation or an on-chain receipt), not a failure.
      if (res.status === 404 && /no data stored/i.test(reason)) {
        return { kind: 'empty', reason: 'This item is a record, not a file: there is nothing to show.' };
      }
      throw new BureauError(reason || `Couldn't open the document (${res.status})`, res.status);
    }
    return classifyBytes(res.bytes, res.mime);
  }
}
