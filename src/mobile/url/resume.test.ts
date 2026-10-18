import { describe, expect, test } from 'bun:test';
import { desktopStart } from './resume';

describe('desktopStart', () => {
  test('phone and web keep the URL they opened on', () => {
    expect(desktopStart('/m/store?shop=emoji', false, 'reload')).toBe('/m/store?shop=emoji');
  });
  test('Desktop: a followed link opens its page', () => {
    expect(desktopStart('/m/spaces/lounge', true, 'navigate')).toBe('/m/spaces/lounge');
  });
  test('Desktop: a refresh or restored tab opens the Wallet', () => {
    expect(desktopStart('/m/spaces/lounge', true, 'reload')).toBeNull();
    expect(desktopStart('/m/spaces/lounge', true, 'back_forward')).toBeNull();
  });
  test('Desktop: a Store page never opens first', () => {
    expect(desktopStart('/m/store?shop=emoji', true, 'navigate')).toBeNull();
  });
});
