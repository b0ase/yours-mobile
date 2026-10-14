import { describe, expect, test } from 'bun:test';
import { PACKS, PD_ART, SUB_FEEDS, resolveArt, subPick } from './cardArt';

describe('card art catalogue', () => {
  test('every public-domain work has a licence, a source and a licence proof', () => {
    expect(PD_ART.length).toBeGreaterThanOrEqual(10);
    for (const a of PD_ART) {
      expect(a.licence).toBe('CC0');
      expect(a.source).toMatch(/^https:\/\/www\.metmuseum\.org\/art\/collection\/search\/\d+$/);
      expect(a.licenceProof).toMatch(/^https:\/\/collectionapi\.metmuseum\.org\//);
      expect(a.title && a.artist && a.year && a.museum && a.src).toBeTruthy();
    }
    expect(new Set(PD_ART.map((a) => a.id)).size).toBe(PD_ART.length);
  });
  test('credits resolve', () => {
    expect(resolveArt({ kind: 'art', id: 'met-45434' })?.line).toBe(
      'Katsushika Hokusai · The Great Wave · The Met (CC0)',
    );
    expect(resolveArt({ kind: 'pack', pack: 'vexvoid', id: 'cover' })?.line).toBe('Art: VexVoid · Echoes in the Abyss');
    expect(PACKS.every((p) => p.items.length >= 4)).toBe(true);
  });
  test('mock subscription rotates weekly and reports paid so far', () => {
    expect(SUB_FEEDS.map((f) => f.id).sort()).toEqual(['bart', 'bmusic', 'bpics']);
    expect(subPick('bmusic', 0)).not.toEqual(subPick('bmusic', 1));
    expect(subPick('bmusic', 4)).toEqual(subPick('bmusic', 0));
    expect(resolveArt({ kind: 'sub', feed: 'bmusic', week: 0, paid: 4, active: true })?.line).toBe(
      'This week: Echoes in the Abyss by VexVoid · bMusic subscription · 1p/week · paid so far 4p',
    );
  });
});
