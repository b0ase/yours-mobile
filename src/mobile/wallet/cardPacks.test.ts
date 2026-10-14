import { describe, expect, test } from 'bun:test';
import { ownsPack } from './cardPacks';

describe('holder art packs', () => {
  test('nothing held unlocks nothing', () => {
    for (const p of ['vexvoid', 'npg', 'npgx'] as const) expect(ownsPack(p, { tokens: [], nftNames: [] })).toBe(false);
  });
  test('tokens unlock their pack only', () => {
    const h = { tokens: ['npg'], nftNames: [] };
    expect(ownsPack('npg', h)).toBe(true);
    expect(ownsPack('npgx', h)).toBe(false);
    expect(ownsPack('npgx', { tokens: ['$NPGX'], nftNames: [] })).toBe(true);
    expect(ownsPack('npg', { tokens: ['NPGX'], nftNames: [] })).toBe(false);
    expect(ownsPack('vexvoid', { tokens: ['VEXVOID'], nftNames: [] })).toBe(true);
  });
  test('NFT names unlock', () => {
    expect(ownsPack('vexvoid', { tokens: [], nftNames: ['Echoes in the Abyss #3'] })).toBe(true);
    expect(ownsPack('npg', { tokens: [], nftNames: ['Ninja Punk Girls #12'] })).toBe(true);
    expect(ownsPack('npgx', { tokens: [], nftNames: ['NPGX Echo Neonflare'] })).toBe(true);
    expect(ownsPack('npg', { tokens: [], nftNames: ['NPGX Echo'] })).toBe(false);
  });
});
