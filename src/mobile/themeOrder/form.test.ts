import { describe, expect, test } from 'bun:test';
import { editionsFrom, fileError, formOk, publicUrl, toSlug, validateForm, type MyOrder, type OrderForm } from './form';
import { quoteFields, quoteOutputs, type Quote } from './api';

const good: OrderForm = {
  name: 'Vex Void',
  slug: 'vex-void',
  brand: 'Vex Void',
  isBrand: false,
  link: 'x.com/vexvoid',
  colours: ['#ff0066', '#111111'],
  files: [{ name: 'logo.png', type: 'image/png', size: 1000 }],
  note: '',
  proof: '',
};

describe('theme order form', () => {
  test('a good form passes', () => {
    expect(validateForm(good)).toEqual({});
    expect(formOk(good)).toBe(true);
  });
  test.each([
    [{ name: 'V' }, 'name'],
    [{ slug: 'ab' }, 'slug'],
    [{ slug: 'Bad Slug' }, 'slug'],
    [{ slug: 'custom' }, 'slug'],
    [{ brand: '  ' }, 'brand'],
    [{ link: 'http://localhost' }, 'link'],
    [{ link: 'ftp://x.com' }, 'link'],
    [{ colours: ['#ff0066'] }, 'colours'],
    [{ colours: ['#ff0066', '#111111', '#222222', '#333333'] }, 'colours'],
    [{ files: [] }, 'files'],
    [{ files: [{ name: 'a.gif', type: 'image/gif', size: 10 }] }, 'files'],
    [{ files: [{ name: 'big.png', type: 'image/png', size: 2 * 1024 * 1024 + 1 }] }, 'files'],
    [{ files: Array(5).fill({ name: 'a.png', type: 'image/png', size: 1 }) }, 'files'],
    [{ note: 'x'.repeat(501) }, 'note'],
    [{ isBrand: true }, 'proof'],
  ] as [Partial<OrderForm>, keyof OrderForm][])('%j → error on %s', (over, key) => {
    expect(Object.keys(validateForm({ ...good, ...over }))).toEqual([key]);
  });
  test('brand with a verified name passes', () => {
    expect(validateForm({ ...good, isBrand: true, proof: 'vexvoid.x' })).toEqual({});
  });
  test('slug and url helpers', () => {
    expect(toSlug('  Vex Void!! Édition ')).toBe('vex-void-edition');
    expect(publicUrl('x.com/vexvoid')).toBe('https://x.com/vexvoid');
    expect(publicUrl('https://1.2.3.4/')).toBeNull();
    expect(fileError({ name: 'a.svg', type: 'image/svg+xml', size: 5 })).toBeNull();
  });
});

describe('quote fields + outputs', () => {
  test('fields are strings the server signs', () => {
    const files = [{ path: 'k/abc.png', type: 'image/png', size: 1000 }];
    const f = quoteFields({ ...good, colours: ['#FF0066', '#111111'], proof: 'vexvoid.x' }, files);
    expect(Object.values(f).every((v) => typeof v === 'string')).toBe(true);
    expect(JSON.parse(f.colours)).toEqual(['#ff0066', '#111111']);
    expect(JSON.parse(f.proof)).toEqual({ kind: 'paymail', value: 'vexvoid.x' });
    expect(f.isBrand).toBe('0');
    expect('proof' in quoteFields(good, files)).toBe(false);
  });
  test('quote → payment outputs plus the 0-sat memo', () => {
    const q: Quote = {
      quote_id: 'q',
      outputs: [{ script: '76a9', satoshis: 5 }],
      memo_hex: '006a',
      usd: 99,
      sats: 5,
      expires_at: '',
    };
    expect(quoteOutputs(q).map((o) => [o.lockingScript, o.satoshis])).toEqual([
      ['76a9', 5],
      ['006a', 0],
    ]);
  });
});

describe('My editions', () => {
  const o = (p: Partial<MyOrder>): MyOrder => ({
    id: '1',
    slug: 'vex',
    name: 'Vex',
    status: 'paid',
    renews: null,
    expires_at: '2027-10-16T00:00:00.000Z',
    txid: null,
    created_at: null,
    ...p,
  });
  test('a renewal never hides a live edition and extends the date', () => {
    const e = editionsFrom([
      o({ id: '2', name: null, renews: 'vex', status: 'paid', expires_at: '2028-10-16T00:00:00.000Z' }),
      o({ status: 'live' }),
    ]);
    expect(e).toEqual([{ slug: 'vex', name: 'Vex', status: 'live', expires: '2028-10-16T00:00:00.000Z' }]);
  });
});
