import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { bavatarSvg, blendFor, bavatarSeed } from './bavatar';
import { bavatarDataUri } from '../names/avatar';

const K = '02' + 'ab'.repeat(32);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('bAvatars (copy of bit-sign lib/bavatar)', () => {
  test('same key → same SVG, different keys differ', () => {
    expect(bavatarSvg(K)).toBe(bavatarSvg(K));
    expect(bavatarSvg(K)).not.toBe(bavatarSvg('03' + 'cd'.repeat(32)));
  });
  test('byte-identical to bChatX (bit-sign src/lib/bavatar/bavatar.ts at merge e11bdae9)', () => {
    // If this fails, the two copies have drifted: copy bit-sign's file over this one.
    expect(sha(bavatarSvg(K, { size: 128 }))).toBe('b80f040d370fee126744bec7e478cf0121232d238b18e59b212397bca3f64162');
    expect(sha(bavatarSvg('alice', { size: 128 }))).toBe(
      '311892148adc2f604ef58abfc0fa75bf6bdda3a5a4a115df24d9f9347186bd17',
    );
  });
  test('every blend is Bloom + 2–3 layers', () => {
    for (let i = 0; i < 100; i++) {
      const { styles } = blendFor(bavatarSeed('n' + i));
      expect(styles[0]).toBe('bloom');
      expect(styles.length >= 3 && styles.length <= 4).toBe(true);
    }
  });
  test('the account fallback is a data URI for a real key, empty otherwise', () => {
    expect(bavatarDataUri(K).startsWith('data:image/svg+xml')).toBe(true);
    expect(bavatarDataUri(K)).toBe(bavatarDataUri(K.toUpperCase()));
    expect(bavatarDataUri('')).toBe('');
    expect(bavatarDataUri('not-a-key')).toBe('');
  });
});
