import { describe, expect, test } from 'bun:test';
import { runSiteSwap } from './swapSite';
import { SWAP_ACCEPT_ACTION, SWAP_OFFER_ACTION, isSwapOrigin } from './swapAction';

const terms = { ref: 'doc-1', docHash: 'ab'.repeat(32), tokenId: 'aa'.repeat(32) + '_0', amount: '100', priceUsd: 1 };
const never = async () => {
  throw new Error('deps must not be touched');
};

describe('swap site calls', () => {
  test('only bChatX may ask', async () => {
    const r = await runSiteSwap(SWAP_OFFER_ACTION, 'https://evil.example', { terms }, never);
    expect(r).toMatchObject({ success: false, code: 'ORIGIN' });
    const v = await runSiteSwap(SWAP_OFFER_ACTION, 'https://bchatx-preview.vercel.app', { terms }, never);
    expect(v).toMatchObject({ success: false, code: 'ORIGIN' });
  });
  test('chat.bwalletx.com (bChatX on our private domain) may ask; lookalikes may not', async () => {
    expect(isSwapOrigin('https://chat.bwalletx.com')).toBe(true);
    for (const o of [
      'http://chat.bwalletx.com',
      'https://chat.bwalletx.com.evil.example',
      'https://bwalletx.com',
      'https://web.bwalletx.com',
      'chat.bwalletx.com',
    ])
      expect(isSwapOrigin(o)).toBe(false);
    const r = await runSiteSwap(
      SWAP_OFFER_ACTION,
      'https://chat.bwalletx.com',
      { terms: { ...terms, docHash: 'x' } },
      never,
    );
    expect(r).toMatchObject({ success: false, code: 'BAD_REQUEST' });
  });
  test('malformed terms are refused before the wallet is touched', async () => {
    const r = await runSiteSwap(
      SWAP_OFFER_ACTION,
      'https://www.bchatx.com',
      { terms: { ...terms, docHash: 'x' } },
      never,
    );
    expect(r).toMatchObject({ success: false, code: 'BAD_REQUEST' });
  });
  test('accept without an offer is refused', async () => {
    const r = await runSiteSwap(SWAP_ACCEPT_ACTION, 'https://www.bchatx.com', { terms }, never);
    expect(r).toMatchObject({ success: false, code: 'BAD_REQUEST' });
  });
  test('a price over the cap is refused before any sheet', async () => {
    let asked = false;
    const r = await runSiteSwap(
      SWAP_OFFER_ACTION,
      'https://www.bchatx.com',
      { terms: { ...terms, priceUsd: 50 } },
      async () => ({
        ctx: {} as never,
        quote: async () => ({ rate: 25, source: 't' }),
        ask: async () => (asked = true),
        store: { get: async () => undefined, put: async () => undefined },
      }),
    );
    expect(r.success).toBe(false);
    expect(asked).toBe(false);
    expect((r as { error: string }).error).toMatch(/over the \$10 cap/);
  });
  test('priceSats terms still apply the USD cap with an on-demand rate', async () => {
    let asked = false;
    const r = await runSiteSwap(
      SWAP_OFFER_ACTION,
      'https://www.bchatx.com',
      {
        terms: {
          ref: terms.ref,
          docHash: terms.docHash,
          tokenId: terms.tokenId,
          amount: '100',
          priceSats: 100_000_000,
        },
      },
      async () => ({
        ctx: {} as never,
        quote: async () => ({ rate: 25, source: 'WhatsOnChain BSV/USD rate' }),
        ask: async () => (asked = true),
        store: { get: async () => undefined, put: async () => undefined },
      }),
    );
    expect(r.success).toBe(false);
    expect(asked).toBe(false);
    expect((r as { error: string }).error).toMatch(/cap/);
  });
  test('no rate from any source: clear NO_RATE error, no sheet', async () => {
    let asked = false;
    const msg = "Couldn't get the BSV price (tried WhatsOnChain, CoinGecko). Check your connection and try again";
    const r = await runSiteSwap(
      SWAP_OFFER_ACTION,
      'https://www.bchatx.com',
      {
        terms: { ref: terms.ref, docHash: terms.docHash, tokenId: terms.tokenId, amount: '100', priceSats: 11_852_554 },
      },
      async () => ({
        ctx: {} as never,
        quote: async () => {
          throw new Error(msg);
        },
        ask: async () => (asked = true),
        store: { get: async () => undefined, put: async () => undefined },
      }),
    );
    expect(r).toEqual({ success: false, error: msg, code: 'NO_RATE' });
    expect(asked).toBe(false);
  });
  test('an accept already sent on this device returns its txid and never re-sends', async () => {
    const r = await runSiteSwap(SWAP_ACCEPT_ACTION, 'https://www.bchatx.com', { terms, offer: {} }, async () => ({
      ctx: {} as never,
      quote: async () => ({ rate: 25, source: 't' }),
      ask: async () => true,
      store: {
        get: async () => ({ ref: 'doc-1', state: 'sent' as const, txid: 'ff'.repeat(32), at: 1 }),
        put: async () => undefined,
      },
    }));
    expect(r).toEqual({ success: true, data: { txid: 'ff'.repeat(32), recovered: true } });
  });
  test('a half-finished accept (signing, no txid) refuses instead of paying again', async () => {
    const r = await runSiteSwap(SWAP_ACCEPT_ACTION, 'https://www.bchatx.com', { terms, offer: {} }, async () => ({
      ctx: {} as never,
      quote: async () => ({ rate: 25, source: 't' }),
      ask: async () => true,
      store: { get: async () => ({ ref: 'doc-1', state: 'signing' as const, at: 1 }), put: async () => undefined },
    }));
    expect((r as { error: string }).error).toMatch(/already started/);
  });
});

describe('swap release', () => {
  test('only bChatX may release, and a ref is required', async () => {
    const { SWAP_RELEASE_ACTION } = await import('./swapAction');
    expect((await runSiteSwap(SWAP_RELEASE_ACTION, 'https://evil.example', { ref: 'r' }, never)).success).toBe(false);
    expect(await runSiteSwap(SWAP_RELEASE_ACTION, 'https://www.bchatx.com', {}, never)).toMatchObject({
      success: false,
      code: 'BAD_REQUEST',
    });
  });
});
