import { describe, expect, test } from 'bun:test';
import { isPremiumName, lengthTierUsd, nameTierUsd, NAME_TIERS, offerHref } from './tiers';
import { buyThenGive, categoryOf, normaliseQuery, railNames, resultFor, suggestionsFor } from './inventory';
import { guestNamesRoute } from './guestRoute';
import { newSellBatch } from '../opnsSell';
import type { OpnsListing } from '../opnsSell';

const HOUSE = '1A3SPh9TwVAwmBv9d8VTczwKq761s1byt7';
const L = (name: string, seller = HOUSE, priceSats = 5_000_000): OpnsListing => ({
  name,
  outpoint: `${name.padEnd(64, '0').slice(0, 64)}.0`,
  origin: '',
  priceSats,
  seller,
});

describe('tier pricing', () => {
  test('$1 for 5+, $5 for 4, $15 for 3 characters', () => {
    expect(nameTierUsd('coffee')).toBe(1);
    expect(nameTierUsd('bread')).toBe(1);
    expect(nameTierUsd('cafe')).toBeNull(); // short names: held for renting, offer only
    expect(nameTierUsd('zqx')).toBeNull();
    expect(NAME_TIERS.map((t) => t.usd)).toEqual([1]);
  });
  test('1–2 characters and the premium shortlist are offers only', () => {
    expect(nameTierUsd('ab')).toBeNull();
    expect(isPremiumName('b0ase')).toBe(true);
    expect(nameTierUsd('b0ase')).toBeNull();
    expect(lengthTierUsd('b0ase')).toBe(1);
    expect(offerHref('b0ase')).toContain('mailto:support@bwalletx.com');
  });
  test('List selected and auto-list use the tier; premium names are skipped unless priced', () => {
    const b = newSellBatch(
      [
        { name: 'coffee', id: 'a' },
        { name: 'cafe', id: 'b' },
        { name: 'b0ase', id: 'c' },
      ],
      50,
    )!;
    expect(b.items.map((i) => [i.name, i.usd])).toEqual([
      ['coffee', 1], // 'cafe' (4 letters) is held for renting: offer only, never auto-listed
    ]);
    const priced = newSellBatch([{ name: 'b0ase', id: 'c' }], 50, { b0ase: 500 })!;
    expect(priced.items[0].usd).toBe(500);
  });
});

describe('result states', () => {
  const book = [L('coffee'), L('teapot', '1Someone')];
  test('free → claim', () => {
    expect(resultFor({ status: 'available', name: 'zzqqfree' }, book).kind).toBe('free');
  });
  test('listed by us → house; by someone else → listed', () => {
    expect(resultFor({ status: 'taken', name: 'coffee', origin: 'o' }, book).kind).toBe('house');
    expect(resultFor({ status: 'taken', name: 'teapot', origin: 'o' }, book).kind).toBe('listed');
  });
  test('taken and not listed → taken with suggestions', () => {
    const r = resultFor({ status: 'taken', name: 'coffeeshop', origin: 'o' }, book);
    expect(r.kind).toBe('taken');
    if (r.kind === 'taken') expect(r.suggestions).toContain('coffeeshop-bsv');
  });
  test('premium wins over listed; already yours wins over everything', () => {
    expect(resultFor({ status: 'taken', name: 'b0ase', origin: 'o' }, [L('b0ase')]).kind).toBe('premium');
    expect(resultFor({ status: 'taken', name: 'coffee', origin: 'o' }, book, new Set(['coffee'])).kind).toBe('mine');
  });
  test('invalid input', () => {
    expect(resultFor({ status: 'invalid', name: 'a b', reason: 'Letters, numbers and - only' }, []).kind).toBe(
      'invalid',
    );
  });
  test('a listing seen only on the inscription counts as listed', () => {
    const r = resultFor({ status: 'taken', name: 'teacup', origin: 'o', listing: { outpoint: 'x.0', price: 9 } }, []);
    expect(r.kind).toBe('listed');
  });
  test('query normalising', () => {
    expect(normaliseQuery(' @Coffee ')).toBe('coffee');
    expect(normaliseQuery('$alice@bwalletx.com')).toBe('alice');
  });
});

describe('inventory', () => {
  test('category map is loaded', () => {
    expect(categoryOf('aaron')).toBe('firstnames');
  });
  test('rails: house only, premium out, short = 3–4 letters', () => {
    const book = [L('aaron'), L('aaron2', '1Other'), L('cafe'), L('zqx'), L('b0ase'), L('abcde')];
    expect(railNames('short', book).map((l) => l.name)).toEqual([]); // short names are offer-only (held for renting)
    expect(railNames('firstnames', book).map((l) => l.name)).toEqual(['aaron']);
    expect(railNames('words', book).some((l) => l.name === 'b0ase')).toBe(false);
  });
  test('suggestions prefer listed house names', () => {
    expect(suggestionsFor('coffe', [L('coffee')])[0]).toBe('coffee');
  });
});

describe('give a name: buy, then gift', () => {
  test('buys first, then finds the id, then sends', async () => {
    const calls: string[] = [];
    const r = await buyThenGive(
      {
        buy: async () => (calls.push('buy'), 'tx1'),
        idOf: async () => (calls.push('id'), 'id1'),
        send: async (id, to) => (calls.push(`send:${id}:${to}`), 'tx2'),
        waitMs: 0,
      },
      'coffee',
      '1Dest',
    );
    expect(calls).toEqual(['buy', 'id', 'send:id1:1Dest']);
    expect(r).toEqual({ ok: true, buyTxid: 'tx1', giftTxid: 'tx2' });
  });
  test('a failed buy never sends', async () => {
    let sent = false;
    const r = await buyThenGive(
      {
        buy: async () => {
          throw new Error('no funds');
        },
        idOf: async () => 'x',
        send: async () => ((sent = true), 'tx'),
        waitMs: 0,
      },
      'coffee',
      '1Dest',
    );
    expect(sent).toBe(false);
    expect(r).toEqual({ ok: false, stage: 'buy', error: 'no funds' });
  });
  test('a failed gift keeps the buy txid (the name stays with the buyer)', async () => {
    const r = await buyThenGive(
      { buy: async () => 'tx1', idOf: async () => undefined, send: async () => 'tx', waitMs: 0, tries: 2 },
      'coffee',
      '1Dest',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.stage, r.buyTxid]).toEqual(['gift', 'tx1']);
  });
});

describe('guest route', () => {
  test('/names is public, keeps ?q=', () => {
    expect(guestNamesRoute('/names')).toBe('/m/names');
    expect(guestNamesRoute('/names', '?q=coffee')).toBe('/m/names?q=coffee');
    expect(guestNamesRoute('/wallet')).toBeNull();
  });
});
