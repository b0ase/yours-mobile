import { describe, expect, test } from 'bun:test';
import { STORE_APPLY, STORE_LOAD, tauriLocalBackend, tauriSecureStore, type Invoke } from './storage';
import { isAppUrl } from './links';
import { detectTauri, detectWebApp } from '../webApp';

/** A fake Rust side: the store_* commands over an in-memory map, recording every call. */
const fakeRust = (initial: Record<string, string> = {}) => {
  const disk = new Map(Object.entries(initial));
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke: Invoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === STORE_LOAD) return Object.fromEntries(disk) as T;
    if (cmd === STORE_APPLY) {
      const { sets, removes } = args as { sets: Record<string, string>; removes: string[] };
      for (const k of removes) disk.delete(k);
      for (const [k, v] of Object.entries(sets)) disk.set(k, v);
      return undefined as T;
    }
    throw new Error(`unknown command ${cmd}`);
  };
  return { invoke, disk, calls };
};

describe('Tauri storage.local backend', () => {
  test('load returns what the Rust side holds; null is an empty store', async () => {
    const rust = fakeRust({ 'chrome.storage.local:accounts': '{"a":1}' });
    expect(await tauriLocalBackend(rust.invoke).load()).toEqual({ 'chrome.storage.local:accounts': '{"a":1}' });
    const empty: Invoke = async <T>() => null as T;
    expect(await tauriLocalBackend(empty).load()).toEqual({});
  });

  test('one batch is one store_apply call (one atomic write) with sets and removes together', async () => {
    const rust = fakeRust({ old: '1' });
    await tauriLocalBackend(rust.invoke).apply({ a: '"x"', b: '2' }, ['old']);
    expect(rust.calls).toEqual([{ cmd: STORE_APPLY, args: { sets: { a: '"x"', b: '2' }, removes: ['old'] } }]);
    expect(Object.fromEntries(rust.disk)).toEqual({ a: '"x"', b: '2' });
  });

  test('an empty batch writes nothing', async () => {
    const rust = fakeRust();
    await tauriLocalBackend(rust.invoke).apply({}, []);
    expect(rust.calls).toEqual([]);
  });

  test('a failed write rejects, so the hub never reports a set that did not persist', async () => {
    const failing: Invoke = async () => {
      throw new Error('disk full');
    };
    await expect(tauriLocalBackend(failing).apply({ a: '1' }, [])).rejects.toThrow('disk full');
  });

  test('survives a "restart": a new backend over the same Rust store sees earlier writes', async () => {
    const rust = fakeRust();
    await tauriLocalBackend(rust.invoke).apply({ 'chrome.storage.local:selectedAccount': '"acc1"' }, []);
    const relaunched = tauriLocalBackend(rust.invoke);
    expect(await relaunched.load()).toEqual({ 'chrome.storage.local:selectedAccount': '"acc1"' });
  });
});

describe('Tauri secure store (YoursNative.secure*)', () => {
  test('loads once, then reads from memory; writes go straight through', async () => {
    const rust = fakeRust({ 'bio:declined': '1' });
    const s = tauriSecureStore(rust.invoke);
    expect(await s.get('bio:declined')).toBe('1');
    expect(await s.get('missing')).toBeNull();
    await s.set('bio:enrolled:a', '1');
    await s.remove('bio:declined');
    expect((await s.keys()).sort()).toEqual(['bio:enrolled:a']);
    expect(rust.calls.filter((c) => c.cmd === STORE_LOAD)).toHaveLength(1);
    expect(Object.fromEntries(rust.disk)).toEqual({ 'bio:enrolled:a': '1' });
  });
});

describe('Desktop detection and links', () => {
  test('Tauri is detected by its injected internals only', () => {
    expect(detectTauri({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(detectTauri({})).toBe(false);
    expect(detectTauri(undefined)).toBe(false);
  });
  test('Desktop is not the web app (its keys are not in browser storage)', () => {
    expect(detectWebApp({ native: false, extension: false })).toBe(true);
    expect(detectWebApp({ native: false, extension: false, tauri: true })).toBe(false);
  });
  test('only bwalletx:// deep links are accepted', () => {
    expect(isAppUrl('bwalletx://space/bwallet-lounge')).toBe(true);
    expect(isAppUrl('https://evil.example/x')).toBe(false);
    expect(isAppUrl('file:///etc/passwd')).toBe(false);
    expect(isAppUrl('not a url')).toBe(false);
  });
});
