/**
 * End-to-end: real relay + TokenBlaster's site side (../../../tokenblaster.lol/src/lib/pair/site.ts)
 * + bWallet's phone side (src/mobile/pair/sessions.ts), with the wallet call stubbed.
 * Run from the bwallet repo: bun test relay/e2e
 */
import { expect, mock, test } from 'bun:test';
import http from 'node:http';
import { createRelay } from '../relay.mjs';

const SITE_ORIGIN = 'http://localhost:3000';
const calls: unknown[] = [];

test('QR → scan → same code → connect → request reaches the wallet and the answer comes back', async () => {
  const server = http.createServer();
  const relay = createRelay({ server });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.NEXT_PUBLIC_PAIR_RELAY = `localhost:${port}`;

  // Browser-ish globals. Pages get the Origin header from the browser; add it for the site socket.
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  Object.assign(globalThis, { location: { origin: SITE_ORIGIN }, sessionStorage: mem(), localStorage: mem() });
  (globalThis as { document?: unknown }).document = { visibilityState: 'visible', addEventListener() {} };
  const Native = globalThis.WebSocket;
  (globalThis as { WebSocket: unknown }).WebSocket = class extends Native {
    constructor(url: string) {
      super(url, url.includes('role=site') ? ({ headers: { Origin: SITE_ORIGIN } } as never) : undefined);
    }
  };

  mock.module(new URL('../../src/mobile/dappBrowser.ts', import.meta.url).pathname, () => ({
    handleSiteCall: async (origin: string, _url: string, type: string, params: unknown) => {
      calls.push({ origin, type, params });
      return { success: true, data: { publicKey: '02' + 'ab'.repeat(32) } };
    },
  }));
  mock.module(new URL('../../src/mobile/storeBuild.ts', import.meta.url).pathname, () => ({
    appNameFor: () => 'bWalletX',
  }));

  const site = await import('../../../tokenblaster.lol/src/lib/pair/site.ts');
  const phone = await import('../../src/mobile/pair/sessions.ts');

  const states: { k: string; [x: string]: unknown }[] = [];
  const stop = site.startPairing((s: { k: string }) => states.push(s));
  const until = async (f: () => unknown, ms = 5000) => {
    const t = Date.now();
    while (!f()) {
      if (Date.now() - t > ms) throw new Error('timeout ' + JSON.stringify(states.map((s) => s.k)));
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  await until(() => states.find((s) => s.k === 'qr'));
  const link = (states.find((s) => s.k === 'qr') as { link: string }).link;
  expect(link).toStartWith('https://bwallet.space/pair?v=1&r=localhost');

  const pending = await phone.beginPairing(link);
  expect(pending.origin).toBe(SITE_ORIGIN);
  await until(() => states.find((s) => s.k === 'code'));
  expect((states.find((s) => s.k === 'code') as { code: string }).code).toBe(pending.code);

  pending.confirm();
  await until(() => states.find((s) => s.k === 'ready'));
  const wallet = (states.find((s) => s.k === 'ready') as { wallet: { getPublicKey: (a: unknown) => Promise<unknown> } })
    .wallet;
  const r = await wallet.getPublicKey({ identityKey: true });
  expect(r).toEqual({ publicKey: '02' + 'ab'.repeat(32) });
  expect(calls).toEqual([{ origin: SITE_ORIGIN, type: 'getPublicKey', params: { identityKey: true } }]);
  expect(phone.pairedSites().map((s: { origin: string }) => s.origin)).toEqual([SITE_ORIGIN]);

  // A QR claiming another origin is refused by the phone (relay reports the real one).
  const forged = link.replace(encodeURIComponent(SITE_ORIGIN), encodeURIComponent('https://tokenblaster.lol'));
  const stop2 = site.startPairing(() => {});
  await expect(phone.beginPairing(forged)).rejects.toThrow();
  stop2();

  stop();
  relay.close();
  server.close();
}, 20000);
