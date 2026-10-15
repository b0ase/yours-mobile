import { expect, test } from 'bun:test';
import { themeSource, themeVarFor } from '../../../vite.theme';

test('neutral inline colours move onto theme variables with the old colour as fallback', () => {
  expect(themeSource("<p style={{ color: '#98A2B3' }} />")).toContain("color: 'var(--bw-muted, #98A2B3)'");
  expect(themeSource("x = { background: '#17191E' }")).toContain('var(--bw-card, #17191E)');
  expect(themeSource("x = { border: '1px solid #2b2f36' }")).toContain("'1px solid var(--bw-line, #2b2f36)'");
  expect(themeSource("style={{ color: active ? GOLD : '#fff' }}")).toContain("'var(--bw-text, #fff)'");
  expect(themeSource("style={{ background: GOLD, color: '#000' }}")).toBe(
    "style={{ background: GOLD, color: '#000' }}",
  );
  expect(themeSource("x = { background: 'var(--bw-accent)', color: '#010101' }")).toContain(
    'var(--bw-on-accent, #010101)',
  );
  const chip = themeSource(
    "style={{ background: on ? '#2a2100' : '#17191E', borderColor: on ? GOLD : '#2b2f36', color: on ? GOLD : '#fff' }}",
  );
  expect(chip).toContain("'var(--bw-card, #17191E)'");
  expect(chip).toContain("'var(--bw-line, #2b2f36)'");
  expect(chip).toContain("'var(--bw-text, #fff)'");
  expect(chip).toContain("'#2a2100'");
  expect(themeSource("x = { background: 'linear-gradient(transparent, #010101 35%)' }")).toContain(
    'var(--bw-pack-bg, #010101)',
  );
  expect(themeSource("const MUTED = '#98A2B3';")).toBe("const MUTED = 'var(--bw-muted, #98A2B3)';");
});
test('brand colours, tailwind class strings and media overlays are left alone', () => {
  expect(themeVarFor('color', '#F5B800')).toBeNull();
  expect(themeSource("x = { color: 'text-[#98A2B3]' }")).toBe("x = { color: 'text-[#98A2B3]' }");
  const ov = "<div className='video-overlay' style={{ color: '#fff' }} />";
  expect(themeSource(ov)).toBe(ov);
});
test('alpha suffixes become color-mix so variables still work', () => {
  expect(themeSource("a = theme.color.global.gray + '40'")).toBe(
    'a = `color-mix(in srgb, ${theme.color.global.gray} 25%, transparent)`',
  );
  expect(themeSource('b = `1px solid ${theme.color.global.gray}14`')).toBe(
    'b = `1px solid color-mix(in srgb, ${theme.color.global.gray} 8%, transparent)`',
  );
});
