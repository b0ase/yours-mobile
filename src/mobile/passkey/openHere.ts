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
 *         "bwalletx-open-v2") → AES-256-GCM key + HMAC-SHA256 key.
 *   code: 6 random digits made ON THE PHONE and shown only on the phone. The user types them on the computer, which
 *         sends { t:'proof', m: HMAC(macKey, "bwalletx-open-proof|<channel>|<code>") }. The phone checks it once: a
 *         wrong proof ends the session. (Audit C2, 19 Oct 2026: the old code came from the computer's own key, so a
 *         non-browser client with a forged Origin could show the matching code. Whoever made the QR knows k; only
 *         someone looking at the phone knows the code.)
 *   send: only after a good proof and the app lock: one sealed frame phone → computer, AAD
 *         "bwalletx-open|wallet|<channel>", payload { t:'wallet', words, name, exp }. The computer accepts exactly one
 *         and closes (single use).
 *
 * The relay's verifiedOrigin is only what the computer's websocket claimed. A browser can't lie about it, but any
 * other client can, so it is a hint (we still refuse a mismatch) and never shown as proof of anything.
 */
import { PrivateKey, PublicKey } from '@bsv/sdk';
import { inOrder } from '../../pair/in-order';
import { b64url, fromB64url, newChannel, relaySocketUrl, DEFAULT_RELAY, PAIR_HOST } from '../../pair/protocol';

export const OPEN_VERSION = '2';
export const OPEN_INFO = 'bwalletx-open-v2';
export const OPEN_CODE_DIGITS = 6;
export const OPEN_LIFETIME_S = 120;

export type OpenLink = { v: string; r: string; c: string; k: string; o: string; e: number };
export type OpenPayload = { t: 'wallet'; words: string; name?: string; exp: number };
export type OpenFrame = { t: 'open'; n: string; d: string };
export type OpenProof = { t: 'proof'; m: string };

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

/** Shared AES-GCM key (the sealed frame) + HMAC key (the computer's proof that it was told the phone's code). */
export async function deriveOpen(mine: PrivateKey, theirs: string, channel: string, info = OPEN_INFO) {
  const point = mine.deriveSharedSecret(PublicKey.fromString(theirs));
  const ikm = new Uint8Array(point.encode(true) as number[]);
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: fromB64url(channel) as BufferSource, info: enc.encode(info) },
      base,
      512,
    ),
  );
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const macKey = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  return { key, macKey };
}

/** 6 uniform random digits, made on the phone. Never derived from anything the computer has. */
export function newOpenCode(): string {
  const lim = 4_294_000_000; // largest multiple of 10^6 below 2^32, so every code is equally likely
  const u = new Uint32Array(1);
  do crypto.getRandomValues(u);
  while (u[0] >= lim);
  return String(u[0] % 10 ** OPEN_CODE_DIGITS).padStart(OPEN_CODE_DIGITS, '0');
}

/** "123 456", "123456", "123-456" → "123456"; anything else → ''. */
export const normaliseOpenCode = (s: string) => {
  const d = s.replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${OPEN_CODE_DIGITS}}$`).test(d) ? d : '';
};
export const showOpenCode = (c: string) => `${c.slice(0, 3)} ${c.slice(3)}`;

const proofMsg = (channel: string, code: string) => enc.encode(`bwalletx-open-proof|${channel}|${code}`);

/** Computer: prove it was told the code shown on the phone. */
export async function openProof(macKey: CryptoKey, channel: string, code: string): Promise<OpenProof> {
  const m = new Uint8Array(await crypto.subtle.sign('HMAC', macKey, proofMsg(channel, normaliseOpenCode(code))));
  return { t: 'proof', m: b64url(m) };
}

/** Phone: constant-time check (WebCrypto verify) of the computer's proof. */
export async function checkOpenProof(macKey: CryptoKey, channel: string, code: string, f: { m?: unknown }) {
  if (typeof f.m !== 'string') return false;
  try {
    return await crypto.subtle.verify('HMAC', macKey, fromB64url(f.m) as BufferSource, proofMsg(channel, code));
  } catch {
    return false;
  }
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
 * Computer side. Shows the QR, waits for the phone to join (onJoined: ask for the code shown on the phone), sends one
 * proof of that code (submitCode; one try), takes one wallet, closes. onExpired after 2 minutes.
 */
export function startOpenSession(cb: {
  onJoined: () => void;
  onWallet: (p: OpenPayload) => void;
  onExpired: () => void;
  onError: (m: string) => void;
}): { url: string; submitCode: (code: string) => Promise<boolean>; close: () => void } {
  const me = PrivateKey.fromRandom();
  const channel = newChannel();
  const e = Math.floor(Date.now() / 1000) + OPEN_LIFETIME_S;
  const r = relayHost();
  const link: OpenLink = { v: OPEN_VERSION, r, c: channel, k: me.toPublicKey().toString(), o: location.origin, e };
  let keys: { key: CryptoKey; macKey: CryptoKey } | null = null;
  let proved = false;
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
    let f: { t?: string; k?: string; n?: string; d?: string; peer?: string; role?: string };
    try {
      f = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (f.t === 'hello' && typeof f.k === 'string' && !keys) {
      keys = await deriveOpen(me, f.k, channel);
      cb.onJoined();
    } else if (f.t === 'relay' && f.peer === 'left' && f.role === 'wallet' && proved) {
      // The phone ends the session on a wrong code.
      done = true;
      clearTimeout(timer);
      ws.close();
      cb.onError("Your phone didn't accept that code. Scan again.");
    } else if (f.t === 'open' && keys && proved) {
      try {
        const p = await openOpen(keys.key, channel, f as OpenFrame);
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
    submitCode: async (code) => {
      if (done || !keys || proved || !normaliseOpenCode(code)) return false;
      proved = true; // one try: the phone ends the session on a wrong code
      ws.send(JSON.stringify(await openProof(keys.macKey, channel, code)));
      return true;
    },
    close: () => {
      done = true;
      clearTimeout(timer);
      ws.close();
    },
  };
}

/**
 * Phone side, step 1: join, send hello, make the code to show. `confirmed` resolves once the computer has proved it
 * was told the code (it rejects, and the session ends, on the first wrong proof).
 * Step 2 (after `confirmed` and the app lock): send(words, name). send refuses before a good proof.
 */
export function beginOpenHere(
  scanned: string,
  allowLocal = false,
): Promise<{
  code: string;
  confirmed: Promise<void>;
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
  const code = newOpenCode();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relaySocketUrl(link.r, link.c, 'wallet'));
    let settled = false;
    let keys: { key: CryptoKey; macKey: CryptoKey } | null = null;
    let state: 'waiting' | 'ok' | 'dead' = 'waiting';
    let confirm: { ok: () => void; no: (e: Error) => void } = { ok: () => undefined, no: () => undefined };
    const confirmed = new Promise<void>((ok, no) => (confirm = { ok, no }));
    confirmed.catch(() => undefined);
    const kill = (m: string) => {
      if (state === 'dead') return;
      state = 'dead';
      ws.close();
      confirm.no(new Error(m));
    };
    const fail = (m: string) => {
      if (settled) return kill(m);
      settled = true;
      state = 'dead';
      ws.close();
      reject(new Error(m));
    };
    const t = setTimeout(() => fail('The computer did not answer. Make sure its QR code is still showing.'), 15_000);
    const expiry = setTimeout(
      () => state === 'waiting' && kill('This code has expired. Scan again.'),
      Math.max(0, link.e * 1000 - Date.now()),
    );
    ws.onerror = () => fail('Could not reach the pairing service.');
    ws.onmessage = inOrder(async (ev: MessageEvent) => {
      let f: { t?: string; verifiedOrigin?: string; m?: unknown };
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (f.t === 'relay' && f.verifiedOrigin && !settled) {
        clearTimeout(t);
        // A hint, not proof (any non-browser client can claim an Origin): refuse a mismatch, trust only the code.
        if (f.verifiedOrigin !== link.o || !isWalletOrigin(f.verifiedOrigin, allowLocal))
          return fail("This code wasn't shown by bWalletX. Don't continue.");
        ws.send(JSON.stringify({ t: 'hello', k: P.toPublicKey().toString() }));
        keys = await deriveOpen(P, link.k, link.c);
        settled = true;
        resolve({
          code: showOpenCode(code),
          confirmed,
          send: async (words, name) => {
            if (state !== 'ok' || !keys) throw new Error('Type the code on your computer first.');
            if (Math.floor(Date.now() / 1000) > link.e) throw new Error('This code has expired.');
            state = 'dead'; // single use
            const frame = await sealOpen(keys.key, link.c, { t: 'wallet', words, name, exp: link.e });
            ws.send(JSON.stringify(frame));
            setTimeout(() => ws.close(), 1500);
          },
          cancel: () => kill('Cancelled.'),
        });
      } else if (f.t === 'proof' && keys && state === 'waiting') {
        if (await checkOpenProof(keys.macKey, link.c, code, f)) {
          state = 'ok';
          clearTimeout(expiry);
          confirm.ok();
        } else kill("The computer typed the wrong code. Scan again; if you didn't type it, someone else is trying.");
      }
    });
  });
}

// ── "Your phone has it" (round 5) ─────────────────────────────────────────────────────────────────────────────
/**
 * The computer's "Put this wallet on your phone" QR also carries a one-time relay channel + ephemeral key. When the
 * phone opens that link and restores with its passkey, it sends one sealed ping { t:'restored', fp } where fp =
 * SHA-256("bwalletx-restored|" + words). The computer shows "✓ Your phone has it" only if fp matches its own wallet.
 * Best effort; no server, no PII; the relay sees ciphertext only. Separate HKDF label from "open on computer".
 */
export const RESTORED_INFO = 'bwalletx-restored-v1';
export const RESTORED_LIFETIME_S = 280; // under the relay's 300 s QR limit; the QR is renewed before it lapses
const PING_KEY = 'bwx:restored-ping';

export async function walletFingerprint(words: string): Promise<string> {
  const norm = words.trim().toLowerCase().split(/\s+/).join(' ');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`bwalletx-restored|${norm}`)));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type PingParams = { r: string; c: string; k: string; e: number };
export const pingQuery = (p: PingParams) => `&r=${encodeURIComponent(p.r)}&c=${p.c}&k=${p.k}&e=${p.e}`;
export function parsePing(search: string, nowS = Math.floor(Date.now() / 1000)): PingParams | null {
  const q = new URLSearchParams(search);
  const p = { r: q.get('r') ?? '', c: q.get('c') ?? '', k: q.get('k') ?? '', e: Number(q.get('e')) };
  if (!/^[A-Za-z0-9_-]{22}$/.test(p.c) || !/^0[23][0-9a-f]{64}$/i.test(p.k) || !/^[a-z0-9.-]+(:\d+)?$/i.test(p.r))
    return null;
  if (!Number.isFinite(p.e) || p.e < nowS || p.e > nowS + RESTORED_LIFETIME_S + 30) return null;
  return p;
}

/** Phone: remember the ping channel from /restore?passkey=1&r&c&k&e and join it at once (it must join before the
 * QR lapses; once joined the relay keeps the channel). */
let pingSocket: { ws: WebSocket; p: PingParams; origin: Promise<string | null> } | null = null;
export function armRestorePing(search = typeof location === 'undefined' ? '' : location.search): boolean {
  const p = parsePing(search);
  if (!p || typeof WebSocket === 'undefined') return false;
  try {
    sessionStorage.setItem(PING_KEY, JSON.stringify(p));
  } catch {
    /* fine */
  }
  const ws = new WebSocket(relaySocketUrl(p.r, p.c, 'wallet'));
  const origin = new Promise<string | null>((res) => {
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const f = JSON.parse(String(ev.data)) as { t?: string; verifiedOrigin?: string };
        if (f.t === 'relay' && f.verifiedOrigin) res(f.verifiedOrigin);
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => res(null);
    setTimeout(() => res(null), 15_000);
  });
  pingSocket = { ws, p, origin };
  return true;
}

/** Phone, after the passkey opened the backup: tell the computer (best effort, never throws). */
export async function sendRestoredPing(words: string, allowLocal = false): Promise<boolean> {
  const s = pingSocket;
  pingSocket = null;
  if (!s) return false;
  try {
    const origin = await s.origin;
    if (!origin || !isWalletOrigin(origin, allowLocal)) return false;
    const me = PrivateKey.fromRandom();
    s.ws.send(JSON.stringify({ t: 'hello', k: me.toPublicKey().toString() }));
    const { key } = await deriveOpen(me, s.p.k, s.p.c, RESTORED_INFO);
    const n = crypto.getRandomValues(new Uint8Array(12));
    const fp = await walletFingerprint(words);
    const d = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: n as BufferSource,
          additionalData: enc.encode(`bwalletx-restored|${s.p.c}`) as BufferSource,
        },
        key,
        enc.encode(JSON.stringify({ t: 'restored', fp })),
      ),
    );
    s.ws.send(JSON.stringify({ t: 'restored', n: b64url(n), d: b64url(d) }));
    setTimeout(() => s.ws.close(), 1500);
    return true;
  } catch {
    return false;
  }
}

/** Computer: the extra QR params + a listener; renews itself before the relay's QR limit. */
export function listenForRestore(
  fp: string,
  onRestored: () => void,
): { params: () => PingParams; onChange: (l: () => void) => void; close: () => void } {
  let cur: { ws: WebSocket; me: PrivateKey; p: PingParams } | null = null;
  let done = false;
  let listener: () => void = () => undefined;
  let renew: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    cur?.ws.close();
    const me = PrivateKey.fromRandom();
    const p: PingParams = {
      r: relayHost(),
      c: newChannel(),
      k: me.toPublicKey().toString(),
      e: Math.floor(Date.now() / 1000) + RESTORED_LIFETIME_S,
    };
    const ws = new WebSocket(relaySocketUrl(p.r, p.c, 'site', p.e));
    let key: CryptoKey | null = null;
    let joined = false;
    ws.onmessage = inOrder(async (ev: MessageEvent) => {
      if (done) return;
      const f = JSON.parse(String(ev.data)) as { t?: string; k?: string; n?: string; d?: string; peer?: string };
      if (f.t === 'relay' && f.peer === 'joined') joined = true;
      if (f.t === 'hello' && typeof f.k === 'string') key = (await deriveOpen(me, f.k, p.c, RESTORED_INFO)).key;
      if (f.t === 'restored' && key && f.n && f.d) {
        try {
          const pt = await crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: fromB64url(f.n) as BufferSource,
              additionalData: enc.encode(`bwalletx-restored|${p.c}`) as BufferSource,
            },
            key,
            fromB64url(f.d) as BufferSource,
          );
          const m = JSON.parse(dec.decode(pt)) as { t?: string; fp?: string };
          if (m.t === 'restored' && m.fp === fp) {
            done = true;
            ws.close();
            onRestored();
          }
        } catch {
          /* not ours */
        }
      }
    });
    cur = { ws, me, p };
    // A phone that joined keeps this channel alive; otherwise renew before the QR lapses.
    renew = setTimeout(
      () => {
        if (!done && !joined) {
          open();
          listener();
        }
      },
      (RESTORED_LIFETIME_S - 20) * 1000,
    );
  };
  open();
  return {
    params: () => cur!.p,
    onChange: (l) => {
      listener = l;
    },
    close: () => {
      done = true;
      clearTimeout(renew);
      cur?.ws.close();
    },
  };
}
