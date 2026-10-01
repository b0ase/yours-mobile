import { describe, expect, test } from 'bun:test';

(globalThis as Record<string, unknown>).__MINT_FEE_ADDRESS__ = '';
(globalThis as Record<string, unknown>).__MARKET_BLOCKLIST_URL__ = '';
(globalThis as Record<string, unknown>).__MARKET_REPORT_URL__ = '';
const m = await import('./mint');
const { BUNDLED, SafetyFilter } = await import('../market/safety');
const f = new SafetyFilter(BUNDLED);

const ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const none = { kind: 'none' } as const;

describe('mint fee estimate', () => {
  test('bytes × sat/kB plus overhead, no creation fee by default', () => {
    const c = m.estimateCost(10_000, 100, 50);
    expect(c.networkSats).toBe(Math.ceil(((10_000 + m.TX_OVERHEAD_BYTES) * 100) / 1000) + 1);
    expect(c.feeSats).toBe(0);
    expect(c.totalSats).toBe(c.networkSats);
    expect(c.usd).toBeCloseTo((c.totalSats / 1e8) * 50);
  });
  test('new collection doubles the tx count', () => {
    expect(m.estimateCost(1000, 100, 0, { newCollection: true }).networkSats).toBe(
      2 * m.estimateCost(1000, 100).networkSats,
    );
  });
  test('1% creation fee (min 1 sat) only with a valid fee address', () => {
    const c = m.estimateCost(1_000_000, 100, 0, { feeAddress: ADDR });
    expect(c.feeSats).toBe(Math.ceil(c.networkSats * 0.01));
    expect(m.estimateCost(10, 1, 0, { feeAddress: ADDR }).feeSats).toBe(1);
    expect(m.estimateCost(1000, 100, 0, { feeAddress: 'not-an-address' }).feeSats).toBe(0);
  });
  test('no USD without a rate', () => expect(m.estimateCost(1, 100).usd).toBeNull());
});

describe('size limits', () => {
  test('accepts up to 10 MB', () => expect(m.checkSize(m.MAX_MINT_BYTES).ok).toBe(true));
  test('rejects over 10 MB with a clear message', () => {
    const r = m.checkSize(m.MAX_MINT_BYTES + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('10.0 MB');
  });
  test('rejects empty', () => expect(m.checkSize(0).ok).toBe(false));
  test('media types only', () => {
    expect(m.isMintableType('image/png')).toBe(true);
    expect(m.isMintableType('video/mp4')).toBe(true);
    expect(m.isMintableType('audio/mpeg')).toBe(true);
    expect(m.isMintableType('application/pdf')).toBe(false);
  });
});

describe('metadata', () => {
  test('MAP app/type/name/description', () => {
    expect(m.buildMap({ title: ' Sunset ', description: ' Beach ', collection: none })).toEqual({
      app: 'bWallet',
      type: 'ord',
      name: 'Sunset',
      description: 'Beach',
    });
  });
  test('description omitted when empty', () => {
    expect(m.buildMap({ title: 'A', description: '  ', collection: none })).toEqual({
      app: 'bWallet',
      type: 'ord',
      name: 'A',
    });
  });
  test('title required; new collection needs a name', () => {
    expect(m.validateForm({ title: ' ', description: '', collection: none }, f)).toBe('Add a title.');
    expect(m.validateForm({ title: 'x', description: '', collection: { kind: 'new', name: '' } }, f)).toBe(
      'Name the new collection.',
    );
    expect(m.validateForm({ title: 'Cat', description: 'my cat', collection: none }, f)).toBeNull();
  });
  test('collection id from mintCollection', () => {
    expect(m.collectionIdFrom('ab', undefined)).toBe('ab_0');
    expect(m.collectionIdFrom('ab', 'ab_0')).toBe('ab_0');
  });
  test('base64 of bytes', () =>
    expect(m.fileToBase64(new TextEncoder().encode('hi').buffer as ArrayBuffer)).toBe('aGk='));
});

describe('safety block', () => {
  test('blocked keywords in title, description or collection', () => {
    expect(m.validateForm({ title: 'NSFW drop', description: '', collection: none }, f)).toBe(m.BLOCKED_MESSAGE);
    expect(m.blockedText({ title: 'ok', description: 'adult art', collection: none }, f)).toBe(true);
    expect(m.blockedText({ title: 'ok', description: '', collection: { kind: 'new', name: 'sex pics' } }, f)).toBe(
      true,
    );
  });
  test('innocent words pass', () => {
    expect(m.blockedText({ title: 'Essex sunset', description: 'Dickens cockpit', collection: none }, f)).toBe(false);
  });
});

describe('fee output wrapper', () => {
  test('appends one fee output to the next createAction only', async () => {
    const calls: { outputs?: { satoshis: number; outputDescription: string }[] }[] = [];
    const wallet = { createAction: async (a: (typeof calls)[0]) => (calls.push(a), { txid: 't' }) };
    const ctx = m.withFeeOutput({ wallet } as never, 5, ADDR) as unknown as { wallet: typeof wallet };
    await ctx.wallet.createAction({ outputs: [{ satoshis: 1, outputDescription: 'Inscription' }] });
    await ctx.wallet.createAction({ outputs: [] });
    expect(calls[0].outputs!.map((o) => o.satoshis)).toEqual([1, 5]);
    expect(calls[0].outputs![1].outputDescription).toBe('bWallet mint fee');
    expect(calls[1].outputs).toEqual([]);
  });
  test('no fee address → context unchanged', () => {
    const ctx = { wallet: {} } as never;
    expect(m.withFeeOutput(ctx, 5, '')).toBe(ctx);
  });
});
