import { describe, expect, test } from 'bun:test';
import type { WalletOutput } from '@bsv/sdk';
import { isMediaOutput, kindOf } from './media';

const out = (tags: string[]) => ({ outpoint: 'x.0', satoshis: 1, spendable: true, tags }) as WalletOutput;

describe('media filters', () => {
  test('kindOf groups by MIME family', () => {
    expect(kindOf('audio/mpeg')).toBe('music');
    expect(kindOf('video/mp4')).toBe('video');
    expect(kindOf('image/png')).toBe('images');
    expect(kindOf('text/html')).toBe('other');
    expect(kindOf(undefined)).toBe('other');
  });
  test('fungible tokens are not media', () => {
    expect(isMediaOutput(out(['type:application/bsv-20']))).toBe(false);
    expect(isMediaOutput(out(['type:image/png']))).toBe(true);
  });
});
