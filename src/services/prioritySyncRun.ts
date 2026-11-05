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
import { createInternalizeLock, type InternalizeLock } from './internalizeLock';
import { spentIn, type SpendCheck } from './spendCheck';

const SYNC_PROTOCOLS = [ONESAT_PROTOCOL, LEGACY_ONESAT_PROTOCOL] as WalletProtocol[];

type Derivation = {
  address: string;
  derivationPrefix: string;
  derivationSuffix: string;
  senderIdentityKey: string;
  protocolID: WalletProtocol;
};

/** The P2PKH hash of each address, as hex, for spotting our outputs in a raw tx (bare or after an inscription). */
export const pkhHex = (address: string) => Utils.toHex(Utils.fromBase58Check(address).data as number[]);

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

/** The keys the address sync scans: SYNC_PROTOCOLS x `count` deposit indexes, as the 1sat pipeline derives them. */
export type SyncKeys = {
  identityKey: string;
  addresses: string[];
  /** P2PKH hash (hex) of each address. */
  hashes: Set<string>;
  keyByHash: Map<string, CoinKey>;
  addressDerivations: Parameters<typeof internalizeBeef>[0]['addressDerivations'];
};

export const deriveSyncKeys = async (wallet: OneSatContext['wallet'], count: number): Promise<SyncKeys> => {
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true });
  const derivations: Derivation[] = [];
  for (const protocolID of SYNC_PROTOCOLS) {
    for (let i = 0; i < count; i++) {
      const derivationSuffix = String(i);
      const { publicKey } = await wallet.getPublicKey({
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
  ) as unknown as SyncKeys['addressDerivations'];
  return {
    identityKey,
    addresses,
    hashes: new Set(addresses.map(pkhHex)),
    keyByHash: new Map<string, CoinKey>(derivations.map((d) => [pkhHex(d.address), d])),
    addressDerivations,
  };
};

/** The processed-tx store's two calls the intake needs (ProcessedTxStoreIdb). */
export type ProcessedTxids = { has(txid: string): Promise<boolean>; add(txid: string): Promise<void> };

/**
 * Taking a plain-coin payment into the wallet: the one path the address sync's coins part and the receive watcher
 * (services/receiveWatch.ts) share. Its outputs paying our keys go into the deposit basket with the record the 1sat
 * pipeline writes; the address sync's sweep then moves them into funding as before.
 */
export type IntakeResult = 'taken' | 'already' | 'none' | 'spent' | 'unclear';

export type CoinIntake = {
  /** Our plain coin outputs of `txid` in this BEEF (bare P2PKH to one of our keys, more than 1 sat). */
  coins(txid: string, beef: number[]): { vout: number; satoshis: number }[];
  /**
   * Take `txid`'s coin outputs in, once: under the shared internalize lock, skipped when the processed store already
   * has the txid ('already'), recorded there after ('taken'). 'none': it pays us no plain coin; nothing written.
   * 'spent': every coin output is already spent (another copy of this wallet swept it; review 20, H1): nothing written,
   * nothing recorded. 'unclear': the spend check could not answer and this intake skips what it can't check.
   */
  take(txid: string, beef: number[]): Promise<IntakeResult>;
};

export const makeCoinIntake = (d: {
  wallet: Pick<OneSatContext['wallet'], 'internalizeAction'>;
  keyByHash: Map<string, CoinKey>;
  processed: ProcessedTxids;
  lock?: InternalizeLock;
  /**
   * Spent already, mempool included (services/spendCheck.ts)? Asked before the lock is taken. Owner, 5 Nov 2026 (review
   * 20, H1): the owner stream lists a payment unspent until its sweep is mined, so the other copy of this wallet took in
   * a payment the extension had swept, and counted it on top of the sweep's change.
   */
  spends?: SpendCheck;
  /** Of these txids, the ones storage holds (our own spends): a spender it does not hold means another copy took it. */
  knownTxids?: (txids: string[]) => Promise<Set<string>>;
  /** Another copy of this wallet spent these outputs: ask for a device-sync pull (services/receiveWatch.ts). */
  foreignSpend?: (spenders: string[]) => void;
  /** The spend check can't answer: take the coin as before ('take', the address sync) or wait ('skip', the watcher). */
  unknownSpend?: 'take' | 'skip';
}): CoinIntake => {
  const lock = d.lock ?? createInternalizeLock();
  const parse = (txid: string, beef: number[]) => {
    const beefObj = Beef.fromBinary(beef);
    const tx = beefObj.findTxid(txid)?.tx;
    if (!tx) throw new Error(`Transaction ${txid} is not in its BEEF`);
    return { beefObj, tx };
  };
  return {
    coins: (txid, beef) => {
      const { tx } = parse(txid, beef);
      return coinOutputs(tx, d.keyByHash, 'probe').outputs.map((o) => ({
        vout: o.outputIndex,
        satoshis: tx.outputs[o.outputIndex].satoshis ?? 0,
      }));
    },
    take: async (txid, beef) => {
      const { beefObj, tx } = parse(txid, beef);
      let { outputs } = coinOutputs(tx, d.keyByHash, randomActionId());
      if (!outputs.length) return 'none';
      // Outside the lock: a network call never holds up the other intakes.
      let complete = true;
      if (d.spends) {
        const ops = outputs.map((o) => `${txid}.${o.outputIndex}`);
        const answer = await d.spends(ops).catch(() => new Map<string, string | null>());
        const { spent, spenders } = spentIn(answer, ops);
        if (spenders.length) {
          const ours = (await d.knownTxids?.(spenders).catch(() => new Set<string>())) ?? new Set<string>();
          const foreign = spenders.filter((t) => !ours.has(t));
          if (foreign.length) d.foreignSpend?.(foreign);
        }
        const unclear = ops.filter((o) => !answer.has(o));
        const skip = new Set([...spent, ...(d.unknownSpend === 'skip' ? unclear : [])]);
        if (skip.size) {
          outputs = outputs.filter((o) => !skip.has(`${txid}.${o.outputIndex}`));
          // Only what is spent elsewhere may be left out of the record; an output skipped as unclear is tried again.
          complete = !(d.unknownSpend === 'skip' && unclear.length);
        }
        if (!outputs.length) return spent.length ? 'spent' : 'unclear';
      }
      return lock(async () => {
        if (await d.processed.has(txid)) return 'already';
        const satoshis = outputs.reduce((t, o) => t + (tx.outputs[o.outputIndex].satoshis ?? 0), 0);
        await d.wallet.internalizeAction({
          tx: beefObj.toBinaryAtomic(txid),
          outputs,
          description: `Received ${satoshis} sats`.slice(0, 50),
        });
        if (complete) await d.processed.add(txid);
        return 'taken';
      });
    },
  };
};

export const runPrioritySync = async (
  ctx: OneSatContext,
  opts: {
    count: number;
    onProgress?: (p: PartProgress) => void;
    onCoinsReady?: (r: { found: number; failed: number }) => void;
    /** The internalize lock shared with the receive guard and the receive watcher (services/internalizeLock.ts). */
    lock?: InternalizeLock;
    /** Spent already, mempool included? A coin another copy of this wallet swept is not taken in (review 20, H1). */
    spends?: SpendCheck;
    knownTxids?: (txids: string[]) => Promise<Set<string>>;
    foreignSpend?: (spenders: string[]) => void;
  },
): Promise<PrioritySyncResult> => {
  const services = ctx.services;
  if (!services) throw new Error('address sync needs services');
  // No IndexedDB (a test runner, a server): the stock action, which picks its own store.
  if (typeof indexedDB === 'undefined') {
    const r = await syncAddresses.execute(ctx, { count: opts.count });
    return { ...r, coins: { found: 0, failed: 0 }, names: { total: 0, failed: r.failed } };
  }

  const lock = opts.lock ?? createInternalizeLock();
  const { identityKey, addresses, hashes, keyByHash, addressDerivations } = await deriveSyncKeys(
    ctx.wallet,
    opts.count,
  );

  const store = new ProcessedTxStoreIdb(identityKey);
  // The spend check fails open here, as before it existed: a payment is never left out because an index is down.
  const intake = makeCoinIntake({
    wallet: ctx.wallet,
    keyByHash,
    processed: store,
    lock,
    spends: opts.spends,
    knownTxids: opts.knownTxids,
    foreignSpend: opts.foreignSpend,
    unknownSpend: 'take',
  });
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
      internalize: (_txid, beef) =>
        lock(async () => {
          await internalizeBeef({
            beef: Uint8Array.from(beef),
            addressDerivations,
            wallet: ctx.wallet,
            services,
            chain: ctx.chain,
          });
        }),
      // The receive watcher may have taken it in since the scan: take() checks the processed store inside the lock.
      internalizeCoin: async (txid, beef) => {
        const r = await intake.take(txid, beef);
        // Spent elsewhere (or unclear): not recorded, so a later run looks again once the indexer has the spend.
        return r === 'spent' || r === 'unclear' ? 'skipped' : undefined;
      },
      onProgress: opts.onProgress,
      onCoinsReady: opts.onCoinsReady,
    });
  } finally {
    await store.close();
  }
};
