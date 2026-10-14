import { describe, expect, test } from 'bun:test';
import {
  dedupeNews,
  discussionFor,
  fetchNews,
  hideStory,
  HIDDEN_KEY,
  loadHidden,
  MAX_HIDDEN,
  normalizeUrl,
  parseFeed,
  swipeCloses,
  unhideStory,
  visibleNews,
  type NewsItem,
} from './bnews';

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<title>CoinGeek</title>
<item>
  <title>Zumo launches &#8216;UK Tracker&#8217; &amp; more</title>
  <link>https://coingeek.com/zumo/?utm_source=rss</link>
  <pubDate>Wed, 14 Oct 2026 05:00:00 +0000</pubDate>
  <description><![CDATA[<p>Full article body that must not be kept.</p>]]></description>
  <media:content url="https://cdn.example.com/a.jpg" medium="image" />
</item>
<item>
  <title><![CDATA[No link item]]></title>
</item>
<item>
  <title>Guid permalink</title>
  <guid>https://coingeek.com/guid-story/</guid>
  <enclosure url="http://insecure.example.com/b.jpg" type="image/jpeg" />
</item>
<item>
  <title>Bad scheme</title>
  <link>javascript:alert(1)</link>
</item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title type="html">Atom &lt;b&gt;story&lt;/b&gt;</title>
  <link rel="alternate" href="https://www.example.org/post#top"/>
  <published>2026-10-13T10:00:00Z</published>
  <media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" url="https://img.example.org/t.png"/>
</entry>
</feed>`;

const src = { id: 'coingeek' as const, label: 'CoinGeek' };

describe('parseFeed', () => {
  test('RSS: headline, link, time, https image; no body; skips items without a web link', () => {
    const items = parseFeed(RSS, src);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({
      id: 'https://coingeek.com/zumo',
      title: 'Zumo launches ‘UK Tracker’ & more',
      link: 'https://coingeek.com/zumo/?utm_source=rss',
      source: 'coingeek',
      sourceLabel: 'CoinGeek',
      at: Date.parse('2026-10-14T05:00:00Z'),
      image: 'https://cdn.example.com/a.jpg',
    });
    expect(JSON.stringify(items)).not.toContain('Full article body');
    expect(items[1].link).toBe('https://coingeek.com/guid-story/');
    expect(items[1].image).toBeNull(); // http image dropped
    expect(items[1].at).toBe(0);
  });

  test('Atom: alternate link, tags stripped from the title', () => {
    const [it] = parseFeed(ATOM, { id: 'hn', label: 'HN' });
    expect(it.title).toBe('Atom story');
    expect(it.id).toBe('https://example.org/post');
    expect(it.image).toBe('https://img.example.org/t.png');
    expect(it.at).toBe(Date.parse('2026-10-13T10:00:00Z'));
  });

  test('junk input gives nothing', () => {
    expect(parseFeed('', src)).toEqual([]);
    expect(parseFeed('<html>not a feed</html>', src)).toEqual([]);
  });
});

describe('normalizeUrl', () => {
  test('drops www, hash, tracking params, trailing slash; keeps real params', () => {
    expect(normalizeUrl('http://WWW.Example.com/a/?utm_medium=x&id=3&fbclid=9#h')).toBe('https://example.com/a/?id=3');
    expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
  });
});

const item = (id: string, at: number, extra: Partial<NewsItem> = {}): NewsItem => ({
  id,
  title: `t ${id}`,
  link: id,
  source: 'hn',
  sourceLabel: 'HN',
  at,
  image: null,
  ...extra,
});

describe('dedupeNews', () => {
  test('same link or same headline collapses; image filled from a duplicate; newest first', () => {
    const out = dedupeNews([
      [item('https://a.com/1', 1), item('https://a.com/2', 5, { title: 'Big News!' })],
      [
        item('https://a.com/1', 9, { image: 'https://i/1.png' }),
        item('https://b.com/x', 7, { title: 'big news' }),
        item('https://c.com/3', 3),
      ],
    ]);
    expect(out.map((i) => i.id)).toEqual(['https://a.com/2', 'https://c.com/3', 'https://a.com/1']);
    expect(out.find((i) => i.id === 'https://a.com/1')!.image).toBe('https://i/1.png');
  });
});

describe('swipe-hide', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  test('hide persists, unhide restores, visibleNews filters', () => {
    const s = mem();
    let h = hideStory([], 'x', s);
    h = hideStory(h, 'y', s);
    h = hideStory(h, 'x', s); // no duplicate
    expect(loadHidden(s)).toEqual(['y', 'x']);
    expect(visibleNews([item('x', 1), item('y', 2), item('z', 3)], h).map((i) => i.id)).toEqual(['z']);
    h = unhideStory(h, 'y', s);
    expect(loadHidden(s)).toEqual(['x']);
  });

  test('capped, and corrupt storage reads as empty', () => {
    const s = mem();
    let h: string[] = [];
    for (let i = 0; i < MAX_HIDDEN + 5; i++) h = hideStory(h, `s${i}`, s);
    expect(h.length).toBe(MAX_HIDDEN);
    expect(h[0]).toBe('s5');
    s.setItem(HIDDEN_KEY, '{nope');
    expect(loadHidden(s)).toEqual([]);
    expect(loadHidden(null)).toEqual([]);
  });

  test('only a mostly horizontal left swipe past the threshold closes', () => {
    expect(swipeCloses(-120, 10)).toBe(true);
    expect(swipeCloses(-60, 0)).toBe(false);
    expect(swipeCloses(120, 0)).toBe(false);
    expect(swipeCloses(-120, 100)).toBe(false);
  });
});

describe('discussionFor', () => {
  test('matches posts linking the story (normalised), dedupes, oldest first', () => {
    const id = 'https://coingeek.com/zumo';
    const posts = [
      { txid: 'b', text: 'Read this https://www.coingeek.com/zumo/?utm_source=x.', at: 2 },
      { txid: 'a', text: 'first! https://coingeek.com/zumo', at: 1 },
      { txid: 'a', text: 'first! https://coingeek.com/zumo', at: 1 },
      { txid: 'c', text: 'other https://coingeek.com/zumo-2', at: 0 },
    ];
    expect(discussionFor(id, posts).map((p) => p.txid)).toEqual(['a', 'b']);
  });
});

describe('fetchNews', () => {
  test('web reads only CORS sources; failures are skipped', async () => {
    const asked: string[] = [];
    const out = await fetchNews(false, async (u) => {
      asked.push(u);
      return RSS;
    });
    expect(asked).toEqual(['https://www.wired.com/feed/rss']);
    expect(out.length).toBe(2);
    const all = await fetchNews(true, async (u) => {
      if (u.includes('hnrss')) throw new Error('down');
      return u.includes('coingeek') ? RSS : null;
    });
    expect(all.length).toBe(2);
  });
});
