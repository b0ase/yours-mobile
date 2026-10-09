import { describe, expect, test } from 'bun:test';
import { bytesToSealed, decodeEnvelope, encodeEnvelope, newMessageId, sealedToBytes, type Envelope } from './envelope';
import { quote, rank, route, split, type MailMeta } from './route';
import { parseProfile } from '../calls/rateCard';

const K = (c: string) => `02${c.repeat(64)}`;
const env = (o: Partial<Envelope> = {}): Envelope => ({
  t: 'bmail',
  v: 1,
  id: 'ab'.repeat(16),
  from: K('a'),
  to: K('b'),
  at: 1000,
  sealed: 'c2VhbGVk',
  ...o,
});
const postage = {
  txid: 'f'.repeat(64),
  sats: 500,
  outputIndex: 0,
  beef: '0100',
  derivationPrefix: 'p',
  derivationSuffix: 's',
};

describe('envelope', () => {
  test('round-trips, including postage and reply-paid', () => {
    const e = env({ postage, replyPaidSats: 200, inReplyTo: 'cd'.repeat(16), usesReplyCredit: true });
    expect(decodeEnvelope(encodeEnvelope(e))).toEqual(e);
    expect(decodeEnvelope(JSON.parse(encodeEnvelope(e)))).toEqual(e);
  });
  test('rejects junk and bad fields', () => {
    expect(decodeEnvelope('not json')).toBeNull();
    expect(decodeEnvelope({ ...env(), t: 'x' })).toBeNull();
    expect(decodeEnvelope({ ...env(), from: 'nope' })).toBeNull();
    expect(decodeEnvelope({ ...env(), at: -1 })).toBeNull();
  });
  test('drops malformed postage and reply-paid above postage', () => {
    expect(decodeEnvelope({ ...env(), postage: { ...postage, txid: 'x' } })?.postage).toBeUndefined();
    expect(decodeEnvelope({ ...env(), postage: { ...postage, sats: 0 } })?.postage).toBeUndefined();
    expect(decodeEnvelope({ ...env(), postage, replyPaidSats: 900 })?.replyPaidSats).toBeUndefined();
    expect(decodeEnvelope({ ...env(), usesReplyCredit: true })?.usesReplyCredit).toBeUndefined();
  });
  test('sealed bytes round-trip and clamp', () => {
    expect(bytesToSealed(sealedToBytes({ subject: 'Hi', body: 'There ✉️' }))).toEqual({
      subject: 'Hi',
      body: 'There ✉️',
    });
    expect(bytesToSealed(sealedToBytes({ subject: 'x'.repeat(500), body: '' })).subject.length).toBe(120);
  });
  test('message ids are 32 hex chars', () => expect(newMessageId()).toMatch(/^[0-9a-f]{32}$/));
});

const m = (id: string, from: string, verifiedSats: number, at: number, replyCredit = false): MailMeta => ({
  id,
  from,
  verifiedSats,
  at,
  replyCredit,
});

describe('routing and ranking', () => {
  const friends = new Set([K('f')]);
  const isFriend = (k: string) => friends.has(k);
  test('friends free into Inbox; strangers need verified postage ≥ price', () => {
    expect(route(m('1', K('f'), 0, 1), { isFriend, priceSats: 100 })).toBe('inbox');
    expect(route(m('2', K('s'), 100, 1), { isFriend, priceSats: 100 })).toBe('inbox');
    expect(route(m('3', K('s'), 99, 1), { isFriend, priceSats: 100 })).toBe('requests');
    expect(route(m('4', K('s'), 0, 1), { isFriend, priceSats: 0 })).toBe('requests');
    expect(route(m('5', K('s'), 0, 1, true), { isFriend, priceSats: 100 })).toBe('inbox');
  });
  test('friends on top, then highest postage, ties newest; Newest toggle', () => {
    const mail = [m('a', K('s'), 100, 5), m('b', K('f'), 0, 1), m('c', K('t'), 900, 2), m('d', K('u'), 100, 9)];
    expect(rank(mail, { isFriend }).map((x) => x.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(rank(mail, { isFriend, newest: true }).map((x) => x.id)).toEqual(['d', 'a', 'c', 'b']);
    const s = split(mail, { isFriend, priceSats: 500 });
    expect(s.inbox.map((x) => x.id)).toEqual(['b', 'c']);
    expect(s.requests.map((x) => x.id)).toEqual(['d', 'a']);
  });
  test('quote: tiers are multiples of the price, reply paid added', () => {
    expect(quote(300, 'standard')).toEqual({ stamp: 300, replyPaid: 0, total: 300 });
    expect(quote(300, 'priority', 200)).toEqual({ stamp: 900, replyPaid: 200, total: 1100 });
    expect(quote(0, 'standard').stamp).toBe(1);
  });
  test('profile keeps a valid mail price only', () => {
    expect(parseProfile({ mail: { usd: 0.05 } }).mail).toEqual({ usd: 0.05 });
    expect(parseProfile({ mail: { usd: -1 } }).mail).toBeUndefined();
    expect('mail' in parseProfile({})).toBe(false);
  });
});

describe('examples', () => {
  test('examples are display-only: ids can never be real message ids, inbox and requests both covered', async () => {
    const { EXAMPLES } = await import('./examples');
    for (const e of EXAMPLES) expect(/^[0-9a-f]{8,64}$/i.test(e.id)).toBe(false);
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    expect(EXAMPLES.some((e) => e.box === 'requests' && e.token?.spreading)).toBe(true);
    expect(EXAMPLES.some((e) => e.stamps.includes('reply'))).toBe(true);
  });
});
