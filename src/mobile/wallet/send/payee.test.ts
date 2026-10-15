import { describe, expect, test } from 'bun:test';
import { canonPaymail, hasPaid, loadPaid, lookalikeOf, payeeNote, recordPaid, shape } from './payee';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const KEY = '02' + 'ab'.repeat(32);

describe('shape', () => {
  test('folds look-alike characters', () => {
    expect(shape('b0ase')).toBe(shape('boase'));
    expect(shape('B0-ASE@bwalletx.com')).toBe('boase');
    expect(shape('$al1ce')).toBe(shape('alice'));
    expect(shape('5teve')).toBe(shape('steve'));
    expect(shape('9reg')).toBe(shape('qreg'));
    expect(shape('rnike')).toBe(shape('mike'));
    expect(shape('vvill')).toBe(shape('will'));
    expect(shape('j_o.h-n')).toBe('john');
    expect(shape('8ob')).toBe(shape('bob'));
    expect(shape('2oe')).toBe(shape('zoe'));
  });
  test('different names stay different', () => {
    expect(shape('alice')).not.toBe(shape('alicia'));
  });
});

describe('canonPaymail', () => {
  test('lowercases and joins our domains', () => {
    expect(canonPaymail('B0ase@BWalletX.com')).toBe(canonPaymail('b0ase@bwallet.space'));
    expect(canonPaymail('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe('');
    expect(canonPaymail('x@handcash.io')).toBe('x@handcash.io');
  });
});

describe('lookalikeOf', () => {
  const known = [{ paymail: 'boase@bwalletx.com', label: '$boase' }];
  test('warns for a different name with the same shape', () => {
    expect(lookalikeOf('b0ase@bwalletx.com', known)?.label).toBe('$boase');
  });
  test('exact match is trusted', () => {
    expect(lookalikeOf('boase@bwalletx.com', known)).toBeNull();
    expect(lookalikeOf('BOASE@bwallet.space', known)).toBeNull();
  });
  test('unrelated names and addresses are fine', () => {
    expect(lookalikeOf('alice@bwalletx.com', known)).toBeNull();
    expect(lookalikeOf('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', known)).toBeNull();
  });
});

describe('paid store + payeeNote', () => {
  test('first payment, then trusted; look-alike flagged', () => {
    const s = mem();
    expect(payeeNote('acct', 'boase@bwalletx.com', { label: '$boase' }, s, [])?.firstTime).toBe(true);
    recordPaid('acct', [{ paymail: 'boase@bwalletx.com', label: '$boase' }], 1, s);
    recordPaid('acct', [{ paymail: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', label: 'x' }], 2, s);
    expect(loadPaid('acct', s)).toHaveLength(1);
    expect(hasPaid('acct', 'boase@bwallet.space', s)).toBe(true);
    const same = payeeNote('acct', 'boase@bwalletx.com', { label: '$boase', pubkey: KEY }, s, []);
    expect(same?.firstTime).toBe(false);
    expect(same?.lookalike).toBeUndefined();
    expect(same?.fingerprint).toBe('02abab…abab');
    const other = payeeNote('acct', 'b0ase@bwalletx.com', { label: '$b0ase' }, s, []);
    expect(other?.firstTime).toBe(true);
    expect(other?.lookalike?.name).toBe('$boase');
  });
  test('contacts count for look-alikes but are trusted on exact match', () => {
    const s = mem();
    const contacts = [{ paymail: 'alice@bwalletx.com', label: '$alice' }];
    expect(payeeNote('acct', 'al1ce@bwalletx.com', undefined, s, contacts)?.lookalike?.name).toBe('$alice');
    expect(payeeNote('acct', 'alice@bwalletx.com', undefined, s, contacts)?.lookalike).toBeUndefined();
  });
  test('plain address with no name: no note', () => {
    expect(payeeNote('acct', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', undefined, mem(), [])).toBeUndefined();
  });
});
