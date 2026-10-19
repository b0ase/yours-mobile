/**
 * "Open your phone's wallet on this computer" (WhatsApp-Web style; owner, 19 Oct 2026). VITE_SEEDLESS=1 only.
 * Threat model: docs/SEEDLESS-PASSKEY.md § Open on computer.
 *
 * Reuses the phone-pairing relay (relay/relay.mjs: site + wallet sockets, frames forwarded verbatim, and the
 * relay vouches for the site's websocket Origin) and the pairing crypto shape (src/pair/protocol.ts), with its own
 * HKDF label so a pairing key can never be confused with a transfer key.
 *
 *   QR:   https://www.bwallet.space/open?v=1&r=<relay>&c=<channel>&k=<computer ephemeral pubkey>&o=<origin>&e=<expiry>
 *         nothing secret: an ephemeral public key, a random channel id, the page's origin, a 2-minute expiry.
 *   key:  ECDH(secp256k1, phone ephemeral × computer ephemeral) → HKDF-SHA256(salt = channel, info =
 *         "bwalletx-open-v1") → AES-256-GCM; the code is 4 digits from SHA-256 of the key, shown on both screens.
 *   send: one sealed frame phone → computer, AAD "bwalletx-open|wallet|<channel>", payload { t:'wallet', words,
 *         name, exp }. The computer accepts exactly one and closes (single use).
 */
import { PrivateKey, PublicKey } from '@bsv/sdk';
import { inOrder } from '../../pair/in-order';
import { b64url, fromB64url, newChannel, relaySocketUrl, DEFAULT_RELAY, PAIR_HOST } from '../../pair/protocol';

export const OPEN_VERSION = '1';
export const OPEN_INFO = 'bwalletx-open-v1';
export const OPEN_LIFETIME_S = 120;

export type OpenLink = { v: string; r: string; c: string; k: string; o: string; e: number };
export type OpenPayload = { t: 'wallet'; words: string; name?: string; exp: number };
export type OpenFrame = { t: 'open'; n: string; d: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Only bWalletX's own web origins may receive a wallet (plus localhost for development when allowed). */
export const isWalletOrigin = (origin: string, allowLocal = false): boolean =>
  /^https:\/\/([a-z0-9-]+\.)*bwalletx\.com$/.test(origin) ||
  (allowLocal && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin));

export const openUrl = (l: OpenLink) => {
  const q = new URLSearchParams({ v: l.v, r: l.r, c: l.c, k: l.k, o: l.o, e: String(l.e) });
  return `https://${PAIR_HOST}/open?${q}`;
};

export const isOpenLink = (s: string) => {
  try {
    const u = new URL(s.trim());
    return (u.host === PAIR_HOST || u.host === 'bwallet.space') && u.pathname === '/open';
  } catch {
    return false;
  }
};

export function parseOpenUrl(text: string, nowS = Math.floor(Date.now() / 1000), allowLocal = false): OpenLink {
  if (!isOpenLink(text)) throw new Error('Not a bWalletX "open on computer" code');
  const q = new URL(text.trim()).searchParams;
  const l: OpenLink = {
    v: q.get('v') ?? '',
    r: q.get('r') ?? '',
    c: q.get('c') ?? '',
    k: q.get('k') ?? '',
    o: q.get('o') ?? '',
    e: Number(q.get('e')),
  };
  if (l.v !== OPEN_VERSION) throw new Error('This code needs a newer bWalletX');
  if (!/^[A-Za-z0-9_-]{22}$/.test(l.c) || !/^0[23][0-9a-f]{64}$/i.test(l.k) || !/^[a-z0-9.-]+(:\d+)?$/i.test(l.r))
    throw new Error('Bad code');
  if (!isWalletOrigin(l.o, allowLocal))
    throw new Error(`${l.o || 'That site'} is not bWalletX. Don't open your wallet there.`);
  if (!Number.isFinite(l.e) || l.e < nowS) throw new Error('This code has expired. Refresh the page on your computer.');
  if (l.e > nowS + OPEN_LIFETIME_S + 30) throw new Error('Bad code');
  return l;
}

/** Shared key + the 4-digit check code ("4-7-2-9"), the same on both screens. */
export async function deriveOpen(mine: PrivateKey, theirs: string, channel: string) {
  const point = mine.deriveSharedSecret(PublicKey.fromString(theirs));
  const ikm = new Uint8Array(point.encode(true) as number[]);
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: fromB64url(channel) as BufferSource, info: enc.encode(OPEN_INFO) },
      base,
      256,
    ),
  );
  const key = await crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bits));
  const code = String(((h[0] << 8) | h[1]) % 10000)
    .padStart(4, '0')
    .split('')
    .join('-');
  return { key, code };
}

const aad = (channel: string) => enc.encode(`bwalletx-open|wallet|${channel}`);

export async function sealOpen(key: CryptoKey, channel: string, p: OpenPayload): Promise<OpenFrame> {
  const n = crypto.getRandomValues(new Uint8Array(12));
  const d = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: n as BufferSource, additionalData: aad(channel) as BufferSource },
      key,
      enc.encode(JSON.stringify(p)),
    ),
  );
  return { t: 'open', n: b64url(n), d: b64url(d) };
}

/** Throws on tampering, a wrong key, or an expired payload. */
export async function openOpen(key: CryptoKey, channel: string, f: OpenFrame, nowS = Math.floor(Date.now() / 1000)) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64url(f.n) as BufferSource, additionalData: aad(channel) as BufferSource },
    key,
    fromB64url(f.d) as BufferSource,
  );
  const p = JSON.parse(dec.decode(pt)) as OpenPayload;
  if (p.t !== 'wallet' || typeof p.words !== 'string' || !p.words.trim()) throw new Error('Bad payload');
  if (!(p.exp >= nowS)) throw new Error('Expired');
  return p;
}

const relayHost = () => (import.meta.env.VITE_PAIR_RELAY as string | undefined) || DEFAULT_RELAY;

/**
 * Computer side. Shows the QR, waits for the phone's hello, shows the code, takes one wallet, closes.
 * Callbacks: onCode when the phone joined; onWallet with the words; onExpired after 2 minutes.
 */
export function startOpenSession(cb: {
  onCode: (code: string) => void;
  onWallet: (p: OpenPayload) => void;
  onExpired: () => void;
  onError: (m: string) => void;
}): { url: string; close: () => void } {
  const me = PrivateKey.fromRandom();
  const channel = newChannel();
  const e = Math.floor(Date.now() / 1000) + OPEN_LIFETIME_S;
  const r = relayHost();
  const link: OpenLink = { v: OPEN_VERSION, r, c: channel, k: me.toPublicKey().toString(), o: location.origin, e };
  let key: CryptoKey | null = null;
  let done = false;
  const ws = new WebSocket(relaySocketUrl(r, channel, 'site', e));
  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      ws.close();
      cb.onExpired();
    }
  }, OPEN_LIFETIME_S * 1000);
  ws.onerror = () => !done && cb.onError("Couldn't reach the pairing service.");
  // One frame at a time: the wallet frame must not race the hello's key derivation.
  ws.onmessage = inOrder(async (ev: MessageEvent) => {
    if (done) return;
    let f: { t?: string; k?: string; n?: string; d?: string };
    try {
      f = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (f.t === 'hello' && typeof f.k === 'string' && !key) {
      const s = await deriveOpen(me, f.k, channel);
      key = s.key;
      cb.onCode(s.code);
    } else if (f.t === 'open' && key) {
      try {
        const p = await openOpen(key, channel, f as OpenFrame);
        done = true;
        clearTimeout(timer);
        ws.close();
        cb.onWallet(p);
      } catch {
        cb.onError("That didn't come from your phone. Try again.");
      }
    }
  });
  return {
    url: openUrl(link),
    close: () => {
      done = true;
      clearTimeout(timer);
      ws.close();
    },
  };
}

/**
 * Phone side, step 1: join, check the relay-verified origin, send hello, get the code to show.
 * Step 2 (after the user confirms with the app lock): send(words, name).
 */
export function beginOpenHere(
  scanned: string,
  allowLocal = false,
): Promise<{
  origin: string;
  code: string;
  send: (words: string, name?: string) => Promise<void>;
  cancel: () => void;
}> {
  let link: OpenLink;
  try {
    link = parseOpenUrl(scanned, undefined, allowLocal);
  } catch (e) {
    return Promise.reject(e);
  }
  const P = PrivateKey.fromRandom();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relaySocketUrl(link.r, link.c, 'wallet'));
    let settled = false;
    const fail = (m: string) => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(m));
    };
    const t = setTimeout(() => fail('The computer did not answer. Make sure its QR code is still showing.'), 15_000);
    ws.onerror = () => fail('Could not reach the pairing service.');
    ws.onmessage = async (ev: MessageEvent) => {
      const f = JSON.parse(String(ev.data)) as { t?: string; verifiedOrigin?: string };
      if (f.t !== 'relay' || !f.verifiedOrigin || settled) return;
      clearTimeout(t);
      if (f.verifiedOrigin !== link.o || !isWalletOrigin(f.verifiedOrigin, allowLocal))
        return fail(`This code was shown by ${f.verifiedOrigin}, not bWalletX. Don't continue.`);
      ws.send(JSON.stringify({ t: 'hello', k: P.toPublicKey().toString() }));
      const { key, code } = await deriveOpen(P, link.k, link.c);
      settled = true;
      resolve({
        origin: f.verifiedOrigin,
        code,
        send: async (words, name) => {
          if (Math.floor(Date.now() / 1000) > link.e) throw new Error('This code has expired.');
          const frame = await sealOpen(key, link.c, { t: 'wallet', words, name, exp: link.e });
          ws.send(JSON.stringify(frame));
          setTimeout(() => ws.close(), 1500);
        },
        cancel: () => ws.close(),
      });
    };
  });
}
