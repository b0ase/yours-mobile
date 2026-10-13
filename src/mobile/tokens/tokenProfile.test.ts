import { afterEach, describe, expect, it } from 'vitest';
import { BSM, PrivateKey } from '@bsv/sdk';
import { parseLinks, parseUtility } from './linkData';
import {
  bsmSigner,
  clearTokenProfileCache,
  fetchTokenProfile,
  pickProfile,
  verifyProfile,
  type ProfileCandidate,
} from './tokenProfile';

// Real $NPG profile on mainnet: a2d8bae1…fc7f_0, exact bytes from ordfs.network, signature from its MAP fields.
const NPG_ID = 'b8747a4b356875cc90842c733ad2770b12bf50c17cf204afd0605f9dcba67d31_1';
const NPG_ISSUER = '1sPzWgCv5ftiv2VtJAspLYgz6bUtrgtVj';
const NPG_CONTENT =
  '{"p":"bsv-21-profile","id":"b8747a4b356875cc90842c733ad2770b12bf50c17cf204afd0605f9dcba67d31_1","v":1,"name":"Ninja Punk Girls","website":"https://www.ninjapunkgirls.com","app":"https://www.tokenblaster.lol/arcade/npg-arena","x":"https://x.com/NinjaPunkGirls","telegram":"https://t.me/ninjapunkgirls","utility":"Entry to the $NPG room. Used in Ninja Punk Girls games and the card market."}';
const NPG_SIG = 'IJZ9XgaiArdIdK9WT2Bbd6FX22rybdBxY6On5MQDHFi8EM9iMVdBMKsIj6i14zgKqS52pYLV4TNw2sLtgycSOhY=';
const NPG: ProfileCandidate = {
  outpoint: 'a2d8bae1fceb19d6f4814b6ccd8aff112e3c95b812c86221e5a07fd4e246fc7f_0',
  content: NPG_CONTENT,
  aipAddress: NPG_ISSUER,
  aipSig: NPG_SIG,
};

const signed = (key: PrivateKey, body: Record<string, unknown>): ProfileCandidate => {
  const content = JSON.stringify(body);
  const sig = BSM.sign(Array.from(new TextEncoder().encode(content)), key, 'base64') as string;
  return { outpoint: `${'0'.repeat(64)}_0`, content, aipAddress: key.toAddress(), aipSig: sig };
};

describe('token profile verification', () => {
  it('verifies the real $NPG profile signature', () => {
    expect(bsmSigner(NPG_CONTENT, NPG_SIG)).toBe(NPG_ISSUER);
    const p = verifyProfile(NPG, NPG_ID, NPG_ISSUER)!;
    expect(p.v).toBe(1);
    expect(parseLinks(p).map((l) => [l.kind, l.label])).toEqual([
      ['website', 'ninjapunkgirls.com'],
      ['app', 'tokenblaster.lol'],
      ['x', 'x.com'],
      ['telegram', 't.me'],
    ]);
    expect(parseUtility(p)).toMatch(/^Entry to the \$NPG room/);
  });

  it('rejects tampered content', () => {
    const bad = { ...NPG, content: NPG_CONTENT.replace('ninjapunkgirls.com', 'evil.com') };
    expect(verifyProfile(bad, NPG_ID, NPG_ISSUER)).toBeNull();
  });

  it('rejects a wrong signer, whether or not it claims the issuer address', () => {
    const other = PrivateKey.fromRandom();
    const own = signed(other, { p: 'bsv-21-profile', id: NPG_ID, v: 9, website: 'https://evil.com' });
    expect(verifyProfile(own, NPG_ID, NPG_ISSUER)).toBeNull();
    expect(verifyProfile({ ...own, aipAddress: NPG_ISSUER }, NPG_ID, NPG_ISSUER)).toBeNull();
    expect(pickProfile([NPG, own], NPG_ID, NPG_ISSUER)?.v).toBe(1);
  });

  it('rejects a profile for another token or with a missing signature', () => {
    expect(verifyProfile(NPG, `${'a'.repeat(64)}_0`, NPG_ISSUER)).toBeNull();
    expect(verifyProfile({ ...NPG, aipSig: undefined }, NPG_ID, NPG_ISSUER)).toBeNull();
  });

  it('picks the highest valid v and drops excluded fields', () => {
    const key = PrivateKey.fromRandom();
    const issuer = key.toAddress();
    const id = `${'b'.repeat(64)}_1`;
    const v1 = signed(key, { p: 'bsv-21-profile', id, v: 1, website: 'https://one.io' });
    const v3 = signed(key, { p: 'bsv-21-profile', id, v: 3, website: 'https://three.io', dividend: '5%', shares: 1 });
    const v2 = signed(key, { p: 'bsv-21-profile', id, v: 2, website: 'https://two.io' });
    const p = pickProfile([v1, v3, v2], id, issuer)!;
    expect(p.v).toBe(3);
    expect(p.website).toBe('https://three.io');
    expect(p).not.toHaveProperty('dividend');
    expect(p).not.toHaveProperty('shares');
  });

  it('drops a utility line with returns wording', () => {
    const key = PrivateKey.fromRandom();
    const id = `${'c'.repeat(64)}_0`;
    const c = signed(key, { p: 'bsv-21-profile', id, v: 1, utility: 'Guaranteed 10x returns' });
    expect(verifyProfile(c, id, key.toAddress())).not.toHaveProperty('utility');
  });
});

describe('token profile discovery', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearTokenProfileCache();
  });

  it('finds the issuer, lists its profile inscriptions, verifies exact ORDFS bytes', async () => {
    const urls: string[] = [];
    const txo = {
      outpoint: NPG.outpoint,
      data: {
        map: { app: 'npg', type: 'bsv-21-profile', aip_address: NPG_ISSUER, aip_sig: NPG_SIG },
        insc: { file: { type: 'application/json' }, json: JSON.parse(NPG_CONTENT) },
      },
    };
    globalThis.fetch = (async (input: string | URL) => {
      const u = String(input);
      urls.push(u);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (u.endsWith(`/txos/${NPG_ID}`)) return json({ owner: NPG_ISSUER });
      if (u.includes(`/txos/address/${NPG_ISSUER}/unspent`)) return json([txo]);
      if (u.includes(`/txos/address/${NPG_ISSUER}/history`)) return json([]);
      if (u === `https://ordfs.network/${NPG.outpoint}`) return new Response(NPG_CONTENT, { status: 200 });
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const p = await fetchTokenProfile(NPG_ID);
    expect(p?.website).toBe('https://www.ninjapunkgirls.com');
    expect(urls.some((u) => u.includes('/unspent?q='))).toBe(true);
    // Cached: a second read makes no new requests.
    const n = urls.length;
    await fetchTokenProfile(NPG_ID);
    expect(urls.length).toBe(n);
  });
});
