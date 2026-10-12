import { describe, expect, test } from 'bun:test';
import { albumBlocks } from './albumLayout';
import { dedupeByOrigin } from './media';

const it = (outpoint: string, origin: string, pending?: boolean, tag = '') => ({
  output: { outpoint },
  origin,
  pending,
  tag,
});
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('dedupeByOrigin', () => {
  test('the same outpoint listed twice shows once', () => {
    const r = dedupeByOrigin([it(`${A}.0`, `${A}_0`), it(`${A}.0`, `${A}_0`)]);
    expect(r.length).toBe(1);
  });
  test('two outputs of one inscription (a transfer) keep the newest location', () => {
    const r = dedupeByOrigin([it(`${A}.0`, `${A}_0`, false, 'old'), it(`${B}.1`, `${A}.0`, false, 'new')]);
    expect(r.map((i) => i.tag)).toEqual(['new']);
  });
  test('a pending copy never replaces or joins its on-chain copy', () => {
    const r = dedupeByOrigin([it(`${A}.0`, `${A}_0`, false, 'chain'), it(`${B}.0`, `${A}_0`, true, 'pending')]);
    expect(r.map((i) => i.tag)).toEqual(['chain']);
    const r2 = dedupeByOrigin([it(`${B}.0`, `${A}_0`, true, 'pending'), it(`${A}.0`, `${A}_0`, false, 'chain')]);
    expect(r2.map((i) => i.tag)).toEqual(['chain']);
  });
  test('different inscriptions stay, in order', () => {
    const r = dedupeByOrigin([it(`${A}.0`, `${A}_0`), it(`${C}.0`, `${C}_0`), it(`${B}.0`, `${B}_0`)]);
    expect(r.map((i) => i.origin)).toEqual([`${A}_0`, `${C}_0`, `${B}_0`]);
  });
});

describe('album shown once on the Media home', () => {
  const once = (b: { inHero: boolean; fullList: boolean }) => Number(b.inHero) + Number(b.fullList);
  test('hybrid with the album as hero: only the compact list in the hero', () => {
    expect(albumBlocks({ view: 'hybrid', heroIsAlbum: true, oneAlbum: true })).toEqual({
      inHero: true,
      fullList: false,
    });
  });
  test('list view, or another hero slide: only the full list', () => {
    expect(albumBlocks({ view: 'list', heroIsAlbum: true, oneAlbum: true })).toEqual({ inHero: false, fullList: true });
    expect(albumBlocks({ view: 'hybrid', heroIsAlbum: false, oneAlbum: true }).fullList).toBe(true);
  });
  test('never both, in any view', () => {
    for (const view of ['cards', 'list', 'hybrid'] as const)
      for (const heroIsAlbum of [true, false])
        for (const oneAlbum of [true, false])
          expect(once(albumBlocks({ view, heroIsAlbum, oneAlbum }))).toBeLessThanOrEqual(1);
  });
});
