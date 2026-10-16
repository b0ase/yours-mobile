/**
 * Feed › bRadio › Podcasts: public podcast RSS feeds. Episodes stream straight from each
 * publisher's enclosure URL; nothing is copied or re-hosted.
 *
 * Checked 15 Oct 2026: each URL returns RSS with recent audio <enclosure>s and sends
 * `Access-Control-Allow-Origin: *`, so web and desktop can read it too (phones use native HTTP).
 * A feed without CORS would fail on web, so it isn't listed. No active BSV-only show with audio
 * enclosures was found (CoinGeek Conversations' feed no longer lists episodes).
 */
export type PodcastShow = {
  id: string;
  name: string;
  rss: string;
  homepage: string;
};

export const PODCAST_SHOWS: PodcastShow[] = [
  {
    id: 'whatbitcoindid',
    name: 'What Bitcoin Did',
    rss: 'https://feeds.fountain.fm/UZSKQcrOnhqYS1JopxGg',
    homepage: 'https://www.whatbitcoindid.com/',
  },
  {
    id: 'bitcoin-takeover',
    name: 'Bitcoin Takeover',
    rss: 'https://bitcoin-takeover.com/audio/feed.xml',
    homepage: 'https://bitcoin-takeover.com/',
  },
  {
    id: 'coin-stories',
    name: 'Coin Stories',
    rss: 'https://feeds.simplecast.com/760kY6cd',
    homepage: 'https://www.nataliebrunell.com/',
  },
  {
    id: 'tftc',
    name: 'TFTC',
    rss: 'https://feeds.fountain.fm/ZwwaDULvAj0yZvJ5kdB9',
    homepage: 'https://tftc.io/',
  },
  {
    id: 'bitcoin-audible',
    name: 'Bitcoin Audible',
    rss: 'https://feeds.fountain.fm/jju8hH7aXnP0afzXN7GS',
    homepage: 'https://bitcoinaudible.com/',
  },
  {
    id: 'hard-fork',
    name: 'Hard Fork',
    rss: 'https://feeds.simplecast.com/6HKOhNgS',
    homepage: 'https://www.nytimes.com/column/hard-fork',
  },
  {
    id: 'decoder',
    name: 'Decoder',
    rss: 'https://feeds.megaphone.fm/recodedecode',
    homepage: 'https://www.theverge.com/decoder-podcast-with-nilay-patel',
  },
  {
    id: 'syntax',
    name: 'Syntax',
    rss: 'https://feeds.megaphone.fm/FSI1483080183',
    homepage: 'https://syntax.fm/',
  },
];
