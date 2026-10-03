import { describe, expect, test } from 'bun:test';
import { goesNative } from './overlayFetch';

const h = (o: Record<string, string>) => new Headers(o);

describe('overlay submissions bypass CORS on phones', () => {
  test('only POST /overlay/submit to api.1sat.app with x-topics', () => {
    const url = 'https://api.1sat.app/1sat/bsv21/overlay/submit';
    expect(goesNative(url, 'POST', h({ 'x-topics': '["tm_x"]' }))).toBe(true);
    expect(goesNative(url, 'POST', h({}))).toBe(false);
    expect(goesNative(url, 'GET', h({ 'x-topics': '[]' }))).toBe(false);
    expect(goesNative('https://evil.example/overlay/submit', 'POST', h({ 'x-topics': '[]' }))).toBe(false);
    expect(goesNative('https://api.1sat.app/1sat/bsv21/abc', 'POST', h({ 'x-topics': '[]' }))).toBe(false);
  });
});
