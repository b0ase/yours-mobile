import { expect, test } from 'bun:test';
import { thumbOrFullUrls, thumbUrl } from './thumbs';

const OP = `${'a'.repeat(64)}_0`;

test('thumbUrl uses the 1sat-stack resize endpoint', () => {
  expect(thumbUrl(OP)).toBe(`https://api.1sat.app/1sat/ordfs/image/${OP}?w=384&h=384&fit=fill&f=webp&q=70`);
  expect(thumbUrl(`${'a'.repeat(64)}.0`, 96)).toContain(`/${OP}?w=96&h=96`);
  expect(thumbUrl('nope')).toBeNull();
  expect(thumbUrl(null)).toBeNull();
});

test('thumbOrFullUrls falls back to full content hosts', () => {
  const urls = thumbOrFullUrls(OP);
  expect(urls[0]).toContain('/ordfs/image/');
  expect(urls.slice(1).every((u) => u.endsWith(`/content/${OP}`))).toBe(true);
  expect(thumbOrFullUrls('bad')).toEqual([]);
});

test('isSvg matches svg content types only', async () => {
  const { isSvg } = await import('./thumbs');
  expect(isSvg('image/svg+xml')).toBe(true);
  expect(isSvg('Image/SVG+XML; charset=utf-8')).toBe(true);
  expect(isSvg('image/png')).toBe(false);
  expect(isSvg(null)).toBe(false);
});
