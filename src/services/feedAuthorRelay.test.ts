/**
 * The extension sends the feed-author binding from its service worker (bChatX's CORS has no chrome-extension://
 * origin). These pin the worker's side: only the wallet's own pages, only a claim, only the one URL; and the
 * manifest's host permission.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  answerFeedAuthorRelay,
  FEED_AUTHOR_BINDING_API,
  FEED_AUTHOR_BINDING_HOST_PERMISSION,
  FEED_AUTHOR_RELAY_ACTION,
  feedAuthorTransport,
  isFeedAuthorBody,
  retryAfterMs,
  sendFeedAuthorClaim,
  sendFeedAuthorClaimViaWorker,
} from './feedAuthorRelay';

const claim = {
  alias: 'peytonmoon69',
  identityKey: '02' + 'ab'.repeat(32),
  bapId: 's3JdX57uoLS6MQmYKf98BUMiSNf',
  postingAddress: '13XXTWWsTgwHZknqVMJ59Fcop49hxKToae',
  timestamp: 1_763_200_000_000,
  identitySignature: '30' + 'ab'.repeat(20),
  postingSignature: 'A'.repeat(88),
};
const spy = (status = 200, body: unknown = { ok: true }, headers: Record<string, string> = {}) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof fetch;
  return { calls, f };
};

describe('routing', () => {
  test('the extension goes through its worker; web, iOS and Android send directly', () => {
    expect(feedAuthorTransport(true)).toBe('worker');
    expect(feedAuthorTransport(false)).toBe('direct');
  });

  test('the panel’s message carries the action and the claim, and the worker’s answer comes back', async () => {
    const seen: unknown[] = [];
    const runtime = {
      sendMessage: async (m: unknown) => (
        seen.push(m),
        { status: 409, body: { code: 'bap_not_indexed' }, retryAfter: '90' }
      ),
    };
    expect(await sendFeedAuthorClaimViaWorker(claim, runtime)).toEqual({
      status: 409,
      body: { code: 'bap_not_indexed' },
      retryAfter: '90',
    });
    expect(seen).toEqual([{ action: FEED_AUTHOR_RELAY_ACTION, body: claim }]);
  });

  test('no worker, a worker that throws or answers nonsense: "no answer", never an error', async () => {
    const none = { status: 0, body: null, retryAfter: null };
    expect(await sendFeedAuthorClaimViaWorker(claim, { sendMessage: () => Promise.reject(new Error('gone')) })).toEqual(
      none,
    );
    expect(await sendFeedAuthorClaimViaWorker(claim, { sendMessage: async () => undefined })).toEqual(none);
    expect(await sendFeedAuthorClaimViaWorker(claim, { sendMessage: async () => ({ status: '200' }) })).toEqual(none);
  });
});

describe('the worker’s side', () => {
  test('from the wallet’s own page: one POST of the claim to the one URL, no cookies', async () => {
    const { calls, f } = spy(200, { ok: true, handle: 'peytonmoon69', address: claim.postingAddress });
    const a = await answerFeedAuthorRelay({ body: claim }, true, f);
    expect(a).toEqual({ status: 200, body: { ok: true, code: undefined, retryAfter: undefined }, retryAfter: null });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(FEED_AUTHOR_BINDING_API);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.credentials).toBe('omit');
    expect(JSON.parse(String(calls[0].init.body))).toEqual(claim);
  });

  test('from anything else (a web page, a content script): nothing is sent', async () => {
    const { calls, f } = spy();
    expect((await answerFeedAuthorRelay({ body: claim }, false, f)).status).toBe(0);
    expect(calls.length).toBe(0);
  });

  test('not a proxy: a body that is not exactly a claim is not sent', async () => {
    const { calls, f } = spy();
    for (const bad of [
      null,
      'text',
      [claim],
      { ...claim, url: 'https://evil.example' },
      { ...claim, alias: undefined },
      { ...claim, timestamp: '1763200000000' },
      { ...claim, timestamp: 1.5 },
      { ...claim, postingSignature: 'A'.repeat(5000) },
      { ...claim, bapId: '' },
    ]) {
      expect(isFeedAuthorBody(bad)).toBe(false);
      expect((await answerFeedAuthorRelay({ body: bad }, true, f)).status).toBe(0);
    }
    expect(isFeedAuthorBody(claim)).toBe(true);
    expect(calls.length).toBe(0);
  });

  test('the answer keeps the status, the code and Retry-After; no network is "no answer"', async () => {
    const { f } = spy(409, { code: 'bap_not_indexed', error: 'x', retryAfter: 30 }, { 'retry-after': '120' });
    expect(await sendFeedAuthorClaim(claim, f)).toEqual({
      status: 409,
      body: { ok: undefined, code: 'bap_not_indexed', retryAfter: 30 },
      retryAfter: '120',
    });
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await sendFeedAuthorClaim(claim, down)).toEqual({ status: 0, body: null, retryAfter: null });
  });

  test('background.ts answers the action, for its own pages only', () => {
    const src = readFileSync(join(import.meta.dir, '../background.ts'), 'utf8');
    expect(src).toContain('if (message?.action === FEED_AUTHOR_RELAY_ACTION) {');
    expect(src).toContain('answerFeedAuthorRelay(message, isExtensionSender(sender, chrome.runtime.id))');
    // Before the general wallet-call handling, and it keeps the channel open for the async answer.
    const at = src.indexOf('if (message?.action === FEED_AUTHOR_RELAY_ACTION) {');
    expect(src.slice(at, at + 400)).toContain('return true;');
    expect(at).toBeLessThan(src.indexOf('const isFromExtension = isExtensionSender(sender, chrome.runtime.id);'));
  });
});

describe('manifest', () => {
  test('the extension build asks for host access to bChatX, which covers the binding URL', () => {
    expect(FEED_AUTHOR_BINDING_HOST_PERMISSION).toBe('https://www.bchatx.com/*');
    expect(FEED_AUTHOR_BINDING_API.startsWith(FEED_AUTHOR_BINDING_HOST_PERMISSION.slice(0, -1))).toBe(true);
    const build = readFileSync(join(import.meta.dir, '../../scripts/build.ts'), 'utf8');
    const at = build.indexOf('manifest.host_permissions = [');
    expect(at).toBeGreaterThan(0);
    expect(build.slice(at, build.indexOf('];', at))).toContain('FEED_AUTHOR_BINDING_HOST_PERMISSION,');
    expect(build).toContain("import { FEED_AUTHOR_BINDING_HOST_PERMISSION } from '../src/services/feedAuthorRelay';");
  });
});

describe('Retry-After', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  test('seconds, an HTTP date, or the body’s number; nothing usable is 0', () => {
    expect(retryAfterMs({ body: null, retryAfter: '120' }, now)).toBe(120_000);
    expect(retryAfterMs({ body: null, retryAfter: 'Sun, 15 Nov 2026 12:05:00 GMT' }, now)).toBe(300_000);
    expect(retryAfterMs({ body: { retryAfter: 45 }, retryAfter: null }, now)).toBe(45_000);
    expect(retryAfterMs({ body: null, retryAfter: null }, now)).toBe(0);
    expect(retryAfterMs({ body: null, retryAfter: 'soon' }, now)).toBe(0);
    expect(retryAfterMs({ body: null, retryAfter: 'Sun, 15 Nov 2026 11:00:00 GMT' }, now)).toBe(0);
    expect(retryAfterMs({ body: { retryAfter: -5 }, retryAfter: '0' }, now)).toBe(0);
  });
  test('capped at a day: a wild value can’t park the binding for ever', () => {
    expect(retryAfterMs({ body: null, retryAfter: '999999999' }, now)).toBe(24 * 3600_000);
  });
});
