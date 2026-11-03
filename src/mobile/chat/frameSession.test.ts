import { describe, expect, test } from 'bun:test';
import { ChatApiError, type ChatSession } from './api';
import { answerFrameSession, isBchatFrameOrigin, parseFrameSessionMode, singleFlight } from './frameSession';

const S = (token: string, handle = 'b0asex'): ChatSession => ({ token, handle, address: '1Addr' });
const CODE = 'A'.repeat(43);
const BCHATX = 'https://www.bchatx.com';

describe('frame session origins', () => {
  test('only the exact bChatX origins', () => {
    expect(isBchatFrameOrigin('https://www.bchatx.com')).toBe(true);
    expect(isBchatFrameOrigin('https://chat.bwalletx.com')).toBe(true);
    for (const bad of [
      'https://bchatx.com.evil.com',
      'https://evil.com',
      'http://www.bchatx.com',
      'https://www.bchatx.com/',
      'https://bitcoin-writer.com',
      'capacitor://localhost',
      'null',
      '',
      null,
    ])
      expect(isBchatFrameOrigin(bad)).toBe(false);
  });
  test('modes', () => {
    expect(parseFrameSessionMode({ mode: 'code' })).toBe('code');
    expect(parseFrameSessionMode({ mode: 'whoami' })).toBe('whoami');
    expect(parseFrameSessionMode({ mode: 'token' })).toBeNull();
    expect(parseFrameSessionMode(null)).toBeNull();
  });
});

describe('answerFrameSession', () => {
  test('refuses any other framed site, without touching the session', async () => {
    let touched = false;
    const deps = {
      load: () => ((touched = true), S('t')),
      signIn: async () => ((touched = true), S('t')),
      mint: async () => ((touched = true), { code: CODE }),
    };
    const r = await answerFrameSession('https://bitcoin-writer.com', { mode: 'code' }, deps);
    expect(r.success).toBe(false);
    expect(touched).toBe(false);
  });

  test('whoami answers the stored handle with no server call', async () => {
    let minted = false;
    const deps = { load: () => S('t', 'alice'), signIn: async () => S('x'), mint: async () => ((minted = true), {}) };
    expect(await answerFrameSession(BCHATX, { mode: 'whoami' }, deps)).toEqual({
      success: true,
      data: { handle: 'alice' },
    });
    const none = { ...deps, load: () => null };
    expect(await answerFrameSession(BCHATX, { mode: 'whoami' }, none)).toEqual({
      success: true,
      data: { handle: null },
    });
    expect(minted).toBe(false);
  });

  test('code: uses the stored session; the wallet token is never in the reply', async () => {
    const seen: string[] = [];
    const deps = {
      load: () => S('wallet-token'),
      signIn: async () => S('fresh'),
      mint: async (s: ChatSession) => (seen.push(s.token), { code: CODE }),
    };
    const r = await answerFrameSession(BCHATX, { mode: 'code' }, deps);
    expect(r).toEqual({ success: true, data: { code: CODE, handle: 'b0asex' } });
    expect(seen).toEqual(['wallet-token']);
    expect(JSON.stringify(r)).not.toContain('wallet-token');
  });

  test('code: signs in first when the account has no session yet', async () => {
    const deps = {
      load: () => null,
      signIn: async () => S('fresh', 'bob'),
      mint: async (s: ChatSession) => ({ code: s.token === 'fresh' ? CODE : 'x' }),
    };
    expect(await answerFrameSession(BCHATX, { mode: 'code' }, deps)).toEqual({
      success: true,
      data: { code: CODE, handle: 'bob' },
    });
  });

  test('code: a stale token (401) signs in again once', async () => {
    let signIns = 0;
    const deps = {
      load: () => S('stale'),
      signIn: async () => (signIns++, S('fresh')),
      mint: async (s: ChatSession) => {
        if (s.token === 'stale') throw new ChatApiError('Unauthorized', 401);
        return { code: CODE };
      },
    };
    expect((await answerFrameSession(BCHATX, { mode: 'code' }, deps)).success).toBe(true);
    expect(signIns).toBe(1);
  });

  test('code: other failures are a one-line error, no retry loop', async () => {
    let signIns = 0;
    const deps = {
      load: () => S('t'),
      signIn: async () => (signIns++, S('t')),
      mint: async () => {
        throw new ChatApiError('Too many sign-in codes. Wait a minute.', 429);
      },
    };
    expect(await answerFrameSession(BCHATX, { mode: 'code' }, deps)).toEqual({
      success: false,
      error: 'Too many sign-in codes. Wait a minute.',
    });
    expect(signIns).toBe(0);
  });

  test('code: a malformed server answer is refused', async () => {
    const deps = { load: () => S('t'), signIn: async () => S('t'), mint: async () => ({ code: 'short' }) };
    expect((await answerFrameSession(BCHATX, { mode: 'code' }, deps)).success).toBe(false);
  });

  test('code: a wallet bChatX has not seen and no name yet says so plainly', async () => {
    const deps = {
      load: () => null,
      signIn: async () => {
        throw new ChatApiError('Choose your handle first.', 409, {
          needs_handle: true,
          claim_token: 'c',
          address: 'a',
        });
      },
      mint: async () => ({ code: CODE }),
    };
    expect(await answerFrameSession(BCHATX, { mode: 'code' }, deps)).toEqual({
      success: false,
      error: 'Choose your bChatX name in the Chat tab first.',
    });
  });

  test('unknown mode', async () => {
    const deps = { load: () => S('t'), signIn: async () => S('t'), mint: async () => ({ code: CODE }) };
    expect((await answerFrameSession(BCHATX, { mode: 'steal' }, deps)).success).toBe(false);
  });
});

test('singleFlight shares one in-flight sign-in', async () => {
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const once = singleFlight(async () => {
    n++;
    await gate;
    return n;
  });
  const a = once();
  const b = once();
  release();
  expect(await a).toBe(1);
  expect(await b).toBe(1);
  expect(await once()).toBe(2);
});
