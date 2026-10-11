import { describe, expect, test } from 'bun:test';
import { cardFrontArtUri } from './cardFrontArt';
import { bavatarSvg } from '../bavatar/bavatar';

const A = '02' + 'a1'.repeat(32);
const B = '03' + 'b2'.repeat(32);

describe('cardFrontArtUri', () => {
  test('bWalletX: the account bAvatar art, seeded by the identity key', () => {
    const uri = cardFrontArtUri(A, false);
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(uri.split(',')[1])).toBe(bavatarSvg(A, { size: 512, label: '' }));
  });
  test('different accounts get different art; same account is cached and stable', () => {
    expect(cardFrontArtUri(A, false)).not.toBe(cardFrontArtUri(B, false));
    expect(cardFrontArtUri(A.toUpperCase(), false)).toBe(cardFrontArtUri(A, false));
  });
  test('bWallet edition keeps the yellow card', () => {
    expect(cardFrontArtUri(A, true)).toBe('');
  });
  test('no identity key: no art', () => {
    expect(cardFrontArtUri(undefined, false)).toBe('');
    expect(cardFrontArtUri('alice', false)).toBe('');
  });
});
