import { describe, expect, test } from 'bun:test';
import { clipsForSale, fetchOriginals, normaliseId, ORIGINALS_URL, parseOriginals } from './movies';

const T = 'a'.repeat(64);
const C = 'b'.repeat(64);
const row = (over: Record<string, unknown> = {}) => ({
  original: true,
  tokenId: `${T}_0`,
  title: 'Night Shift',
  ticker: '$NIGHT',
  poster: '/p.jpg',
  trailerUrl: 'https://cdn.example/t.mp4',
  clips: [
    { outpoint: `${C}_1`, title: 'Opening', price: 1000 },
    { outpoint: `${C}_2`, title: 'Unlisted' },
  ],
  ...over,
});

describe('Exchange › Movies', () => {
  test('normaliseId: outpoints only, lower-case, dot to underscore', () => {
    expect(normaliseId(`${T.toUpperCase()}.3`)).toBe(`${T}_3`);
    expect(normaliseId('NIGHT')).toBeNull();
    expect(normaliseId(42)).toBeNull();
  });

  test('parseOriginals keeps only Originals (no source tweet) with a token ID', () => {
    const out = parseOriginals({
      originals: [
        row(),
        row({ tokenId: `${'c'.repeat(64)}_0`, original: false }),
        row({ tokenId: `${'d'.repeat(64)}_0`, sourceTweet: 'https://x.com/a/status/1' }),
        row({ tokenId: 'NIGHT' }),
        row({ title: 'Duplicate' }),
      ],
    });
    expect(out.map((o) => o.tokenId)).toEqual([`${T}_0`]);
    expect(out[0].title).toBe('Night Shift');
    expect(out[0].ticker).toBe('NIGHT');
    expect(out[0].poster).toBe('https://www.bmovies.app/p.jpg');
  });

  test('keyed on token ID, not ticker: same ticker, two tokens, two movies', () => {
    const out = parseOriginals({ originals: [row(), row({ tokenId: `${C}_0` })] });
    expect(out).toHaveLength(2);
  });

  test('clipsForSale lists only priced clips', () => {
    const [m] = parseOriginals({ originals: [row()] });
    expect(m.clips).toHaveLength(2);
    expect(clipsForSale(m).map((c) => c.outpoint)).toEqual([`${C}_1`]);
  });

  test('junk bodies give no movies', () => {
    expect(parseOriginals(null)).toEqual([]);
    expect(parseOriginals({ originals: 'x' })).toEqual([]);
    expect(parseOriginals([row()])).toEqual([]);
  });

  test('fetchOriginals: a missing endpoint is an empty list, never made-up rows', async () => {
    const seen: string[] = [];
    const miss = (async (u: string) => {
      seen.push(u);
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    expect(await fetchOriginals(miss)).toEqual([]);
    expect(seen).toEqual([ORIGINALS_URL]);
    const boom = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchOriginals(boom)).toEqual([]);
    const ok = (async () => Response.json({ originals: [row()] })) as unknown as typeof fetch;
    expect((await fetchOriginals(ok)).map((o) => o.tokenId)).toEqual([`${T}_0`]);
  });
});
