import { describe, expect, test } from 'bun:test';
import { parseThemeLink } from './themeLink';

describe('bwalletx://theme links', () => {
  test('names a free pack', () => {
    expect(parseThemeLink('bwalletx://theme/pink')).toBe('pink');
    expect(parseThemeLink('bwalletx://theme/WHITE/')).toBe('white');
    expect(parseThemeLink('bwalletx://theme?id=yellow')).toBe('yellow');
    expect(parseThemeLink('bwalletx://theme/blackwhite')).toBe('blackwhite');
    expect(parseThemeLink('bwalletx://theme/light')).toBe('white');
  });

  test('never offers a paid edition', () => {
    for (const id of ['vexvoid', 'npg', 'npgx']) expect(parseThemeLink(`bwalletx://theme/${id}`)).toBeNull();
  });

  test('ignores other links and unknown names', () => {
    expect(parseThemeLink('bwalletx://space/abc')).toBeNull();
    expect(parseThemeLink('bwalletx://theme/nope')).toBeNull();
    expect(parseThemeLink('bwalletx://theme/')).toBeNull();
    expect(parseThemeLink('https://web.bwalletx.com/pink')).toBeNull();
    expect(parseThemeLink('bwalletx://theme/%E0%A4%A')).toBeNull();
    expect(parseThemeLink(null)).toBeNull();
  });
});
