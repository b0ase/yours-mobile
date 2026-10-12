import { describe, expect, test } from 'bun:test';
import { EMBED_SANDBOX, embedSrc, parseStart, parseVideoLink } from './video-embed';
import { messageVideo } from '../chat/roomMediaInfo';

// Keep in step with bit-sign video-embed-selftest.mts.
const ID = 'dQw4w9WgXcQ';

describe('parseVideoLink', () => {
  test.each([
    [`https://www.youtube.com/watch?v=${ID}`, 0],
    [`https://youtube.com/watch?feature=share&v=${ID}&t=1m30s`, 90],
    [`https://m.youtube.com/watch?v=${ID}#t=42`, 42],
    [`https://youtu.be/${ID}?t=75`, 75],
    [`https://www.youtube.com/shorts/${ID}`, 0],
    [`https://www.youtube.com/live/${ID}`, 0],
    [`https://www.youtube.com/embed/${ID}?start=10`, 10],
  ])('YouTube %s', (url, start) => {
    const v = parseVideoLink(url);
    expect(v?.provider).toBe('youtube');
    expect(v?.id).toBe(ID);
    expect(v?.start).toBe(start);
  });
  test('shorts are portrait, live is live', () => {
    expect(parseVideoLink(`https://www.youtube.com/shorts/${ID}`)?.portrait).toBe(true);
    expect(parseVideoLink(`https://www.youtube.com/live/${ID}`)?.live).toBe(true);
  });
  test('Vimeo and direct files', () => {
    expect(parseVideoLink('https://vimeo.com/76979871')?.id).toBe('76979871');
    expect(parseVideoLink('https://example.com/a.mp4')?.provider).toBe('file');
    expect(parseVideoLink('http://example.com/a.mp4')).toBeNull();
    expect(parseVideoLink('https://example.com/page')).toBeNull();
    expect(parseVideoLink('https://www.youtube.com/watch?v=short')).toBeNull();
  });
  test('start formats', () => {
    expect(parseStart('1:02:03')).toBe(3723);
    expect(parseStart('junk')).toBe(0);
  });
});

describe('privacy', () => {
  test('youtube-nocookie with start, Vimeo dnt, files are not iframes', () => {
    expect(embedSrc(parseVideoLink(`https://youtu.be/${ID}?t=75`)!)).toStartWith(
      `https://www.youtube-nocookie.com/embed/${ID}?`,
    );
    expect(embedSrc(parseVideoLink(`https://youtu.be/${ID}?t=75`)!)).toContain('start=75');
    expect(embedSrc(parseVideoLink('https://vimeo.com/76979871')!)).toContain('dnt=1');
    expect(embedSrc(parseVideoLink('https://example.com/a.mp4')!)).toBeNull();
  });
  test('sandbox has no top navigation, forms or downloads', () => {
    expect(EMBED_SANDBOX).not.toMatch(/allow-top-navigation|allow-forms|allow-downloads/);
  });
});

describe('room messages', () => {
  test('first video link in a message, trailing punctuation dropped', () => {
    expect(messageVideo(`watch this https://youtu.be/${ID}?t=5.`)?.start).toBe(5);
    expect(messageVideo('no links here')).toBeNull();
    expect(messageVideo('https://example.com then https://vimeo.com/76979871')?.provider).toBe('vimeo');
  });
});
