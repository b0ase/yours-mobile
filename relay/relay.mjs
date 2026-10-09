/**
 * bWallet phone-pairing relay (tokenblaster.lol docs/wallet-connect.md §4).
 *
 * Two websockets per channel: the site (desktop page) and the wallet (bWallet on a phone). The relay
 * forwards their frames verbatim. Frames after the hello are end-to-end encrypted, so it can't read or
 * change them. It stores nothing on disk and logs counts only.
 *
 * The one thing it vouches for is the site's origin: browsers set the websocket Origin header and page
 * scripts can't change it, so the relay ties the channel to that origin and tells the phone
 * ({ t: 'relay', verifiedOrigin }). The phone refuses to pair unless it matches the QR.
 */
import { WebSocketServer } from 'ws';

export const LIMITS = {
  maxFrame: 4 * 1024 * 1024, // large transaction bundles
  framesPerMinute: 60,
  channelsPerIp: 1000,
  queueFrames: 20,
  queueMs: 60_000,
  maxQrLifetimeS: 300,
  unpairedIdleMs: 2 * 60_000,
  pairedIdleMs: 24 * 60 * 60_000,
};

const CHANNEL = /^[A-Za-z0-9_-]{22}$/; // 16 random bytes, base64url
const ROLES = new Set(['site', 'wallet']);
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

export function createRelay({ server, now = () => Date.now(), log = () => {} } = {}) {
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

  /** Decide whether an upgrade is allowed. Returns { ok, code, reason, ... }. */
  function admit(req) {
    const url = new URL(req.url, 'http://relay');
    const m = url.pathname.match(/^\/v1\/c\/([^/]+)$/);
    const role = url.searchParams.get('role');
    if (!m || !CHANNEL.test(m[1]) || !ROLES.has(role)) return { ok: false, code: 400, reason: 'bad request' };
    const id = m[1];
    const ip = (req.headers['x-real-ip'] || req.socket.remoteAddress || '').toString();
    let ch = channels.get(id);
    const t = now();

    if (role === 'site') {
      const origin = req.headers.origin;
      if (!acceptableOrigin(origin)) return { ok: false, code: 403, reason: 'origin' };
      if (ch) {
        if (ch.origin !== origin) return { ok: false, code: 403, reason: 'origin mismatch' };
        return { ok: true, id, role, ch };
      }
      const e = Number(url.searchParams.get('e'));
      if (!Number.isFinite(e) || e * 1000 < t || e * 1000 > t + LIMITS.maxQrLifetimeS * 1000)
        return { ok: false, code: 400, reason: 'expiry' };
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
      };
      channels.set(id, ch);
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      return { ok: true, id, role, ch };
    }

    // wallet
    if (!ch) return { ok: false, code: 404, reason: 'no such channel' };
    // Unpaired: the QR must still be fresh. The site socket may be away (iOS suspends Safari while the
    // user switches to bWallet on the same phone); the channel and its origin were fixed when the site
    // opened it, so the wallet may join and its frames queue for the site like any other away case.
    if (!ch.paired && t > ch.expiry) return { ok: false, code: 410, reason: 'qr expired' };
    return { ok: true, id, role, ch };
  }

  function attach(ws, { id, role, ch }) {
    ch[role]?.close(4001, 'replaced');
    ch[role] = ws;
    ch.lastActive = now();
    if (role === 'wallet') {
      ch.paired = true;
      send(ws, { t: 'relay', verifiedOrigin: ch.origin });
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

  server?.on('upgrade', (req, socket, head) => {
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
      clearInterval(timer);
      for (const id of [...channels.keys()]) drop(id);
      wss.close();
    },
    _sweep: sweep,
  };
}
