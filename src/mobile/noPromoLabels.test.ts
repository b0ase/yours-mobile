/**
 * De minimis guard (owner, 15 Oct 2026; restated 13 Nov 2026: "I thought we were meant to be careful about
 * 'trending'?"): no user-visible "Trending", "Hot" or "Pumping" anywhere in the phone app. Sorts stay neutral
 * and named for the objective data behind them (New, A–Z, 24h volume, 24h change, holders).
 *
 * Scans every .ts/.tsx file under src/mobile (tests and fixtures excluded), comments stripped, and checks each
 * string literal and JSX text. Internal keys ('trending' as a sort id, cached('hot')) are bare lowercase words
 * and stay allowed: only text a person could read is checked.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = import.meta.dir;
/** Always banned, any case. */
const BANNED_ANY_CASE = /\b(trending|pumping)\b/i;
/** "Hot" as a label (capitalised); lowercase "hot" is a CSS class or a cache key. */
const BANNED_LABEL = /\bHot\b|\bHOT\b/;
/** Not about tokens: a theme colour's name. */
const ALLOWED = [/^Hot pink\b/];
/** A bare internal key, never shown as text. */
const BARE_KEY = /^[a-z0-9_:.-]+$/;

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'fixtures' || name === 'node_modules' ? [] : files(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });

const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');

const texts = (src: string): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g))
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  // JSX text: between a tag's '>' (not an arrow's) and the next '<'; code between tags has ';' or '='.
  for (const m of src.matchAll(/(?<![=-])>([^<>{}]+)</g)) if (!/[;=]/.test(m[1])) out.push(m[1]);
  return out.map((t) => t.trim()).filter(Boolean);
};

const violations = (t: string) =>
  !BARE_KEY.test(t) && !ALLOWED.some((a) => a.test(t)) && (BANNED_ANY_CASE.test(t) || BANNED_LABEL.test(t));

describe('no promotional token labels in src/mobile', () => {
  it('has no user-visible "Trending", "Hot" or "Pumping"', () => {
    const found: string[] = [];
    for (const f of files(ROOT))
      for (const t of texts(stripComments(readFileSync(f, 'utf8'))))
        if (violations(t)) found.push(`${relative(ROOT, f)}: ${t.slice(0, 80)}`);
    expect(found).toEqual([]);
  });

  it('catches the labels it is meant to catch', () => {
    for (const bad of ['Trending', 'Trending on TokenBlaster', 'Nothing trending right now.', 'Hot', 'Pumping now'])
      expect(violations(bad)).toBe(true);
    for (const ok of ['trending', 'hot', 'Hot pink neon on black', 'Most traded (24h)', 'Photos', 'Hotel'])
      expect(violations(ok)).toBe(false);
  });
});
