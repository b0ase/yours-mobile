import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parsePeckBody, parsePeckFeed, parsePeckItem } from './peck';
import { sourceOf, sourceUrl } from './sources';
import { payDestination } from './tip';
import { mergePosts } from './post';

// Recorded from overlay.peck.to on 2026-10-06.
const fx = (f: string) => parsePeckBody(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const feed = fx('overlay-peck.json') as { data: Record<string, unknown>[] };
const posts = parsePeckFeed(feed);
const REPLY = 'a25696357a71c1708c645ce4a509140be64c6117c26d067d9fd7040a93cb2bdf';
const ROOT = '8687b6a41f262fe8ec944997f668df181bbe0b82d01c2c8130bd9ef93340ced4';

describe('Peck (overlay.peck.to)', () => {
  test('reads posts and replies, drops reposts', () => {
    expect(feed.data.length).toBe(12);
    expect(posts.length).toBe(11);
    expect(posts.every((p) => p.source === 'peck' && p.app === 'peck.to')).toBe(true);
  });
  test('reply fields', () => {
    const r = posts.find((p) => p.txid === REPLY)!;
    expect(r.replyTo).toBe(ROOT);
    expect(r.at).toBe(Date.parse('2026-10-06T13:11:19.000Z'));
    expect(r.text.startsWith('Live check, part two')).toBe(true);
    expect(sourceUrl(r)).toBe(`https://peck.to/tx/${REPLY}`);
  });
  test('tips only to an AIP-verified signer', () => {
    const r = posts.find((p) => p.txid === REPLY)!;
    expect(payDestination(r)).toEqual({ ok: true, address: '1M9wtEmxLsBxTojuH13Wn5hsN1gnQwaH3B' });
    const u = parsePeckItem({ ...feed.data[1], aip_verified: false })!;
    expect(u.author.address.startsWith('peck:')).toBe(true);
    expect(payDestination(u).ok).toBe(false);
  });
  test('skips images, other apps, bad txids; tolerates control chars and garbage', () => {
    expect(parsePeckItem({ ...feed.data[1], media_type: 'image/jpeg', content: 'HEX:ffd8' })).toBeNull();
    expect(parsePeckItem({ ...feed.data[1], app: 'twetch' })).toBeNull();
    expect(parsePeckItem({ ...feed.data[1], txid: 'zz' })).toBeNull();
    expect((parsePeckBody('{"data":["a\u0001b"]}') as { data: unknown[] }).data.length).toBe(1);
    expect(parsePeckFeed(null)).toEqual([]);
  });
  test('thread fixture → its reply', () => {
    const t = fx('overlay-peck-thread.json') as { replies: unknown };
    const r = parsePeckFeed({ data: t.replies });
    expect(r.map((p) => p.replyTo)).toEqual([ROOT]);
  });
  test('registry and dedupe', () => {
    expect(sourceOf('peck.to')).toBe('peck');
    expect(sourceOf('peck.agents')).toBe('peck');
    expect(mergePosts(posts, posts).length).toBe(posts.length);
  });
});
