import { beforeEach, describe, expect, test } from 'bun:test';
import {
  __clearLinkCards,
  extractUrls,
  isSealedBody,
  isSealedMessage,
  linkParts,
  loadLinkCard,
  parseLinkCard,
  previewPlan,
  roomIsEncrypted,
  safeHref,
  shouldUnfurl,
} from './linkify';
import { giphyGif, giphyOnlyMessage, gifOrText, pickPreviewUrl } from './giphyLink';

const YT = 'https://youtu.be/dQw4w9WgXcQ';
const GIF = 'https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/juqBfGDqu981ZSELSQ/giphy.gif?cid=abc&ep=x';
const TN = 'https://terrornode.com/play?room=TERRORNODE';

describe('safeHref: only plain http(s) links are ever an href', () => {
  test('http and https are links', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeHref('http://example.com')).toBe('http://example.com/');
  });

  test('javascript:, data:, vbscript:, file: and friends are never links', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'intent://scan/#Intent;scheme=zxing;end',
      'chrome-extension://abc/index.html',
      '//evil.example/x',
      'ftp://example.com',
    ])
      expect(safeHref(bad)).toBeNull();
  });

  test('no user:password@ (https://paypal.com@evil.example reads as PayPal)', () => {
    expect(safeHref('https://paypal.com@evil.example/login')).toBeNull();
    expect(safeHref('https://user:pass@example.com/')).toBeNull();
  });

  test('a host without a dot is not a link (https://localhost, https://foo)', () => {
    expect(safeHref('https://localhost/admin')).toBeNull();
    expect(safeHref('https://foo')).toBeNull();
  });
});

describe('linkParts / extractUrls', () => {
  test('splits text around links and leaves trailing punctuation out', () => {
    expect(linkParts(`Play ${TN}. Now!`)).toEqual([{ text: 'Play ' }, { text: TN, href: TN }, { text: '. Now!' }]);
  });

  test('the TERRORNODE link from the owner report is clickable', () => {
    const parts = linkParts('https://terrornode.com');
    expect(parts).toEqual([{ text: 'https://terrornode.com', href: 'https://terrornode.com/' }]);
  });

  test('javascript: in text stays plain text', () => {
    const parts = linkParts('click javascript:alert(document.cookie) please');
    expect(parts.every((p) => !p.href)).toBe(true);
    expect(parts.map((p) => p.text).join('')).toBe('click javascript:alert(document.cookie) please');
  });

  test('a credentialed URL stays plain text, the next link still works', () => {
    const parts = linkParts('https://a@b.example x https://ok.example');
    expect(parts.filter((p) => p.href).map((p) => p.href)).toEqual(['https://ok.example/']);
    expect(parts.map((p) => p.text).join('')).toBe('https://a@b.example x https://ok.example');
  });

  test('quotes and angle brackets end a URL (no attribute breakout)', () => {
    const parts = linkParts('see https://x.example/"onmouseover="alert(1)');
    expect(parts.find((p) => p.href)?.href).toBe('https://x.example/');
  });

  test('no links: one plain part; empty: none', () => {
    expect(linkParts('hello $alice')).toEqual([{ text: 'hello $alice' }]);
    expect(linkParts('')).toEqual([]);
    expect(linkParts(null)).toEqual([]);
  });

  test('extractUrls de-duplicates in order and skips unsafe ones', () => {
    expect(extractUrls(`${TN} https://a@b.example ${YT} ${TN}`)).toEqual([TN, YT]);
  });
});

describe('GIPHY links (port of bit-sign lib/giphy-link.ts)', () => {
  test('every GIPHY shape → i.giphy.com/<id>.gif, tracking dropped', () => {
    expect(giphyGif(GIF)?.src).toBe('https://i.giphy.com/juqBfGDqu981ZSELSQ.gif');
    expect(giphyGif('https://giphy.com/gifs/sealed-with-a-gif-you-got-this-juqBfGDqu981ZSELSQ')?.id).toBe(
      'juqBfGDqu981ZSELSQ',
    );
    expect(giphyGif('https://i.giphy.com/juqBfGDqu981ZSELSQ.webp')?.id).toBe('juqBfGDqu981ZSELSQ');
  });

  test('look-alikes, http and odd ports are not GIFs', () => {
    expect(giphyGif('https://giphy.com.evil.example/gifs/x-juqBfGDqu981ZSELSQ')).toBeNull();
    expect(giphyGif('http://i.giphy.com/juqBfGDqu981ZSELSQ.gif')).toBeNull();
    expect(giphyGif('https://i.giphy.com:8443/juqBfGDqu981ZSELSQ.gif')).toBeNull();
    expect(giphyGif('https://giphy.com/search/cats')).toBeNull();
  });

  test('a GIF-only message is just the GIF; with words it is text + GIF', () => {
    expect(giphyOnlyMessage(`  ${GIF} `)).not.toBeNull();
    expect(giphyOnlyMessage(`lol ${GIF}`)).toBeNull();
    expect(gifOrText(GIF)).toBe('GIF');
  });

  test('preview link: video first, then GIPHY, else the first link; a GIPHY .mp4 is a GIF', () => {
    expect(pickPreviewUrl([TN, GIF, YT])).toBe(YT);
    expect(pickPreviewUrl([TN, GIF])).toBe(GIF);
    expect(pickPreviewUrl(['https://media.giphy.com/media/juqBfGDqu981ZSELSQ/giphy.mp4'])).toContain('giphy.mp4');
    expect(pickPreviewUrl([])).toBeNull();
  });
});

describe('encrypted rooms', () => {
  test('sealed bodies and e2ee payloads are recognised', () => {
    expect(isSealedBody('e2ee1:eyJ2IjoxfQ==')).toBe(true);
    expect(isSealedBody('hello e2ee1:x')).toBe(false);
    expect(isSealedMessage({ body: 'hi', event_payload: { e2ee: true } })).toBe(true);
    expect(isSealedMessage({ body: 'hi', event_payload: null })).toBe(false);
  });

  test('a room is encrypted by its metadata or by any sealed message', () => {
    expect(roomIsEncrypted({ metadata: { e2ee: true } })).toBe(true);
    expect(roomIsEncrypted({ metadata: null }, [{ body: 'e2ee1:abc', event_payload: null }])).toBe(true);
    expect(roomIsEncrypted({ metadata: {} }, [{ body: TN, event_payload: null }])).toBe(false);
  });
});

describe('previewPlan', () => {
  test('a plain link gets a card; a video plays; a GIPHY link is the GIF', () => {
    expect(previewPlan(`try ${TN}`, { encrypted: false })).toEqual({ kind: 'card', url: TN });
    expect(previewPlan(`watch ${YT}`, { encrypted: false })).toMatchObject({ kind: 'video', sealed: false });
    expect(previewPlan(GIF, { encrypted: false })).toMatchObject({ kind: 'gif', only: true, sealed: false });
    expect(previewPlan(`ha ${GIF}`, { encrypted: false })).toMatchObject({ kind: 'gif', only: false });
  });

  test('encrypted: no card at all; GIFs and videos wait for a tap', () => {
    expect(previewPlan(`try ${TN}`, { encrypted: true })).toEqual({ kind: 'none' });
    expect(previewPlan(YT, { encrypted: true })).toMatchObject({ kind: 'video', sealed: true });
    expect(previewPlan(GIF, { encrypted: true })).toMatchObject({ kind: 'gif', sealed: true });
  });

  test('no links, an unsafe link or a sealed body: nothing', () => {
    expect(previewPlan('hello', { encrypted: false })).toEqual({ kind: 'none' });
    expect(previewPlan('javascript:alert(1)', { encrypted: false })).toEqual({ kind: 'none' });
    expect(previewPlan('e2ee1:https://x.example', { encrypted: false })).toEqual({ kind: 'none' });
  });
});

describe('unfurl gating', () => {
  beforeEach(() => __clearLinkCards());
  const okCard = (url: string) => ({
    previews: [
      {
        url,
        final_url: url,
        ok: true,
        title: 'TERRORNODE',
        description: 'Play now',
        site_name: 'TERRORNODE',
        image_url: 'https://terrornode.com/og.png',
        favicon_url: 'https://terrornode.com/favicon.ico',
      },
    ],
  });

  test('shouldUnfurl: never in an encrypted room, never a GIPHY or unsafe link', () => {
    expect(shouldUnfurl(TN, { encrypted: false })).toBe(true);
    expect(shouldUnfurl(TN, { encrypted: true })).toBe(false);
    expect(shouldUnfurl(GIF, { encrypted: false })).toBe(false);
    expect(shouldUnfurl('javascript:alert(1)', { encrypted: false })).toBe(false);
  });

  test('an encrypted room makes no unfurl request at all', async () => {
    const calls: string[] = [];
    const card = await loadLinkCard(TN, { encrypted: true }, async (u) => {
      calls.push(u);
      return okCard(u);
    });
    expect(card).toBeNull();
    expect(calls).toEqual([]);
  });

  test('a GIPHY link makes no unfurl request', async () => {
    const calls: string[] = [];
    await loadLinkCard(GIF, { encrypted: false }, async (u) => {
      calls.push(u);
      return okCard(u);
    });
    expect(calls).toEqual([]);
  });

  test('a normal room fetches once per URL and draws the card', async () => {
    const calls: string[] = [];
    const fetcher = async (u: string) => {
      calls.push(u);
      return okCard(u);
    };
    const a = await loadLinkCard(TN, { encrypted: false }, fetcher);
    const b = await loadLinkCard(TN, { encrypted: false }, fetcher);
    expect(calls).toEqual([TN]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ title: 'TERRORNODE', site: 'TERRORNODE', image: 'https://terrornode.com/og.png' });
  });

  test('a failed request may retry; a page with no card does not', async () => {
    let n = 0;
    const failing = async () => {
      n++;
      throw new Error('offline');
    };
    expect(await loadLinkCard(TN, { encrypted: false }, failing)).toBeNull();
    expect(await loadLinkCard(TN, { encrypted: false }, failing)).toBeNull();
    expect(n).toBe(2);
    let m = 0;
    const noCard = async (u: string) => {
      m++;
      return { previews: [{ url: u, ok: false }] };
    };
    const other = 'https://no-card.example/';
    await loadLinkCard(other, { encrypted: false }, noCard);
    await loadLinkCard(other, { encrypted: false }, noCard);
    expect(m).toBe(1);
  });
});

describe('parseLinkCard', () => {
  test('http images and unsafe final URLs are dropped', () => {
    const c = parseLinkCard(
      {
        previews: [
          {
            url: TN,
            ok: true,
            title: 'T',
            image_url: 'http://insecure.example/i.png',
            final_url: 'javascript:alert(1)',
          },
        ],
      },
      TN,
    );
    expect(c?.image).toBeNull();
    expect(c?.href).toBe(TN);
  });

  test('nothing to show (no title, no image) or not ok: no card', () => {
    expect(parseLinkCard({ previews: [{ url: TN, ok: true }] }, TN)).toBeNull();
    expect(parseLinkCard({ previews: [{ url: TN, ok: false, title: 'x' }] }, TN)).toBeNull();
    expect(parseLinkCard(null, TN)).toBeNull();
  });
});

describe('a GIF-only message reads "GIF" in the list and in reply quotes', () => {
  test('list preview and reply snippet', async () => {
    const { previewText } = await import('./messages');
    const { replyRefFor } = await import('./social');
    const room = {
      id: 'r',
      ticker: 'ROOM',
      name: 'Room',
      last_message: { author_handle: 'me', kind: 'text', body: GIF, event_type: null, created_at: '' },
    };
    expect(previewText(room, 'me')).toBe('You: GIF');
    expect(replyRefFor({ id: 'm', author_handle: 'alice', kind: 'text', body: GIF, created_at: '' }).snippet).toBe(
      'GIF',
    );
    expect(
      replyRefFor({ id: 'm', author_handle: 'alice', kind: 'text', body: `see ${TN}`, created_at: '' }).snippet,
    ).toBe(`see ${TN}`);
  });
});
