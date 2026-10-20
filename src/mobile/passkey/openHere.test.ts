import { describe, expect, test } from 'bun:test';
import { BSM, Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';
import {
  beginOpenHere,
  startOpenSession,
  checkOpenProof,
  deriveOpen,
  newOpenCode,
  normaliseOpenCode,
  openProof,
  isWalletOrigin,
  OPEN_LIFETIME_S,
  openOpen,
  openUrl,
  parseOpenUrl,
  sealOpen,
  type OpenFrame,
  type OpenLink,
} from './openHere';
import { fetchBackup, putMessage, signedPut } from './passkeyServer';
import { b64url, sealSeed } from './seedBackup';

const NOW = 1_800_000_000;
const channel = 'AAAAAAAAAAAAAAAAAAAAAA';
const computer = PrivateKey.fromRandom();
const phone = PrivateKey.fromRandom();
const link = (o: Partial<OpenLink> = {}): OpenLink => ({
  v: '2',
  r: 'relay.bwallet.space',
  c: channel,
  k: computer.toPublicKey().toString(),
  o: 'https://web.bwalletx.com',
  e: NOW + OPEN_LIFETIME_S,
  ...o,
});

describe('open on computer: QR', () => {
  test('carries only public data and parses back', () => {
    const u = openUrl(link());
    expect(u).toContain('/open?');
    expect(u).not.toMatch(/words|mnemonic|wif/i);
    expect(parseOpenUrl(u, NOW)).toEqual(link());
  });
  test('refuses non-bWalletX origins (and lookalikes)', () => {
    for (const o of [
      'https://evil.example',
      'https://bwalletx.com.evil.example',
      'http://web.bwalletx.com',
      'https://notbwalletx.com',
    ])
      expect(() => parseOpenUrl(openUrl(link({ o })), NOW)).toThrow();
    expect(isWalletOrigin('https://desktop.bwalletx.com')).toBe(true);
    expect(isWalletOrigin('https://web.bwalletx.com')).toBe(true);
    // Only the two wallet hosts: no wildcard over the rest of the family (review 20 Oct 2026).
    for (const o of [
      'https://auth.bwalletx.com',
      'https://push.bwalletx.com',
      'https://agents.bwalletx.com',
      'https://games.bwalletx.com',
      'https://anything.bwalletx.com',
      'https://bwalletx.com',
      'https://www.bwalletx.com',
      'https://web.bwalletx.com.evil.example',
      'https://web.bwalletx.com:8443',
    ])
      expect(isWalletOrigin(o)).toBe(false);
    expect(isWalletOrigin('http://localhost:4797')).toBe(false);
    expect(isWalletOrigin('http://localhost:4797', true)).toBe(true);
  });
  test('expires after 2 minutes and refuses a too-long expiry', () => {
    expect(() => parseOpenUrl(openUrl(link()), NOW + OPEN_LIFETIME_S + 1)).toThrow('expired');
    expect(() => parseOpenUrl(openUrl(link({ e: NOW + 3600 })), NOW)).toThrow();
  });
});

describe('open on computer: crypto', () => {
  test('both sides get the same keys; the sealed frame opens only with them', async () => {
    const a = await deriveOpen(phone, computer.toPublicKey().toString(), channel);
    const b = await deriveOpen(computer, phone.toPublicKey().toString(), channel);
    const f = await sealOpen(a.key, channel, { t: 'wallet', words: 'one two three', exp: NOW + 60, code: '123456' });
    expect(JSON.stringify(f)).not.toContain('one two');
    expect((await openOpen(b.key, channel, f, NOW)).words).toBe('one two three');
    expect(await checkOpenProof(a.macKey, channel, '123456', await openProof(b.macKey, channel, '123 456'))).toBe(true);
  });
  test('a man in the middle cannot open the payload or make a proof', async () => {
    const mitm = PrivateKey.fromRandom();
    const phoneSide = await deriveOpen(phone, mitm.toPublicKey().toString(), channel);
    const computerSide = await deriveOpen(computer, phone.toPublicKey().toString(), channel);
    const f = await sealOpen(phoneSide.key, channel, { t: 'wallet', words: 'x y z', exp: NOW + 60, code: '123456' });
    await expect(openOpen(computerSide.key, channel, f, NOW)).rejects.toThrow();
    const pr = await openProof(computerSide.macKey, channel, '123456');
    expect(await checkOpenProof(phoneSide.macKey, channel, '123456', pr)).toBe(false);
  });
  test('the proof is bound to the code and the channel', async () => {
    const a = await deriveOpen(phone, computer.toPublicKey().toString(), channel);
    const b = await deriveOpen(computer, phone.toPublicKey().toString(), channel);
    expect(await checkOpenProof(a.macKey, channel, '123456', await openProof(b.macKey, channel, '123457'))).toBe(false);
    expect(
      await checkOpenProof(a.macKey, channel, '123456', await openProof(b.macKey, 'BBBBBBBBBBBBBBBBBBBBBB', '123456')),
    ).toBe(false);
    expect(await checkOpenProof(a.macKey, channel, '123456', { m: 'garbage' })).toBe(false);
    expect(await checkOpenProof(a.macKey, channel, '123456', {})).toBe(false);
  });
  test('codes are 6 random digits', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newOpenCode();
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(190);
    expect(normaliseOpenCode('123 456')).toBe('123456');
    expect(normaliseOpenCode('12345')).toBe('');
  });
  test('bound to its channel and refused after expiry', async () => {
    const a = await deriveOpen(phone, computer.toPublicKey().toString(), channel);
    const b = await deriveOpen(computer, phone.toPublicKey().toString(), channel);
    const f = await sealOpen(a.key, channel, { t: 'wallet', words: 'a b c', exp: NOW + 60, code: '123456' });
    await expect(openOpen(b.key, 'BBBBBBBBBBBBBBBBBBBBBB', f, NOW)).rejects.toThrow();
    await expect(openOpen(b.key, channel, f, NOW + 61)).rejects.toThrow('Expired');
  });
});

/** A stand-in relay socket: the test plays the relay + the computer (or an attacker posing as one). */
class FakeSocket {
  static last: FakeSocket;
  sent: string[] = [];
  closed = false;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(d: string) {
    if (!this.closed) this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  async deliver(o: unknown) {
    await this.onmessage?.({ data: JSON.stringify(o) } as MessageEvent);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('open on computer: phone session (audit C2)', () => {
  const realWs = globalThis.WebSocket;
  const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const run = async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    const now = Math.floor(Date.now() / 1000);
    // The attacker made this QR, so it knows k's private key, and it forges the relay Origin.
    const s = beginOpenHere(openUrl(link({ e: now + OPEN_LIFETIME_S })));
    const ws = FakeSocket.last;
    await ws.deliver({ t: 'relay', verifiedOrigin: 'https://web.bwalletx.com' });
    const session = await s;
    const hello = JSON.parse(ws.sent[0]) as { t: string; k: string };
    expect(hello.t).toBe('hello');
    const keys = await deriveOpen(computer, hello.k, channel);
    return { session, ws, keys };
  };
  const frames = (ws: FakeSocket) => ws.sent.map((d) => JSON.parse(d) as { t: string });

  test('an attacker who knows only the QR + relay traffic cannot get the words sealed', async () => {
    try {
      const { session, ws, keys } = await run();
      // Nothing it has seen depends on the phone's code: the hello is the phone's public key only.
      expect(ws.sent.join()).not.toContain(session.code.replace(' ', ''));
      // Its one guess is wrong (1 in 10^6) and the session dies.
      const guess = session.code.replace(' ', '') === '000000' ? '000001' : '000000';
      await ws.deliver(await openProof(keys.macKey, channel, guess));
      await expect(session.confirmed).rejects.toThrow('wrong code');
      expect(ws.closed).toBe(true);
      // Even with the right code afterwards, and even if the UI called send, nothing is sealed.
      await ws.deliver(await openProof(keys.macKey, channel, session.code));
      await expect(session.send(WORDS)).rejects.toThrow();
      expect(frames(ws).filter((f) => f.t === 'open')).toHaveLength(0);
    } finally {
      globalThis.WebSocket = realWs;
    }
  });

  test('send refuses before any proof (Face ID first is not enough)', async () => {
    try {
      const { session, ws } = await run();
      await expect(session.send(WORDS)).rejects.toThrow('code');
      expect(frames(ws).filter((f) => f.t === 'open')).toHaveLength(0);
      session.cancel();
    } finally {
      globalThis.WebSocket = realWs;
    }
  });

  test('the computer that was told the code gets the words, once', async () => {
    try {
      const { session, ws, keys } = await run();
      await ws.deliver(await openProof(keys.macKey, channel, session.code));
      await session.confirmed;
      await session.send(WORDS, 'Main');
      const open = frames(ws).filter((f) => f.t === 'open') as OpenFrame[];
      expect(open).toHaveLength(1);
      expect((await openOpen(keys.key, channel, open[0])).words).toBe(WORDS);
      await expect(session.send(WORDS)).rejects.toThrow();
    } finally {
      globalThis.WebSocket = realWs;
    }
  });

  test('a mismatched relay origin is still refused (hint only, never shown as verified)', async () => {
    try {
      globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
      const s = beginOpenHere(openUrl(link({ e: Math.floor(Date.now() / 1000) + OPEN_LIFETIME_S })));
      const refused = s.then(
        () => null,
        (e: Error) => e.message,
      );
      await FakeSocket.last.deliver({ t: 'relay', verifiedOrigin: 'https://evil.example' });
      expect(await refused).toContain("wasn't shown by bWalletX");
    } finally {
      globalThis.WebSocket = realWs;
    }
  });
});

describe('open on computer: the computer binds the wallet to the code it was typed (review 20 Oct 2026)', () => {
  const realWs = globalThis.WebSocket;
  const realLoc = (globalThis as { location?: unknown }).location;
  const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const setup = async () => {
    globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
    (globalThis as { location?: unknown }).location = { origin: 'https://web.bwalletx.com' };
    const got: { wallet?: string; error?: string } = {};
    const s = startOpenSession({
      onJoined: () => undefined,
      onWallet: (p) => (got.wallet = p.words),
      onExpired: () => undefined,
      onError: (m) => (got.error = m),
    });
    const ws = FakeSocket.last;
    const url = new URL(s.url);
    const k = url.searchParams.get('k') as string;
    const c = url.searchParams.get('c') as string;
    // Whoever joins first as the "phone" (here: an attacker who saw the QR) says hello with its own key.
    const intruder = PrivateKey.fromRandom();
    await ws.deliver({ t: 'hello', k: intruder.toPublicKey().toString() });
    const keys = await deriveOpen(intruder, k, c);
    return { s, ws, got, keys, c };
  };
  const restore = () => {
    globalThis.WebSocket = realWs;
    (globalThis as { location?: unknown }).location = realLoc;
  };

  test('a wallet sealed with a code other than the typed one is refused', async () => {
    try {
      const { s, ws, got, keys, c } = await setup();
      expect(await s.submitCode('111111')).toBe(true);
      const exp = Math.floor(Date.now() / 1000) + 60;
      await ws.deliver(await sealOpen(keys.key, c, { t: 'wallet', words: WORDS, exp, code: '999999' }));
      expect(got.wallet).toBeUndefined();
      expect(got.error).toContain("didn't come from your phone");
    } finally {
      restore();
    }
  });

  test('a wallet frame with no code at all is refused', async () => {
    try {
      const { s, ws, got, keys, c } = await setup();
      await s.submitCode('111111');
      const exp = Math.floor(Date.now() / 1000) + 60;
      await ws.deliver(await sealOpen(keys.key, c, { t: 'wallet', words: WORDS, exp } as never));
      expect(got.wallet).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('the phone that made the typed code is accepted', async () => {
    try {
      const { s, ws, got, keys, c } = await setup();
      await s.submitCode('111 111');
      const exp = Math.floor(Date.now() / 1000) + 60;
      await ws.deliver(await sealOpen(keys.key, c, { t: 'wallet', words: WORDS, exp, code: '111111' }));
      expect(got.wallet).toBe(WORDS);
    } finally {
      restore();
    }
  });
});

describe('server backup store client', () => {
  test('signed upload verifies against the identity key and binds the blob', async () => {
    const id = PrivateKey.fromRandom();
    const blob = await sealSeed('one two three', new Uint8Array(32).fill(1), {
      rpId: 'bwalletx.com',
      credentialId: b64url(new Uint8Array(16).fill(5)),
    });
    const body = signedPut(blob, id.toWif(), 1234);
    expect(body.identity_key).toBe(id.toPublicKey().toString());
    const hash = Utils.toHex(Hash.sha256(Utils.toArray(JSON.stringify(blob), 'utf8')));
    const msg = Utils.toArray(putMessage(blob.credentialId, hash, 1234), 'utf8');
    expect(
      BSM.verify(msg, Signature.fromCompact(body.signature, 'base64'), PublicKey.fromString(body.identity_key)),
    ).toBe(true);
    const other = Utils.toArray(putMessage(blob.credentialId, '00'.repeat(32), 1234), 'utf8');
    expect(
      BSM.verify(other, Signature.fromCompact(body.signature, 'base64'), PublicKey.fromString(body.identity_key)),
    ).toBe(false);
  });
  test('fetch returns only a valid blob for the asked credential id', async () => {
    const blob = await sealSeed('one two three', new Uint8Array(32).fill(1), {
      rpId: 'bwalletx.com',
      credentialId: b64url(new Uint8Array(16).fill(5)),
    });
    const ok = (async () => new Response(JSON.stringify({ blob }))) as unknown as typeof fetch;
    expect((await fetchBackup(blob.credentialId, ok))?.ct).toBe(blob.ct);
    expect(await fetchBackup('somethingElse_123456', ok)).toBeNull();
    const nf = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchBackup(blob.credentialId, nf)).toBeNull();
  });
});

describe('"your phone has it" ping', () => {
  test('fingerprint is stable, normalised and does not reveal the words', async () => {
    const { walletFingerprint } = await import('./openHere');
    const a = await walletFingerprint('Abandon  ability able');
    expect(a).toBe(await walletFingerprint('abandon ability able'));
    expect(a).not.toBe(await walletFingerprint('abandon ability about'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  test('ping params are validated and expire', async () => {
    const { parsePing, pingQuery, RESTORED_LIFETIME_S } = await import('./openHere');
    const p = { r: 'relay.bwallet.space', c: channel, k: computer.toPublicKey().toString(), e: NOW + 100 };
    expect(parsePing('?passkey=1' + pingQuery(p), NOW)).toEqual(p);
    expect(parsePing('?passkey=1' + pingQuery(p), NOW + 101)).toBeNull();
    expect(parsePing('?passkey=1' + pingQuery({ ...p, e: NOW + RESTORED_LIFETIME_S + 3600 }), NOW)).toBeNull();
    expect(parsePing('?passkey=1' + pingQuery({ ...p, k: 'nope' }), NOW)).toBeNull();
    expect(parsePing('?passkey=1', NOW)).toBeNull();
  });
  test('restored-ping keys are separate from open-on-computer keys', async () => {
    const { RESTORED_INFO } = await import('./openHere');
    const a = await deriveOpen(phone, computer.toPublicKey().toString(), channel);
    const b = await deriveOpen(phone, computer.toPublicKey().toString(), channel, RESTORED_INFO);
    const f = await sealOpen(a.key, channel, { t: 'wallet', words: 'x', exp: NOW + 60, code: '123456' });
    await expect(openOpen(b.key, channel, f, NOW)).rejects.toThrow();
  });
});

describe('biometric confirm', () => {
  test('is unavailable (password fallback) where biometric unlock was never set up', async () => {
    const { confirmWithBiometrics } = await import('../biometricUnlock');
    expect(await confirmWithBiometrics('test')).toBe('unavailable');
  });
});
