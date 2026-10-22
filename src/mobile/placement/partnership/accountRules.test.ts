import { describe, expect, test } from 'bun:test';
import { BigNumber, ECDSA, OP, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk';
import {
  addSignatures,
  finalize,
  isReady,
  mergeSignatures,
  proposalTx,
  sighash,
  signedBy,
  toChecksig,
} from './multisig';
import { keysetFor, type Keyset } from './partnerLock';
import {
  MAX_FEE_SATS,
  accountScript,
  buildAccountProposal,
  checkAccountProposal,
  exportAccountRequest,
  importAccountRequest,
  absorbRequest,
  planAccountPayment,
  type AccountProposal,
} from './accountRules';

const ann = PrivateKey.fromRandom();
const ben = PrivateKey.fromRandom();
const cat = PrivateKey.fromRandom();
const stranger = PrivateKey.fromRandom();
const payee = PrivateKey.fromRandom().toAddress();
const pub = (k: PrivateKey) => k.toPublicKey().toString();
const toHex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
const signAs = (k: PrivateKey, tx: Transaction, inputs: number[]) =>
  Object.fromEntries(
    inputs.map((i) => [i, toHex(toChecksig(ECDSA.sign(new BigNumber(sighash(tx, i)), k, true).toDER() as number[]))]),
  );

const twoOfThree = keysetFor({ kind: 'majority', m: 2 }, [pub(ann), pub(ben), pub(cat)]);
const threeOfThree = keysetFor({ kind: 'unanimous' }, [pub(ann), pub(ben), pub(cat)]);

let n = 0;
function coin(keyset: Keyset, sats: number) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: (n++).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript(),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript: accountScript(keyset), satoshis: sats });
  return { sourceTx: src, vout: 0 };
}

const proposal = (keyset: Keyset, coins = [coin(keyset, 50_000)], sats = 20_000): AccountProposal =>
  buildAccountProposal({
    partnershipId: 'room-1',
    proposalId: 'p-1',
    keyset,
    coins,
    payTo: { label: '$dee', address: payee },
    sats,
    proposedBy: pub(ann),
    summary: 'Pay $dee 20,000 sats',
    now: new Date('2026-10-22T00:00:00Z'),
  });

describe('shared account script', () => {
  test('2 of 3 is bare m-of-n over the sorted keys', () => {
    const c = accountScript(twoOfThree).chunks;
    expect(c[0].op).toBe(OP.OP_2);
    expect(c.slice(1, 4).map((x) => toHex(x.data!))).toEqual([...twoOfThree.pubKeys]);
    expect([...twoOfThree.pubKeys]).toEqual([...twoOfThree.pubKeys].sort());
    expect(c[4].op).toBe(OP.OP_3);
    expect(c[5].op).toBe(OP.OP_CHECKMULTISIG);
    expect(c.length).toBe(6);
  });
  test('3 of 3 needs all three', () => {
    expect(accountScript(threeOfThree).chunks[0].op).toBe(OP.OP_3);
  });
  test('partners listing keys in a different order build the identical script', () => {
    const other = keysetFor({ kind: 'majority', m: 2 }, [pub(cat), pub(ann), pub(ben)]);
    expect(accountScript(other).toHex()).toBe(accountScript(twoOfThree).toHex());
  });
});

describe('planning', () => {
  test('pays, returns change to the account and takes a small fee', () => {
    const r = planAccountPayment(twoOfThree, [coin(twoOfThree, 50_000)], 20_000);
    expect(r.inputs.length).toBe(1);
    expect(r.fee).toBeGreaterThan(0);
    expect(r.fee).toBeLessThan(1_000);
    expect(r.change + r.fee + 20_000).toBe(50_000);
  });
  test('refuses in plain words when the account is short', () => {
    expect(() => planAccountPayment(twoOfThree, [coin(twoOfThree, 1_000)], 20_000)).toThrow(/holds 1,000 sats/);
  });
  test('ignores 1-sat outputs and coins under other scripts', () => {
    expect(() => planAccountPayment(twoOfThree, [coin(twoOfThree, 1), coin(threeOfThree, 90_000)], 10)).toThrow(
      /holds 0 sats/,
    );
  });
});

describe('proposal round trip', () => {
  test('export → import keeps the transaction and checks it', () => {
    const p = proposal(twoOfThree);
    const back = importAccountRequest(exportAccountRequest(p), twoOfThree, 'room-1');
    expect(proposalTx(back).id('hex')).toBe(proposalTx(p).id('hex'));
    expect(checkAccountProposal(back, twoOfThree)).toMatchObject({ sats: 20_000, address: payee, m: 2, n: 3 });
  });
  test('a request for another partnership or keyset is refused', () => {
    const text = exportAccountRequest(proposal(twoOfThree));
    expect(() => importAccountRequest(text, twoOfThree, 'room-2')).toThrow(/different partnership/);
    expect(() => importAccountRequest(text, threeOfThree, 'room-1')).toThrow();
    expect(() => importAccountRequest('hello', twoOfThree, 'room-1')).toThrow(/not a shared account request/);
  });
});

describe('the card matches the transaction', () => {
  test('a changed amount on the card is refused', () => {
    const p = { ...proposal(twoOfThree), sats: 19_000 };
    expect(() => checkAccountProposal(p, twoOfThree)).toThrow(/pays somewhere the card does not show/);
  });
  test('a swapped payee address is refused', () => {
    const p = { ...proposal(twoOfThree), payTo: { label: '$dee', address: stranger.toAddress() } };
    expect(() => checkAccountProposal(p, twoOfThree)).toThrow();
  });
  test('an extra hidden output is refused', () => {
    const p = proposal(twoOfThree);
    const tx = proposalTx(p);
    tx.addOutput({ lockingScript: new P2PKH().lock(stranger.toAddress()), satoshis: 100 });
    expect(() => checkAccountProposal({ ...p, txEF: tx.toHexEF() }, twoOfThree)).toThrow(/card does not show/);
  });
  test('an absurd fee is refused', () => {
    const p = proposal(twoOfThree, [coin(twoOfThree, 200_000)], 20_000);
    const tx = proposalTx(p);
    tx.outputs[1].satoshis = (tx.outputs[1].satoshis ?? 0) - (MAX_FEE_SATS + 1);
    expect(() => checkAccountProposal({ ...p, txEF: tx.toHexEF() }, twoOfThree)).toThrow(/too high/);
  });
});

describe('signatures', () => {
  test('valid signatures count, a stranger and a forged signature are refused, duplicates change nothing', () => {
    let p = proposal(twoOfThree);
    const tx = proposalTx(p);
    expect(() => addSignatures(p, pub(stranger), signAs(stranger, tx, [0]))).toThrow(/not one of these partners/);
    expect(() => addSignatures(p, pub(ben), signAs(ann, tx, [0]))).toThrow(/does not match/);
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    const again = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    expect(signedBy(again)).toEqual([pub(ann)]);
    expect(isReady(again)).toBe(false);
  });

  test('finalize refuses below m, then passes the script check at m (2 of 3)', () => {
    let p = proposal(twoOfThree, [coin(twoOfThree, 30_000), coin(twoOfThree, 30_000)], 40_000);
    const tx = proposalTx(p);
    const all = p.locked.map((l) => l.index);
    p = addSignatures(p, pub(cat), signAs(cat, tx, all));
    expect(() => finalize(p)).toThrow(/Nothing was broadcast/);
    p = addSignatures(p, pub(ann), signAs(ann, tx, all));
    const { rawTx, txid } = finalize(p);
    expect(Transaction.fromHex(rawTx).id('hex')).toBe(txid);
  });

  test('3 of 3 needs everyone', () => {
    let p = proposal(threeOfThree);
    const tx = proposalTx(p);
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    expect(() => finalize(p)).toThrow(/2 of 3/);
    p = addSignatures(p, pub(cat), signAs(cat, tx, [0]));
    expect(() => finalize(p)).not.toThrow();
  });

  test('pasted copies merge only verified signatures; a different transaction is refused', () => {
    const base = proposal(twoOfThree);
    const tx = proposalTx(base);
    const annCopy = addSignatures(base, pub(ann), signAs(ann, tx, [0]));
    const forged: AccountProposal = { ...base, sigs: { '0': { [pub(ben)]: Object.values(signAs(cat, tx, [0]))[0] } } };
    const merged = mergeSignatures(mergeSignatures(base, annCopy), forged);
    expect(signedBy(merged)).toEqual([pub(ann)]);
    const other = proposal(twoOfThree, [coin(twoOfThree, 60_000)]);
    expect(() => mergeSignatures(base, other)).toThrow(/different proposals/);
  });

  test('absorbRequest adds a new request and folds a returned copy into the known one', () => {
    const base = proposal(twoOfThree);
    const tx = proposalTx(base);
    const benCopy = addSignatures(base, pub(ben), signAs(ben, tx, [0]));
    const text = exportAccountRequest(benCopy);
    const added = absorbRequest([], importAccountRequest(text, twoOfThree, 'room-1'), text);
    expect(signedBy(added[0])).toEqual([pub(ben)]);
    const annCopy = addSignatures(base, pub(ann), signAs(ann, tx, [0]));
    const text2 = exportAccountRequest(annCopy);
    const both = absorbRequest(added, importAccountRequest(text2, twoOfThree, 'room-1'), text2);
    expect(both.length).toBe(1);
    expect(isReady(both[0])).toBe(true);
  });
});
