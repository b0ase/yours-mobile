import { expect, test } from 'bun:test';
import { failedFetchMessage, nameFailedFetch } from './nameFailedFetch';

test('a failed request names its host and stays a TypeError', async () => {
  const target = {
    fetch: (async () => {
      throw new TypeError('Load failed');
    }) as unknown as typeof fetch,
  };
  nameFailedFetch(target);
  const err = await target.fetch('https://api.whatsonchain.com/v1/bsv/main/tx/ab/hex').catch((e) => e);
  expect(err).toBeInstanceOf(TypeError);
  expect(err.message).toBe("Couldn't reach api.whatsonchain.com (Load failed). Check your connection and try again.");
});

test('non-network errors pass through untouched', () => {
  expect(failedFetchMessage('not a url ::', 'x')).toContain('x');
});
