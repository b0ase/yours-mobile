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
      forward: { from: 'boase@bwalletx.com', to: 'b0asex@bwalletx.com', expiresAt: null },
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
      forward: { from: 'boase@bwalletx.com', to: 'b0asex@bwalletx.com', expiresAt: null },
    });
    const r = await resolveRecipient(f, parseRecipient('boase@bwallet.space'));
    expect(r.nameBinding).toBe('changed');
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: KEY_CHANGED });
  });
});
