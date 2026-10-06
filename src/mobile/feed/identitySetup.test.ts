import { describe, expect, test } from 'bun:test';
import type { Script } from '@bsv/sdk';
import { isNoIdentityError, NoPostingIdentityError, signWithIdentity } from './feedApi';

const signed = {} as Script;
const noId = () => Promise.reject(new Error('No BAP identity found. Publish your identity first.'));

describe('signWithIdentity (inline posting-identity setup)', () => {
  test('signs straight away when there is an identity', async () => {
    let asked = false;
    const out = await signWithIdentity(
      async () => signed,
      async () => (asked = true),
    );
    expect(out).toBe(signed);
    expect(asked).toBe(false);
  });

  test('no identity: runs the setup, then signs', async () => {
    let calls = 0;
    const sign = () => (++calls === 1 ? noId() : Promise.resolve(signed));
    expect(await signWithIdentity(sign, async () => true)).toBe(signed);
    expect(calls).toBe(2);
  });

  test('setup cancelled: nothing signed', async () => {
    expect(await signWithIdentity(noId, async () => false)).toBeNull();
  });

  test('no setup screen: a plain error, no jargon', async () => {
    const err = await signWithIdentity(noId, null).catch((e) => e);
    expect(err).toBeInstanceOf(NoPostingIdentityError);
    expect(err.message).not.toMatch(/BAP|AIP|Settings|identity/i);
  });

  test('other errors pass through untouched', async () => {
    const err = await signWithIdentity(
      () => Promise.reject(new Error('Insufficient funds')),
      async () => true,
    ).catch((e) => e);
    expect(err.message).toBe('Insufficient funds');
  });

  test('recognises the @1sat/actions message', () => {
    expect(isNoIdentityError(new Error('No BAP identity found'))).toBe(true);
    expect(isNoIdentityError(new Error('other'))).toBe(false);
  });
});
