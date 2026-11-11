import { describe, expect, test } from 'bun:test';
import { canonPaymail, hasPaid, loadPaid, lookalikeOf, payeeNote, recordPaid, SELF_PAY_NOTE, shape } from './payee';

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

describe('payment to self (P0, 11 Nov 2026: 1¢ to own boase@bwalletx.com)', () => {
  const OWN = '03' + 'cd'.repeat(32);
  test('a name that resolves to this wallet\'s own identity key says "This is you", nothing else', () => {
    const s = mem();
    const n = payeeNote('acct', 'boase@bwalletx.com', { label: '$boase', pubkey: OWN.toUpperCase() }, s, [], OWN);
    expect(n?.self).toBe(true);
    expect(n?.firstTime).toBeUndefined();
    expect(n?.lookalike).toBeUndefined();
    expect(SELF_PAY_NOTE).toBe('This is you. Only the network fee will be spent.');
  });
  test('someone else, an unresolved name, or no own key: no self note', () => {
    const s = mem();
    expect(payeeNote('acct', 'alice@bwalletx.com', { label: '$alice', pubkey: KEY }, s, [], OWN)?.self).toBeUndefined();
    expect(payeeNote('acct', 'boase@bwalletx.com', { label: '$boase' }, s, [], OWN)?.self).toBeUndefined();
    expect(payeeNote('acct', 'boase@bwalletx.com', { label: '$boase', pubkey: OWN }, s, [])?.self).toBeUndefined();
  });
  test('the confirm sheet shows the note and still offers Send (informational, never blocks)', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { SendConfirmation } = await import('../../../components/SendConfirmation');
    const { theme } = await import('../../../theme');
    const html = (self: boolean) =>
      renderToStaticMarkup(
        createElement(SendConfirmation, {
          show: true,
          theme,
          usdPerBsv: 50,
          lineItems: [
            {
              address: 'boase@bwalletx.com',
              amount: '0.00061088 BSV',
              sats: 61_088,
              payee: payeeNote(
                'acct',
                'boase@bwalletx.com',
                { label: '$boase', pubkey: self ? OWN : KEY },
                mem(),
                [],
                OWN,
              ),
            },
          ],
          totalSats: 61_088,
          onConfirm: () => undefined,
          onCancel: () => undefined,
        }),
      );
    const mine = html(true);
    expect(mine).toContain(SELF_PAY_NOTE);
    expect(mine).not.toContain('First payment to');
    expect(mine).toMatch(/>Send</); // the Send button is there as always
    expect(html(false)).not.toContain(SELF_PAY_NOTE);
  });
});
