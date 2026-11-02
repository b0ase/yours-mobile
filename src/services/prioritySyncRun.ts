/**
 * Wires prioritySync (services/prioritySync.ts) to the wallet: the same addresses, processed-tx store and
 * internalization as the 1sat `syncAddresses` action, so the two are interchangeable run to run.
 */
import {
  DEFAULT_DEPOSIT_PREFIX,
  ProcessedTxStoreIdb,
  internalizeBeef,
  randomActionId,
  syncAddresses,
  type OneSatContext,
} from '@1sat/actions';
import { DEPOSIT_BASKET, LEGACY_ONESAT_PROTOCOL, ONESAT_PROTOCOL } from '@1sat/types';
import { Beef, OP, PublicKey, Utils, type InternalizeOutput, type Transaction, type WalletProtocol } from '@bsv/sdk';
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

/**
 * Satoshis of each output whose script holds a P2PKH to one of `hashes` (bare or after an inscription), read
 * straight from the raw bytes. Owner, 1 Nov 2026: parsing every transaction with Transaction.fromBinary and turning
 * each locking script into hex (OpNS mints carry inscriptions of hundreds of KB) grew the iPhone web view ~10 MB/s
 * until iOS killed it; this keeps no copy of the transaction.
 */
export const outputsPaying = (raw: Uint8Array, hashes: Set<string>): number[] => {
  let p = 4;
  const u32 = (at: number) => (raw[at] | (raw[at + 1] << 8) | (raw[at + 2] << 16)) + raw[at + 3] * 2 ** 24;
  const varint = (): number => {
    if (p >= raw.length) throw new Error('raw transaction is truncated');
    const b = raw[p++];
    if (b < 0xfd) return b;
    if (b === 0xfd) return ((p += 2), raw[p - 2] | (raw[p - 1] << 8));
    if (b === 0xfe) return ((p += 4), u32(p - 4));
    return ((p += 8), u32(p - 8) + u32(p - 4) * 2 ** 32);
  };
  const inputs = varint();
  for (let i = 0; i < inputs; i++) {
    p += 36;
    const scriptLength = varint();
    p += scriptLength + 4;
  }
  const outputs = varint();
  const paid: number[] = [];
  for (let i = 0; i < outputs; i++) {
    if (p + 8 > raw.length) throw new Error('raw transaction is truncated');
    const satoshis = u32(p) + u32(p + 4) * 2 ** 32;
    p += 8;
    const scriptLength = varint();
    const end = p + scriptLength;
    if (end > raw.length) throw new Error('raw transaction is truncated');
    for (let j = p; j + 25 <= end; j++) {
      if (raw[j] !== 0x76 || raw[j + 1] !== 0xa9 || raw[j + 2] !== 0x14 || raw[j + 23] !== 0x88 || raw[j + 24] !== 0xac)
        continue;
      if (hashes.has(Utils.toHex(Array.from(raw.subarray(j + 3, j + 23))))) {
        paid.push(satoshis);
        break;
      }
    }
    p = end;
  }
  if (p + 4 > raw.length) throw new Error('raw transaction is truncated');
  return paid;
};

/** Indexer tags that mark a 1-sat item (inscription, ordinal, token, name, listing), never a plain coin. */
const ONE_SAT_TAGS = ['insc', 'origin', 'bsv20', 'bsv21', 'opns', 'ordlock'];

/** True when the indexer tags every one of `rows` as a 1-sat item; false when any is untagged or unknown. */
export const allOneSat = (rows: ({ data?: Record<string, unknown> } | null | undefined)[]): boolean =>
  rows.length > 0 && rows.every((r) => !!r?.data && ONE_SAT_TAGS.some((t) => r.data![t] !== undefined));

/** The receive key behind a plain coin output: the same record the 1sat pipeline writes for plain BSV. */
export type CoinKey = { derivationPrefix: string; derivationSuffix: string; protocolID: WalletProtocol };

/**
 * Plain P2PKH outputs of `tx` (just the 25-byte script, more than 1 sat) paying one of our keys, as deposit-basket
 * insertions. Inscriptions and tokens are left to the names part.
 */
export const coinOutputs = (
  tx: Transaction,
  keyByHash: Map<string, CoinKey>,
  actionId: string,
): { outputs: InternalizeOutput[]; satoshis: number } => {
  const outputs: InternalizeOutput[] = [];
  let satoshis = 0;
  tx.outputs.forEach((o, vout) => {
    const c = o.lockingScript.chunks;
    if ((o.satoshis ?? 0) <= 1 || c.length !== 5) return;
    if (c[0].op !== OP.OP_DUP || c[1].op !== OP.OP_HASH160 || c[3].op !== OP.OP_EQUALVERIFY) return;
    if (c[4].op !== OP.OP_CHECKSIG || c[2].data?.length !== 20) return;
    const key = keyByHash.get(Utils.toHex(c[2].data));
    if (!key) return;
    satoshis += o.satoshis ?? 0;
    outputs.push({
      outputIndex: vout,
      protocol: 'basket insertion',
      insertionRemittance: {
        basket: DEPOSIT_BASKET,
        tags: [`id:${actionId}_${vout}`],
        customInstructions: JSON.stringify({
          protocolID: key.protocolID,
          keyID: `${key.derivationPrefix} ${key.derivationSuffix}`,
          counterparty: 'self',
        }),
      },
    });
  });
  return { outputs, satoshis };
};

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
  const hashes = new Set(addresses.map(pkhHex));
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

  const keyByHash = new Map<string, CoinKey>(derivations.map((d) => [pkhHex(d.address), d]));

  const store = new ProcessedTxStoreIdb(identityKey);
  try {
    const { height } = await ctx.wallet.getHeight({});
    return await prioritySync({
      addresses,
      height,
      store,
      stream: (a, from, onIndexerProgress) => services.owner.sync(a, from, onIndexerProgress),
      ourOutputs: async (txid) => outputsPaying(await services.beef.getRawTx(txid), hashes),
      classified: new ProcessedTxStoreIdb(`${identityKey}:classified-1sat`),
      isOneSatOnly: async (outpoints) =>
        outpoints.length > 0 &&
        allOneSat(
          (await services.txo.getBatch(outpoints, { tags: ['*'] })) as unknown as Parameters<typeof allOneSat>[0],
        ),
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
      internalizeCoin: async (txid, beef) => {
        const beefObj = Beef.fromBinary(beef);
        const tx = beefObj.findTxid(txid)?.tx;
        if (!tx) throw new Error(`Transaction ${txid} is not in its BEEF`);
        const { outputs, satoshis } = coinOutputs(tx, keyByHash, randomActionId());
        if (!outputs.length) return;
        await ctx.wallet.internalizeAction({
          tx: beefObj.toBinaryAtomic(txid),
          outputs,
          description: `Received ${satoshis} sats`.slice(0, 50),
        });
      },
      onProgress: opts.onProgress,
      onCoinsReady: opts.onCoinsReady,
    });
  } finally {
    await store.close();
  }
};
