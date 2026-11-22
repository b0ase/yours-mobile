import { expect, test } from 'bun:test';
import { Services } from '@bsv/wallet-toolbox-client';
import { OneSatServices } from '@1sat/client';
import { hardenWalletServices, WocRateLimited } from './wocResilience';

test('real toolbox: a 429 on every WhatsOnChain call ends in WocRateLimited, not WERR_INTERNAL', async () => {
  const fb = new Services('main');
  const svc = new OneSatServices('main', undefined, fb as never);
  const woc = (fb as unknown as { whatsonchain: { request: unknown } }).whatsonchain;
  woc.request = async () => ({ status: 429, statusText: 'Too Many Requests', ok: false });
  // A fake sleep: the real backoff schedule is exercised, but no real time passes and no clock bound is asserted.
  const slept: number[] = [];
  expect(hardenWalletServices(svc, '', {}, { sleep: async (ms) => void slept.push(ms) })).toBe(true);
  const w = woc as unknown as { request: (u: string, o: object) => Promise<unknown> };
  const e = await w.request('https://api.whatsonchain.com/v1/bsv/main/chain/info', {}).catch((x) => x);
  expect(e).toBeInstanceOf(WocRateLimited);
  expect(slept.length).toBe(5); // 6 attempts, a wait between each
  expect(slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000); // the backoff budget
  (svc as unknown as { close?: () => void }).close?.();
}, 30_000);
