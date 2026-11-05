import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  createUncertainSends,
  outcomeIsUncertain,
  recipientKey,
  UNCERTAIN_SEND_WINDOW_MS,
  UNCERTAIN_SENDS_KEY,
  type KV,
} from './uncertainSends';

const memoryKV = (): KV & { m: Record<string, unknown> } => {
  const m: Record<string, unknown> = {};
  return {
    m,
    get: async (k) => ({ [k]: structuredClone(m[k]) }),
    set: async (i) => void Object.assign(m, structuredClone(i)),
  };
};

describe('recipientKey: what the person typed', () => {
  test('a paymail or $name is case-insensitive and trimmed; an address keeps its case', () => {
    expect(recipientKey('  Bob@HandCash.io ')).toBe('bob@handcash.io');
    expect(recipientKey('$Bob')).toBe('$bob');
    expect(recipientKey(' 1BoatSLRHtKNngkdXEeobR76b53LETtpyT ')).toBe('1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
  });
});

describe('outcomeIsUncertain', () => {
  test('only a proven "not sent" is certain', () => {
    expect(outcomeIsUncertain({ moneyMoved: 'no' })).toBe(false);
    expect(outcomeIsUncertain({ moneyMoved: 'unknown' })).toBe(true);
    expect(outcomeIsUncertain({ moneyMoved: 'yes' })).toBe(true);
  });
});

describe('createUncertainSends (17c: key on what the person typed, kept on the device)', () => {
  test('remembered per account and recipient, NOT per amount: a re-priced $10 or a fresh $name address still matches', async () => {
    const kv = memoryKV();
    let t = 1_000;
    const g = createUncertainSends(kv, () => t);
    await g.note('acct', [{ recipient: 'bob@handcash.io', amount: '$10.00' }]);
    t += 60_000;
    expect(await g.pending('acct', ['BOB@handcash.io'])).toEqual([
      { recipient: 'bob@handcash.io', amount: '$10.00', at: 1_000 },
    ]);
    expect(await g.pending('acct', ['alice@handcash.io'])).toEqual([]);
    expect(await g.pending('other-account', ['bob@handcash.io'])).toEqual([]);
  });
  test('survives a restart (a new instance over the same device store)', async () => {
    const kv = memoryKV();
    await createUncertainSends(kv, () => 5).note('acct', [{ recipient: '$bob', amount: '$1.00' }]);
    expect(await createUncertainSends(kv, () => 6).pending('acct', ['$BOB'])).toHaveLength(1);
    expect(kv.m[UNCERTAIN_SENDS_KEY]).toBeDefined();
  });
  test('after the window, or once the person chose "Send anyway", it is gone', async () => {
    const kv = memoryKV();
    let t = 0;
    const g = createUncertainSends(kv, () => t);
    await g.note('acct', [{ recipient: '$bob', amount: '$1.00' }]);
    t = UNCERTAIN_SEND_WINDOW_MS + 1;
    expect(await g.pending('acct', ['$bob'])).toEqual([]);
    t = 0;
    await g.note('acct', [{ recipient: '$bob', amount: '$1.00' }]);
    await g.clear('acct', ['$bob']);
    expect(await g.pending('acct', ['$bob'])).toEqual([]);
  });
  test('a broken store never blocks a send', async () => {
    const g = createUncertainSends({
      get: async () => Promise.reject(new Error('quota')),
      set: async () => Promise.reject(new Error('quota')),
    });
    await g.note('acct', [{ recipient: '$bob', amount: '$1.00' }]);
    expect(await g.pending('acct', ['$bob'])).toEqual([]);
  });
});

describe('only the wallet’s own Send page asks: sites, pots, subscriptions and agents are never held by it', () => {
  const src = new URL('..', import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  };
  walk(src);
  test('uncertainSends is imported by the Send page alone', () => {
    const users = files
      .filter((f) => /from '[./]+utils\/uncertainSends'|from '\.\/uncertainSends'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length));
    expect(users).toEqual(['pages/BsvWallet.tsx']);
  });
  test('the background send path has no re-tap guard (no new refusal path for sites or agents)', () => {
    for (const f of ['background.ts', 'services/ownSend.ts', 'services/spentRetry.ts']) {
      const text = readFileSync(join(src, f), 'utf8');
      expect(/from '[^']*(sendGuard|uncertainSends)'|guard\.check\(/.test(text)).toBe(false);
    }
  });
});
