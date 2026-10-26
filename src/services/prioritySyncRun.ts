/**
 * Wires prioritySync (services/prioritySync.ts) to the wallet: the same addresses, processed-tx store and
 * internalization as the 1sat `syncAddresses` action, so the two are interchangeable run to run.
 */
import {
  DEFAULT_DEPOSIT_PREFIX,
  ProcessedTxStoreIdb,
  internalizeBeef,
  syncAddresses,
  type OneSatContext,
} from '@1sat/actions';
import { LEGACY_ONESAT_PROTOCOL, ONESAT_PROTOCOL } from '@1sat/types';
import { PublicKey, Transaction, Utils, type WalletProtocol } from '@bsv/sdk';
import { prioritySync, type PartProgress, type PrioritySyncResult } from './prioritySync';

const SYNC_PROTOCOLS = [ONESAT_PROTOCOL, LEGACY_ONESAT_PROTOCOL] as WalletProtocol[];

type Derivation = {
  address: string;
  derivationPrefix: string;
  derivationSuffix: string;
  senderIdentityKey: string;
  protocolID: WalletProtocol;
};

/** The P2PKH hash of each address, as hex, for spotting our outputs in a raw tx (bare or after an inscription). */
const pkhHex = (address: string) => Utils.toHex(Utils.fromBase58Check(address).data as number[]);

export const runPrioritySync = async (
  ctx: OneSatContext,
  opts: {
    count: number;
    onProgress?: (p: PartProgress) => void;
    onCoinsReady?: (r: { found: number; failed: number }) => void;
  },
): Promise<PrioritySyncResult> => {
  const services = ctx.services;
  if (!services) throw new Error('address sync needs services');
  // No IndexedDB (a test runner, a server): the stock action, which picks its own store.
  if (typeof indexedDB === 'undefined') {
    const r = await syncAddresses.execute(ctx, { count: opts.count });
    return { ...r, coins: { found: 0, failed: 0 }, names: { total: 0, failed: r.failed } };
  }

  const { publicKey: identityKey } = await ctx.wallet.getPublicKey({ identityKey: true });
  const derivations: Derivation[] = [];
  for (const protocolID of SYNC_PROTOCOLS) {
    for (let i = 0; i < opts.count; i++) {
      const derivationSuffix = String(i);
      const { publicKey } = await ctx.wallet.getPublicKey({
        protocolID,
        keyID: `${DEFAULT_DEPOSIT_PREFIX} ${derivationSuffix}`,
        forSelf: true,
      });
      derivations.push({
        address: PublicKey.fromString(publicKey).toAddress(),
        derivationPrefix: DEFAULT_DEPOSIT_PREFIX,
        derivationSuffix,
        senderIdentityKey: identityKey,
        protocolID,
      });
    }
  }
  const addresses = derivations.map((d) => d.address);
  const hashes = addresses.map(pkhHex);
  const addressDerivations = new Map(
    derivations.map((d) => [
      d.address,
      {
        outputIndex: 0,
        derivationPrefix: d.derivationPrefix,
        derivationSuffix: d.derivationSuffix,
        senderIdentityKey: d.senderIdentityKey,
        protocolID: d.protocolID,
        counterparty: 'self',
      },
    ]),
  ) as unknown as Parameters<typeof internalizeBeef>[0]['addressDerivations'];

  const store = new ProcessedTxStoreIdb(identityKey);
  try {
    const { height } = await ctx.wallet.getHeight({});
    return await prioritySync({
      addresses,
      height,
      store,
      stream: (a, from, onIndexerProgress) => services.owner.sync(a, from, onIndexerProgress),
      ourOutputs: async (txid) => {
        const tx = Transaction.fromBinary(Array.from(await services.beef.getRawTx(txid)));
        const out: number[] = [];
        for (const o of tx.outputs) {
          const hex = o.lockingScript.toHex();
          if (hashes.some((h) => hex.includes(`76a914${h}88ac`))) out.push(o.satoshis ?? 0);
        }
        return out;
      },
      fetchBeef: async (txid) => {
        const beef = await services.beef.getBeef(txid);
        if (!beef) throw new Error(`Failed to load BEEF for ${txid}`);
        return Array.from(beef);
      },
      internalize: async (_txid, beef) => {
        await internalizeBeef({
          beef: Uint8Array.from(beef),
          addressDerivations,
          wallet: ctx.wallet,
          services,
          chain: ctx.chain,
        });
      },
      onProgress: opts.onProgress,
      onCoinsReady: opts.onCoinsReady,
    });
  } finally {
    await store.close();
  }
};
