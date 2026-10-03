import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { Sealer, deriveSession, newChannel, pairUrl, parsePairUrl, relaySocketUrl } from './protocol';

describe('pairing protocol', () => {
  test('both sides derive the same key and code; frames round-trip', async () => {
    const c = newChannel();
    const S = PrivateKey.fromRandom();
    const P = PrivateKey.fromRandom();
    const site = await deriveSession(S, P.toPublicKey().toString(), c);
    const phone = await deriveSession(P, S.toPublicKey().toString(), c);
    expect(site.code).toMatch(/^\d{4}$/);
    expect(site.code).toBe(phone.code);
    const toPhone = new Sealer(site.key, 'site');
    const atPhone = new Sealer(phone.key, 'wallet');
    const f = await toPhone.seal({ t: 'req', id: '1', action: 'getPublicKey', params: { identityKey: true } });
    expect(await atPhone.open(f)).toEqual({ t: 'req', id: '1', action: 'getPublicKey', params: { identityKey: true } });
    // replay dropped
    expect(await atPhone.open(f)).toBeNull();
    // reflection (a site frame bounced back to the site) fails the AAD
    const toSite = new Sealer(site.key, 'site');
    const own = await toSite.seal({ t: 'ping' });
    expect(await new Sealer(site.key, 'site').open(own)).toBeNull();
    // tamper
    const g = await toPhone.seal({ t: 'ping' });
    expect(await atPhone.open({ ...g, d: g.d.slice(0, -4) + 'AAAA' })).toBeNull();
  });

  test('different channel → different code', async () => {
    const S = PrivateKey.fromRandom();
    const P = PrivateKey.fromRandom();
    const a = await deriveSession(S, P.toPublicKey().toString(), newChannel());
    const b = await deriveSession(S, P.toPublicKey().toString(), newChannel());
    expect(a.code === b.code && a.key === b.key).toBe(false);
  });

  test('pair links: build, parse, reject', () => {
    const k = PrivateKey.fromRandom().toPublicKey().toString();
    const e = Math.floor(Date.now() / 1000) + 120;
    const link = { v: '1', r: 'relay.bwallet.space', c: newChannel(), k, o: 'https://tokenblaster.lol', e };
    expect(parsePairUrl(pairUrl(link))).toEqual(link);
    expect(() => parsePairUrl('https://evil.example/pair?v=1')).toThrow();
    expect(() => parsePairUrl(pairUrl({ ...link, e: 10 }))).toThrow(/expired/);
    expect(() => parsePairUrl(pairUrl({ ...link, o: 'https://a.lol/path' }))).toThrow();
    expect(relaySocketUrl('relay.bwallet.space', link.c, 'site', e)).toBe(
      `wss://relay.bwallet.space/v1/c/${link.c}?role=site&e=${e}`,
    );
  });

  test('large frames (a signed transaction with its proofs) round-trip', async () => {
    const c = newChannel();
    const S = PrivateKey.fromRandom();
    const P = PrivateKey.fromRandom();
    const site = await deriveSession(S, P.toPublicKey().toString(), c);
    const phone = await deriveSession(P, S.toPublicKey().toString(), c);
    const tx = Array.from({ length: 400_000 }, (_, i) => i % 256);
    const f = await new Sealer(phone.key, 'wallet').seal({ t: 'res', id: '9', result: { txid: 'ab', tx } });
    const back = (await new Sealer(site.key, 'site').open(f)) as { result: { tx: number[] } };
    expect(back.result.tx.length).toBe(400_000);
  });
});
