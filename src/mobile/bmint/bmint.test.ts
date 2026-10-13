import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { defaultMintDocument, MINT_TEMPLATES, makeLayer } from './lib/mint-defaults';
import { generators } from './lib/mint-patterns';
import { fileBase, noteMap, noteTitle } from './lib/noteMint';
import { composeSvg, withFonts } from './lib/svg';
import type { MintDocument } from './lib/types';

describe('pattern generators', () => {
  test('every layer type has a generator that returns an <svg>', () => {
    const doc = defaultMintDocument();
    for (const l of doc.layers) {
      const out = generators[l.type](doc.width, doc.height, l.config);
      expect(out.startsWith('<svg')).toBe(true);
    }
  });
  test('deterministic: the same config gives the same SVG', () => {
    const doc = defaultMintDocument();
    for (const l of doc.layers) {
      expect(generators[l.type](1200, 600, l.config)).toBe(generators[l.type](1200, 600, l.config));
    }
  });
  test('guilloche snapshot', () => {
    const l = defaultMintDocument().layers.find((x) => x.type === 'guilloche')!;
    const svg = generators.guilloche(400, 200, l.config);
    expect(svg.length).toBeGreaterThan(500);
    expect(svg).toMatchSnapshot();
  });
});

describe('templates', () => {
  test.each(MINT_TEMPLATES.map((t) => [t.id, t] as const))('%s builds a valid document', (_id, t) => {
    const doc = t.factory();
    expect(doc.width).toBeGreaterThan(0);
    expect(doc.height).toBeGreaterThan(0);
    expect(Array.isArray(doc.layers)).toBe(true);
    for (const l of doc.layers) {
      expect(typeof generators[l.type]).toBe('function');
      expect(l.transform).toBeDefined();
      expect(l.filters).toBeDefined();
    }
    expect(new Set(doc.layers.map((l) => l.id)).size).toBe(doc.layers.length);
  });
  test('banknote and coin are there; no other document kinds', () => {
    expect(MINT_TEMPLATES.map((t) => t.id)).toEqual(['banknote', 'coin', 'token-icon', 'stamp', 'blank']);
  });
});

describe('Mint as NFT metadata', () => {
  const doc: MintDocument = { ...defaultMintDocument(), name: 'Gold 100' };
  test('bmint note fields with the serial', () => {
    expect(noteMap({ doc, template: 'banknote' })).toEqual({
      bmint: 'note',
      template: 'banknote',
      size: '1200x600',
      serial: 'AA000001',
    });
  });
  test('no visible serial → no serial field; empty template → custom', () => {
    const plain = { ...doc, layers: doc.layers.filter((l) => l.type !== 'serial-number') };
    expect(noteMap({ doc: plain, template: '' })).toEqual({ bmint: 'note', template: 'custom', size: '1200x600' });
  });
  test('all values are strings', () => {
    for (const v of Object.values(noteMap({ doc, template: 'x' }))) expect(typeof v).toBe('string');
  });
  test('title and file name', () => {
    expect(noteTitle(doc)).toBe('Gold 100');
    expect(noteTitle({ ...doc, name: '  ' })).toBe('bMint note');
    expect(fileBase({ ...doc, name: 'My note / v2!' })).toBe('My-note-v2');
  });
});

describe('SVG export', () => {
  test('withFonts embeds only the families used', () => {
    const rules = new Map([
      ['Bebas Neue', '@font-face{font-family:Bebas}'],
      ['Oswald', '@font-face{font-family:Oswald}'],
    ]);
    const out = withFonts('<svg width="1"><text font-family="Bebas Neue">1</text></svg>', rules);
    expect(out).toContain('<defs><style>@font-face{font-family:Bebas}</style></defs>');
    expect(out).not.toContain('Oswald');
    expect(withFonts('<svg/>', rules)).toBe('<svg/>');
  });
  test('composeSvg: one group per visible non-UV layer, background, coin clip', () => {
    const base = defaultMintDocument();
    const svg = composeSvg(base);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600"')).toBe(true);
    expect(svg.match(/<g opacity=/g)?.length).toBe(base.layers.length);
    const hidden = { ...base, layers: base.layers.map((l, i) => ({ ...l, visible: i !== 0 })) };
    expect(composeSvg(hidden).match(/<g opacity=/g)?.length).toBe(base.layers.length - 1);
    expect(composeSvg({ ...base, circleMask: true })).toContain('clip-path="url(#m)"');
    const img = {
      ...base,
      layers: [makeLayer('image', 'Pic', { src: 'data:x', fit: 'cover', x: 0.5, y: 0.5, scale: 1 })],
    };
    expect(composeSvg(img)).toContain('preserveAspectRatio="xMidYMid slice"');
  });
});

// Securities are out of bMint (docs/BMINT-PORT-PLAN.md §1): none of these terms may appear in its files.
describe('grep guard: no securities under src/mobile/bmint', () => {
  const GUARD = /stock|bond|share|certificate|kyc|veriff|securit|\$403|btms|dividend|par_value|isin/i;
  const SELF = 'bmint.test.ts';
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const text = files(import.meta.dir).filter((p) => /\.(tsx?|css|svg|json|md)$/.test(p) && !p.endsWith(SELF));
  test('there are files to check', () => expect(text.length).toBeGreaterThan(8));
  test.each(text.map((p) => [p.slice(import.meta.dir.length + 1), p]))('%s', (_n, p) => {
    const hit = readFileSync(p, 'utf8')
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => GUARD.test(line));
    expect(hit).toEqual([]);
  });
});
