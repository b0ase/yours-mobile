import { describe, expect, test } from 'bun:test';
import { applyClaims, claimTicker, parseClaim, parseEligibility } from './claim';
import type { Clip } from './bmovies';

const TOKEN = `${'a'.repeat(64)}_0`;
const clip = (o: Partial<Clip> = {}): Clip => ({
  id: 'convert-2102001651062026668-x',
  offerId: 'convert-2102001651062026668-x',
  title: 'Dear Claudette',
  blurb: '',
  ticker: '',
  handle: 'gossip_goblin',
  tweetUrl: null,
  src: 'https://x/a.mp4',
  poster: null,
  at: 1,
  registered: false,
  ...o,
});

describe('bMovies REGISTER claims', () => {
  test('eligibility answers parse; anything odd means nothing to do', () => {
    expect(parseEligibility({ status: 'eligible', author: 'gossip_goblin' })).toEqual({
      status: 'eligible',
      author: 'gossip_goblin',
    });
    expect(parseEligibility({ status: 'not_author', author: 'gossip_goblin', you: 'bob' })).toEqual({
      status: 'not_author',
      author: 'gossip_goblin',
      you: 'bob',
    });
    expect(parseEligibility({ status: 'eligible' }).status).toBe('unknown_tweet');
    expect(parseEligibility({ status: 'claimed', claim: { tweet_id: '1234567', token_id: 'nope' } }).status).toBe(
      'unknown_tweet',
    );
    expect(parseEligibility(null).status).toBe('unknown_tweet');
  });

  test('claim rows need a tweet id and a token outpoint', () => {
    expect(
      parseClaim({ tweet_id: '2102001651062026668', token_id: TOKEN, ticker: 'DEAR', claimant_handle: 'alice' }),
    ).toEqual({ tweetId: '2102001651062026668', tokenId: TOKEN, ticker: 'DEAR', claimant: 'alice' });
    expect(parseClaim({ tweet_id: 'x', token_id: TOKEN })).toBeNull();
  });

  test('ticker: display ticker, else title, else BMOVIE', () => {
    expect(claimTicker({ ticker: '$goblin', title: 'x' })).toBe('GOBLIN');
    expect(claimTicker({ ticker: '', title: 'Dear Claudette: part 2' })).toBe('DEARCLAUDETT');
    expect(claimTicker({ ticker: '', title: '日本' })).toBe('BMOVIE');
  });

  test('a claimed tweet turns its clip into BUY / SELL with the claimed ticker', () => {
    const tid = (c: Clip) => /-(\d+)-/.exec(c.id)?.[1] ?? null;
    const claims = [{ tweetId: '2102001651062026668', tokenId: TOKEN, ticker: 'DEAR', claimant: 'alice' }];
    const [c] = applyClaims([clip()], claims, tid);
    expect(c.registered).toBe(true);
    expect(c.ticker).toBe('DEAR');
    const [other] = applyClaims([clip({ id: 'convert-999999999999-x' })], claims, tid);
    expect(other.registered).toBe(false);
  });
});
