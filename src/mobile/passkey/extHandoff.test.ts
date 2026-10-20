import { describe, expect, test } from 'bun:test';
import {
  HANDOFF_EXT_ID,
  HANDOFF_LIFETIME_MS,
  HANDOFF_TYPE,
  HANDOFF_WEB_ORIGIN,
  buildHandoffMessage,
  confirmHandoff,
  handoffProof,
  handoffUrl,
  newHandoffCode,
  newHandoffSession,
  normaliseHandoffCode,
  parseHandoffMessage,
  parseHandoffSearch,
  receiveHandoff,
  sameText,
} from './extHandoff';

// A well-known public test phrase (the BIP-39 "abandon" vector), never a real wallet.
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const NOW = 1_800_000_000_000;

const received = async (code = '123456', name?: string) => {
  const s = newHandoffSession(NOW);
  const msg = await buildHandoffMessage(s.nonce, code, WORDS, name);
  const r = receiveHandoff(s, HANDOFF_WEB_ORIGIN, msg, NOW + 1000);
  if (!r.ok) throw new Error('setup failed');
  return { s, msg, session: r.session };
};

describe('request', () => {
  test('a fresh request has a 128-bit nonce, a 2 minute life and waits', () => {
    const s = newHandoffSession(NOW);
    expect(s.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(s.exp).toBe(NOW + HANDOFF_LIFETIME_MS);
    expect(s.state).toBe('waiting');
    expect(newHandoffSession(NOW).nonce).not.toBe(s.nonce);
  });
  test('the URL is the fixed page with only the extension id and nonce', () => {
    const u = new URL(handoffUrl('A'.repeat(22)));
    expect(u.origin).toBe(HANDOFF_WEB_ORIGIN);
    expect(u.pathname).toBe('/restore');
    expect([...u.searchParams.keys()].sort()).toEqual(['ext', 'n', 'passkey']);
    expect(u.searchParams.get('ext')).toBe(HANDOFF_EXT_ID);
  });
  test('the web page accepts only our extension id and a well-formed nonce', () => {
    const n = 'A'.repeat(22);
    expect(parseHandoffSearch(`?passkey=1&ext=${HANDOFF_EXT_ID}&n=${n}`)).toEqual({ nonce: n });
    expect(parseHandoffSearch(`?ext=${'a'.repeat(32)}&n=${n}`)).toBeNull();
    expect(parseHandoffSearch(`?ext=${HANDOFF_EXT_ID}&n=short`)).toBeNull();
    expect(parseHandoffSearch('?passkey=1')).toBeNull();
  });
});

describe('code', () => {
  test('six digits, and typed input is cleaned', () => {
    for (let i = 0; i < 50; i++) expect(newHandoffCode()).toMatch(/^\d{6}$/);
    expect(normaliseHandoffCode(' 123 456 ')).toBe('123456');
    expect(normaliseHandoffCode('123-456')).toBe('123456');
    expect(normaliseHandoffCode('12345')).toBe('');
    expect(normaliseHandoffCode('12345a')).toBe('');
  });
  test('the proof depends on the nonce and the code', async () => {
    const a = await handoffProof('A'.repeat(22), '123456');
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await handoffProof('A'.repeat(22), '123456')).toBe(a);
    expect(await handoffProof('B'.repeat(22), '123456')).not.toBe(a);
    expect(await handoffProof('A'.repeat(22), '123457')).not.toBe(a);
  });
  test('sameText compares whole strings', () => {
    expect(sameText('abc', 'abc')).toBe(true);
    expect(sameText('abc', 'abd')).toBe(false);
    expect(sameText('abc', 'abcd')).toBe(false);
  });
});

describe('message shape', () => {
  const good = async () => buildHandoffMessage('A'.repeat(22), '123456', WORDS, 'Main');
  test('accepts the one allowed shape and cleans the words', async () => {
    const m = await good();
    const p = parseHandoffMessage({ ...m, words: `  ${WORDS.toUpperCase()}\n` });
    expect(p?.words).toBe(WORDS);
    expect(p?.name).toBe('Main');
  });
  test('refuses another type, extra junk types, bad word counts and oversize names', async () => {
    const m = await good();
    expect(parseHandoffMessage(null)).toBeNull();
    expect(parseHandoffMessage('x')).toBeNull();
    expect(parseHandoffMessage({ ...m, t: 'other' })).toBeNull();
    expect(parseHandoffMessage({ ...m, n: 'short' })).toBeNull();
    expect(parseHandoffMessage({ ...m, proof: 'short' })).toBeNull();
    expect(parseHandoffMessage({ ...m, words: 'abandon '.repeat(11).trim() })).toBeNull();
    expect(parseHandoffMessage({ ...m, words: 'abandon '.repeat(13).trim() })).toBeNull();
    expect(parseHandoffMessage({ ...m, words: `${WORDS} 1` })).toBeNull();
    expect(parseHandoffMessage({ ...m, words: 'abandon '.repeat(100) })).toBeNull();
    expect(parseHandoffMessage({ ...m, name: 'x'.repeat(65) })).toBeNull();
    expect(parseHandoffMessage({ ...m, name: 5 })).toBeNull();
    expect(HANDOFF_TYPE).toBe('bwalletx-ext-handoff');
  });
  test('accepts a 24 word phrase', async () => {
    const w24 = Array.from({ length: 24 }, () => 'abandon').join(' ');
    const m = await buildHandoffMessage('A'.repeat(22), '123456', w24);
    expect(parseHandoffMessage(m)?.words.split(' ').length).toBe(24);
  });
});

describe('background receive', () => {
  test('the exact web origin with the live nonce fills the request', async () => {
    const s = newHandoffSession(NOW);
    const msg = await buildHandoffMessage(s.nonce, '123456', WORDS, 'Main');
    const r = receiveHandoff(s, HANDOFF_WEB_ORIGIN, msg, NOW + 5000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.state).toBe('received');
      expect(r.session.words).toBe(WORDS);
      expect(r.session.name).toBe('Main');
    }
  });
  test('every other origin is refused, including lookalikes and subdomains', async () => {
    const s = newHandoffSession(NOW);
    const msg = await buildHandoffMessage(s.nonce, '123456', WORDS);
    for (const o of [
      'https://desktop.bwalletx.com',
      'https://bwalletx.com',
      'https://evil.web.bwalletx.com',
      'https://web.bwalletx.com.evil.com',
      'http://web.bwalletx.com',
      'https://web.bwalletx.com:8443',
      'http://localhost:3000',
      '',
      undefined,
      null,
    ])
      expect(receiveHandoff(s, o, msg, NOW + 1000).ok).toBe(false);
  });
  test('localhost works only when asked (tests), never by default', async () => {
    const s = newHandoffSession(NOW);
    const msg = await buildHandoffMessage(s.nonce, '123456', WORDS);
    expect(receiveHandoff(s, 'http://localhost:5173', msg, NOW, true).ok).toBe(true);
    expect(receiveHandoff(s, 'http://localhost:5173', msg, NOW).ok).toBe(false);
  });
  test('a wrong nonce is refused and leaves the live request untouched', async () => {
    const s = newHandoffSession(NOW);
    const other = await buildHandoffMessage('B'.repeat(22), '123456', WORDS);
    const r = receiveHandoff(s, HANDOFF_WEB_ORIGIN, other, NOW + 1000);
    expect(r.ok).toBe(false);
    expect(r.session).toEqual(s);
  });
  test('an expired request is refused', async () => {
    const s = newHandoffSession(NOW);
    const msg = await buildHandoffMessage(s.nonce, '123456', WORDS);
    expect(receiveHandoff(s, HANDOFF_WEB_ORIGIN, msg, NOW + HANDOFF_LIFETIME_MS + 1).ok).toBe(false);
  });
  test('a request can only be filled once (reuse refused)', async () => {
    const { s, msg, session } = await received();
    const again = await buildHandoffMessage(s.nonce, '999999', 'zoo '.repeat(11) + 'wrong');
    expect(receiveHandoff(session, HANDOFF_WEB_ORIGIN, msg, NOW + 2000).ok).toBe(false);
    const r = receiveHandoff(session, HANDOFF_WEB_ORIGIN, again, NOW + 2000);
    expect(r.ok).toBe(false);
    expect(r.session?.words).toBe(WORDS);
  });
  test('no request, or a malformed message, is refused', async () => {
    const msg = await buildHandoffMessage('A'.repeat(22), '123456', WORDS);
    expect(receiveHandoff(null, HANDOFF_WEB_ORIGIN, msg, NOW).ok).toBe(false);
    const s = newHandoffSession(NOW);
    expect(receiveHandoff(s, HANDOFF_WEB_ORIGIN, { hello: 1 }, NOW).ok).toBe(false);
  });
});

describe('popup confirm', () => {
  test('the right code releases the words and burns the request', async () => {
    const { session } = await received('482915', 'Main');
    const r = await confirmHandoff(session, '482 915', NOW + 10_000);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.words).toBe(WORDS);
      expect(r.name).toBe('Main');
    }
    expect(r.burn).toBe(true);
  });
  test('a wrong code is refused AND burns the request: one attempt', async () => {
    const { session } = await received('482915');
    const r = await confirmHandoff(session, '000000', NOW + 10_000);
    expect(r).toEqual({ ok: false, reason: 'wrong-code', burn: true });
  });
  test('before the web step is done it says so and does not burn', async () => {
    const s = newHandoffSession(NOW);
    expect(await confirmHandoff(s, '123456', NOW + 1000)).toEqual({ ok: false, reason: 'not-received', burn: false });
  });
  test('a malformed code is not a guess, so it does not burn', async () => {
    const { session } = await received();
    expect(await confirmHandoff(session, '12ab', NOW + 1000)).toEqual({ ok: false, reason: 'bad-code', burn: false });
  });
  test('an expired request is refused and burned, even with the right code', async () => {
    const { session } = await received('123456');
    expect(await confirmHandoff(session, '123456', NOW + HANDOFF_LIFETIME_MS + 1)).toEqual({
      ok: false,
      reason: 'expired',
      burn: true,
    });
  });
  test('no request', async () => {
    expect(await confirmHandoff(null, '123456')).toEqual({ ok: false, reason: 'none', burn: false });
  });
});
