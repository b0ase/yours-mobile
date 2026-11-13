import { describe, expect, test } from 'bun:test';
import { Utils } from '@bsv/sdk';
import { makeExpiryDeps } from './unsentExpiryWiring';
import { withPayLock } from '../mobile/themeOrder/storePay';
import { storeKindSynced } from '../mobile/themeOrder/storePaymentDesc';

const TX = 'ab'.repeat(32);
const QUOTE = 'cd'.repeat(16);
const memo = (tag: string, q = QUOTE) =>
  `006a${tag.length.toString(16).padStart(2, '0')}${Utils.toHex(Utils.toArray(tag, 'utf8'))}20${Utils.toHex(Utils.toArray(q, 'utf8'))}`;
const storePayment = {
  txid: TX,
  description: 'Theme purchase · Cool',
  outputs: [{ lockingScript: memo('bwx-theme-buy') }],
};
const send = { txid: TX, description: 'Send', outputs: [] };

/** Just enough of the wallet and storage for makeExpiryDeps to build its deps (nothing here is called). */
const wiring = (o: { storePaid: boolean; created?: Record<string, { quoteId: string; at: number }> }) => ({
  wallet: {} as never,
  storage: {} as never,
  services: null,
  identityKey: '02'.padEnd(66, '0'),
  kv: { load: async () => null, save: async () => undefined },
  createdKV: { get: async () => o.created ?? {}, set: async () => undefined },
  storePaid: o.storePaid,
});

describe('unsentExpiryWiring: Store payments in a build that sells Store items', () => {
  test("storePaid: the Store is asked under the payment's lock; 'mine' only from this device's record", async () => {
    const deps = makeExpiryDeps(wiring({ storePaid: true, created: { [TX]: { quoteId: QUOTE, at: 1 } } }));
    expect(typeof deps.storeAsk).toBe('function');
    expect(deps.lock).toBe(withPayLock);
    expect(await deps.storeKind!(storePayment)).toBe('mine');
    expect(await deps.storeKind!(send)).toBe('not-store');
    // Synced from another device (no record here): the longer cross-device hold.
    expect(await makeExpiryDeps(wiring({ storePaid: true })).storeKind!(storePayment)).toBe('other-device');
  });
  test('storePaid false: no Store question, no lock; the kind is still read', async () => {
    const deps = makeExpiryDeps(wiring({ storePaid: false }));
    expect(deps.storeAsk).toBeUndefined();
    expect(deps.lock).toBeUndefined();
    expect(await deps.storeKind!(storePayment)).toBe('other-device');
  });
});

describe('storeKindSynced (the store build classifier)', () => {
  test("a Store payment's description is 'other-device', never 'mine'; the memo is not needed", async () => {
    expect(await storeKindSynced(storePayment)).toBe('other-device');
    expect(await storeKindSynced({ description: 'bWalletX theme edition' })).toBe('other-device');
    expect(await storeKindSynced({ description: 'Theme purchase · X', outputs: [] } as never)).toBe('other-device');
    expect(await storeKindSynced(send)).toBe('not-store');
    expect(await storeKindSynced({})).toBe('not-store');
  });
});

describe('unsentExpiryWiring in a store build (VITE_STORE_BUILD=1 process)', () => {
  // The flag is inlined at build time; a separate process with the store env reads it as a store build does.
  const run = (env: Record<string, string>) => {
    const code = `
      const { makeExpiryDeps } = await import('./src/services/unsentExpiryWiring.ts');
      const created = { ${JSON.stringify(TX)}: { quoteId: ${JSON.stringify(QUOTE)}, at: 1 } };
      const deps = makeExpiryDeps({
        wallet: {}, storage: {}, services: null, identityKey: '02'.padEnd(66, '0'),
        kv: { load: async () => null, save: async () => undefined },
        createdKV: { get: async () => created, set: async () => undefined },
        storePaid: true,
      });
      console.log(JSON.stringify({
        ask: typeof deps.storeAsk, lock: typeof deps.lock,
        store: await deps.storeKind(${JSON.stringify(storePayment)}),
        send: await deps.storeKind(${JSON.stringify(send)}),
      }));`;
    const r = Bun.spawnSync(['bun', '-e', code], {
      env: { ...process.env, VITE_STORE_BUILD: '', VITE_CHANNEL: '', ...env },
    });
    return JSON.parse(r.stdout.toString()) as { ask: string; lock: string; store: string; send: string };
  };
  test('no Store question or lock even if asked; a synced Store payment (even one recorded here) gets the longer hold', () => {
    for (const env of [{ VITE_STORE_BUILD: '1' }, { VITE_CHANNEL: 'ios-store' }, { VITE_CHANNEL: 'android-play' }])
      expect(run(env)).toEqual({ ask: 'undefined', lock: 'undefined', store: 'other-device', send: 'not-store' });
  });
  test('the same process without the store env is the full wiring', () => {
    expect(run({})).toEqual({ ask: 'function', lock: 'function', store: 'mine', send: 'not-store' });
  });
});
