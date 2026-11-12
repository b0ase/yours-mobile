/**
 * bWallet phone-pairing relay (tokenblaster.lol docs/wallet-connect.md §4).
 *
 * Two websockets per channel: the site (desktop page) and the wallet (bWallet on a phone). The relay
 * forwards their frames verbatim. Frames after the hello are end-to-end encrypted, so it can't read or
 * change them. It stores nothing on disk and logs counts only.
 *
 * It ties the channel to the site socket's Origin header and tells the phone ({ t: 'relay', verifiedOrigin }).
 * Browsers set that header and page scripts can't change it, but any non-browser client can send whatever it
 * likes, so it is only a hint: it stops a QR shown on a phishing page in a real browser, nothing more. Never treat
 * it as proof of who is on the other end (audit C2); protocols that send secrets must authenticate the peer
 * themselves (e.g. "open on computer" makes the computer prove a code shown only on the phone).
 */
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

export const LIMITS = {
  maxFrame: 4 * 1024 * 1024, // large transaction bundles
  framesPerMinute: 60,
  channelsPerIp: 1000,
  queueFrames: 20,
  queueMs: 60_000,
  maxQrLifetimeS: 300,
  unpairedIdleMs: 2 * 60_000,
  pairedIdleMs: 31 * 24 * 60 * 60_000, // CLI pairings last up to 30 days
};

const CHANNEL = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url
const ROLES = new Set(['site', 'wallet']);
// Optional per-role claim secret (b-Aware, 24 Oct 2026): the first socket that brings one owns the role; later
// sockets for that role must bring the same one, so a stranger who knows the channel ID can't take it over.
const CLAIM = /^[A-Za-z0-9_-]{22,64}$/;
const claimHash = (c) => createHash('sha256').update(c).digest('hex');
// b-Aware 26 Oct 2026 (N3-1/N3-2): a new site sends `wc`, the SHA-256 (hex) of the wallet claim that only the QR
// can produce (protocol walletClaimFor(channel, site pubkey)). The relay never sees the QR, so someone who only
// knows the channel ID can't make that claim, and a wallet that brings it always wins the role.
const CLAIM_DIGEST = /^[0-9a-f]{64}$/;
// Session-bound wallet claim (wallet claim v2, 12 Nov 2026). The QR-bound claim above is computable by anyone who sees
// the QR, so it is good for the first join only. A v2 wallet joins with it plus `nc`, the SHA-256 (hex) of its session
// claim: an HMAC keyed by the ECDH secret of its own pairing key and the site's, which only the two ends can compute.
// The relay then binds the wallet role to `nc` and the QR claim stops admitting anyone. Sites that know the pairing
// is v2 send that same digest as `wc` whenever they reconnect, so a re-created channel stays bound to the phone.
export const WALLET_CLAIM_V2 = 2;

/**
 * From this moment a wallet that takes an unclaimed wallet role must bring `nc` (wallets from before wallet claim v2
 * are refused and have to update). Default: not enforced; set RELAY_SESSION_CLAIMS_FROM (ISO date) or
 * createRelay({ sessionClaimsFrom }) in ms once the wallet release that sends `nc` is out.
 */
export const SESSION_CLAIMS_FROM = Infinity;

/**
 * Compatibility window for clients from before 26 Oct 2026 (sites without a site claim, wallets with a random
 * claim). Until this moment the relay still opens a new channel for a site with no claim, and still lets the first
 * wallet claim win on a channel without a QR-bound one. After it, both are refused. Override with
 * RELAY_LEGACY_CLAIMS_UNTIL (ISO date) or createRelay({ legacyUntil }) in ms.
 */
export const LEGACY_CLAIMS_UNTIL = Date.parse('2026-11-30T00:00:00Z');

/**
 * Proxies whose x-real-ip we believe (audit N3-obs). Anyone else could send the header to dodge the per-IP limit, so
 * a direct connection is counted by its socket address. Default: loopback (nginx on the same box).
 */
export const DEFAULT_TRUSTED_PROXIES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** The client's address: x-real-ip only when the socket comes from a trusted proxy. */
export function clientIp(req, trusted = DEFAULT_TRUSTED_PROXIES) {
  const peer = (req.socket?.remoteAddress || '').toString();
  const real = req.headers['x-real-ip'];
  if (real && trusted.includes(peer)) return String(Array.isArray(real) ? real[0] : real).trim();
  return peer;
}
const other = (role) => (role === 'site' ? 'wallet' : 'site');

/** True for an https origin, or http on localhost (local development). */
export function acceptableOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.origin !== origin) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch {
    return false;
  }
}

export function createRelay({
  server,
  now = () => Date.now(),
  log = () => {},
  legacyUntil = LEGACY_CLAIMS_UNTIL,
  sessionClaimsFrom = SESSION_CLAIMS_FROM,
  trustedProxies = DEFAULT_TRUSTED_PROXIES,
} = {}) {
  const legacy = () => now() < legacyUntil;
  const sessionClaimsRequired = () => now() >= sessionClaimsFrom;
  const channels = new Map();
  const perIp = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrame });

  const send = (ws, obj) => ws && ws.readyState === 1 && ws.send(JSON.stringify(obj));

  const drop = (id) => {
    const ch = channels.get(id);
    if (!ch) return;
    for (const role of ROLES) ch[role]?.close(4000, 'channel closed');
    channels.delete(id);
    perIp.set(ch.ip, Math.max(0, (perIp.get(ch.ip) ?? 1) - 1));
  };

  const sweep = () => {
    const t = now();
    for (const [id, ch] of channels) {
      const idle = t - ch.lastActive;
      const bothGone = !ch.site && !ch.wallet;
      if (idle > LIMITS.pairedIdleMs || (!ch.paired && bothGone && idle > LIMITS.unpairedIdleMs)) drop(id);
      for (const role of ROLES) ch.queue[role] = ch.queue[role].filter((q) => t - q.at < LIMITS.queueMs);
    }
  };
  const timer = setInterval(sweep, 30_000);
  timer.unref?.();

  /** True when this claim is the QR-bound wallet claim the site registered (`wc`). */
  const qrBound = (ch, role, claim) =>
    role === 'wallet' && !!ch.walletBinding && !!claim && claimHash(claim) === ch.walletBinding;

  /**
   * Who may take a role:
   * - the QR-bound wallet claim always may (it evicts anyone who got there first: N3-2);
   * - a claimed role admits only its claim;
   * - an unclaimed role: with a QR binding, only the bound claim (legacy wallets may still take it during the
   *   compatibility window); without one, any claim, and no claim only during the window.
   */
  const claimOk = (ch, role, claim) => {
    if (qrBound(ch, role, claim)) return true;
    const held = ch.claims?.[role];
    if (held) return claim !== null && claimHash(claim) === held;
    if (legacy()) return true;
    if (role === 'wallet' && ch.walletBinding) return false;
    return claim !== null;
  };

  /**
   * May this wallet join bind the role to its session claim digest `nc`? Only the phone that proves it saw the QR
   * (the bound claim), or the first wallet on a channel nobody bound (sites and CLIs without `wc`). Never a claim the
   * relay admitted only because of the compatibility window: that would let a squatter pin the role before the phone.
   */
  const mayBind = (ch, role, claim, nc) =>
    role === 'wallet' && !!nc && (qrBound(ch, role, claim) || (!ch.walletBinding && !ch.claims.wallet));

  /** Decide whether an upgrade is allowed. Returns { ok, code, reason, ... }. */
  function admit(req) {
    const url = new URL(req.url, 'http://relay');
    const m = url.pathname.match(/^\/v1\/c\/([^/]+)$/);
    const role = url.searchParams.get('role');
    if (!m || !CHANNEL.test(m[1]) || !ROLES.has(role)) return { ok: false, code: 400, reason: 'bad request' };
    const claim = url.searchParams.get('claim');
    if (claim !== null && !CLAIM.test(claim)) return { ok: false, code: 400, reason: 'bad request' };
    const wc = url.searchParams.get('wc');
    if (wc !== null && (role !== 'site' || !CLAIM_DIGEST.test(wc)))
      return { ok: false, code: 400, reason: 'bad request' };
    const nc = url.searchParams.get('nc');
    if (nc !== null && (role !== 'wallet' || !CLAIM_DIGEST.test(nc)))
      return { ok: false, code: 400, reason: 'bad request' };
    const id = m[1];
    const ip = clientIp(req, trustedProxies);
    let ch = channels.get(id);
    const t = now();

    if (role === 'site') {
      const origin = req.headers.origin;
      if (!acceptableOrigin(origin)) return { ok: false, code: 403, reason: 'origin' };
      if (ch) {
        if (ch.origin !== origin) return { ok: false, code: 403, reason: 'origin mismatch' };
        if (!claimOk(ch, role, claim)) return { ok: false, code: 403, reason: 'role claimed' };
        return { ok: true, id, role, ch, claim, wc };
      }
      const e = Number(url.searchParams.get('e'));
      if (!Number.isFinite(e) || e * 1000 < t || e * 1000 > t + LIMITS.maxQrLifetimeS * 1000)
        return { ok: false, code: 400, reason: 'expiry' };
      // A new channel needs a site claim, so nobody else can take the site socket later (N3-1).
      if (claim === null && !legacy()) return { ok: false, code: 403, reason: 'claim required' };
      if ((perIp.get(ip) ?? 0) >= LIMITS.channelsPerIp) return { ok: false, code: 429, reason: 'too many channels' };
      ch = {
        origin,
        expiry: e * 1000,
        ip,
        paired: false,
        site: null,
        wallet: null,
        queue: { site: [], wallet: [] },
        lastActive: t,
        rate: { start: t, n: 0 },
        claims: { site: null, wallet: null },
        walletBinding: wc,
      };
      channels.set(id, ch);
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      return { ok: true, id, role, ch, claim };
    }

    // wallet
    if (!ch) return { ok: false, code: 404, reason: 'no such channel' };
    // Unpaired: the QR must still be fresh. The site socket may be away (iOS suspends Safari while the
    // user switches to bWallet on the same phone); the channel and its origin were fixed when the site
    // opened it, so the wallet may join and its frames queue for the site like any other away case.
    if (!ch.paired && t > ch.expiry) return { ok: false, code: 410, reason: 'qr expired' };
    if (!claimOk(ch, role, claim)) return { ok: false, code: 403, reason: 'role claimed' };
    // After the cut-over a wallet taking an empty role must be a v2 wallet (the owner reconnecting holds the role).
    if (sessionClaimsRequired() && !ch.claims.wallet && !nc)
      return { ok: false, code: 403, reason: 'claim proof required' };
    return { ok: true, id, role, ch, claim, nc };
  }

  function attach(ws, { role, ch, claim, wc = null, nc = null }) {
    // Re-check: another socket may have claimed the role between admit and the upgrade finishing.
    if (!claimOk(ch, role, claim ?? null)) return ws.close(4003, 'role claimed');
    // Only a site claim the relay already held may move the wallet binding, never one this attach is pinning now.
    const siteProven = role === 'site' && !!claim && !!ch.claims.site && ch.claims.site === claimHash(claim);
    let bound = false;
    if (mayBind(ch, role, claim, nc)) {
      // Wallet claim v2: from now on only the session claim admits the wallet; the QR claim is spent.
      ch.walletBinding = nc;
      ch.claims.wallet = nc;
      bound = true;
    } else if (qrBound(ch, role, claim)) ch.claims[role] = ch.walletBinding;
    else if (claim && !ch.claims[role]) ch.claims[role] = claimHash(claim);
    // A site that proved its own claim may re-bind the wallet role to the session claim digest it knows (v2 pairing).
    if (siteProven && wc && ch.walletBinding !== wc) {
      ch.walletBinding = wc;
      ch.claims.wallet = wc;
    }
    ch[role]?.close(4001, 'replaced');
    ch[role] = ws;
    ch.lastActive = now();
    if (role === 'wallet') {
      ch.paired = true;
      // `wcv` tells the wallet its session claim is now the one bound here (an older relay never says so).
      send(ws, { t: 'relay', verifiedOrigin: ch.origin, ...(bound && { wcv: WALLET_CLAIM_V2 }) });
    }
    send(ch[other(role)], { t: 'relay', peer: 'joined', role });
    // Deliver what arrived while this side was away.
    const t = now();
    for (const q of ch.queue[role].splice(0)) if (t - q.at < LIMITS.queueMs) ws.send(q.data);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4002, 'text frames only');
      const t2 = now();
      if (t2 - ch.rate.start > 60_000) ch.rate = { start: t2, n: 0 };
      if (++ch.rate.n > LIMITS.framesPerMinute) return send(ws, { t: 'relay', error: 'rate limited' });
      ch.lastActive = t2;
      const text = data.toString();
      const peer = ch[other(role)];
      if (peer && peer.readyState === 1) peer.send(text);
      else {
        const q = ch.queue[other(role)];
        q.push({ at: t2, data: text });
        if (q.length > LIMITS.queueFrames) q.shift();
      }
    });
    ws.on('close', () => {
      if (ch[role] !== ws) return;
      ch[role] = null;
      send(ch[other(role)], { t: 'relay', peer: 'left', role });
    });
  }

  let closed = false;
  server?.on('upgrade', (req, socket, head) => {
    // After close() the socket server refuses upgrades; answer it ourselves rather than hand ws a
    // late connection (Bun's ws shim crashes in abortHandshake on that path).
    if (closed) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const a = admit(req);
    if (!a.ok) {
      socket.write(`HTTP/1.1 ${a.code} ${a.reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, a));
  });

  return {
    stats: () => ({ channels: channels.size, sockets: wss.clients.size }),
    close: () => {
      closed = true;
      clearInterval(timer);
      for (const id of [...channels.keys()]) drop(id);
      wss.close();
    },
    _sweep: sweep,
  };
}
