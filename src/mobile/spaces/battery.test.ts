import { describe, expect, test } from 'bun:test';
import { isIgnoringBattery, shouldAskBattery } from './battery';
import type { SpaceSessionPlugin } from './background';

describe('battery optimisation ask', () => {
  test('only Android, only when not exempt, only once', () => {
    expect(shouldAskBattery({ os: 'android', ignoring: false, asked: false })).toBe(true);
    expect(shouldAskBattery({ os: 'android', ignoring: true, asked: false })).toBe(false);
    expect(shouldAskBattery({ os: 'android', ignoring: false, asked: true })).toBe(false);
    expect(shouldAskBattery({ os: 'ios', ignoring: false, asked: false })).toBe(false);
  });
  test('old native build without the method counts as exempt (no sheet)', async () => {
    const p = { isIgnoringBatteryOptimizations: async () => Promise.reject(new Error('not implemented')) } as unknown as SpaceSessionPlugin;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect(await isIgnoringBattery(p, 'android')).toBe(true);
    } finally {
      console.warn = warn;
    }
    const q = { isIgnoringBatteryOptimizations: async () => ({ ignoring: false }) } as unknown as SpaceSessionPlugin;
    expect(await isIgnoringBattery(q, 'android')).toBe(false);
    expect(await isIgnoringBattery(q, 'web')).toBe(true);
  });
});
