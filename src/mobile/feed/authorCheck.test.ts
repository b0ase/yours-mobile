import { describe, expect, test } from 'bun:test';
import { BSM, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import { AIP_PREFIX, MAP_PREFIX, aipMessage, buildPostScript as twetchScript } from '../twetch/twetchPost';
import { AUTHOR_UNCHECKED, aipSignedBy, checkPostAuthor, checkedPayment } from './authorCheck';

/**
 * b-Aware row 111 (cluster baware:unverified-payee limb e): a feed tip paid whatever author address the indexer
 * asserted. The post's own AIP signature must recover to that address before anything is paid.
 */

const AUTHOR = PrivateKey.fromRandom();
const AUTHOR_ADDR = AUTHOR.toPublicKey().toAddress();
const ATTACKER = PrivateKey.fromRandom().toPublicKey().toAddress();

const txWith = (scriptHex: string) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: Script.fromHex(scriptHex), satoshis: 0 });
  return { hex: tx.toHex(), txid: tx.id('hex') };
};

/** Twetch form: the signature is pushed as base64 text. */
const twetchTx = () => txWith(twetchScript({ text: 'gm' }, AUTHOR, 1));

/** @1sat applyBapAip form: the signature is pushed as the raw 65 compact bytes. */
const rawSigTx = (key = AUTHOR, signedText = 'hello', postedText = signedText) => {
  const u = (s: string) => Utils.toArray(s, 'utf8');
  const signed = [
    u(MAP_PREFIX),
    u('SET'),
    u('app'),
    u('bChat'),
    u('type'),
    u('post'),
    u('text'),
    u(signedText),
    u('|'),
  ];
  const posted = [
    u(MAP_PREFIX),
    u('SET'),
    u('app'),
    u('bChat'),
    u('type'),
    u('post'),
    u('text'),
    u(postedText),
    u('|'),
  ];
  const sig = Utils.toArray(BSM.sign(aipMessage(signed), key, 'base64') as string, 'base64');
  const s = new Script().writeOpCode(0).writeOpCode(0x6a);
  for (const p of posted) s.writeBin(p);
  s.writeBin(u(AIP_PREFIX)).writeBin(u('BITCOIN_ECDSA')).writeBin(u(key.toPublicKey().toAddress())).writeBin(sig);
  return txWith(s.toHex());
};

const post = (over: { txid: string; address?: string; source?: 'bchat' | 'twetch' | 'fwetch' }) => ({
  txid: over.txid,
  source: over.source ?? ('bchat' as const),
  author: { address: over.address ?? AUTHOR_ADDR },
});

describe('aipSignedBy', () => {
  test('a Twetch post signed by the author', () => {
    const t = twetchTx();
    expect(aipSignedBy(t.hex, t.txid, AUTHOR_ADDR)).toBe(true);
  });
  test('a raw-signature (@1sat) post signed by the author', () => {
    const t = rawSigTx();
    expect(aipSignedBy(t.hex, t.txid, AUTHOR_ADDR)).toBe(true);
  });
  test('the indexer naming another address is refused', () => {
    const t = twetchTx();
    expect(aipSignedBy(t.hex, t.txid, ATTACKER)).toBe(false);
  });
  test('bytes that do not hash to the txid are refused', () => {
    const t = twetchTx();
    expect(aipSignedBy(rawSigTx().hex, t.txid, AUTHOR_ADDR)).toBe(false);
  });
  test('a signature over different content is refused', () => {
    const t = rawSigTx(AUTHOR, 'hello', 'changed');
    expect(aipSignedBy(t.hex, t.txid, AUTHOR_ADDR)).toBe(false);
  });
  test('an unsigned post is refused', () => {
    const s = new Script().writeOpCode(0).writeOpCode(0x6a).writeBin(Utils.toArray(MAP_PREFIX, 'utf8'));
    const t = txWith(s.toHex());
    expect(aipSignedBy(t.hex, t.txid, AUTHOR_ADDR)).toBe(false);
  });
});

describe('checkPostAuthor / checkedPayment', () => {
  test('verified author: the payment plan pays that address', async () => {
    const t = twetchTx();
    const plan = await checkedPayment('tip', post({ txid: t.txid }), 1000, async () => t.hex);
    expect(plan.payment.address).toBe(AUTHOR_ADDR);
  });
  test('indexer-asserted address that the post did not sign: refused, no plan', async () => {
    const t = twetchTx();
    await expect(
      checkedPayment('tip', post({ txid: t.txid, address: ATTACKER }), 1000, async () => t.hex),
    ).rejects.toThrow();
    expect(await checkPostAuthor(post({ txid: t.txid, address: ATTACKER }), async () => t.hex)).not.toBeNull();
  });
  test('the post cannot be read: refused (never paid unchecked)', async () => {
    const t = twetchTx();
    const why = await checkPostAuthor(post({ txid: t.txid }), async () => {
      throw new Error('offline');
    });
    expect(why).toBe(AUTHOR_UNCHECKED);
  });
});
