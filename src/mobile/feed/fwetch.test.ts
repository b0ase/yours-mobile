import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fwetchPayload, parseFwetchFeed, parseFwetchItem, verifyFwetchPayload, verifyFwetchTx } from './fwetch';
import { SOURCES, sourceOf, sourceUrl } from './sources';
import { payDestination } from './tip';
import { mergePosts } from './post';

// Recorded from api.vulpinenetwork.com on 2026-10-06.
const fx = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
type Item = Record<string, unknown> & { txid: string };
const feed = fx('fwetch-feed.json') as { posts: Item[] };
const raw = fx('fwetch-rawtx.json') as Record<string, string>;
const [A, B, C, ANON] = Object.keys(raw);
const item = (t: string) => feed.posts.find((p) => p.txid === t)!;

describe('fwetch', () => {
  test('signatures verify from the raw tx; address = pub', async () => {
    for (const t of [A, B, C]) expect(await verifyFwetchTx(raw[t], t)).toBe(item(t).signer_addr as string);
    expect(await verifyFwetchTx(raw[A], B)).toBeNull();
    expect(await verifyFwetchTx(raw[ANON], ANON)).toBeNull();
    const p = fwetchPayload(raw[A], A)!;
    expect(await verifyFwetchPayload({ ...p, b: 'tampered' })).toBeNull();
    expect(await verifyFwetchPayload({ ...p, pub: fwetchPayload(raw[B], B)!.pub })).toBeNull();
  });

  test('parse: local posts included, hidden dropped, tips only when verified', async () => {
    const verified = new Map([[A, (await verifyFwetchTx(raw[A], A))!]]);
    const posts = parseFwetchFeed(feed, verified);
    expect(posts.length).toBeGreaterThanOrEqual(30);
    expect(posts.every((p) => p.source === 'fwetch')).toBe(true);
    expect(posts.some((p) => item(p.txid).scope === 'local')).toBe(true);
    expect(new Set(posts.map((p) => p.txid)).size).toBe(posts.length);
    expect(mergePosts(posts, posts).length).toBe(posts.length);
    const a = posts.find((p) => p.txid === A)!;
    expect(payDestination(a)).toEqual({ ok: true, address: item(A).signer_addr as string });
    expect(payDestination(parseFwetchItem(item(B))!).ok).toBe(false); // signer_addr alone
    const anon = parseFwetchItem(item(ANON), new Map([[ANON, item(A).signer_addr as string]]))!;
    expect(payDestination(anon).ok).toBe(false);
    expect(parseFwetchItem({ ...item(A), hidden: 1 }, verified)).toBeNull();
  });

  test('thread replies, registry, link home', () => {
    const t = fx('fwetch-post.json') as { post: Item; replies: Item[] };
    const r = parseFwetchFeed({ posts: t.replies });
    expect(r[0].replyTo).toBe(t.post.txid);
    expect(sourceOf('fwetch')).toBe('fwetch');
    const ids = SOURCES.map((s) => s.id);
    expect(ids.indexOf('fwetch')).toBe(ids.indexOf('peck') + 1);
    expect(sourceUrl({ source: 'fwetch', txid: A, threadId: null })).toBe(`https://fwetch.lol/#/post/${A}`);
  });
});
