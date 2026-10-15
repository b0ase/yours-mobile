import { describe, expect, test } from 'bun:test';
import { PODCAST_SHOWS } from './podcastFeeds';
import {
  CACHE_MS,
  fetchPublicEpisodes,
  formatDuration,
  mergeEpisodes,
  parseDuration,
  parsePodcastRss,
  readCache,
  writeCache,
} from './rssPodcasts';

const show = { id: 'demo', name: 'Demo Show', rss: 'https://x.test/rss', homepage: 'https://x.test/' };

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<title>Demo</title><itunes:image href="https://x.test/show.jpg"/>
<item><title><![CDATA[Older &amp; wiser]]></title><pubDate>Mon, 12 Oct 2026 10:00:00 +0000</pubDate>
<guid isPermaLink="false">ep1</guid><enclosure url="https://cdn.x.test/1.mp3" type="audio/mpeg" length="1"/>
<itunes:duration>1:02:03</itunes:duration></item>
<item><title>Newest</title><pubDate>Wed, 14 Oct 2026 10:00:00 +0000</pubDate>
<enclosure url="https://cdn.x.test/2.mp3" type="audio/mpeg"/><itunes:image href="https://x.test/ep2.jpg"/>
<itunes:duration>2700</itunes:duration></item>
<item><title>Video only</title><enclosure url="https://cdn.x.test/v.mp4" type="video/mp4"/></item>
<item><title>Plain http</title><enclosure url="http://cdn.x.test/3.mp3" type="audio/mpeg"/></item>
</channel></rss>`;

describe('parsePodcastRss', () => {
  test('keeps https audio enclosures, newest first, with art and duration', () => {
    const eps = parsePodcastRss(RSS, show);
    expect(eps.map((e) => e.title)).toEqual(['Newest', 'Older & wiser']);
    expect(eps[0]).toMatchObject({ image: 'https://x.test/ep2.jpg', duration: 2700, showName: 'Demo Show' });
    expect(eps[1]).toMatchObject({ id: 'demo:ep1', image: 'https://x.test/show.jpg', duration: 3723 });
    expect(eps[1].audio).toBe('https://cdn.x.test/1.mp3');
  });
  test('non-RSS gives nothing', () => {
    expect(parsePodcastRss('<html></html>', show)).toEqual([]);
    expect(parsePodcastRss('', show)).toEqual([]);
  });
});

describe('durations', () => {
  test('parse', () => {
    expect(parseDuration('45:10')).toBe(2710);
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('abc')).toBe(0);
    expect(parseDuration(null)).toBe(0);
  });
  test('format', () => {
    expect(formatDuration(3723)).toBe('1 h 2 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(2700)).toBe('45 min');
    expect(formatDuration(30)).toBe('30 s');
    expect(formatDuration(0)).toBe('');
  });
});

describe('merge, cache, fetch', () => {
  test('merge caps per show and overall', () => {
    const eps = parsePodcastRss(RSS, show);
    expect(mergeEpisodes([eps, eps], 1, 1)).toHaveLength(1);
  });
  test('cache expires after 30 min', () => {
    const mem = new Map<string, string>();
    const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const eps = parsePodcastRss(RSS, show);
    writeCache(eps, 1000, s);
    expect(readCache(1000 + CACHE_MS - 1, s)).toHaveLength(2);
    expect(readCache(1000 + CACHE_MS + 1, s)).toBeNull();
  });
  test('failed feeds are skipped', async () => {
    const eps = await fetchPublicEpisodes(
      async (u) => (u === show.rss ? RSS : Promise.reject(new Error('x'))),
      [show, { ...show, id: 'bad', rss: 'https://bad.test/' }],
    );
    expect(eps.map((e) => e.showId)).toEqual(['demo', 'demo']);
  });
  test('shows are https with homepages', () => {
    expect(PODCAST_SHOWS.length).toBeGreaterThanOrEqual(6);
    for (const s of PODCAST_SHOWS) expect(s.rss.startsWith('https://') && s.homepage.startsWith('https://')).toBe(true);
  });
});
