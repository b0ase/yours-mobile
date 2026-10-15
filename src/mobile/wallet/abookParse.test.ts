import { describe, expect, test } from 'bun:test';
import {
  applyHandleDomain,
  dedupe,
  detectFormat,
  hasHandles,
  mapLimited,
  parseCsv,
  parseImport,
  parseJson,
  parseLines,
  parseVcf,
  recognise,
  splitCsv,
  toCsv,
} from './abookParse';

describe('recognise', () => {
  test('paymails, $handles, $name@domain and mailto:', () => {
    expect(recognise('Alice@HandCash.io')).toEqual({ paymail: 'alice@handcash.io', handle: null });
    expect(recognise('$Bob')).toEqual({ paymail: null, handle: 'bob' });
    expect(recognise('$carol@bwalletx.com')?.paymail).toBe('carol@bwalletx.com');
    expect(recognise('mailto:dan@example.com')?.paymail).toBe('dan@example.com');
    expect(recognise('not a thing')).toBeNull();
    expect(recognise('x@nodot')).toBeNull();
  });
});

describe('CSV', () => {
  test('detects the paymail column and name/notes by header, any order', () => {
    const r = parseCsv('Notes,Full Name,Wallet\n"likes, cats",Alice,alice@handcash.io\n,Bob,$bob\n,Eve,nope\n');
    expect(r.entries).toEqual([
      { raw: 'alice@handcash.io', paymail: 'alice@handcash.io', handle: null, name: 'Alice', notes: 'likes, cats' },
      { raw: '$bob', paymail: null, handle: 'bob', name: 'Bob', notes: '' },
    ]);
    expect(r.invalid).toEqual(['nope']);
  });
  test('headerless and semicolon-delimited', () => {
    const r = parseCsv('Alice;alice@x.io\nBob;bob@x.io');
    expect(r.entries.map((e) => [e.paymail, e.name])).toEqual([
      ['alice@x.io', 'Alice'],
      ['bob@x.io', 'Bob'],
    ]);
  });
  test('quoted cells with doubled quotes and CRLF', () => {
    expect(splitCsv('a,"b ""c"", d"\r\ne,f\r\n')).toEqual([
      ['a', 'b "c", d'],
      ['e', 'f'],
    ]);
  });
});

describe('vCard', () => {
  test('EMAIL and X- fields that look like paymails; FN and NOTE', () => {
    const v = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Alice A',
      'EMAIL;TYPE=INTERNET:alice@handcash.io',
      'NOTE:met at\\, CoinGeek',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:Bob',
      'X-PAYMAIL:$bob',
      'TEL:123',
      'END:VCARD',
      'BEGIN:VCARD',
      'FN:Nobody',
      'TEL:999',
      'END:VCARD',
    ].join('\r\n');
    const r = parseVcf(v);
    expect(r.entries.map((e) => [e.raw, e.name, e.notes])).toEqual([
      ['alice@handcash.io', 'Alice A', 'met at, CoinGeek'],
      ['$bob', 'Bob', ''],
    ]);
  });
});

describe('JSON', () => {
  test('arrays of strings and objects, or a wrapped array', () => {
    expect(parseJson('["a@x.io","$b","junk"]').entries.map((e) => e.raw)).toEqual(['a@x.io', '$b']);
    const r = parseJson('{"contacts":[{"displayName":"Al","paymail":"al@x.io","note":"hi"},{"name":"No id"}]}');
    expect(r.entries).toEqual([{ raw: 'al@x.io', paymail: 'al@x.io', handle: null, name: 'Al', notes: 'hi' }]);
  });
});

describe('plain text', () => {
  test('one per line, name around the id, bad lines invalid', () => {
    const r = parseLines('alice@x.io\nBob Smith <bob@x.io>\n$carol\n\nhello world');
    expect(r.entries.map((e) => [e.raw, e.name])).toEqual([
      ['alice@x.io', ''],
      ['bob@x.io', 'Bob Smith'],
      ['$carol', ''],
    ]);
    expect(r.invalid).toEqual(['hello world']);
  });
});

describe('detect', () => {
  test('format by extension and content', () => {
    expect(detectFormat('BEGIN:VCARD')).toBe('vcf');
    expect(detectFormat('[1]')).toBe('json');
    expect(detectFormat('a,b\nc,d')).toBe('csv');
    expect(detectFormat('a@x.io\nb@x.io')).toBe('text');
    expect(detectFormat('x', 'book.csv')).toBe('csv');
    expect(parseImport('{bad json').invalid.length).toBe(1);
  });
});

describe('handles and dedupe', () => {
  test('$handles wait for a domain, then take it', () => {
    const { entries } = parseLines('$bob\nal@x.io');
    expect(hasHandles(entries)).toBe(true);
    expect(dedupe(entries, []).map((r) => r.paymail)).toEqual(['al@x.io']);
    const withDomain = applyHandleDomain(entries, 'handcash.io');
    expect(hasHandles(withDomain)).toBe(false);
    expect(withDomain[0].paymail).toBe('bob@handcash.io');
  });
  test('dedupes within the file (blanks filled) and marks ones already in the book', () => {
    const { entries } = parseCsv('name,paymail,notes\n,A@x.io,\nAnn,a@x.io,n1\nBo,b@x.io,');
    const rows = dedupe(entries, ['B@X.IO']);
    expect(rows.map((r) => [r.paymail, r.name, r.notes, r.status])).toEqual([
      ['a@x.io', 'Ann', 'n1', 'new'],
      ['b@x.io', 'Bo', '', 'existing'],
    ]);
  });
});

describe('mapLimited', () => {
  test('keeps order, never exceeds the limit, reports progress', async () => {
    let live = 0;
    let peak = 0;
    const progress: number[] = [];
    const out = await mapLimited(
      [5, 1, 3, 2, 4],
      2,
      async (n) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, n));
        live--;
        return n * 10;
      },
      (d) => progress.push(d),
    );
    expect(out).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('export', () => {
  test('CSV escapes quotes/commas and neutralises formulas', () => {
    const csv = toCsv([{ name: '=HYPERLINK("x")', paymail: 'a@x.io', handle: 'a', identityKey: '', notes: 'a, b' }]);
    expect(csv).toBe('name,paymail,handle,identity_key,notes\r\n"\'=HYPERLINK(""x"")",a@x.io,a,,"a, b"\r\n');
    expect(parseImport(csv, 'book.csv').entries[0].paymail).toBe('a@x.io');
  });
});
