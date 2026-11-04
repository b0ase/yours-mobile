/**
 * F-D and the 409 sheet (release click-through, 4 Nov 2026).
 *  - The wallet home's "Retry moving this account to this device" notice sat inside the classic balance block, which
 *    the phone and web builds hide (vite.config.mobile.ts, BsvWallet.tsx#obsidian: className="hidden"), so it never
 *    showed there. This applies the real phone-build rewrite and checks where the notice ends up.
 *  - In the Store's pay sheet the notice's Retry button was below the first screen of a phone: the sheet now shows
 *    the notice first, without the price hero, with one short line.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { LOCAL_STORE_NEEDED_MESSAGE } from '../../services/localFirst';
import { errorLayout, isMovingError, MOVING_SHORT } from './buySheetState';

const root = resolve(import.meta.dir, '..', '..', '..');

/** The element (by tag) that encloses `at`, opened at or before `at`: [start, end) of the whole element. */
function enclosing(code: string, openAt: number, tag: string): [number, number] {
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
  re.lastIndex = openAt;
  let depth = 0;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return [openAt, m.index + m[0].length];
  }
  throw new Error(`unclosed <${tag}>`);
}

describe('the move notice shows on the phone and web home', () => {
  test('after the phone-build rewrite, the notice is outside the hidden balance block and above Send / Receive', async () => {
    const { mobileText } = await import(join(root, 'vite.config.mobile.ts'));
    const handler = (mobileText().transform as { handler: (code: string, id: string) => { code: string } }).handler;
    const id = join(root, 'src/pages/BsvWallet.tsx');
    const ctx = {
      error: (m: string) => {
        throw new Error(m);
      },
    };
    const { code } = handler.call(ctx, readFileSync(id, 'utf8'), id);
    const hiddenAt = code.indexOf('className="hidden"');
    expect(hiddenAt).toBeGreaterThan(0);
    const [blockStart, blockEnd] = enclosing(code, code.lastIndexOf('<motion.div', hiddenAt), 'motion.div');
    const notice = code.indexOf('<MoveToDeviceNotice');
    expect(notice).toBeGreaterThan(0);
    expect(notice < blockStart || notice > blockEnd).toBe(true);
    expect(notice).toBeLessThan(code.indexOf('── Action buttons ──'));
  });
});

describe('the Store sheet: Retry on the first screen of a phone', () => {
  test('a payment waiting for the move: notice first, no price hero, one short line', () => {
    expect(isMovingError(LOCAL_STORE_NEEDED_MESSAGE)).toBe(true);
    expect(errorLayout(LOCAL_STORE_NEEDED_MESSAGE)).toEqual({ hero: false, notice: true, error: MOVING_SHORT });
    expect(MOVING_SHORT.length).toBeLessThan(80);
  });

  test('any other error keeps the price and its own words; no error keeps the price', () => {
    const msg = 'Insufficient funds: this needs 5902869 sats, and 0 sats are spendable right now.';
    expect(errorLayout(msg)).toEqual({ hero: true, notice: false, error: msg });
    expect(errorLayout(undefined)).toEqual({ hero: true, notice: false, error: undefined });
  });
});
