import { describe, expect, test } from 'bun:test';
import { makeSecretClipboard, type ClipboardPort } from './secretClipboard';

/** A fake clipboard + manual timers: wipe only if the clip is still ours. */
const setup = () => {
  let board = '';
  let seq = 0;
  let owner: unknown = null;
  const writes: string[] = [];
  const port: ClipboardPort = {
    async write(text) {
      board = text;
      owner = ++seq;
      writes.push(text);
      return owner;
    },
    async clearIfStill(text, token) {
      if (board === text && owner === token) board = '';
    },
  };
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const copy = makeSecretClipboard(port, {
    set: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clear: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  const fire = async () => {
    for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    await Promise.resolve();
  };
  return {
    copy,
    fire,
    timers,
    get board() {
      return board;
    },
    userCopies: (t: string) => {
      board = t;
      owner = 'user';
    },
  };
};

describe('secret clipboard', () => {
  test('wipes after 60 s when the clipboard still holds the secret', async () => {
    const c = setup();
    await c.copy('abandon ability able');
    expect(c.board).toBe('abandon ability able');
    expect(c.timers[0].ms).toBe(60_000);
    await c.fire();
    expect(c.board).toBe('');
  });

  test('leaves something the user copied since', async () => {
    const c = setup();
    await c.copy('abandon ability able');
    c.userCopies('my shopping list');
    await c.fire();
    expect(c.board).toBe('my shopping list');
  });

  test('a second secret copy replaces the first wipe timer', async () => {
    const c = setup();
    await c.copy('first secret');
    await c.copy('second secret');
    expect(c.timers.filter((t) => !t.cleared)).toHaveLength(1);
    await c.fire();
    expect(c.board).toBe('');
  });

  test('a failing wipe is silent', async () => {
    const port: ClipboardPort = {
      write: async () => null,
      clearIfStill: async () => {
        throw new Error('denied');
      },
    };
    let fn: (() => void) | null = null;
    const copy = makeSecretClipboard(port, { set: (f) => (fn = f), clear: () => undefined });
    await copy('x');
    expect(() => fn?.()).not.toThrow();
  });
});
