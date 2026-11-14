/**
 * b-Aware 25 Oct 2026 (fzsusanto row 114): the bPhone meter paid the paymail and the MNEE / token address the bWallet
 * server's profile named, tied to nothing the callee signed, and never shown. The payee is now bound to the key the
 * call goes to (calls/payee.ts) and shown on the quote sheet; anything unbound is refused before a sheet shows.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { bindPayee, payeeLabel, payoutNeedsSigning, sameCardTerms, signPayee } from './payee';
import { parseAsset, type RateAsset, type RateCard } from './rateCard';

const callee = new ProtoWallet(PrivateKey.fromRandom());
const other = new ProtoWallet(PrivateKey.fromRandom());
// signRequest asks for { identityKey: true }; a ProtoWallet has no identity flag, so answer with its root key.
const asWallet = (w: ProtoWallet) => ({
  getPublicKey: () => w.getPublicKey({ identityKey: true }),
  createSignature: (a: Parameters<ProtoWallet['createSignature']>[0]) => w.createSignature(a),
});
const keyOf = async (w: ProtoWallet) => (await w.getPublicKey({ identityKey: true })).publicKey;

const ADDR = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const SWAP = '1HQTpVArDyFac7hnoMBFjDPxCqQt3boHRp';
const TOKEN = `${'b'.repeat(64)}_0`;
const card = (asset: RateAsset): RateCard => ({ amount: 1, per: 'minute', asset });
const signed = async (w: ProtoWallet, asset: Exclude<RateAsset, { kind: 'bsv' }>, address = ADDR) =>
  ({ ...asset, address, proof: await signPayee(asWallet(w), asset, address) }) as RateAsset;

describe('bindPayee: MNEE and token meters pay only an address the callee signed', () => {
  test("the callee's own signed address is paid", async () => {
    const key = await keyOf(callee);
    for (const a of [{ kind: 'mnee' } as const, { kind: 'bsv21', id: TOKEN, sym: 'BOB', dec: 0 } as const]) {
      const asset = await signed(callee, a);
      // Through the server's JSON and the wallet's parser, as a caller receives it.
      const served = parseAsset(JSON.parse(JSON.stringify(asset)))!;
      expect(await bindPayee(card(served), null, key)).toEqual({ ok: true, payTo: { address: ADDR } });
    }
  });

  test('an address with no signature (what the server served before) is refused', async () => {
    const r = await bindPayee(card({ kind: 'mnee', address: ADDR }), null, await keyOf(callee));
    expect(r.ok).toBe(false);
  });

  test('a swapped address under the real signature is refused', async () => {
    const asset = (await signed(callee, { kind: 'mnee' })) as { kind: 'mnee'; address: string };
    expect((await bindPayee(card({ ...asset, address: SWAP }), null, await keyOf(callee))).ok).toBe(false);
  });

  test("someone else's signature is refused, even over their own address", async () => {
    const asset = await signed(other, { kind: 'mnee' }, SWAP);
    expect((await bindPayee(card(asset), null, await keyOf(callee))).ok).toBe(false);
  });

  test('an MNEE signature does not stand for a token, nor one token for another', async () => {
    const key = await keyOf(callee);
    const mnee = (await signed(callee, { kind: 'mnee' })) as { proof: never };
    const asToken = { kind: 'bsv21', id: TOKEN, sym: 'BOB', dec: 0, address: ADDR, proof: mnee.proof } as RateAsset;
    expect((await bindPayee(card(asToken), null, key)).ok).toBe(false);
    const tok = (await signed(callee, { kind: 'bsv21', id: TOKEN, sym: 'BOB', dec: 0 })) as { proof: never };
    const otherToken = {
      kind: 'bsv21',
      id: `${'c'.repeat(64)}_0`,
      sym: 'BOB',
      dec: 0,
      address: ADDR,
      proof: tok.proof,
    };
    expect((await bindPayee(card(otherToken as RateAsset), null, key)).ok).toBe(false);
  });
});

describe('bindPayee: BSV pays the paymail only through the callee key', () => {
  test("the payee carries the callee's identity key, shown with the paymail", async () => {
    const key = await keyOf(callee);
    const r = await bindPayee(card({ kind: 'bsv' }), 'ann@bwallet.space', key);
    expect(r).toEqual({ ok: true, payTo: { paymail: 'ann@bwallet.space', identityKey: key } });
    if (r.ok) expect(payeeLabel(r.payTo)).toContain('ann@bwallet.space');
  });
  test('a paymail on a third-party host is refused (it could drop the payment after deriving outputs)', async () => {
    const r = await bindPayee(card({ kind: 'bsv' }), 'ann@handcash.io', await keyOf(callee));
    expect(r).toEqual({ ok: false, error: expect.stringContaining("isn't a bWalletX paymail") });
  });
  test('no paymail, or no key, is refused', async () => {
    expect((await bindPayee(card({ kind: 'bsv' }), null, await keyOf(callee))).ok).toBe(false);
    expect((await bindPayee(card({ kind: 'bsv' }), 'ann@bwallet.space', 'not-a-key')).ok).toBe(false);
  });
});

describe('the meter and the sheets', () => {
  const store = readFileSync(new URL('./store.ts', import.meta.url), 'utf8');
  test('dial binds the payee to the dialled key before quoting', () => {
    expect(store).toContain('await bindPayee(card, sameKey ? (bp?.paymail ?? null) : null, peer.key)');
    expect(store).not.toContain('payToFor(');
  });
  test("a BSV meter payment names the callee's key, so the host's outputs must derive from it", () => {
    expect(store).toContain('identityKey: payTo.identityKey,');
    expect(store).toContain('requireVerified: true');
  });
  test('the quote sheet shows the payee', () => {
    const sheet = readFileSync(new URL('./QuoteSheet.tsx', import.meta.url), 'utf8');
    expect(sheet).toContain('{payeeLabel(s.payTo)}');
  });
  test("saving bPhone settings signs the wallet's own MNEE / token payout address", () => {
    const settings = readFileSync(new URL('./BPhoneSettings.tsx', import.meta.url), 'utf8');
    expect(settings).toContain('const address = await ownPayout(next.rate.asset.kind);');
    expect(settings).toContain('await signPayee(apiContext.wallet, next.rate.asset, address)');
  });
  test("opening bPhone settings re-signs an old card with the wallet's own address, never the served one", () => {
    const settings = readFileSync(new URL('./BPhoneSettings.tsx', import.meta.url), 'utf8');
    expect(settings).toContain('const own = await ownPayout(kind);');
    expect(settings).toContain('await payoutNeedsSigning(publicKey.toLowerCase(), p.rate.asset, own)');
    // signAndSave signs the card's own kind / token for `own` (ownPayout), never the served address.
    expect(settings).toContain('const proof = await signPayee(myKey, rate.asset, own);');
    expect(settings).toContain('asset: { ...rate.asset, address: own, proof }');
  });
});

describe("payoutNeedsSigning: the callee's wallet re-signs only its own address", () => {
  test('an unsigned card, a swapped address, or a stale signature needs signing; a good one does not', async () => {
    const key = await keyOf(callee);
    const good = await signed(callee, { kind: 'mnee' });
    expect(await payoutNeedsSigning(key, good, ADDR)).toBe(false);
    expect(await payoutNeedsSigning(key, { kind: 'mnee', address: ADDR }, ADDR)).toBe(true);
    // The server served a different address: sign the wallet's own, not that one.
    expect(await payoutNeedsSigning(key, { ...good, address: SWAP } as RateAsset, ADDR)).toBe(true);
    expect(await payoutNeedsSigning(key, await signed(other, { kind: 'mnee' }), ADDR)).toBe(true);
  });
  test('a BSV card, no card, or no own address: nothing to sign', async () => {
    const key = await keyOf(callee);
    expect(await payoutNeedsSigning(key, { kind: 'bsv' }, ADDR)).toBe(false);
    expect(await payoutNeedsSigning(key, undefined, ADDR)).toBe(false);
    expect(await payoutNeedsSigning(key, { kind: 'mnee', address: ADDR }, undefined)).toBe(false);
  });
});

/** Re-review of row 114: the quiet re-sign trusted the server's card (loadMyProfile overwrites the local cache). */
describe('the quiet re-sign signs only the price this device saved', () => {
  const mnee = (amount: number, per: RateCard['per'] = 'minute'): RateCard => ({
    amount,
    per,
    asset: { kind: 'mnee' },
  });
  const tok = (id: string): RateCard => ({ amount: 1, per: 'minute', asset: { kind: 'bsv21', id, sym: 'T', dec: 0 } });

  test('same kind, token id, amount and per: quiet; anything else, or no local card: ask the owner', () => {
    expect(sameCardTerms(mnee(1), mnee(1))).toBe(true);
    expect(sameCardTerms(tok(TOKEN), tok(TOKEN))).toBe(true);
    expect(sameCardTerms(null, mnee(1))).toBe(false);
    expect(sameCardTerms(mnee(1), mnee(0.01))).toBe(false);
    expect(sameCardTerms(mnee(1), mnee(1, 'second'))).toBe(false);
    expect(sameCardTerms(mnee(1), tok(TOKEN))).toBe(false);
    expect(sameCardTerms(tok(TOKEN), tok(`${'c'.repeat(64)}_0`))).toBe(false);
  });

  test('settings read the local card before the server copy, and sign a different card only on Yes', () => {
    const src = readFileSync(new URL('./BPhoneSettings.tsx', import.meta.url), 'utf8');
    const local = src.indexOf('const local = readMyProfileCache(publicKey.toLowerCase())?.rate ?? null;');
    const load = src.indexOf('const p = await loadMyProfile(f, publicKey.toLowerCase());');
    expect(local).toBeGreaterThan(0);
    expect(local).toBeLessThan(load);
    // The quiet path is behind the terms check; a mismatch only raises the prompt.
    expect(src).toMatch(
      /if \(!sameCardTerms\(local, p\.rate\)\) \{\s*if \(live\) setResignAsk\(\{ base: p, own \}\);\s*return;/,
    );
    // The prompt's Yes is the only other caller of signAndSave.
    expect(src.match(/await signAndSave\(/g)?.length).toBe(2);
    expect(src).toContain('const saved = await signAndSave(ask.base, ask.own);');
    expect(src).toContain('onClick={() => void confirmResign()}');
  });
});
