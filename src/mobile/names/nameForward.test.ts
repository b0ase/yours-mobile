import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { trustCurrentKey } from './binding';
import {
  KEY_CHANGED,
  NAME_MISMATCH,
  destinationFor,
  forwardLabel,
  forwardTarget,
  parseRecipient,
  resolveRecipient,
  type Fetch,
} from './names';
import { signRequest } from './paymail';

// boase@ served as b0asex@ (owner, 28 Oct 2026): a forward is said out loud; a silent swap is never paid.
const wallet = (n: number) => {
  const priv = new PrivateKey(n);
  return Object.assign(new ProtoWallet(priv), { key: priv.toPublicKey().toString() });
};
const bindingFrom = async (w: ReturnType<typeof wallet>, alias: string, seq: number) => {
  const r = await signRequest(w, 'bind', { alias, seq: String(seq) });
  return { alias, identityKey: r.identityKey, seq, timestamp: String(r.timestamp), signature: r.signature };
};
// A forward signed by the typed name's owner (key `w`), with that name's own binding riding along.
const signedForward = async (
  w: ReturnType<typeof wallet>,
  from: string,
  to: string,
  expiresAt: number | string | null,
  over: Record<string, unknown> = {},
) => {
  const r = await signRequest(w, 'forward', {
    from,
    to,
    expiresAt: expiresAt === null ? '' : String(expiresAt),
  });
  return {
    from: `${from}@bwalletx.com`,
    to: `${to}@bwalletx.com`,
    expiresAt,
    identityKey: r.identityKey,
    timestamp: String(r.timestamp),
    signature: r.signature,
    fromBinding: await bindingFrom(w, from, 1),
    ...over,
  };
};
const OURS = {
  capabilities: {
    pki: 'https://pay.bwallet.space/api/paymail/id/{alias}@{domain.tld}',
    '2a40af698840': 'https://pay.bwallet.space/api/p2p/{alias}@{domain.tld}',
    '5c55a7fdb7bb': 'https://pay.bwallet.space/api/beef/{alias}@{domain.tld}',
  },
};
const host = (id: unknown): Fetch => {
  const routes: Record<string, unknown> = {
    'https://dns.google.com/resolve?name=_bsvalias._tcp.bwallet.space': { Status: 3 },
    'https://bwallet.space/.well-known/bsvalias': OURS,
    'https://pay.bwallet.space/api/paymail/id/': id,
  };
  return async (url) => {
    const hit = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    return hit === undefined
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(routes[hit]), { status: 200 });
  };
};

describe('forwarded names', () => {
  const mem = new Map<string, string>();
  const real = globalThis.localStorage;
  beforeAll(() => {
    globalThis.localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });
  afterAll(() => {
    globalThis.localStorage = real;
  });

  test('forwardTarget accepts only a forward from the typed name to another name', () => {
    expect(forwardTarget('boase', { from: 'boase@bwalletx.com', to: 'b0asex@bwalletx.com' })).toBe('b0asex');
    expect(forwardTarget('boase', { from: 'other@bwalletx.com', to: 'b0asex@bwalletx.com' })).toBeUndefined();
    expect(forwardTarget('boase', { from: 'boase@bwalletx.com', to: 'boase@bwalletx.com' })).toBeUndefined();
    expect(forwardTarget('boase', null)).toBeUndefined();
  });

  test('a declared forward with the target signed pays, and says "forwards to … (same owner)"', async () => {
    mem.clear();
    const owner = wallet(41);
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'b0asex', 1),
      forward: await signedForward(owner, 'boase', 'b0asex', null),
    });
    const r = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(r.forwardsTo).toBe('b0asex');
    expect(r.nameBinding).toBe('signed');
    expect(forwardLabel(r)).toBe('boase@ forwards to b0asex@ (same owner)');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
  });

  test('another name served with no forward is a mismatch: never paid, clear message', async () => {
    mem.clear();
    const owner = wallet(42);
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'b0asex', 1),
    });
    const r = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(r.forwardsTo).toBeUndefined();
    expect(r.nameBinding).toBe('mismatch');
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: NAME_MISMATCH });
  });

  test('a forward never weakens the key-change stop on the typed name', async () => {
    mem.clear();
    const was = wallet(43);
    const now = wallet(44);
    trustCurrentKey('boase', was.key); // paid boase@ before, at another key
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: now.key,
      binding: await bindingFrom(now, 'b0asex', 1),
      forward: await signedForward(was, 'boase', 'b0asex', null),
    });
    const r = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(r.nameBinding).toBe('changed');
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: KEY_CHANGED });
  });

  // The attack: a hostile host serves the attacker's name (and key) for a well-bound typed name.
  const attack = async (
    forward: (victim: ReturnType<typeof wallet>, attacker: ReturnType<typeof wallet>) => unknown,
  ) => {
    mem.clear();
    const victim = wallet(51);
    const attacker = wallet(52);
    const f = host({
      handle: 'mallory@bwalletx.com',
      pubkey: attacker.key,
      binding: await bindingFrom(attacker, 'mallory', 1),
      forward: await forward(victim, attacker),
    });
    return resolveRecipient(f, parseRecipient('boase@bwallet.space'));
  };
  const refused = (r: Awaited<ReturnType<typeof attack>>) => {
    expect(r.forwardsTo).toBeUndefined();
    expect(forwardLabel(r)).toBeUndefined();
    expect(r.nameBinding).toBe('mismatch');
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: NAME_MISMATCH });
    expect(JSON.parse(mem.get('bwallet.names.seenKeys') ?? '{}')).toEqual({}); // nothing pinned
  };

  test('an unsigned forward is ignored: the typed name is checked and the swap refuses', async () => {
    refused(await attack(() => ({ from: 'boase@bwalletx.com', to: 'mallory@bwalletx.com', expiresAt: null })));
  });

  test("a forward signed by the attacker, not the typed name's owner, refuses", async () => {
    refused(
      await attack(async (victim, attacker) =>
        signedForward(attacker, 'boase', 'mallory', null, { fromBinding: await bindingFrom(victim, 'boase', 1) }),
      ),
    );
  });

  test('an expired forward refuses', async () => {
    refused(await attack((victim) => signedForward(victim, 'boase', 'mallory', Date.now() - 1000)));
  });

  test('a forward whose signed target differs from the served one refuses', async () => {
    refused(
      await attack((victim) =>
        signedForward(victim, 'boase', 'mallory', null, { to: 'mallory@bwalletx.com', signature: '00' }),
      ),
    );
    refused(
      await attack(async (victim) => ({
        ...(await signedForward(victim, 'boase', 'someoneelse', null)),
        to: 'mallory@bwalletx.com',
      })),
    );
  });

  test('a signed forward that has not expired is followed', async () => {
    mem.clear();
    const owner = wallet(53);
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'b0asex', 1),
      forward: await signedForward(owner, 'boase', 'b0asex', Date.now() + 60_000),
    });
    const r = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(r.forwardsTo).toBe('b0asex');
    expect(forwardLabel(r)).toBe('boase@ forwards to b0asex@ (same owner)');
  });

  // Review fix: confirm() saves the TARGET's key under the typed name; the next resolve must still follow the forward.
  test('a forward between two different keys still pays after the payer confirmed it once', async () => {
    mem.clear();
    const old = wallet(56); // boase@'s owner key, signs the forward
    const now = wallet(57); // b0asex@'s key, the one paid
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: now.key,
      binding: await bindingFrom(now, 'b0asex', 1),
      forward: await signedForward(old, 'boase', 'b0asex', null),
    });
    const first = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(first.forwardsTo).toBe('b0asex');
    expect(first.nameBinding).toBe('signed');
    trustCurrentKey('boase', first.pubkey as string); // what NameInput confirm() remembers
    const again = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(again.forwardsTo).toBe('b0asex');
    expect(again.nameBinding).toBe('signed');
    expect(destinationFor(again, 'bsv').ok).toBe(true);
  });

  test('a remembered key that is neither the signer nor the served key still refuses', async () => {
    mem.clear();
    const known = wallet(58);
    const old = wallet(59);
    const now = wallet(60);
    trustCurrentKey('boase', known.key);
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: now.key,
      binding: await bindingFrom(now, 'b0asex', 1),
      forward: await signedForward(old, 'boase', 'b0asex', null),
    });
    const r = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(r.forwardsTo).toBeUndefined();
    expect(r.nameBinding).toBe('mismatch');
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: NAME_MISMATCH });
  });

  test('expiresAt "" means no expiry (signed as ""), like null', async () => {
    mem.clear();
    const owner = wallet(61);
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'b0asex', 1),
      forward: await signedForward(owner, 'boase', 'b0asex', ''),
    });
    const r = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(r.forwardsTo).toBe('b0asex');
    expect(forwardLabel(r)).toBe('boase@ forwards to b0asex@ (same owner)');
  });

  test('expiresAt as a future ISO string is followed; a past one refuses', async () => {
    mem.clear();
    const owner = wallet(62);
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'b0asex', 1),
      forward: await signedForward(owner, 'boase', 'b0asex', new Date(Date.now() + 60_000).toISOString()),
    });
    expect((await resolveRecipient(f, parseRecipient('boase@bwallet.space'))).forwardsTo).toBe('b0asex');
    refused(
      await attack((victim) => signedForward(victim, 'boase', 'mallory', new Date(Date.now() - 1000).toISOString())),
    );
  });

  test('a forward whose typed-name key is not the one this wallet knows refuses', async () => {
    mem.clear();
    const known = wallet(54);
    const owner = wallet(55);
    trustCurrentKey('boase', known.key);
    const f = host({
      handle: 'b0asex@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'b0asex', 1),
      forward: await signedForward(owner, 'boase', 'b0asex', null),
    });
    const r = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(r.forwardsTo).toBeUndefined();
    expect(r.nameBinding).toBe('mismatch');
  });
});
