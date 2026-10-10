// Vendored from tokenblaster.lol src/lib/pair/site.ts at bc42afd (the site side of phone pairing), so this e2e runs without the sibling repo. Keep in step with tokenblaster when the pairing protocol changes.
/**
 * Site side of phone pairing (docs/wallet-connect.md §4): show a QR, let bWallet on a phone join the
 * relay channel, compare the 4-digit code, then hand back a WalletInterface whose calls travel to
 * the phone, end-to-end encrypted. To the rest of the site it is just another wallet in the chooser.
 */
import { PrivateKey, type WalletInterface } from '@bsv/sdk';
import QRCode from 'qrcode';
import {
  DEFAULT_RELAY,
  PAIR_VERSION,
  QR_LIFETIME_S,
  Sealer,
  deriveSession,
  isSealed,
  newChannel,
  pairUrl,
  relaySocketUrl,
  type HelloFrame,
  type PairMessage,
  type RelayFrame,
} from './protocol';

export const RELAY = process.env.NEXT_PUBLIC_PAIR_RELAY || DEFAULT_RELAY;
const STORE = 'tokenblaster.pair';

export type PairState =
  | { k: 'starting' }
  | { k: 'qr'; qr: string; link: string; expires: number }
  | { k: 'code'; code: string; phone: string }
  | { k: 'ready'; wallet: WalletInterface; phone: string }
  | { k: 'error'; message: string };

type Saved = { c: string; r: string; s: string; k: string; phone: string; sent: number; lastSeen: number };

/** A live, paired channel: requests out, responses in. */
class Channel {
  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private outbox: string[] = [];
  private closed = false;

  constructor(
    private saved: Saved,
    private sealer: Sealer,
    private onGone: (why: string) => void,
  ) {}

  open(ws?: WebSocket) {
    this.ws = ws ?? new WebSocket(relaySocketUrl(this.saved.r, this.saved.c, 'site'));
    this.ws.onopen = () => this.flush();
    if (ws && ws.readyState === WebSocket.OPEN) this.flush();
    this.ws.onmessage = (ev) => void this.receive(String(ev.data));
    this.ws.onclose = () => {
      if (this.closed) return;
      // Reloads and network blips: rejoin the same channel (the relay keeps it for 24 h).
      setTimeout(() => !this.closed && this.open(), 2000);
    };
  }

  private async receive(raw: string) {
    const f = JSON.parse(raw) as RelayFrame | unknown;
    if ((f as RelayFrame).t === 'relay' || !isSealed(f)) return;
    const msg = await this.sealer.open(f);
    if (!msg) return;
    this.persist();
    if (msg.t === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'Refused on your phone'));
      else p.resolve(msg.result);
    } else if (msg.t === 'close') {
      this.close(false);
      this.onGone('Disconnected on your phone');
    }
  }

  private flush() {
    while (this.ws?.readyState === WebSocket.OPEN && this.outbox.length) this.ws.send(this.outbox.shift()!);
  }

  private persist() {
    try {
      sessionStorage.setItem(STORE, JSON.stringify({ ...this.saved, ...this.sealer.counters }));
    } catch {
      /* the session just won't survive a reload */
    }
  }

  async request(action: string, params: unknown): Promise<unknown> {
    const id = crypto.randomUUID();
    const frame = await this.sealer.seal({ t: 'req', id, action, params } satisfies PairMessage);
    this.persist();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.outbox.push(JSON.stringify(frame));
      this.flush();
    });
  }

  close(notify = true) {
    this.closed = true;
    const finish = () => this.ws?.close();
    if (notify && this.ws?.readyState === WebSocket.OPEN)
      void this.sealer.seal({ t: 'close', reason: 'site disconnected' }).then((f) => {
        this.ws?.send(JSON.stringify(f));
        finish();
      });
    else finish();
    for (const p of this.pending.values()) p.reject(new Error('Disconnected'));
    this.pending.clear();
    try {
      sessionStorage.removeItem(STORE);
    } catch {
      /* ignore */
    }
  }

  /** BRC-100 WalletInterface: every method becomes a request to the phone. */
  wallet(): WalletInterface {
    return new Proxy({} as WalletInterface, {
      get: (_t, method) =>
        typeof method === 'string' && method !== 'then'
          ? (args: unknown) => this.request(method, args ?? {})
          : undefined,
    });
  }
}

let current: Channel | null = null;

/** A paired phone from earlier in this tab (survives reloads, not tab close). */
let resumed: { wallet: WalletInterface; phone: string } | null = null;

export function resumePhone(
  onGone: (why: string) => void = () => {},
): { wallet: WalletInterface; phone: string } | null {
  if (resumed) return resumed;
  if (current) return null;
  let saved: Saved | null = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(STORE) ?? 'null') as Saved | null;
  } catch {
    return null;
  }
  if (!saved) return null;
  const s = saved;
  const ch = new Promise<Channel>((resolve) => {
    void deriveSession(PrivateKey.fromHex(s.s), s.k, s.c).then(({ key }) => {
      const sealer = new Sealer(key, 'site');
      sealer.restore({ sent: s.sent, lastSeen: s.lastSeen });
      const c = new Channel(s, sealer, onGone);
      c.open();
      current = c;
      resolve(c);
    });
  });
  const wallet = new Proxy({} as WalletInterface, {
    get: (_t, method) =>
      typeof method === 'string' && method !== 'then'
        ? async (args: unknown) => (await ch).request(method, args ?? {})
        : undefined,
  });
  resumed = { wallet, phone: s.phone };
  return resumed;
}

export function disconnectPhone() {
  current?.close();
  current = null;
  resumed = null;
}

/**
 * Show a QR and wait for a phone. Calls `onState` as things happen; returns a stop function
 * (call it when the chooser closes). A fresh QR is made when one expires.
 */
export function startPairing(onState: (s: PairState) => void): () => void {
  let stopped = false;
  let ws: WebSocket | null = null;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let handedOver = false;

  const round = async () => {
    if (stopped) return;
    const S = PrivateKey.fromRandom();
    const c = newChannel();
    const e = Math.floor(Date.now() / 1000) + QR_LIFETIME_S;
    const link = pairUrl({ v: PAIR_VERSION, r: RELAY, c, k: S.toPublicKey().toString(), o: location.origin, e });
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 320 });
    if (stopped) return;
    const sock = new WebSocket(relaySocketUrl(RELAY, c, 'site', e));
    ws = sock;
    let sealer: Sealer | null = null;
    let phone = 'bWallet';
    let phoneKey = '';
    sock.onopen = () => onState({ k: 'qr', qr, link, expires: e * 1000 });
    sock.onerror = () =>
      !sealer && onState({ k: 'error', message: 'Phone pairing is unreachable right now. Try again shortly.' });
    sock.onmessage = async (ev) => {
      const f = JSON.parse(String(ev.data)) as RelayFrame | HelloFrame | unknown;
      // 1. The phone's hello (plaintext): derive the key, show the code.
      if ((f as HelloFrame).t === 'hello' && !sealer) {
        const h = f as HelloFrame;
        clearTimeout(refresh);
        phone = h.info?.name || 'bWallet';
        phoneKey = h.k;
        const { key, code } = await deriveSession(S, h.k, c);
        sealer = new Sealer(key, 'site');
        onState({ k: 'code', code, phone });
        return;
      }
      // 2. "ready" (encrypted): the user tapped Connect on the phone.
      if (!sealer || !isSealed(f)) return;
      const msg = await sealer.open(f);
      if (msg?.t === 'ready') {
        const saved: Saved = { c, r: RELAY, s: S.toHex(), k: phoneKey, phone, ...sealer.counters };
        try {
          sessionStorage.setItem(STORE, JSON.stringify(saved));
        } catch {
          /* the session just won't survive a reload */
        }
        const ch = new Channel(saved, sealer, () => {});
        ch.open(sock);
        current = ch;
        handedOver = true;
        onState({ k: 'ready', wallet: ch.wallet(), phone });
      } else if (msg?.t === 'close') onState({ k: 'error', message: 'Cancelled on the phone.' });
    };
    refresh = setTimeout(
      () => {
        if (sealer || stopped) return;
        sock.close();
        void round();
      },
      QR_LIFETIME_S * 1000 - 5000,
    );
  };

  onState({ k: 'starting' });
  void round();
  return () => {
    stopped = true;
    clearTimeout(refresh);
    if (!handedOver) ws?.close();
  };
}
