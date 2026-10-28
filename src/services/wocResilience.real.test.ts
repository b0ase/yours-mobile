import { expect, test } from 'bun:test';
import { Services } from '@bsv/wallet-toolbox-client';
import { OneSatServices } from '@1sat/client';
import { hardenWalletServices, WocRateLimited } from './wocResilience';

test('real toolbox: a 429 on every WhatsOnChain call ends in WocRateLimited, not WERR_INTERNAL', async () => {
  const fb = new Services('main');
  const svc = new OneSatServices('main', undefined, fb as never);
  const woc = (fb as unknown as { whatsonchain: { request: unknown } }).whatsonchain;
  woc.request = async () => ({ status: 429, statusText: 'Too Many Requests', ok: false });
  expect(hardenWalletServices(svc, '')).toBe(true);
  const w = woc as unknown as { request: (u: string, o: object) => Promise<unknown> };
  const t0 = Date.now();
  const e = await w.request('https://api.whatsonchain.com/v1/bsv/main/chain/info', {}).catch((x) => x);
  expect(e).toBeInstanceOf(WocRateLimited);
  expect(Date.now() - t0).toBeLessThan(11_000);
  (svc as unknown as { close?: () => void }).close?.();
}, 15_000);
