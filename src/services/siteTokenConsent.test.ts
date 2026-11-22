import { describe, expect, test } from 'bun:test';
import { chromeConsentStore, LEGACY_LIST_CONSENT_KEY, LIST_CONSENT_DAYS, memoryConsentStore } from './siteTokens';
import { keepGlobals } from '../testing/stubGlobals';

keepGlobals('chrome');
const DAY = 86_400_000;

describe('b-Aware 25 Oct: site token list consent expires and can be withdrawn', () => {
  test('memory store: expires after the limit, forget drops only that site', async () => {
    let t = Date.UTC(2026, 9, 25);
    const s = memoryConsentStore(() => t);
    await s.add('a.example', 'tok');
    await s.add('b.example', 'tok');
    expect(await s.has('a.example', 'tok')).toBe(true);
    await s.forget!('a.example');
    expect(await s.has('a.example', 'tok')).toBe(false);
    expect(await s.has('b.example', 'tok')).toBe(true);
    t += LIST_CONSENT_DAYS * DAY;
    expect(await s.has('b.example', 'tok')).toBe(false);
  });

  test('stored store: legacy entries with no time are expired; forget and expiry apply', async () => {
    const data: Record<string, unknown> = { [LEGACY_LIST_CONSENT_KEY]: [`old.example|tok|${Date.UTC(2026, 9, 25)}`] };
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: { get: async (k: string) => ({ [k]: data[k] }), set: async (v: object) => void Object.assign(data, v) },
      },
    };
    let t = Date.UTC(2026, 9, 25);
    const s = chromeConsentStore(() => t);
    expect(await s.has('old.example', 'tok')).toBe(false);
    await s.add('a.example', 'tok');
    expect(await s.has('a.example', 'tok')).toBe(true);
    // A second instance (another part of the wallet) sees a Forget made through this one.
    await chromeConsentStore(() => t).forget!('a.example');
    expect(await s.has('a.example', 'tok')).toBe(false);
    await s.add('a.example', 'tok');
    t += LIST_CONSENT_DAYS * DAY + 1;
    expect(await s.has('a.example', 'tok')).toBe(false);
  });
});

describe('b-Aware 318: token list consent is per account', () => {
  const setup = () => {
    const data: Record<string, unknown> = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: { get: async (k: string) => ({ [k]: data[k] }), set: async (v: object) => void Object.assign(data, v) },
      },
    };
    return data;
  };

  test('approve on account A, switch to B: the same request asks again', async () => {
    setup();
    const t = Date.UTC(2026, 10, 18);
    const a = chromeConsentStore(() => t, 'acct-A');
    const b = chromeConsentStore(() => t, 'acct-B');
    await a.add('a.example', 'tok_0');
    expect(await a.has('a.example', 'tok_0')).toBe(true);
    expect(await b.has('a.example', 'tok_0')).toBe(false);
    expect(await b.list()).toEqual({});
    expect(await a.list()).toEqual({ 'a.example': ['tok_0'] });
    // B answering does not disturb A's answer.
    await b.add('a.example', 'tok_0');
    expect(await a.has('a.example', 'tok_0')).toBe(true);
  });

  test('legacy shared entries are dropped, not handed to whichever account is active', async () => {
    const data = setup();
    const t = Date.UTC(2026, 10, 18);
    data[LEGACY_LIST_CONSENT_KEY] = [`a.example|tok_0|${t}`];
    const a = chromeConsentStore(() => t, 'acct-A');
    expect(await a.has('a.example', 'tok_0')).toBe(false);
    await a.add('b.example', 'tok_0');
    expect(data[LEGACY_LIST_CONSENT_KEY]).toEqual([]);
  });

  test('forget with an account id drops that account only; with none, every account', async () => {
    setup();
    const t = Date.UTC(2026, 10, 18);
    const a = chromeConsentStore(() => t, 'acct-A');
    const b = chromeConsentStore(() => t, 'acct-B');
    await a.add('a.example', 'tok_0');
    await b.add('a.example', 'tok_0');
    await a.forget('a.example');
    expect(await a.has('a.example', 'tok_0')).toBe(false);
    expect(await b.has('a.example', 'tok_0')).toBe(true);
    await a.add('a.example', 'tok_0');
    await chromeConsentStore(() => t).forget('a.example');
    expect(await a.has('a.example', 'tok_0')).toBe(false);
    expect(await b.has('a.example', 'tok_0')).toBe(false);
  });
});
