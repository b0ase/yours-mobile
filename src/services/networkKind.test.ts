import { afterEach, describe, expect, test } from 'bun:test';
import { Capacitor } from '@capacitor/core';
import { isPhone, onWifi } from './networkKind';

const plugins = Capacitor as unknown as { Plugins: Record<string, unknown> };
const nav = globalThis as unknown as { navigator?: { connection?: { type?: string } } };
const saved = nav.navigator;

afterEach(() => {
  delete plugins.Plugins.Network;
  Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true, writable: true });
});

const setConnection = (type: string | undefined) =>
  Object.defineProperty(globalThis, 'navigator', {
    value: { ...(saved ?? {}), connection: type === undefined ? undefined : { type } },
    configurable: true,
    writable: true,
  });

describe('networkKind: the Wi-Fi rule of the weekly full pass', () => {
  test('not a phone in tests (the web wallet and the extension)', () => {
    expect(isPhone()).toBe(false);
  });

  test('the Capacitor Network plugin when the app ships it', async () => {
    plugins.Plugins.Network = { getStatus: async () => ({ connected: true, connectionType: 'wifi' }) };
    expect(await onWifi()).toBe(true);
    plugins.Plugins.Network = { getStatus: async () => ({ connected: true, connectionType: 'cellular' }) };
    expect(await onWifi()).toBe(false);
  });

  test("else the WebView's Network Information API; unknown when neither can tell (iOS without the plugin)", async () => {
    setConnection('wifi');
    expect(await onWifi()).toBe(true);
    setConnection('cellular');
    expect(await onWifi()).toBe(false);
    setConnection(undefined);
    expect(await onWifi()).toBeUndefined();
  });
});
