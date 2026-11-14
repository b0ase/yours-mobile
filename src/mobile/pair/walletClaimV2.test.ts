/**
 * Wallet claim v2 (12 Nov 2026): the QR claim admits the first join only; the phone then holds the wallet role with a
 * session claim only it and the site can compute. Same fake WebSocket as staleConnect.test.ts.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import {
  PAIR_VERSION,
  Sealer,
  claimDigestSync,
  deriveSession,
  isSealed,
  pairUrl,
  sessionWalletClaim,
  walletClaimFor,
  type PairMessage,
} from '../../pair/protocol';
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
keepGlobals('localStorage', 'fetch');

const sessions = (await import('./sessions?walletClaimV2' as string)) as typeof import('./sessions');
// Leave this copy inert when the file ends: its reconnect timers would otherwise fire during the next file and act on
// that file's localStorage and WebSocket stubs (bun runs every test file in one process).
afterAll(() => sessions.__resetPairingForTests());
const settle = () => new Promise<void>((r) => setTimeout(r, 25));
/**
 * Wait until `ok()` holds (polling, up to 5 s). A fixed 25 ms wait raced the phone's reconnect on a loaded machine
 * (full `bun test src`, 13 Nov 2026): the claim was read from the socket the test had just closed.
 */
const until = async (ok: () => boolean) => {
  for (let t = 0; t < 1000 && !ok(); t++) await new Promise<void>((r) => setTimeout(r, 5));
};
const HOST = 'https://pairtest.example';
sessions.setPairRevoker(async () => true);
sessions.setAgentPairDeps({ ctx: undefined, currentId: '1AccountAAAAAAAAAAAAAAAAAAAAAAAAAA', accountCount: 1 });

/** Scan a QR; the fake relay answers as a v2 relay (wcv: 2) or an older one. */
const scan = async (channel: string, relayV2: boolean) => {
  const S = PrivateKey.fromRandom();
  const k = S.toPublicKey().toString();
  const pending = sessions.beginPairing(
    pairUrl({
      v: PAIR_VERSION,
      r: 'relay.bwallet.space',
      c: channel,
      k,
      o: HOST,
      e: Math.floor(Date.now() / 1000) + 120,
    }),
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
    await resume(c);
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

/** The latest socket for a channel. */
const sock = (c: string) => FakeWS.all.findLast((w) => w.url.includes(c))!;
/** The phone comes back to the page after its socket closed: wait for the socket it opens again, then settle. */
const resume = async (c: string) => {
  const before = sock(c);
  sessions.onPairVisibility();
  await until(() => sock(c) !== before);
  await settle();
};
/** What the site reads from the phone's sealed frames on `ws` (its own key + the hello), in order. */
const siteReads = async (ws: FakeWS, from: Sealer) => {
  const out: PairMessage[] = [];
  for (const raw of ws.sent) {
    const f = JSON.parse(raw) as unknown;
    if (!isSealed(f)) continue;
    const m = await from.open(f);
    if (m) out.push(m);
  }
  return out;
};
const siteSealer = async (S: PrivateKey, phonePub: string, c: string) =>
  new Sealer((await deriveSession(S, phonePub, c)).key, 'site');

describe('v1 sessions upgrade through the site (review 13 Nov 2026)', () => {
  test('a v1 session tells the site its session claim digest in every sealed ready, and still sends nc on resume', async () => {
    const c = 'WCVUPAAAAAAAAAAAAAAAAA';
    const { p, S, k, hello } = await scan(c, false); // paired through an older relay: v1
    p.confirm();
    await settle();
    expect(stored(c)).toMatchObject({ claim: walletClaimFor(c, k) });
    const session = sessionWalletClaim(S, hello.k, c);
    const want = { t: 'ready', wcv: 2, nc: claimDigestSync(session) };
    const reader = await siteSealer(S, hello.k, c);
    expect(await siteReads(sock(c), reader)).toContainEqual(want); // the first ready
    sock(c).close();
    await resume(c);
    const ws = sock(c);
    const u = new URL(ws.url);
    expect(u.searchParams.get('claim')).toBe(walletClaimFor(c, k));
    expect(u.searchParams.get('nc')).toBe(claimDigestSync(session));
    // The relay doesn't hold the session claim yet (the site hasn't re-bound): the session stays v1 on its claim.
    ws.deliver({ t: 'relay', verifiedOrigin: HOST });
    await settle();
    expect(stored(c)).toMatchObject({ claim: walletClaimFor(c, k) });
    expect(stored(c)?.wcv).toBeUndefined();
    expect(await siteReads(ws, reader)).toContainEqual(want);
  });

  test('after the site re-binds, the old claim is refused; the next connect uses the session claim and keeps it', async () => {
    const c = 'WCVUPBBBBBBBBBBBBBBBBB';
    const { p, S, k, hello } = await scan(c, false);
    p.confirm();
    await settle();
    sock(c).close();
    await resume(c);
    const session = sessionWalletClaim(S, hello.k, c);
    expect(new URL(sock(c).url).searchParams.get('claim')).toBe(walletClaimFor(c, k));
    sock(c).close(); // refused (the relay now holds only the session claim): closed before any relay frame
    await resume(c);
    expect(new URL(sock(c).url).searchParams.get('claim')).toBe(session);
    sock(c).deliver({ t: 'relay', verifiedOrigin: HOST, wcv: 2 });
    await settle();
    expect(stored(c)).toMatchObject({ claim: session, wcv: 2 });
    // The next resume is a plain v2 one.
    sock(c).close();
    await resume(c);
    const re = new URL(sock(c).url);
    expect(re.searchParams.get('claim')).toBe(session);
    expect(re.searchParams.get('nc')).toBe(claimDigestSync(session));
  });

  test('a channel re-created from a v1 pairing (QR binding): an older claim is refused, the QR claim binds the session claim', async () => {
    const c = 'WCVUPDDDDDDDDDDDDDDDDD';
    const { p, S, k, hello } = await scan(c, false);
    p.confirm();
    await settle();
    // A session from before QR-bound claims: its stored claim is a random one.
    const old = 'randomoldclaimrandomol';
    mem.set(
      'bwallet.pair.sessions',
      JSON.stringify(
        (JSON.parse(mem.get('bwallet.pair.sessions')!) as { c: string }[]).map((x) =>
          x.c === c ? { ...x, claim: old } : x,
        ),
      ),
    );
    const session = sessionWalletClaim(S, hello.k, c);
    const tried: (string | null)[] = [];
    sock(c).close();
    for (let i = 0; i < 3; i++) {
      await resume(c);
      tried.push(new URL(sock(c).url).searchParams.get('claim'));
      if (i < 2) sock(c).close(); // refused: the relay holds the QR binding only
    }
    expect(tried).toEqual([old, session, walletClaimFor(c, k)]);
    sock(c).deliver({ t: 'relay', verifiedOrigin: HOST, wcv: 2 });
    await settle();
    expect(stored(c)).toMatchObject({ claim: session, wcv: 2 });
  });

  test('a v2 session refused on its session claim tries the QR claim next, and keeps the session claim stored', async () => {
    const c = 'WCVUPEEEEEEEEEEEEEEEEE';
    const { p, k, hello, S } = await scan(c, true);
    p.confirm();
    await settle();
    const session = sessionWalletClaim(S, hello.k, c);
    sock(c).close();
    await resume(c);
    expect(new URL(sock(c).url).searchParams.get('claim')).toBe(session);
    sock(c).close();
    await resume(c);
    expect(new URL(sock(c).url).searchParams.get('claim')).toBe(walletClaimFor(c, k));
    sock(c).deliver({ t: 'relay', verifiedOrigin: HOST });
    await settle();
    expect(stored(c)).toMatchObject({ claim: session, wcv: 2 });
  });

  test('an older relay on resume (no wcv): the session stays v1 on its claim', async () => {
    const c = 'WCVUPCCCCCCCCCCCCCCCCC';
    const { p, k } = await scan(c, false);
    p.confirm();
    await settle();
    sock(c).close();
    await resume(c);
    sock(c).deliver({ t: 'relay', verifiedOrigin: HOST });
    await settle();
    expect(stored(c)?.claim).toBe(walletClaimFor(c, k));
    expect(stored(c)?.wcv).toBeUndefined();
  });

  afterAll(() => {
    for (const s of sessions.pairedSites()) sessions.forget(s.c, false);
  });
});

describe('before Connect', () => {
  test("a sealed close from the site ends the card and says the codes didn't match", async () => {
    const c = 'WCVNOAAAAAAAAAAAAAAAAA';
    const { p, ws, S, hello } = await scan(c, true);
    const said: (string | undefined)[] = [];
    p.onGone((m) => said.push(m));
    const site = await siteSealer(S, hello.k, c);
    ws.deliver(await site.seal({ t: 'close', reason: 'codes did not match' }));
    await settle();
    expect(said).toEqual([sessions.SITE_SAID_NO_MESSAGE]);
    expect(said[0]).toContain("codes didn't match");
    expect(ws.readyState).toBe(3);
    p.confirm(); // too late: nothing is stored
    expect(stored(c)).toBeUndefined();
    // A card asked afterwards hears the same.
    p.onGone((m) => said.push(m));
    expect(said.at(-1)).toBe(sessions.SITE_SAID_NO_MESSAGE);
  });

  test('a refused join says the code was used when the relay is up, and unreachable when it is not', async () => {
    const g = globalThis as { fetch: unknown };
    for (const [up, want] of [
      [true, /already used/],
      [false, /Could not reach the pairing service/],
    ] as const) {
      g.fetch = async () => {
        if (!up) throw new TypeError('network');
        return new Response(null);
      };
      const S = PrivateKey.fromRandom();
      const pending = sessions.beginPairing(
        pairUrl({
          v: PAIR_VERSION,
          r: 'relay.bwallet.space',
          c: up ? 'WCVUSEDAAAAAAAAAAAAAAA' : 'WCVUSEDBBBBBBBBBBBBBBB',
          k: S.toPublicKey().toString(),
          o: HOST,
          e: Math.floor(Date.now() / 1000) + 120,
        }),
      );
      const ws = FakeWS.all.at(-1)!;
      // What a browser does on a refused upgrade: error, then close 1006.
      ws.onerror?.();
      ws.readyState = 3;
      ws.onclose?.({ code: 1006 });
      await expect(pending).rejects.toThrow(want);
    }
  });
});
