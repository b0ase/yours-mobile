import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { FeaturePausedError, resetKillSwitchCache } from '../mobile/config/killSwitch';
import { sweepLegacyMnee } from './sweepLegacyMnee';

const realFetch = globalThis.fetch;
const setStatus = (paused: unknown[]) => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ paused }), { status: 200 })) as typeof fetch;
  resetKillSwitchCache();
};

const key = PrivateKey.fromRandom();
const approver = PrivateKey.fromRandom().toPublicKey().toString();
const dest = PrivateKey.fromRandom().toPublicKey().toAddress();

// A source tx paying 1 sat to the legacy address, so the sweep can build and sign.
const sourceHex = () => {
  const tx = new Transaction(1, [], [], 0);
  tx.addOutput({
    lockingScript: new P2PKH().lock(key.toPublicKey().toAddress()),
    satoshis: 1,
  });
  return tx.toHex();
};

const makeClient = () => {
  const calls = { getConfig: 0, getAllUtxos: 0, fetchRawTx: 0, submitRawTx: 0 };
  const client = {
    getConfig: async () => {
      calls.getConfig++;
      return { approver, tokenId: 'x_0', feeAddress: dest, fees: [{ min: 0, max: 1e12, fee: 0 }] };
    },
    getAllUtxos: async () => {
      calls.getAllUtxos++;
      return [{ txid: 'aa'.repeat(32), vout: 0, data: { bsv21: { amt: 500_000 } } }];
    },
    fetchRawTx: async () => {
      calls.fetchRawTx++;
      return sourceHex();
    },
    submitRawTx: async () => {
      calls.submitRawTx++;
      return {};
    },
    getTxStatus: async () => ({ status: 'SUCCESS' }),
  };
  return { client: client as never, calls };
};

describe('legacy MNEE sweep and the spending pause (b-Aware 505)', () => {
  beforeEach(() => resetKillSwitchCache());
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetKillSwitchCache();
  });

  test('paused: throws FeaturePausedError, no config, no build, no signature, no cosigner call', async () => {
    setStatus(['spending']);
    const { client, calls } = makeClient();
    const progress = mock(() => {});
    await expect(
      sweepLegacyMnee({ mneeClient: client, legacyPrivateKey: key, destinationAddress: dest, onProgress: progress }),
    ).rejects.toBeInstanceOf(FeaturePausedError);
    expect(calls).toEqual({ getConfig: 0, getAllUtxos: 0, fetchRawTx: 0, submitRawTx: 0 });
    expect(progress).not.toHaveBeenCalled();
  });

  test('not paused: sweep reaches the cosigner as before', async () => {
    setStatus([]);
    const { client, calls } = makeClient();
    const r = await sweepLegacyMnee({ mneeClient: client, legacyPrivateKey: key, destinationAddress: dest });
    expect(calls.submitRawTx).toBe(1);
    expect(r.error).toBe('No ticket ID returned from MNEE');
  });

  test('paused while the sweep is building: nothing reaches the cosigner (check right before submit)', async () => {
    setStatus([]);
    const { client, calls } = makeClient();
    const inner = (client as { fetchRawTx: () => Promise<string> }).fetchRawTx;
    (client as { fetchRawTx: () => Promise<string> }).fetchRawTx = async () => {
      setStatus(['spending']); // the pause lands after the first check, before the submit
      return inner();
    };
    await expect(
      sweepLegacyMnee({ mneeClient: client, legacyPrivateKey: key, destinationAddress: dest }),
    ).rejects.toBeInstanceOf(FeaturePausedError);
    expect(calls.fetchRawTx).toBeGreaterThan(0);
    expect(calls.submitRawTx).toBe(0);
  });

  test('a different feature paused does not stop the sweep', async () => {
    setStatus(['passkeyCreate']);
    const { client, calls } = makeClient();
    await sweepLegacyMnee({ mneeClient: client, legacyPrivateKey: key, destinationAddress: dest });
    expect(calls.submitRawTx).toBe(1);
  });
});
