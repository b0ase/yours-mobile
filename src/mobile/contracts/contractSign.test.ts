/**
 * Owner, 14 Nov 2026 (b-Aware row 115): "paid contract listing need an author's signature". The wallet's own publish
 * signs the envelope with the account's identity key under a reserved protocol; a paid buy refuses anything not
 * signed by author.identityKey; the author is shown as the $name whose signed binding points at that key, else the
 * short key, never the typed name.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { isReservedProtocol } from '../../services/reservedProtocols';
import {
  CONTRACT_ENVELOPE_FORMAT,
  CONTRACT_SIGN_PROTOCOL,
  contractAuthorKey,
  signContractEnvelope,
  type ContractEnvelope,
} from './contractNft';

// contractAuthorLabel resolves the signed handle through names.ts: answer it here, then put the real module back.
const realNames = { ...(await import('../names/names')) };
let resolved: { pubkey?: string; nameBinding?: string } | Error = new Error('offline');
mock.module('../names/names', () => ({
  ...realNames,
  resolvePaymail: async () => {
    if (resolved instanceof Error) throw resolved;
    return resolved;
  },
}));
afterAll(() => {
  mock.module('../names/names', () => realNames);
});
const { contractAuthorLabel } = await import('./market');

const asWallet = (w: ProtoWallet) => ({
  getPublicKey: () => w.getPublicKey({ identityKey: true }),
  createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => w.createSignature(a),
});
const ann = new ProtoWallet(PrivateKey.fromRandom());
const mallory = new ProtoWallet(PrivateKey.fromRandom());
const keyOf = async (w: ProtoWallet) => (await w.getPublicKey({ identityKey: true })).publicKey;
const base = {
  format: CONTRACT_ENVELOPE_FORMAT,
  contract: { format: 'bwalletx.contract/1', name: 'NDA', version: '1', network: 'mainnet', summary: 's' },
  description: 'A plain NDA',
  author: { name: 'Ann Lawyer', address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' },
  sale: { priceUsd: 5, copies: 10, payTo: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT' },
} as ContractEnvelope;
const f = (() => Promise.reject(new Error('no network'))) as never;

describe('author signatures on contract envelopes', () => {
  test('the signing protocol is reserved: no site can make the wallet produce one', () => {
    expect(isReservedProtocol(CONTRACT_SIGN_PROTOCOL)).toBe(true);
  });

  test("a signed envelope carries the author's key and verifies, through JSON as the chain holds it", async () => {
    const env = await signContractEnvelope(asWallet(ann), base, 'ann@bwallet.space');
    expect(env.author.identityKey).toBe(await keyOf(ann));
    expect(env.author.handle).toBe('ann@bwallet.space');
    expect(await contractAuthorKey(JSON.parse(JSON.stringify(env)))).toBe(await keyOf(ann));
  });

  test('payTo, price, text, handle or key changed after signing: not signed', async () => {
    const env = await signContractEnvelope(asWallet(ann), base, 'ann@bwallet.space');
    for (const bad of [
      { ...env, sale: { ...env.sale, payTo: '1HQTpVArDyFac7hnoMBFjDPxCqQt3boHRp' } },
      { ...env, sale: { ...env.sale, priceUsd: 50 } },
      { ...env, description: 'Another text' },
      { ...env, author: { ...env.author, handle: 'mallory@bwallet.space' } },
      { ...env, author: { ...env.author, identityKey: await keyOf(mallory) } },
      { ...env, authorSig: undefined },
    ])
      expect(await contractAuthorKey(bad as ContractEnvelope)).toBeNull();
  });

  test('a re-sign by someone else is valid only for their own key', async () => {
    const theirs = await signContractEnvelope(asWallet(mallory), base);
    expect(await contractAuthorKey(theirs)).toBe(await keyOf(mallory));
  });
});

describe('how the author is shown', () => {
  test("signed + the handle's signed binding is the author's key: $name", async () => {
    const env = await signContractEnvelope(asWallet(ann), base, 'ann@bwallet.space');
    resolved = { pubkey: await keyOf(ann), nameBinding: 'signed' };
    expect(await contractAuthorLabel(f, env)).toEqual({ label: '$ann', named: true });
  });

  test('handle bound to another key, unsigned binding, a handle off our domains, or offline: the short key', async () => {
    const key = await keyOf(mallory);
    const short = `${key.slice(0, 6)}…${key.slice(-4)}`;
    // Mallory signs a listing claiming Ann's handle (and Ann's typed name).
    const env = await signContractEnvelope(asWallet(mallory), base, 'ann@bwallet.space');
    resolved = { pubkey: await keyOf(ann), nameBinding: 'signed' };
    expect(await contractAuthorLabel(f, env)).toEqual({ label: short, named: false });
    resolved = { pubkey: key, nameBinding: 'unsigned' };
    expect(await contractAuthorLabel(f, env)).toEqual({ label: short, named: false });
    resolved = new Error('offline');
    expect(await contractAuthorLabel(f, env)).toEqual({ label: short, named: false });
    resolved = { pubkey: key, nameBinding: 'signed' };
    const elsewhere = await signContractEnvelope(asWallet(mallory), base, 'ann@handcash.io');
    expect(await contractAuthorLabel(f, elsewhere)).toEqual({ label: short, named: false });
    // Never the typed name.
    expect(JSON.stringify(await contractAuthorLabel(f, env))).not.toContain('Ann Lawyer');
  });

  test("unsigned: null (the sheet marks the typed name as the author's own words; paid ones cannot be bought)", async () => {
    expect(await contractAuthorLabel(f, base)).toBeNull();
  });
});

describe('the wallet signs its own publish', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  test('publishContract signs as the account and mints the signed envelope', () => {
    const src = read('./market.ts');
    expect(src).toContain('const signed = await signContractEnvelope(ctx.wallet, env, handle);');
    expect(src).toContain('await mintJson(ctx, signed, CONTRACT_CONTENT_TYPE, MAP(signed))');
  });
  test("the Contracts publish passes the account's bWalletX paymail as the handle", () => {
    const src = read('./ContractsMarket.tsx');
    expect(src).toContain('accountNamesFor(account?.addresses.identityAddress).paymail || undefined');
    expect(src).toContain('return publishContract(apiContext, env, handle);');
  });
  test("a paid listing's sheet never shows the typed name for a signed listing, and Buy is off when unsigned", () => {
    const src = read('./ContractsMarket.tsx');
    expect(src).toContain('if (a) return a.label;');
    expect(src).toContain('|| unsignedPaid(open)}');
  });
});
