import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Browser } from 'puppeteer';
import {
  MAIN_VIEW_TARGETS,
  buildFixture,
  cardPictureUri,
  chromePath,
  launchChrome,
  measure,
  openView,
  type Reading,
} from '../../testing/siteLookRender';
import { ICON_RATIO, TEXT_RATIO } from './contrastGuard';

/**
 * The COO's report (7 Nov 2026): RB connected artechex.com, whose v2 theme is mode "light". The whole-view look left
 * the top row's price and History white on paper, "-1.53% today" red, "Swap into BSV" white on white, the card dark
 * navy with a dark-blue balance and Scan pill, and the dock's inactive icons dark on dark. This renders the main view
 * with the real components and stylesheets in headless Chrome and checks what is painted.
 * Skipped when no Chrome is installed (nothing is downloaded).
 */
const ARTECHEX = {
  v: 2,
  name: 'ArtechEx',
  mode: 'light',
  accent: '#002FA7',
  accentHi: '#1F3BDB',
  bg: '#F4F1EA',
  surface: '#FBFAF6',
  text: '#151311',
};
const KEY = '02' + 'ab'.repeat(32);

const failures = (rs: Reading[]) =>
  rs
    .filter((r) => r.name.endsWith('(missing)') || r.ratio < (r.kind === 'icon' ? ICON_RATIO : TEXT_RATIO))
    .map((r) => `${r.name}: ${r.fg} on ${r.bg} = ${r.ratio.toFixed(2)}:1`);

describe.skipIf(!chromePath())('main wallet view in a connected site’s light theme (ArtechEx)', () => {
  let browser: Browser | null = null;
  let dir = '';
  beforeAll(async () => {
    dir = await buildFixture();
    browser = await launchChrome();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  test('every reported element reads: text 4.5:1, icons 3:1, against what is painted behind it', async () => {
    const page = await openView(browser as Browser, dir, { theme: ARTECHEX, identityPubKey: KEY });
    const rs = await measure(page, MAIN_VIEW_TARGETS);
    await page.close();
    expect(rs.length).toBeGreaterThanOrEqual(MAIN_VIEW_TARGETS.length);
    expect(failures(rs)).toEqual([]);
    // The view really wears the site: the page is its paper and the price its ink, not Gold's white on black.
    expect(rs.find((r) => r.name === 'top row: price')).toMatchObject({ fg: '#151311', bg: '#FBFAF6' });
    expect(rs.find((r) => r.name === 'card: balance')?.fg).toBe('#151311');
  }, 60_000);

  test('a card that keeps its own (dark-shaded) picture: its ink is picked for the dark face', async () => {
    const page = await openView(browser as Browser, dir, {
      theme: ARTECHEX,
      identityPubKey: KEY,
      storage: { ['bw-card-img:' + KEY]: cardPictureUri() },
    });
    const rs = await measure(
      page,
      MAIN_VIEW_TARGETS.filter((t) => t.name.startsWith('card')),
    );
    await page.close();
    expect(failures(rs)).toEqual([]);
    expect(rs.find((r) => r.name === 'card: balance')?.fg).toBe('#F2F2F0');
  }, 60_000);
});
