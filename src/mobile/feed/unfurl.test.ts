import { describe, expect, test } from 'bun:test';
import { mediaFromText } from './media';
import { isOwnHost, ownLinkPreview, parsePreviews } from './unfurl';
import type { Http } from '../chat/api';

// A real bChat post linking our own sites; responses as bit-sign's /api/bitsign/unfurl returned them (9 Oct 2026).
const POST = 'New desktop wallet https://bwalletx.com/desktop and say hi https://www.bchatx.com/u/b0asex';
const ROWS: Record<string, unknown> = {
  'https://bwalletx.com/desktop': {
    url: 'https://bwalletx.com/desktop',
    site_name: 'bWalletX',
    title: 'bWalletX Desktop: your whole Bitcoin life in one window',
    description: 'The whole wallet on a big screen.',
    image_url: 'https://bwalletx.com/og-desktop-mkt-v2.png',
    ok: true,
  },
  'https://www.bchatx.com/u/b0asex': {
    url: 'https://www.bchatx.com/u/b0asex',
    site_name: null,
    title: 'Message $b0asex',
    description: 'Send $b0asex a message on bChat.',
    image_url: 'https://cloud.handcash.io/v2/users/profilePicture/boase',
    ok: true,
  },
};
const calls: string[] = [];
const http: Http = async ({ url }) => {
  calls.push(url);
  const u = new URL(url).searchParams.get('url') ?? '';
  return { status: 200, data: { previews: ROWS[u] ? [ROWS[u]] : [] } };
};

describe('own-site link previews in the Feed', () => {
  test('both links in the post are own hosts and get OG cards', async () => {
    const { links } = mediaFromText(POST);
    expect(links.map((l) => l.url)).toEqual(['https://bwalletx.com/desktop', 'https://www.bchatx.com/u/b0asex']);
    expect(links.every((l) => isOwnHost(l.url))).toBe(true);
    const desk = await ownLinkPreview(links[0].url, http);
    expect(desk?.image).toBe('https://bwalletx.com/og-desktop-mkt-v2.png');
    expect(desk?.title).toContain('bWalletX Desktop');
    const prof = await ownLinkPreview(links[1].url, http);
    expect(prof?.title).toBe('Message $b0asex');
    expect(calls[0]).toBe('https://www.bitcoinchat.online/api/bitsign/unfurl?url=https%3A%2F%2Fbwalletx.com%2Fdesktop');
  });

  test('other hosts never fetch; own hosts include bmovies.app and our subdomains', async () => {
    const n = calls.length;
    expect(await ownLinkPreview('https://example.com/x', http)).toBeNull();
    expect(calls.length).toBe(n);
    for (const h of ['https://bmovies.app/', 'https://web.bwalletx.com/', 'https://desktop.bwalletx.com/', 'https://bchatx.com/'])
      expect(isOwnHost(h)).toBe(true);
    expect(isOwnHost('http://bwalletx.com/')).toBe(false);
    expect(isOwnHost('https://bwalletx.com.evil.io/')).toBe(false);
  });

  test('parsePreviews drops failed rows and non-https images', () => {
    expect(parsePreviews({ previews: [{ url: 'https://bwalletx.com/', ok: false, title: 'x' }] })).toEqual([]);
    expect(parsePreviews({ previews: [{ url: 'https://bwalletx.com/', ok: true, title: 'T', image_url: 'http://a/b.png' }] })[0].image).toBeNull();
    expect(parsePreviews(null)).toEqual([]);
  });
});
