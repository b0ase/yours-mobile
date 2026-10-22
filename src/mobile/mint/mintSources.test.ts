import { describe, expect, test } from 'bun:test';
import { MINT_KINDS } from './mintKinds';
import { MINT_SOURCES, mintSource } from './mintSources';

describe('mint sources', () => {
  test('every platform picks a real mint type', () => {
    const kinds = new Set(MINT_KINDS.map((k) => k.id));
    for (const s of MINT_SOURCES) expect(kinds.has(s.kind)).toBe(true);
  });

  test('every platform says how to get the file', () => {
    for (const s of MINT_SOURCES) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.steps.length).toBeGreaterThan(0);
      for (const step of s.steps) expect(step.trim().length).toBeGreaterThan(0);
    }
  });

  test('ids are unique and look up', () => {
    const ids = MINT_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(mintSource(id)?.id).toBe(id);
  });

  test('video platforms pick Video, music platforms pick Music', () => {
    expect(mintSource('youtube')?.kind).toBe('video');
    expect(mintSource('tiktok')?.kind).toBe('video');
    expect(mintSource('soundcloud')?.kind).toBe('music');
    expect(mintSource('instagram')?.kind).toBe('picture');
  });
});
