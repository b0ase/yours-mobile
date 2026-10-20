import { describe, expect, test } from 'bun:test';
import { copyWithAutoClear, revealSeed, SeedRevealError, seedWords } from './seedReveal';

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

const deps = (ok = true, mnemonic: string | undefined = PHRASE) => {
  const calls = { verify: 0, read: 0 };
  return {
    calls,
    d: {
      verifyPassword: async (pw: string) => {
        calls.verify++;
        return ok && pw === 'right';
      },
      readMnemonic: async () => {
        calls.read++;
        return mnemonic;
      },
    },
  };
};

describe('seedWords', () => {
  test('splits on any whitespace', () => {
    expect(seedWords(`  ${PHRASE.replace(/ /g, '  \n')} `)).toHaveLength(12);
    expect(seedWords(undefined)).toEqual([]);
  });
});

describe('revealSeed password gate', () => {
  test('wrong password never decrypts', async () => {
    const { d, calls } = deps();
    await expect(revealSeed(d, { password: 'wrong' })).rejects.toBeInstanceOf(SeedRevealError);
    expect(calls.read).toBe(0);
  });
  test('empty password is refused without a check', async () => {
    const { d, calls } = deps();
    await expect(revealSeed(d, { password: '' })).rejects.toThrow('Wrong password');
    expect(calls.read).toBe(0);
  });
  test('right password returns the 12 words in order', async () => {
    const { d } = deps();
    const w = await revealSeed(d, { password: 'right' });
    expect(w).toHaveLength(12);
    expect(w[0]).toBe('abandon');
    expect(w[11]).toBe('accident');
  });
  test('biometric-verified skips the password', async () => {
    const { d, calls } = deps();
    expect(await revealSeed(d, { verified: true })).toHaveLength(12);
    expect(calls.verify).toBe(0);
  });
  test('a key-imported account has no phrase', async () => {
    const { d } = deps(true, '');
    await expect(revealSeed(d, { password: 'right' })).rejects.toThrow('no 12 words');
  });
  test('errors never carry the words', async () => {
    const d = {
      verifyPassword: async () => true,
      readMnemonic: async (): Promise<string> => {
        throw new Error(PHRASE);
      },
    };
    const err = await revealSeed(d, { password: 'x' }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('abandon');
  });
});

describe('copyWithAutoClear', () => {
  test('copies, then empties the clipboard after 60 s', async () => {
    const writes: string[] = [];
    let fire: (() => void) | undefined;
    let delay = 0;
    const timers = {
      set: ((fn: () => void, ms: number) => {
        fire = fn;
        delay = ms;
        return 1;
      }) as unknown as typeof setTimeout,
      clear: (() => {
        fire = undefined;
      }) as unknown as typeof clearTimeout,
    };
    await copyWithAutoClear('w1 w2', { writeText: async (t) => void writes.push(t) }, undefined, timers);
    expect(writes).toEqual(['w1 w2']);
    expect(delay).toBe(60_000);
    await fire?.();
    expect(writes).toEqual(['w1 w2', '']);
  });
  test('cancel stops the clear', async () => {
    const writes: string[] = [];
    let fire: (() => void) | undefined;
    const timers = {
      set: ((fn: () => void) => {
        fire = fn;
        return 1;
      }) as unknown as typeof setTimeout,
      clear: (() => {
        fire = undefined;
      }) as unknown as typeof clearTimeout,
    };
    const cancel = await copyWithAutoClear('x', { writeText: async (t) => void writes.push(t) }, 10, timers);
    cancel();
    expect(fire).toBeUndefined();
    expect(writes).toEqual(['x']);
  });
});
