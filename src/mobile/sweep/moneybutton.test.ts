import { describe, expect, test } from 'bun:test';
import { accountKey, addressAt, HD_ACCOUNTS } from './hd';
import {
  addressHash,
  isP2pkh,
  MONEYBUTTON_PATH,
  parseSfp,
  sfpOutputsFor,
  splitSpendable,
  txOutputs,
} from './moneybutton';

// BIP39 test vector phrase (public, holds nothing).
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// The unsigned example transaction from Money Button's SFP "build" docs (paymail-09-sfp-build, June 2021):
// output 0 is plain P2PKH change, output 1 an SFP token output (100 tokens of d5956a1a2230@domain.tld).
const DOC_TX =
  '01000000025bf17cd0adb6410b67169ef7b3741c47676da6832278a93bddb3b24caab4683b010000001601000100010001000773667040302e32010001000100ffffffffc0807468f96e619953f32483d891c31c4605ff7c6a3b4a0412308b39b7d7af8701000000020000ffffffff02bf3de505000000001976a9140a55a8545ae88cd5ea609e991ec5b0d280b4f0dd88ac2202000000000000f8610773667040302e321764353935366131613232333040646f6d61696e2e746c641493ce48570b55c42c2af816aeaba06cfee1224fae144ce164fc17e44c4a77ebbfb3e1c52c6ae4544d97140a55a8545ae88cd5ea609e991ec5b0d280b4f0dd00000000005979557a75547a547a547a547a5879547a75537a537a537a5779537a75527a527a5679527a75517a5579517a75615b7901008791635a79a9517987695b795b79ac696854795a7987695c79008791696079a952798769011179011179ac695e79a9537987695f795f79ac7777777777777777777777777777777777776a156400000000000000736f6d65206e6f74657312000000000000';
const TXID = 'ab'.repeat(32);

describe('Money Button import', () => {
  test("derivation: m/44'/0'/0' receive addresses (BIP44 vectors for the abandon…about phrase)", () => {
    expect(MONEYBUTTON_PATH).toBe("m/44'/0'/0'");
    const acct = accountKey(PHRASE, '', MONEYBUTTON_PATH);
    expect(addressAt(acct, MONEYBUTTON_PATH, 0, 0).address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
    expect(addressAt(acct, MONEYBUTTON_PATH, 0, 1).address).toBe('1Ak8PffB2meyfYnbXZR9EGfLfFZVpzJvQP');
    expect(addressAt(acct, MONEYBUTTON_PATH, 0, 2).address).toBe('1MNF5RSaabFwcbtJirJwKnDytsXXEsVsNb');
  });

  test('the sweep walks the Money Button account and names it', () => {
    const a = HD_ACCOUNTS.find((x) => x.path === MONEYBUTTON_PATH);
    expect(a?.wallet).toContain('Money Button');
  });

  test('parses the SFP output in the docs example and leaves P2PKH alone', () => {
    const outs = txOutputs(DOC_TX);
    expect(outs).toHaveLength(2);
    expect(isP2pkh(outs[0].script)).toBe(true);
    expect(parseSfp(outs[0].script)).toBeNull();
    expect(outs[1].satoshis).toBe(546);
    const sfp = parseSfp(outs[1].script)!;
    expect(sfp.version).toBe('sfp@0.2');
    expect(sfp.asset).toBe('d5956a1a2230@domain.tld');
    expect(sfp.amount).toBe(100n);
    expect(sfp.notes).toBe('some notes');
    expect(sfp.hashes).toContain('0a55a8545ae88cd5ea609e991ec5b0d280b4f0dd');
  });

  test('finds token outputs naming our address only', () => {
    // 181WNGArrHe1dpzqv9fmtvjYMVaMTnKGPk is the owner address requested in the docs example.
    const ours = new Set([addressHash('181WNGArrHe1dpzqv9fmtvjYMVaMTnKGPk')]);
    const found = sfpOutputsFor(DOC_TX, TXID, ours);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ outpoint: `${TXID}_1`, amount: 100n, satoshis: 546 });
    expect(sfpOutputsFor(DOC_TX, TXID, new Set([addressHash('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA')]))).toHaveLength(0);
  });

  test('a BSV sweep only spends plain P2PKH coins', () => {
    const outs = txOutputs(DOC_TX);
    const inputs = outs.map((o, i) => ({ outpoint: `${TXID}_${i}`, lockingScript: o.script }));
    const { spendable, kept } = splitSpendable(inputs);
    expect(spendable.map((i) => i.outpoint)).toEqual([`${TXID}_0`]);
    expect(kept.map((i) => i.outpoint)).toEqual([`${TXID}_1`]);
    // A protected outpoint is kept even if its script looks plain.
    expect(splitSpendable(inputs, new Set([`${TXID}_0`])).spendable).toHaveLength(0);
  });

  test('rejects non-SFP and malformed scripts', () => {
    expect(parseSfp('61')).toBeNull();
    expect(parseSfp('6107736670')).toBeNull();
    expect(parseSfp('0063036f7264')).toBeNull();
  });
});
