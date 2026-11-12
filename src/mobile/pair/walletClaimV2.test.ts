/**
 * Wallet claim v2 (12 Nov 2026): the QR claim admits the first join only; the phone then holds the wallet role with a
 * session claim only it and the site can compute. Same fake WebSocket as staleConnect.test.ts.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { PAIR_VERSION, claimDigestSync, pairUrl, sessionWalletClaim, walletClaimFor } from '../../pair/protocol';
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

const sessions = (await import('./sessions?walletClaimV2' as string)) as typeof import('./sessions');
const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const HOST = 'https://pairtest.example';
sessions.setPairRevoker(async () => true);
sessions.setAgentPairDeps({ ctx: undefined, currentId: '1AccountAAAAAAAAAAAAAAAAAAAAAAAAAA', accountCount: 1 });


/** Scan a QR; the fake relay answers as a v2 relay (wcv: 2) or an older one. */
const scan = async (channel: string, relayV2: boolean) => {
  const S = PrivateKey.fromRandom();
  const k = S.toPublicKey().toString();
  const pending = sessions.beginPairing(
    pairUrl({ v: PAIR_VERSION, r: 'relay.bwallet.space', c: channel, k, o: HOST, e: Math.floor(Date.now() / 1000) + 120 }),
  );
  const ws = FakeWS.all.at(-1)!;
  ws.deliver({ t: 'relay', verifiedOrigin: HOST, ...(relayV2 && { wcv: 2 }) });
  const p = await pending;
  const hello = JSON.parse(ws.sent[0]) as { t: string; k: string; wcv?: number };
  return { p, ws, S, k, hello };
};
const stored = (c: string) =>
  (JSON.parse(mem.get('bwallet.pair.sessions') ?? '[]') as { c: string; claim?: string; wcv?: number }[]).find(
    (s) => s.c === c,
  );

describe('wallet claim v2', () => {
  test('first join sends the QR claim and the session claim digest; a v2 relay leaves only the session claim', async () => {
    const c = 'WCVAAAAAAAAAAAAAAAAAAA';
    const { p, ws, S, k, hello } = await scan(c, true);
    const u = new URL(ws.url);
    expect(u.searchParams.get('claim')).toBe(walletClaimFor(c, k));
    expect(hello.wcv).toBe(2);
    const session = sessionWalletClaim(S, hello.k, c); // what the site computes from the hello
    expect(u.searchParams.get('nc')).toBe(claimDigestSync(session));
    p.confirm();
    await settle();
    expect(stored(c)).toMatchObject({ claim: session, wcv: 2 });
    expect(stored(c)!.claim).not.toBe(walletClaimFor(c, k));
    // Rejoin: the session claim and its digest, never the QR claim.
    FakeWS.all.findLast((w) => w.url.includes(c))!.close();
    sessions.onPairVisibility();
    await settle();
    const re = new URL(FakeWS.all.findLast((w) => w.url.includes(c))!.url);
    expect(re.searchParams.get('claim')).toBe(session);
    expect(re.searchParams.get('nc')).toBe(claimDigestSync(session));
  });

  test('an older relay (no wcv): keeps the QR claim, and the hello does not ask the site to re-bind', async () => {
    const c = 'WCVBBBBBBBBBBBBBBBBBBB';
    const { p, k, hello } = await scan(c, false);
    expect(hello.wcv).toBeUndefined();
    p.confirm();
    await settle();
    expect(stored(c)?.claim).toBe(walletClaimFor(c, k));
    expect(stored(c)?.wcv).toBeUndefined();
  });

  afterAll(() => {
    for (const s of sessions.pairedSites()) sessions.forget(s.c, false);
  });
});
