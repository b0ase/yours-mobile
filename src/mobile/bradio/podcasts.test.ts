import { describe, expect, test } from 'bun:test';
import fixture from './fixtures/podcasts.json';
import {
  fetchLiveSpaces,
  fetchOwnedAudio,
  fetchPodcasts,
  forSale,
  isOwned,
  normOutpoint,
  parseLiveSpaces,
  parsePodcastPage,
  podcastProofMessage,
} from './podcasts';
import { routeFromData, routeFromQuery, routeToQuery } from '../push/logic';

const res = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('podcast catalogue (fixtures)', () => {
  const page = parsePodcastPage(fixture);
  test('keeps valid items, drops bad ids and non-https media', () => {
    expect(page.items.map((p) => p.id)).toEqual(['pod_abc123', 'pod_nopreview', 'pod_insecure']);
    expect(page.items[2].previewUrl).toBeNull();
    expect(page.cursor).toBe('next-1');
  });
  test('never carries a full audio URL; normalises origins and handles', () => {
    const p = page.items[0];
    expect('audioUrl' in p).toBe(false);
    expect(p.host).toBe('b0asex');
    expect(p.nft?.origin).toBe(`${'a'.repeat(64)}_0`);
    expect(p.nft?.price).toBe(50000);
  });
  test('for sale and ownership', () => {
    expect(forSale(page.items).map((p) => p.id)).toEqual(['pod_abc123']);
    expect(isOwned(page.items[0], new Set([normOutpoint(`${'A'.repeat(64)}.0`)]))).toBe(true);
    expect(isOwned(page.items[0], new Set())).toBe(false);
    expect(isOwned(page.items[1], new Set(['x']))).toBe(false);
  });
  test('missing endpoint → empty page', async () => {
    expect(await fetchPodcasts(async () => res(404, null))).toEqual({ items: [], cursor: null });
    expect(
      await fetchPodcasts(async () => {
        throw new Error('offline');
      }),
    ).toEqual({ items: [], cursor: null });
  });
});

describe('live spaces', () => {
  test('parses and filters slugs', () => {
    expect(
      parseLiveSpaces({ spaces: [{ slug: 'lounge', title: 'Lounge', host: '@b', listeners: 4 }, { slug: 'no/pe' }] }),
    ).toEqual([{ slug: 'lounge', title: 'Lounge', host: 'b', listeners: 4 }]);
  });
  test('missing endpoint → none', async () => {
    expect(await fetchLiveSpaces(async () => res(404, null), 'b0asex')).toEqual([]);
  });
});

describe('owned audio (challenge + signature)', () => {
  const pod = parsePodcastPage(fixture).items[0];
  test('signs bwx-podcast:<id>:<nonce> and sends the proof headers', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    let signed = '';
    const f = async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return url.endsWith('/challenge')
        ? res(200, { nonce: 'n1', expiresAt: 'x' })
        : res(200, { url: 'https://cdn/x.mp3' });
    };
    const url = await fetchOwnedAudio(f, pod, async (m) => ((signed = m), { pubKey: 'PK', sig: 'SIG' }));
    expect(url).toBe('https://cdn/x.mp3');
    expect(signed).toBe(podcastProofMessage('pod_abc123', 'n1'));
    expect(calls[1].headers['x-bwx-origin']).toBe(pod.nft!.origin);
    expect(calls[1].headers['x-bwx-pubkey']).toBe('PK');
    expect(calls[1].headers['x-bwx-sig']).toBe('SIG');
  });
  test('403 stub → null (preview fallback)', async () => {
    const f = async (url: string) => (url.endsWith('/challenge') ? res(200, { nonce: 'n' }) : res(403, null));
    expect(await fetchOwnedAudio(f, pod, async () => ({ pubKey: 'p', sig: 's' }))).toBeNull();
  });
});

describe('space_live push', () => {
  test('routes to the Space', () => {
    const r = routeFromData({ kind: 'space_live', slug: 'lounge', host: 'b', title: 'Live' });
    expect(r).toEqual({ segment: 'space', ticker: 'lounge' });
    expect(routeFromQuery(`?${routeToQuery(r!)}`)).toEqual(r);
    expect(routeFromData({ kind: 'space_live', slug: '../x' })).toBeNull();
  });
});
