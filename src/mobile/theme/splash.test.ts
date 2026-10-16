import { expect, test } from 'bun:test';
import { accentById } from './accents';
import { splashPalette, splashScript } from './splash';

test('splash: every non-Gold pack has colours; Mono White is a black b on white; Gold paints nothing', () => {
  const p = splashPalette();
  expect(p.gold).toBeUndefined();
  expect(p.white?.[0]).toBe('#FFFFFF');
  expect(p.white?.[1]).toBe(accentById('white').text);
  expect(p.paper).toEqual(p.white as [string, string]);
  expect(splashScript()).toContain('bwx.accent.boot');
  expect(splashScript()).toContain('try{');
});
