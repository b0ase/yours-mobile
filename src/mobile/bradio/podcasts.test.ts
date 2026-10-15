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
  PodcastListedError,
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
  const card = {
    ticker: 'LOUNGE',
    room_name: 'Lounge',
    title: 'Lounge live',
    host: '@b',
    host_avatar: 'https://cdn.example.com/b.png',
    gated: false,
    entry_line: null,
    speakers: 2,
    listeners: 4,
    started_at: '2026-10-15T10:00:00Z',
    ended_at: null,
    page: '/s/lounge',
    reason: 'following',
  };
  test('parses {live:[card]}; slug from page; skips page null and bad slugs', () => {
    const out = parseLiveSpaces({
      live: [card, { ...card, page: null }, { ...card, page: '/s/no%2Fpe' }, { ...card, page: '/x/y' }],
      generated_at: 'x',
    });
    expect(out).toEqual([
      {
        slug: 'lounge',
        ticker: 'LOUNGE',
        title: 'Lounge live',
        host: 'b',
        hostAvatar: 'https://cdn.example.com/b.png',
        listeners: 4,
        speakers: 2,
        gated: false,
        reason: 'following',
      },
    ]);
  });
  test('live server shape (page_url)', () => {
    const { page: _p, ...rest } = card;
    expect(parseLiveSpaces({ live: [{ ...rest, page_url: '/s/lounge', listen_url: '/s/lounge' }] })[0].slug).toBe(
      'lounge',
    );
  });
  test('falls back to room_name; unknown reason and http avatar dropped', () => {
    const [s] = parseLiveSpaces({ live: [{ ...card, title: '', reason: 'x', host_avatar: 'http://a/b.png' }] });
    expect(s.title).toBe('Lounge');
    expect(s.reason).toBeNull();
    expect(s.hostAvatar).toBeNull();
  });
  test('missing endpoint → none', async () => {
    expect(await fetchLiveSpaces(async () => res(404, null), 'b0asex')).toEqual([]);
  });
});

describe('podcast nulls and paging', () => {
  test('null hostIdKey/previewUrl/nft are fine; next is the cursor', () => {
    const p = parsePodcastPage({
      items: [{ id: 'p1', title: 'T', hostIdKey: null, previewUrl: null, nft: null }],
      next: 'c2',
    });
    expect(p.items[0].hostIdKey).toBeNull();
    expect(p.items[0].previewUrl).toBeNull();
    expect(p.items[0].nft).toBeNull();
    expect(p.cursor).toBe('c2');
    expect(parsePodcastPage({ items: [], next: null }).cursor).toBeNull();
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
    expect(calls[1].headers['x-bwx-nonce']).toBe('n1');
    expect(calls.length).toBe(2);
  });
  test('refusal → one fresh challenge with a new nonce, then success', async () => {
    const nonces: string[] = [];
    let n = 0;
    const f = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/challenge')) return res(200, { nonce: `n${++n}` });
      const h = (init?.headers ?? {}) as Record<string, string>;
      nonces.push(h['x-bwx-nonce']);
      return nonces.length === 1 ? res(401, null) : res(200, { url: 'https://cdn/y.mp3' });
    };
    expect(await fetchOwnedAudio(f, pod, async () => ({ pubKey: 'p', sig: 's' }))).toBe('https://cdn/y.mp3');
    expect(nonces).toEqual(['n1', 'n2']);
  });
  test('two refusals → null after exactly two challenges', async () => {
    let challenges = 0;
    const f = async (url: string) =>
      url.endsWith('/challenge') ? (challenges++, res(200, { nonce: 'n' })) : res(403, null);
    expect(await fetchOwnedAudio(f, pod, async () => ({ pubKey: 'p', sig: 's' }))).toBeNull();
    expect(challenges).toBe(2);
  });
  test('audio 404 (unknown or excluded) → null, no retry', async () => {
    let challenges = 0;
    const f = async (url: string) =>
      url.endsWith('/challenge') ? (challenges++, res(200, { nonce: 'n' })) : res(404, null);
    expect(await fetchOwnedAudio(f, pod, async () => ({ pubKey: 'p', sig: 's' }))).toBeNull();
    expect(challenges).toBe(1);
  });
  test('listed item: signer refusal propagates, no audio request', async () => {
    const urls: string[] = [];
    const f = async (url: string) => (urls.push(url), res(200, { nonce: 'n' }));
    const signer = async (): Promise<{ pubKey: string; sig: string }> => {
      throw new PodcastListedError();
    };
    await expect(fetchOwnedAudio(f, pod, signer)).rejects.toBeInstanceOf(PodcastListedError);
    expect(urls.every((u) => u.endsWith('/challenge'))).toBe(true);
  });
  test('challenge 404 → null without signing', async () => {
    let signed = false;
    const f = async () => res(404, null);
    expect(await fetchOwnedAudio(f, pod, async () => ((signed = true), { pubKey: 'p', sig: 's' }))).toBeNull();
    expect(signed).toBe(false);
  });
  test('403 owner-only → null (preview fallback)', async () => {
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
  test('prefers url over slug', () => {
    expect(routeFromData({ kind: 'space_live', slug: 'a', url: 'bwalletx://space/b' })).toEqual({
      segment: 'space',
      ticker: 'b',
    });
    expect(routeFromData({ kind: 'space_live', slug: 'a', url: 'https://x/y' })).toEqual({
      segment: 'space',
      ticker: 'a',
    });
  });
});
