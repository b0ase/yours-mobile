import { describe, expect, test } from 'bun:test';
import { HANDOFF_WEB_ORIGIN, buildHandoffMessage } from './extHandoff';
import * as m from './extHandoffStore';
import type { SessionArea } from './extHandoffStore';

// A well-known public test phrase (the BIP-39 "abandon" vector), never a real wallet.
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const fakeArea = (): SessionArea & { data: Record<string, unknown> } => {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k) => (k in data ? { [k]: structuredClone(data[k]) } : {}),
    set: async (items) => {
      Object.assign(data, structuredClone(items));
    },
    remove: async (k) => {
      delete data[k];
    },
  };
};

const nonceOf = (url: string) => new URL(url).searchParams.get('n') ?? '';

describe('flag off: the hand-off does nothing', () => {
  test('a message is refused and nothing is stored', async () => {
    // The flag is on by default now (VITE_SEEDLESS=0 or a store build turns it off), so pass it off explicitly.
    const a = fakeArea();
    const url = await m.startHandoff(a);
    const msg = await buildHandoffMessage(nonceOf(url), '123456', WORDS);
    expect(await m.handleExternalHandoff(msg, HANDOFF_WEB_ORIGIN, a, Date.now(), false)).toBe(false);
    expect((await m.readHandoff(a))?.state).toBe('waiting');
  });
});

describe('flag on', () => {
  test('start, receive from the web origin, confirm with the code: the words come out once', async () => {
    const a = fakeArea();
    const url = await m.startHandoff(a);
    const n = nonceOf(url);
    const msg = await buildHandoffMessage(n, '482915', WORDS, 'Main');
    expect(await m.handleExternalHandoff(msg, HANDOFF_WEB_ORIGIN, a, Date.now(), true)).toBe(true);
    const r = await m.confirmTypedCode('482915', a);
    expect(r).toEqual({ ok: true, words: WORDS, name: 'Main' });
    expect(await m.readHandoff(a)).toBeNull(); // erased after success
    expect((await m.confirmTypedCode('482915', a)).ok).toBe(false); // and cannot be replayed
  });

  test('a wrong code erases the parked words: one attempt', async () => {
    const a = fakeArea();
    const n = nonceOf(await m.startHandoff(a));
    await m.handleExternalHandoff(
      await buildHandoffMessage(n, '482915', WORDS),
      HANDOFF_WEB_ORIGIN,
      a,
      Date.now(),
      true,
    );
    expect(await m.confirmTypedCode('000000', a)).toEqual({ ok: false, reason: 'wrong-code' });
    expect(await m.readHandoff(a)).toBeNull();
    expect((await m.confirmTypedCode('482915', a)).ok).toBe(false);
  });

  test('another origin cannot fill the request', async () => {
    const a = fakeArea();
    const n = nonceOf(await m.startHandoff(a));
    const msg = await buildHandoffMessage(n, '482915', WORDS);
    expect(await m.handleExternalHandoff(msg, 'https://desktop.bwalletx.com', a, Date.now(), true)).toBe(false);
    expect((await m.readHandoff(a))?.state).toBe('waiting');
  });

  test('typing a code before the web step finished does not burn the request', async () => {
    const a = fakeArea();
    await m.startHandoff(a);
    expect(await m.confirmTypedCode('123456', a)).toEqual({ ok: false, reason: 'not-received' });
    expect((await m.readHandoff(a))?.state).toBe('waiting');
  });

  test('starting again replaces the old request', async () => {
    const a = fakeArea();
    const first = nonceOf(await m.startHandoff(a));
    const second = nonceOf(await m.startHandoff(a));
    expect(second).not.toBe(first);
    const old = await buildHandoffMessage(first, '123456', WORDS);
    expect(await m.handleExternalHandoff(old, HANDOFF_WEB_ORIGIN, a, Date.now(), true)).toBe(false);
  });
});

describe('expired requests are erased (review 20 Oct 2026)', () => {
  test('sweep removes a request past its time, even one holding parked words', async () => {
    const a = fakeArea();
    await m.startHandoff(a);
    await m.sweepExpiredHandoff(a, Date.now() + 10 * 60_000);
    expect(await m.readHandoff(a)).toBeNull();
  });

  test('sweep leaves a live request alone', async () => {
    const a = fakeArea();
    await m.startHandoff(a);
    await m.sweepExpiredHandoff(a);
    expect((await m.readHandoff(a))?.state).toBe('waiting');
  });
});
