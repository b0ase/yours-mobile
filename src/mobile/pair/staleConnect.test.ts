/**
 * Owner, 27 Oct 2026: the desktop signed in through the stored pairing while a Connect card from its second QR
 * stayed open on the phone. A card that is no longer wanted now closes. Same fake WebSocket as wakeResume.test.ts.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_VERSION, pairUrl } from '../../pair/protocol';
import { keepGlobals, stubGlobals } from '../../testing/stubGlobals';

const siteCall: () => Promise<unknown> = async () => ({ success: true, data: { publicKey: '02ab' } });
// Keep the real exports: bun module mocks are process-wide, and a partial mock breaks later files (lapseRevoke.test.ts).
const realDappBrowser = { ...(await import('../dappBrowser')) };
mock.module('../dappBrowser', () => ({ ...realDappBrowser, handleSiteCall: () => siteCall() }));

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeWS[] = [];
  readyState = 1;
  sent: string[] = [];
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const mem = new Map<string, string>();
const chromeLocal = new Map<string, unknown>();
const visibility = 'visible';
// Restored when this file finishes: a leaked document/localStorage broke the theme and pageHidden tests.
stubGlobals({
  WebSocket: FakeWS,
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
  document: {
    get visibilityState() {
      return visibility;
    },
    addEventListener: () => undefined,
  },
  chrome: {
    storage: {
      local: {
        set: async (v: Record<string, unknown>) => {
          for (const [k, x] of Object.entries(v)) chromeLocal.set(k, x);
        },
      },
    },
  },
});
// The first test deletes and puts back localStorage; make sure the stub is what comes back even if it throws.
keepGlobals('localStorage');

const sessions = (await import('./sessions?staleConnect' as string)) as typeof import('./sessions');
const { closeConnectCardsFor } = await import('./pairLogin');
const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const HOST = 'https://pairtest.example';
sessions.setPairRevoker(async () => true);
sessions.setAgentPairDeps({ ctx: undefined, currentId: '1AccountAAAAAAAAAAAAAAAAAAAAAAAAAA', accountCount: 1 });

/** Scan a QR and get the Connect card up, without pressing Connect. */
const card = async (channel: string) => {
  const pending = sessions.beginPairing(
    pairUrl({
      v: PAIR_VERSION,
      r: 'relay.bwallet.space',
      c: channel,
      k: PrivateKey.fromRandom().toPublicKey().toString(),
      o: HOST,
      e: Math.floor(Date.now() / 1000) + 120,
    }),
  );
  const ws = FakeWS.all.at(-1)!;
  ws.deliver({ t: 'relay', verifiedOrigin: HOST });
  const p = await pending;
  let gone = 0;
  p.onGone(() => gone++);
  return { p, ws, gone: () => gone };
};

describe('stale Connect card', () => {
  test('closes when the site leaves the channel (its QR was closed)', async () => {
    const c = await card('STALEAAAAAAAAAAAAAAAAA');
    c.ws.deliver({ t: 'relay', peer: 'left', role: 'site' });
    await settle();
    expect(c.gone()).toBe(1);
    expect(c.ws.readyState).toBe(3);
    // Connect on a gone card does nothing.
    c.p.confirm();
    expect(sessions.pairedSites().some((s) => s.c === 'STALEAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  test('closes when the channel closes', async () => {
    const c = await card('STALEBBBBBBBBBBBBBBBBB');
    c.ws.close();
    await settle();
    expect(c.gone()).toBe(1);
  });

  test('closes when the site signed in through another pairing', async () => {
    const c = await card('STALECCCCCCCCCCCCCCCCC');
    closeConnectCardsFor('https://other.example');
    expect(c.gone()).toBe(0);
    closeConnectCardsFor(HOST);
    expect(c.gone()).toBe(1);
  });

  test('a confirmed or cancelled card is never closed as stale', async () => {
    const a = await card('STALEDDDDDDDDDDDDDDDDD');
    a.p.confirm();
    await settle();
    closeConnectCardsFor(HOST);
    expect(a.gone()).toBe(0);
    const b = await card('STALEEEEEEEEEEEEEEEEEE');
    b.p.cancel();
    await settle();
    expect(b.gone()).toBe(0);
  });

  afterAll(() => {
    for (const s of sessions.pairedSites()) sessions.forget(s.c, false);
  });
});
