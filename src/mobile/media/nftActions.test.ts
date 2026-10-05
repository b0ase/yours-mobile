import { describe, expect, test } from 'bun:test';
import { countNew, nftAvatarUri, normalizeOutpoint, ordinalsUrl, refreshMessage } from './nftActions';

const TX = 'a'.repeat(64);

describe('nft detail helpers', () => {
  test('normalizeOutpoint accepts . and _', () => {
    expect(normalizeOutpoint(`${TX}.3`)).toBe(`${TX}_3`);
    expect(normalizeOutpoint(`${TX.toUpperCase()}_0`)).toBe(`${TX}_0`);
    expect(normalizeOutpoint('nope')).toBe('');
    expect(normalizeOutpoint(undefined)).toBe('');
  });
  test('avatar uri and ordinals link', () => {
    expect(nftAvatarUri(`${TX}.1`)).toBe(`1sat://${TX}_1`);
    expect(nftAvatarUri('bad')).toBe('');
    expect(ordinalsUrl(`${TX}.1`)).toBe(`https://1satordinals.com/outpoint/${TX}_1`);
    expect(ordinalsUrl('')).toBe('');
  });
  test('refresh counting and message', () => {
    expect(countNew(['a', 'b'], ['a', 'b', 'c', 'd'])).toBe(2);
    expect(countNew(['a'], ['a'])).toBe(0);
    expect(refreshMessage(1)).toBe('1 new NFT');
    expect(refreshMessage(2)).toBe('2 new NFTs');
    expect(refreshMessage(0)).toBe('Up to date');
    expect(refreshMessage(0, false)).toBe('Showing the latest the indexer has');
  });
});
