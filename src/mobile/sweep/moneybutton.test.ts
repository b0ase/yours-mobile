import { describe, expect, test } from 'bun:test';
import { accountKey, addressAt, HD_ACCOUNTS } from './hd';
import {
  addressHash,
  isP2pkh,
  MONEYBUTTON_PATH,
  findOwnedSfp,
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

  // Real mainnet mint of a Money Button asset (sfp@0.1, Aug 2020), public data. The funding input came
  // from a used receive address (12GJAc…) but the token owner (c0d311… = 1JaZb4…) is an address with
  // no plain history: owner matching must cover unused addresses in the walked range.
  const REAL_TX =
    '0100000001f6634b83b45a662849b75958cd130fd1bc80c2b1349539229a0ae72901266f72010000006b483045022100ceae82e86572a34c5ad2375470baecf9ac6e6732a584826f431b4a5e0bacff6c022009111876abb2291ebe12e364b6b6df326d43fc3eb8209e50f3eb16c24ef3b0fa412102c375a9c478894866d36595c7998520eeb1848c0f690801095defac1d449c3b23ffffffff022202000000000000c2610773667040302e31223466336363346462663432612e6173736574406d6f6e6579627574746f6e2e636f6d14036d480462d6bc7b69b303cd6688e4bfb9e13a1314c0d3114698049d91bf1a779be4878b789a9ca73a000000005779547a75537a537a537a5679537a75527a527a5579527a75517a5479517a75615379587987695879008791695c79a9517987695d795d79ac695a79a9527987695b795b79ac77777777777777777777777777776a1240420f00000000006d696e74696e670f00003fb00600000000001976a914be278f8b053b4c1d44a7f27a27b03b8caed85e0088ac00000000';
  const REAL_TXID = 'a3042ad4188a35d3c34952c401d86ef66332888aee5985ed63c8c4baaf6ed178';

  test('real Money Button mint (sfp@0.1)', () => {
    const sfp = parseSfp(txOutputs(REAL_TX)[0].script)!;
    expect(sfp).toMatchObject({ version: 'sfp@0.1', asset: '4f3cc4dbf42a.asset@moneybutton.com', amount: 1000000n });
    expect(sfp.hashes).toEqual([
      '036d480462d6bc7b69b303cd6688e4bfb9e13a13',
      'c0d3114698049d91bf1a779be4878b789a9ca73a',
    ]);
    const owner = new Set([addressHash('1JaZb4KiX4WfWggym5A1TXT8vbxqP8co9F')]);
    expect(sfpOutputsFor(REAL_TX, REAL_TXID, owner).map((o) => o.outpoint)).toEqual([`${REAL_TXID}_0`]);
    // The funding address alone doesn't own it.
    expect(
      sfpOutputsFor(REAL_TX, REAL_TXID, new Set([addressHash('12GJAcMfQgaQUXiLaZrTBQwpbJovdTezon')])),
    ).toHaveLength(0);
  });

  test('owners in the gaps, and the range grows past the highest matched owner', () => {
    const acct = accountKey(PHRASE, '', MONEYBUTTON_PATH);
    const at = (i: number) => addressHash(addressAt(acct, MONEYBUTTON_PATH, 0, i).address);
    const push = (hex: string) => (hex.length / 2).toString(16).padStart(2, '0') + hex;
    const ascii = (t: string) => Buffer.from(t).toString('hex');
    const sfpScript = (owner: string, amt: number) =>
      '61' +
      push(ascii('sfp@0.1')) +
      push(ascii('x.asset@moneybutton.com')) +
      push('036d480462d6bc7b69b303cd6688e4bfb9e13a13') +
      push(owner) +
      '00000000' +
      '6a' +
      push(amt.toString(16).padStart(2, '0') + '00000000000000');
    const out = (script: string) => '2202000000000000' + (script.length / 2).toString(16).padStart(2, '0') + script;
    // Used (fee) address at 5 → first range ends at 25. Owner at 22 is in range; owner at 40 is only
    // reached by growing the range to 22 + 20; owner at 70 stays out of reach.
    const hex =
      '01000000' +
      '00' +
      '03' +
      out(sfpScript(at(22), 1)) +
      out(sfpScript(at(40), 2)) +
      out(sfpScript(at(70), 3)) +
      '00000000';
    const used = [addressAt(acct, MONEYBUTTON_PATH, 0, 5)];
    const found = findOwnedSfp([{ txid: TXID, hex }], new Set(), [{ key: acct, path: MONEYBUTTON_PATH, used }]);
    expect(found.map((o) => o.amount)).toEqual([1n, 2n]);
    // A pasted key's hash matches on its own.
    expect(findOwnedSfp([{ txid: TXID, hex }], new Set([at(70)]), []).map((o) => o.amount)).toEqual([3n]);
  });
});
