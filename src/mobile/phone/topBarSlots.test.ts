import { describe, expect, test } from 'bun:test';
import { BAPP_BARS, TOP_BAR_FIXED, topBarBappForPath, topBarSlots } from './bappBarModel';

// Every route a bApp owns, plus wallet pages, with and without sub-paths.
const routes = [
  '/',
  '/bsv-wallet',
  '/m/home',
  '/m/calls',
  '/m/media',
  '/m/lock',
  ...BAPP_BARS.flatMap((b) => [
    b.prefix,
    `${b.prefix}/x`,
    b.home,
    ...(b.also ?? []),
    ...b.sections.map((s) => s.route.split('?')[0]),
  ]),
];

describe('phone top bar: a fixed icon set, never a duplicate', () => {
  test('no route renders the same entry twice, and the bar is 5 or 6 slots', () => {
    for (const r of routes) {
      const slots = topBarSlots(r);
      expect(new Set(slots).size).toBe(slots.length);
      expect(slots.length === 5 || slots.length === 6).toBe(true);
    }
  });
  test('bMail open: still five icons, the mailbox is the bMail button (bug 19 Oct 2026)', () => {
    for (const r of ['/m/bmail', '/m/bmail/', '/m/bmail/thread/1']) {
      expect(topBarBappForPath(r)).toBeNull();
      expect(topBarSlots(r)).toEqual([...TOP_BAR_FIXED]);
    }
  });
  test('other bApps still get their own button after Calls', () => {
    expect(topBarSlots('/m/bpics')).toEqual(['accounts', 'calls', 'bpics', 'bmail', 'media', 'lock']);
  });
});
