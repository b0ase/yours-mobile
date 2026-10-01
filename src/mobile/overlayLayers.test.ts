import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Guard: bottom sheets (fixed, full-screen, content pinned to the bottom) must sit above the tab bar
 * (tabs/BottomMenu.tsx, z-[100]); otherwise their lowest buttons hide behind it.
 */
const TAB_BAR_Z = 100;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx$/.test(f) ? [p] : [];
  });

describe('overlay layers', () => {
  test('every bottom sheet is above the tab bar', () => {
    const bad: string[] = [];
    for (const f of files(join(import.meta.dir))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!/fixed inset-0/.test(line) || !/items-end/.test(line)) return;
          const m = line.match(/z-\[?(\d+)\]?/);
          if (!m || Number(m[1]) <= TAB_BAR_Z) bad.push(`${f}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
