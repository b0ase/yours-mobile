/**
 * P0 22 Nov 2026 (owner): "signing in with bwallet doesn't work on the phone … we get the share code and click OK but
 * it doesn't return us to the app, and doesn't connect … it sends us round in loops if we cancel."
 *
 * Site and wallet on ONE phone. The site's tab sleeps while the user is in bWallet (iOS kills its relay socket), so:
 *  - the site leaving the channel must not close the Connect card of a same-phone link (it has `ret`): it is asleep;
 *  - when it rejoins, say hello again (its key may have gone with the frozen socket) as well as ready;
 *  - a link with the site's sign-in challenge (`ln`, `lx`, @bwalletx/connect 0.9.0) signs in on the same card, and the
 *    signature goes with `ready`, and in the return, so the user isn't sent back to the wallet a second time;
 *  - the return to the site happens without an origin proof too (sites on @bwalletx/connect have none): `ret` must be
 *    on the relay-verified origin, so it only ever opens the site the user came from.
 * Same fake WebSocket as staleConnect.test.ts.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { PrivateKey, ProtoWallet, PublicKey, Signature, Utils } from '@bsv/sdk';
import { PAIR_VERSION, Sealer, deriveSession, isSealed, pairUrl, type PairLink } from '../../pair/protocol';
import { keepGlobals, stubGlobals } from '../../testing/stubGlobals';

const realDappBrowser = { ...(await import('../dappBrowser')) };
mock.module('../dappBrowser', () => ({ ...realDappBrowser, handleSiteCall: async () => ({ success: true, data: {} }) }));

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
stubGlobals({
  WebSocket: FakeWS,
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
  document: { visibilityState: 'visible', addEventListener: () => undefined },
  chrome: { storage: { local: { set: async () => undefined } } },
});
keepGlobals('localStorage');

const sessions = (await import('./sessions?samePhone' as string)) as typeof import('./sessions');
afterAll(() => sessions.__resetPairingForTests());
const { returnHref } = await import('./openReturn');
const settle = () => new Promise<void>((r) => setTimeout(r, 25));
const HOST = 'https://pairtest.example';
const root = PrivateKey.fromRandom();
sessions.setPairRevoker(async () => true);
sessions.setAgentPairDeps({
  ctx: { wallet: new ProtoWallet(root) } as never,
  currentId: '1AccountAAAAAAAAAAAAAAAAAAAAAAAAAA',
  accountCount: 1,
});

let n = 0;
const chan = () => `SAME${String(++n).padStart(18, 'A')}`;
const loginFields = (ms = 120_000) => ({ ln: `nonce_${n}_abcdef`, lx: new Date(Date.now() + ms).toISOString() });

/** Scan a same-phone link (ret, rid; `extra` adds ln/lx) and get the Connect card up. */
const card = async (extra: Partial<PairLink> = {}, same = true) => {
  const site = PrivateKey.fromRandom();
  const link: PairLink = {
    v: PAIR_VERSION,
    r: 'relay.bwallet.space',
    c: chan(),
    k: site.toPublicKey().toString(),
    o: HOST,
    e: Math.floor(Date.now() / 1000) + 120,
    ...(same && { ret: `${HOST}/rooms/lounge`, rid: `rid${String(n).padStart(20, 'x')}`, b: 'safari' as const }),
    ...extra,
  };
  const pending = sessions.beginPairing(pairUrl(link));
  const ws = FakeWS.all.at(-1)!;
  ws.deliver({ t: 'relay', verifiedOrigin: HOST });
  const p = await pending;
  let gone = 0;
  p.onGone(() => gone++);
  const hello = JSON.parse(ws.sent.find((s) => s.includes('"hello"'))!) as { k: string };
  const { key } = await deriveSession(site, hello.k, link.c);
  const siteSealer = new Sealer(key, 'site');
  return { p, ws, link, site, hello, siteSealer, gone: () => gone };
};
const sealedFrom = async (ws: FakeWS, sealer: Sealer, from = 0) => {
  const out = [];
  for (const s of ws.sent.slice(from)) {
    const f = JSON.parse(s);
    if (isSealed(f)) out.push(await sealer.open(f));
  }
  return out;
};

describe('same phone: the site tab sleeps', () => {
  test('the Connect card stays when the sleeping site tab drops off the channel', async () => {
    const c = await card();
    c.ws.deliver({ t: 'relay', peer: 'left', role: 'site' });
    await settle();
    expect(c.gone()).toBe(0);
    expect(c.ws.readyState).toBe(1);
  });

  test('a desktop QR (no ret) still closes when the site leaves', async () => {
    const c = await card({}, false);
    c.ws.deliver({ t: 'relay', peer: 'left', role: 'site' });
    await settle();
    expect(c.gone()).toBe(1);
  });

  test('the site tab rejoining before Connect gets the hello again', async () => {
    const c = await card();
    const before = c.ws.sent.filter((s) => s.includes('"hello"')).length;
    c.ws.deliver({ t: 'relay', peer: 'joined', role: 'site' });
    await settle();
    expect(c.ws.sent.filter((s) => s.includes('"hello"')).length).toBe(before + 1);
  });

  test('after Connect, a rejoining site tab gets hello and ready again', async () => {
    const c = await card();
    await c.p.confirm();
    await settle();
    const from = c.ws.sent.length;
    c.ws.deliver({ t: 'relay', peer: 'joined', role: 'site' });
    await settle();
    const later = c.ws.sent.slice(from);
    expect(later.some((s) => s.includes('"hello"'))).toBe(true);
    const msgs = await sealedFrom(c.ws, c.siteSealer);
    expect(msgs.filter((m) => m?.t === 'ready').length).toBeGreaterThanOrEqual(2);
  });
});

describe('same phone: sign in with Connect, and go back', () => {
  test('without an origin proof, a ret on the verified origin still returns (sites on @bwalletx/connect)', async () => {
    const c = await card();
    expect(c.p.proven).toBe(false);
    expect(c.p.returnPlan?.ret).toBe(`${HOST}/rooms/lounge`);
  });

  test('a ret on another host never returns', async () => {
    const c = await card({ ret: 'https://evil.example/x' });
    expect(c.p.returnPlan).toBeNull();
  });

  test('the card says it signs in, and Connect folds the signature into ready and the return', async () => {
    const lf = loginFields();
    const c = await card(lf);
    expect(c.p.signIn).toBe(true);
    const back = c.p.takeReturn();
    const r = await c.p.confirm();
    await settle();
    const msgs = await sealedFrom(c.ws, c.siteSealer);
    const ready = msgs.find((m) => m?.t === 'ready') as { login?: { k: string; sig: string } };
    expect(ready?.login?.k).toBe(root.toPublicKey().toString());
    // The signature is the login signature the site's verifySignIn checks: protocol [2,'bwallet sign in'], keyID =
    // nonce, counterparty anyone, over loginMessage(origin, nonce, expiry).
    const { loginMessage } = await import('./pairLogin');
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      protocolID: [2, 'bwallet sign in'],
      keyID: lf.ln,
      counterparty: root.toPublicKey().toString(),
      data: Utils.toArray(loginMessage(HOST, lf.ln, lf.lx), 'utf8'),
      signature: Utils.toArray(ready.login!.sig, 'hex'),
    } as never).catch(() => ({ valid: false }));
    expect(valid).toBe(true);
    // The return carries the wallet's pairing key and the same sealed ready, for a new tab that missed the relay.
    expect(r?.wk).toBe(c.hello.k);
    const href = returnHref(back!, 'ios', r ?? undefined);
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe(`${HOST}/rooms/lounge`);
    const q = new URLSearchParams(u.hash.slice(1));
    expect(q.get('bwx')).toBe('ok');
    expect(q.get('wk')).toBe(c.hello.k);
    const b64 = q.get('f')!.replace(/-/g, '+').replace(/_/g, '/');
    const frame = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (ch) => ch.charCodeAt(0))));
    const fresh = new Sealer((await deriveSession(c.site, q.get('wk')!, c.link.c)).key, 'site');
    const m = (await fresh.open(frame)) as { t: string; login?: { k: string } };
    expect(m.t).toBe('ready');
    expect(m.login?.k).toBe(root.toPublicKey().toString());
    expect(PublicKey.fromString(m.login!.k)).toBeTruthy();
    expect(Signature).toBeTruthy();
  });

  test('an expired or malformed challenge is not signed: plain Connect', async () => {
    const c = await card(loginFields(-1000));
    expect(c.p.signIn).toBe(false);
    await c.p.confirm();
    await settle();
    const msgs = await sealedFrom(c.ws, c.siteSealer);
    expect((msgs.find((m) => m?.t === 'ready') as { login?: unknown })?.login).toBeUndefined();
  });

  test('No tells the site (it stops waiting) instead of leaving it on the code', async () => {
    const c = await card();
    c.p.cancel();
    await settle();
    const msgs = await sealedFrom(c.ws, c.siteSealer);
    expect(msgs.some((m) => m?.t === 'close')).toBe(true);
  });

  afterAll(() => {
    for (const s of sessions.pairedSites()) sessions.forget(s.c, false);
  });
});
