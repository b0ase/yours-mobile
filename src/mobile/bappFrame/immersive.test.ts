import { describe, expect, it } from 'bun:test';
import { isImmersiveViewport } from './immersive';

describe('bApp frame immersive mode', () => {
  it('is on for a phone in landscape', () => {
    expect(isImmersiveViewport(844, 390)).toBe(true);
    expect(isImmersiveViewport(915, 412)).toBe(true);
  });
  it('is off in portrait and on big screens', () => {
    expect(isImmersiveViewport(390, 844)).toBe(false);
    expect(isImmersiveViewport(1366, 1024)).toBe(false);
    expect(isImmersiveViewport(1920, 1080)).toBe(false);
  });
});
