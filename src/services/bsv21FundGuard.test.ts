import { describe, expect, test } from 'bun:test';
import { fundOverlayExact, fundingCopy, fundingTotal, transfersCovered, type FundingTemplate } from './bsv21FundGuard';

const tpl = (...sats: number[]): FundingTemplate => ({
  outputs: sats.map((s) => ({ lockingScript: '76a9', satoshis: s, outputDescription: 'Overlay funding' })),
});

const setup = (templates: FundingTemplate[]) => {
  let calls = 0;
  const paid: number[] = [];
  const bsv21 = {
    other: 'kept',
    async getFundingTemplate() {
      return templates[Math.min(calls++, templates.length - 1)];
    },
  };
  const ctx = { services: { bsv21, beef: 'b' }, wallet: 'w' };
  // Like @1sat/actions fundBsv21Overlay: fetches the template itself and pays it.
  const action = {
    async execute(c: typeof ctx) {
      const t = await c.services.bsv21.getFundingTemplate();
      paid.push(fundingTotal(t));
      expect((c.services.bsv21 as { other?: string }).other).toBe('kept');
      expect(c.services.beef).toBe('b');
      return { txid: 'tx' };
    },
  };
  return { ctx, action, paid, calls: () => calls };
};

describe('fund the indexer only for the confirmed amount', () => {
  test('no amount means no payment', async () => {
    const { ctx, action, paid, calls } = setup([tpl(10_000_000)]);
    expect((await fundOverlayExact(ctx, 'id_0', undefined, action)).error).toBe('funding-amount-unknown');
    expect((await fundOverlayExact(ctx, 'id_0', 0, action)).error).toBe('funding-amount-unknown');
    expect(paid).toEqual([]);
    expect(calls()).toBe(0);
  });

  test('a template that changed since the confirm is refused', async () => {
    const { ctx, action, paid } = setup([tpl(10_000_000, 500)]);
    const r = await fundOverlayExact(ctx, 'id_0', 10_000_000, action);
    expect(r).toEqual({ error: 'funding-amount-changed', templateSats: 10_000_500 });
    expect(paid).toEqual([]);
  });

  test('a template lookup failure pays nothing', async () => {
    const ctx = {
      services: {
        bsv21: {
          getFundingTemplate: async (): Promise<FundingTemplate> => {
            throw new Error('503');
          },
        },
      },
    };
    const action = { execute: async () => ({ txid: 'x' }) };
    expect((await fundOverlayExact(ctx, 'id_0', 1000, action)).error).toBe('funding-template-unavailable');
  });

  test('the action pays the checked template even if the indexer changes it in between', async () => {
    const { ctx, action, paid } = setup([tpl(10_000_000), tpl(99_000_000)]);
    const r = await fundOverlayExact(ctx, 'id_0', 10_000_000, action);
    expect(r.txid).toBe('tx');
    expect(paid).toEqual([10_000_000]);
  });

  test('nothing asked: nothing paid', async () => {
    const { ctx, action, paid } = setup([tpl()]);
    expect((await fundOverlayExact(ctx, 'id_0', 1000, action)).error).toBe('funding-not-needed');
    expect(paid).toEqual([]);
  });

  test('the copy says the amount, not refundable, and the transfers covered', () => {
    expect(transfersCovered(10_000_000, 1000)).toBe(5000);
    expect(transfersCovered(10_000_000, 0)).toBeUndefined();
    expect(fundingCopy(10_000_000, 'TERANODE', 5000)).toBe(
      'Pays 0.1 BSV to the TERANODE indexer. Not refundable. Covers about 5,000 future transfers for all holders.',
    );
    expect(fundingCopy(10_000_000, 'TERANODE', undefined)).toBe(
      'Pays 0.1 BSV to the TERANODE indexer. Not refundable.',
    );
  });
});
