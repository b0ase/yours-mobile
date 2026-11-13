/**
 * End-to-end: "Open on computer" and the "your phone has it" ping through the real relay with its compatibility
 * window closed (as after 30 Nov 2026), so every socket must bring the claims the relay requires.
 * Run from the bwallet repo: bun test relay/e2e
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import http from 'node:http';
import { createRelay } from '../relay.mjs';
import { walletClaimFor, relaySocketUrl } from '../../src/pair/protocol';

const ORIGIN = 'http://localhost:3000'; // a wallet origin when local origins are allowed
const g = globalThis as Record<string, unknown>;
const saved = Object.fromEntries(['location', 'sessionStorage', 'WebSocket'].map((k) => [k, g[k]]));
const savedRelayEnv = process.env.VITE_PAIR_RELAY;
const Native = globalThis.WebSocket;
const server = http.createServer();
const relay = createRelay({ server, legacyUntil: 0 });
let port = 0;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;
  process.env.VITE_PAIR_RELAY = `localhost:${port}`;
  const m = new Map<string, string>();
  Object.assign(globalThis, {
    location: { origin: ORIGIN, search: '' },
    sessionStorage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  });
  // Browsers set the Origin header on the computer's socket.
  g.WebSocket = class extends Native {
    constructor(url: string) {
      super(url, url.includes('role=site') ? ({ headers: { Origin: ORIGIN } } as never) : undefined);
    }
  };
});

afterAll(() => {
  relay.close();
  server.closeAllConnections?.();
  server.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  if (savedRelayEnv === undefined) delete process.env.VITE_PAIR_RELAY;
  else process.env.VITE_PAIR_RELAY = savedRelayEnv;
});

const until = async (f: () => unknown, ms = 5000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** True when the relay refuses a wallet socket (HTTP error on upgrade). */
const refused = (url: string) =>
  new Promise<boolean>((res) => {
    const w = new Native(url);
    w.onopen = () => (w.close(), res(false));
    w.onerror = () => res(true);
  });

test("open on computer works with the compatibility window closed, and the QR claim cannot take the phone's socket", async () => {
  const { startOpenSession, beginOpenHere, parseOpenUrl } = await import('../../src/mobile/passkey/openHere');
  let joined = false;
  let wallet: { words: string } | null = null;
  const errors: string[] = [];
  const s = startOpenSession({
    onJoined: () => (joined = true),
    onWallet: (p) => (wallet = p),
    onExpired: () => errors.push('expired'),
    onError: (m) => errors.push(m),
  });
  await new Promise((r) => setTimeout(r, 100)); // the QR is on screen once the computer's socket is open
  const phone = await beginOpenHere(s.url, true);
  await until(() => joined || errors.length);
  expect(errors).toEqual([]);
  // Someone who saw the QR computes the same QR claim: the relay bound the wallet role to the phone's session claim.
  const l = parseOpenUrl(s.url, undefined, true);
  expect(await refused(relaySocketUrl(l.r, l.c, 'wallet', undefined, walletClaimFor(l.c, l.k)))).toBe(true);
  expect(await s.submitCode(phone.code)).toBe(true);
  await phone.confirmed;
  await phone.send('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  await until(() => wallet || errors.length);
  expect(errors).toEqual([]);
  expect(wallet!.words).toContain('abandon');
}, 20000);

test('"your phone has it" ping works with the compatibility window closed', async () => {
  const { listenForRestore, armRestorePing, sendRestoredPing, walletFingerprint, pingQuery } =
    await import('../../src/mobile/passkey/openHere');
  const words = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  let restored = false;
  const l = listenForRestore(await walletFingerprint(words), () => (restored = true));
  await new Promise((r) => setTimeout(r, 100)); // the computer's socket opens the channel first
  expect(armRestorePing(`?passkey=1${pingQuery(l.params())}`)).toBe(true);
  expect(await sendRestoredPing(words, true)).toBe(true);
  await until(() => restored);
  l.close();
}, 20000);
