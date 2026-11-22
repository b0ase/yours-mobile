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
import { BSM, PrivateKey, ProtoWallet, PublicKey, Signature, Utils } from '@bsv/sdk';
import {
  PAIR_VERSION,
  Sealer,
  deriveSession,
  isSealed,
  pairUrl,
  signPairProofV2,
  type PairLink,
} from '../../pair/protocol';
import { keepGlobals, stubGlobals } from '../../testing/stubGlobals';

const realDappBrowser = { ...(await import('../dappBrowser')) };
mock.module('../dappBrowser', () => ({
  ...realDappBrowser,
  handleSiteCall: async () => ({ success: true, data: {} }),
}));

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
// The site's origin key: its public half is "published" at HOST/.well-known/bwalletx-pair.json via this fetch stub.
const originKey = PrivateKey.fromRandom();
stubGlobals({
  fetch: async (url: string) =>
    String(url) === 'https://pairtest.example/.well-known/bwalletx-pair.json'
      ? new Response(JSON.stringify({ keys: [originKey.toPublicKey().toString()] }), { status: 200 })
      : new Response('no', { status: 404 }),
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
const ROOT_ACCOUNT = root.toPublicKey().toAddress();
sessions.setPairRevoker(async () => true);
sessions.setAgentPairDeps({
  ctx: { wallet: new ProtoWallet(root) } as never,
  currentId: ROOT_ACCOUNT,
  accountCount: 1,
});

let n = 0;
const chan = () => `SAME${String(++n).padStart(18, 'A')}`;
const loginFields = (ms = 120_000) => ({ ln: `nonce_${n}_abcdef`, lx: new Date(Date.now() + ms).toISOString() });

/** Scan a same-phone link (ret, rid; `extra` adds ln/lx) and get the Connect card up. `proven`: signed s2. */
const card = async (extra: Partial<PairLink> = {}, same = true, proven = false) => {
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
  if (proven) link.s2 = signPairProofV2({ ...link, ret: link.ret!, rid: link.rid! }, originKey);
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
  test('without an origin proof, the return goes to the verified origin ROOT only (review 22 Nov, 4)', async () => {
    const c = await card();
    expect(c.p.proven).toBe(false);
    expect(c.p.returnPlan?.ret).toBe(`${HOST}/`);
  });

  test('never to a subdomain, a port or another scheme, proven or not (review 22 Nov, 4)', async () => {
    for (const ret of ['https://sub.pairtest.example/', 'https://pairtest.example:8443/', 'http://pairtest.example/']) {
      const c = await card({ ret });
      expect(c.p.returnPlan).toBeNull();
    }
  });

  test('a ret on another host never returns', async () => {
    const c = await card({ ret: 'https://evil.example/x' });
    expect(c.p.returnPlan).toBeNull();
  });

  test('CTO 22 Nov: the sign-in signature goes ONLY in the return; the relay ready says ls:1 and carries none', async () => {
    const lf = loginFields();
    // A valid s2 for this link: also what a script that got its own link signed would hold. It still sees no signature.
    const c = await card(lf, true, true);
    expect(c.p.signIn).toBe(true);
    const back = c.p.takeReturn();
    const r = await c.p.confirm();
    await settle();
    // Over the relay: "signed in, see the return", no signature anywhere.
    const msgs = await sealedFrom(c.ws, c.siteSealer);
    const ready = msgs.find((m) => m?.t === 'ready') as { login?: unknown; ls?: number };
    expect(ready?.ls).toBe(1);
    expect(ready?.login).toBeUndefined();
    expect(msgs.some((m) => JSON.stringify(m).includes('"sig"'))).toBe(false);
    // The return carries the wallet's pairing key and the sealed ready WITH the signature, to the exact origin only.
    expect(r?.wk).toBe(c.hello.k);
    const href = returnHref(back!, 'ios', r ?? undefined);
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe(`${HOST}/`); // review 3: always the root of the relay-seen origin
    const q = new URLSearchParams(u.hash.slice(1));
    expect(q.get('bwx')).toBe('ok');
    expect(q.get('wk')).toBe(c.hello.k);
    const b64 = q.get('f')!.replace(/-/g, '+').replace(/_/g, '/');
    const frame = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (ch) => ch.charCodeAt(0)),
      ),
    );
    const m = (await c.siteSealer.open(frame)) as { t: string; login?: { k: string; sig: string } }; // after the relay ready
    expect(m.t).toBe('ready');
    expect(m.login?.k).toBe(root.toPublicKey().toString());
    // The signature is the login signature the site's verifySignIn checks.
    const { loginMessage } = await import('./pairLogin');
    const { valid } = await new ProtoWallet('anyone')
      .verifySignature({
        protocolID: [2, 'bwallet sign in'],
        keyID: lf.ln,
        counterparty: root.toPublicKey().toString(),
        data: Utils.toArray(loginMessage(HOST, lf.ln, lf.lx), 'utf8'),
        signature: Utils.toArray(m.login!.sig, 'hex'),
      } as never)
      .catch(() => ({ valid: false }));
    expect(valid).toBe(true);
    expect(PublicKey.fromString(m.login!.k)).toBeTruthy();
    expect(Signature).toBeTruthy();
    // A rejoin's ready carries no signature either.
    const from = c.ws.sent.length;
    c.ws.deliver({ t: 'relay', peer: 'joined', role: 'site' });
    await settle();
    expect(c.ws.sent.slice(from).some((x) => x.includes('"sig"'))).toBe(false);
  });

  test('CTO 22 Nov (a): no return possible (a desktop QR, no ret) means no folded sign-in: the separate sheet', async () => {
    const c = await card(loginFields(), false, false);
    expect(c.p.returnPlan).toBeNull();
    expect(c.p.signIn).toBe(false);
  });

  test('an expired or malformed challenge is not signed: plain Connect', async () => {
    const c = await card(loginFields(-1000), true, true);
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

  test('the sign-in card names the account that will sign in (review 22 Nov, 5)', async () => {
    mem.set(`bwallet.name.${ROOT_ACCOUNT}`, 'b0asex');
    const c = await card(loginFields(), true, true);
    expect(c.p.signInAs).toBe('$b0asex');
    mem.delete(`bwallet.name.${ROOT_ACCOUNT}`);
  });

  test('a challenge that expires while the card is up is not signed (review 22 Nov, 3)', async () => {
    const c = await card(loginFields(300), true, true);
    expect(c.p.signIn).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    await c.p.confirm();
    await settle();
    const msgs = await sealedFrom(c.ws, c.siteSealer);
    expect((msgs.find((m) => m?.t === 'ready') as { login?: unknown })?.login).toBeUndefined();
  });

  test('the card closes when its code expires, and Connect after that does nothing (review 22 Nov, 3)', async () => {
    const c = await card({ e: Math.floor(Date.now() / 1000) + 1 });
    await new Promise((r) => setTimeout(r, 2100));
    expect(c.gone()).toBe(1);
    expect(await c.p.confirm()).toBeNull();
    expect(sessions.pairedSites().some((s) => s.c === c.link.c)).toBe(false);
  });

  test('review 3 (1): the wallet ignores origin proofs: a valid s2 never drops the "claims to be" warning', async () => {
    const c = await card(loginFields(), true, true);
    expect(c.p.proven).toBe(false);
    expect(c.p.returnPlan?.ret).toBe(`${HOST}/`);
  });

  test('review 3 (1): the one-tap sign-in needs only a return (no proof); the signature still goes only there', async () => {
    const c = await card(loginFields());
    expect(c.p.proven).toBe(false);
    expect(c.p.signIn).toBe(true);
    const r = await c.p.confirm();
    await settle();
    const msgs = await sealedFrom(c.ws, c.siteSealer);
    expect(msgs.some((m) => JSON.stringify(m).includes('"sig"'))).toBe(false);
    expect(r?.frame).toBeTruthy();
  });

  test('review 3 (2): a one-tap sign-in never arms the silent chat-key (BSM) follow-up over the relay', async () => {
    const lf = loginFields();
    const c = await card(lf);
    await c.p.confirm();
    await settle();
    const { loginMessage, takeBsmFollowUp } = await import('./pairLogin');
    const { MESSAGE_SIGNING_PROTOCOL } = await import('@1sat/types');
    const hash = BSM.magicHash(Utils.toArray(loginMessage(HOST, lf.ln, lf.lx), 'utf8'));
    const follow = takeBsmFollowUp(c.link.c, 'createSignature', {
      protocolID: MESSAGE_SIGNING_PROTOCOL,
      keyID: 'identity',
      counterparty: 'self',
      hashToDirectlySign: hash,
    });
    expect(follow).toBe(false); // it gets a sheet like any other signature
  });

  test('review 2 (6): the card signs with the account it opened under; another account open now refuses', async () => {
    const c = await card(loginFields(), true, true);
    sessions.setAgentPairDeps({
      ctx: { wallet: new ProtoWallet(root) } as never,
      currentId: '1AccountBBBBBBBBBBBBBBBBBBBBBBBBBB',
      accountCount: 2,
    });
    const r = await c.p.confirm();
    expect(r).toBeNull();
    expect(c.gone()).toBe(1);
    expect(sessions.pairedSites().some((s) => s.c === c.link.c)).toBe(false);
    sessions.setAgentPairDeps({
      ctx: { wallet: new ProtoWallet(root) } as never,
      currentId: ROOT_ACCOUNT,
      accountCount: 1,
    });
  });

  test('review 4 (L3, CTO): Android browser intents fold; iOS custom schemes never carry the sign-in', async () => {
    // Android: intent:// with an exact package from our own table goes only to that installed browser.
    sessions.setReturnPlatform('android');
    for (const b of ['chrome', 'firefox', 'samsung', 'edge', 'brave', 'opera'] as const) {
      const c = await card({ ...loginFields(), b });
      expect(c.p.signIn).toBe(true);
    }
    // iOS: googlechromes:// / firefox:// are custom schemes any app can register: no fold, the separate sheet.
    sessions.setReturnPlatform('ios');
    for (const b of ['chrome', 'firefox'] as const) {
      const c = await card({ ...loginFields(), b });
      expect(c.p.returnPlan).not.toBeNull(); // it still returns…
      expect(c.p.signIn).toBe(false); // …but the sign-in goes on the separate sheet
    }
    expect((await card({ ...loginFields(), b: 'safari' })).p.signIn).toBe(true); // plain https
    sessions.setReturnPlatform(null);
  });

  test('review 4 (L6): the signing wallet must be the card account; another identity refuses with a plain line', async () => {
    const c = await card(loginFields());
    let message: string | undefined;
    c.p.onGone((m) => (message = m));
    sessions.setAgentPairDeps({
      ctx: { wallet: new ProtoWallet(PrivateKey.fromRandom()) } as never,
      currentId: ROOT_ACCOUNT,
      accountCount: 1,
    });
    const r = await c.p.confirm();
    expect(r).toBeNull();
    expect(message).toBe(sessions.PAIR_ACCOUNT_CHANGED_MESSAGE);
    expect(sessions.pairedSites().some((s) => s.c === c.link.c)).toBe(false);
    sessions.setAgentPairDeps({
      ctx: { wallet: new ProtoWallet(root) } as never,
      currentId: ROOT_ACCOUNT,
      accountCount: 1,
    });
  });

  afterAll(() => {
    for (const s of sessions.pairedSites()) sessions.forget(s.c, false);
  });
});
