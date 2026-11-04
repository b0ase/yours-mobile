/**
 * The wallet side of "Recover change from my 12 words" (services/seedChange.ts): what initWallet passes in. Its own
 * module so the round-trip test (seedChange.roundtrip.test.ts) runs exactly the production wiring.
 *
 * Reads: every store the wallet can reach (this device's, and the remote backup's spendable rows), the chain through
 * the wallet's services (raw transactions, block proofs, address history) and WhatsOnChain's spend index.
 * Writes: only this wallet's storage, through the toolbox's internalizeAction ('wallet payment' with the derivation), and
 * only for a mined, unspent output storage holds no row for. Nothing is signed or broadcast.
 *
 * Only while this device's store is the active one (review L1): with the remote active, the rows that decide whether a
 * coin is already held live on the remote, and a claim into the device copy could be pushed over a newer remote row.
 * Recovery waits until the account has moved to the device store (it does on open once a verified copy is pulled).
 */
import type { MerklePath } from '@bsv/sdk';
import { atomicBeefOf, timedStep } from './recoverByTxid';
import { makeTxidRecoverDeps, managedStores, withRepairStore, type TxidWiring } from './recoverByTxidWiring';
import {
  p2pkhHex,
  wocSpentLookup,
  type ClaimResult,
  type SeedChangeDeps,
  type SeedChangeKV,
  type SeedChangeState,
  type SeedKeyDeriver,
  type SpendState,
} from './seedChange';

/** Transaction statuses whose outputs storage treats as real (internalizeAction merges into these). */
const SETTLED = ['completed', 'unproven', 'sending', 'nosend'];
/** A spender the walk may stop at (review L2): done or broadcast, and its change rows are in storage. */
const FINAL = ['completed', 'unproven'];
export const REMOTE_ACTIVE_REFUSAL =
  'this account’s main copy is still the remote backup. Lock and unlock the wallet so this device becomes the main copy, then try again. Nothing was changed.';
const TXID = /^[0-9a-f]{64}$/;
const PAGE = 1000;

type OutRow = {
  txid?: string;
  vout: number;
  spendable: boolean;
  spentBy?: number;
  transactionId: number;
  change?: boolean;
};
type TxRow = { transactionId: number; txid?: string; status: string };

export type SeedChangeWiring = Omit<TxidWiring, 'wallet' | 'services'> & {
  wallet: TxidWiring['wallet'] & { keyDeriver: SeedKeyDeriver };
  services: TxidWiring['services'] & {
    hashOutputScript?: (scriptHex: string) => string;
    getScriptHashHistory?: (hash: string) => Promise<{ status?: string; history?: { txid?: string }[] } | undefined>;
  };
  /** Addresses the seed derives (identity, legacy pay and ordinals, deposit addresses). */
  seedAddresses: () => string[] | Promise<string[]>;
  /** Who spent an outpoint; WhatsOnChain (rate-limited) unless given. */
  spentBy?: (outpoint: string) => Promise<SpendState>;
  kv: SeedChangeKV;
  /** Start a fresh scan ("Start fresh"). */
  fresh?: boolean;
  runMs?: number;
  maxDepth?: number;
  maxTxs?: number;
  now?: () => number;
};

export function makeSeedChangeDeps(w: SeedChangeWiring): SeedChangeDeps {
  const t = makeTxidRecoverDeps({ ...w, legacyAddresses: [] } as TxidWiring);
  const identityKey = w.wallet.keyDeriver.identityKey;
  const spentBy = w.spentBy ?? wocSpentLookup();
  const log = w.log ?? ((m: string) => console.log(m));

  const storageOutpoints = async () => {
    const open = new Set<string>();
    const settled = new Set<string>();
    // This device's (active) store: outputs, and which spender it knows.
    await withRepairStore(w.storage, async (sp, userId) => {
      const txs = (await sp.findTransactions({ partial: { userId }, noRawTx: true })) as unknown as TxRow[];
      const byId = new Map(txs.map((x) => [x.transactionId, x]));
      const rows: OutRow[] = [];
      for (let offset = 0; offset < 1_000_000; offset += PAGE) {
        const page = (await sp.findOutputs({
          partial: { userId },
          noScript: true,
          paged: { limit: PAGE, offset },
        })) as unknown as OutRow[];
        rows.push(...page);
        if (page.length < PAGE) break;
      }
      // Payments whose change rows storage holds: an interrupted sync or a short restore can leave one without them.
      const withChange = new Set(rows.filter((o) => o.change).map((o) => o.transactionId));
      for (const o of rows) {
        if (!o.txid || !TXID.test(o.txid)) continue;
        const outpoint = `${o.txid}.${o.vout}`;
        const spender = o.spentBy != null ? byId.get(o.spentBy) : undefined;
        // Stop the walk only at a spender that is done or broadcast and whose change is held; anything else (stuck,
        // nosend, change rows missing, unknown) is looked up on chain and walked past.
        const final =
          !o.spendable && !!spender?.txid && FINAL.includes(spender.status) && withChange.has(spender.transactionId);
        (final ? settled : open).add(outpoint);
      }
    });
    // Backups (the remote): coins it holds as unspent that this device doesn't have.
    for (const { name, m } of managedStores(w.storage)) {
      if (!m.user || (m as { isStorageProvider?: boolean }).isStorageProvider) continue;
      try {
        await timedStep(
          `seed change: read ${name}`,
          w.stepTimeoutMs ?? 20_000,
          'Couldn’t reach the backup',
          async () => {
            for (let offset = 0; offset < 1_000_000; offset += PAGE) {
              const page = (await m.storage.findOutputsAuth(
                { userId: m.user!.userId, identityKey },
                { partial: { spendable: true }, noScript: true, paged: { limit: PAGE, offset } },
              )) as unknown as OutRow[];
              for (const o of page) {
                const outpoint = o.txid && TXID.test(o.txid) ? `${o.txid}.${o.vout}` : '';
                if (outpoint && !settled.has(outpoint)) open.add(outpoint);
              }
              if (page.length < PAGE) break;
            }
          },
          log,
        );
      } catch (e) {
        log(`[seedChange] couldn't read ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { open: [...open], settled: [...settled] };
  };

  const addressHistory = async (address: string) => {
    const script = p2pkhHex(address);
    // No history service at all (never on the shipped services): skip addresses rather than retry them forever.
    if (!script || !w.services.hashOutputScript || !w.services.getScriptHashHistory) return [];
    const r = await w.services.getScriptHashHistory(w.services.hashOutputScript(script));
    if (r?.status !== 'success' || !Array.isArray(r.history)) return undefined;
    return r.history.map((h) => (h.txid ?? '').toLowerCase()).filter((x) => TXID.test(x));
  };

  const claim = async (txid: string, change: Parameters<SeedChangeDeps['claim']>[1]): Promise<ClaimResult> => {
    if (!w.storage.isActiveStorageProvider()) throw new Error(REMOTE_ACTIVE_REFUSAL);
    // Mined only: a proof that names this txid. A payment still in the mempool is left for a later run.
    const merklePath: MerklePath | undefined = await t.getMerklePath(txid).catch(() => undefined);
    if (!merklePath?.path?.[0]?.some((l) => l.hash === txid))
      return change.map((c) => ({ vout: c.vout, state: 'pending', detail: 'not mined yet' }));
    const rawTx = await t.getRawTx(txid);
    if (!rawTx?.length) throw new Error('the transaction couldn’t be fetched');
    const rows = await t.activeRows(txid);
    const results: ClaimResult = [];
    const add: typeof change = [];
    for (const c of change) {
      const row = rows?.outputs.find((o) => o.vout === c.vout);
      if (row) {
        const ok = row.spendable && rows?.tx && SETTLED.includes(rows.tx.status);
        results.push(
          ok
            ? { vout: c.vout, state: 'already' }
            : {
                vout: c.vout,
                state: 'held',
                detail: `storage holds it (${rows?.tx?.status ?? 'no transaction'}, unspendable)`,
              },
        );
        continue;
      }
      if (rows?.tx && !SETTLED.includes(rows.tx.status)) {
        results.push({ vout: c.vout, state: 'held', detail: `storage holds this payment as ${rows.tx.status}` });
        continue;
      }
      const s = await spentBy(`${txid}.${c.vout}`).catch((): SpendState => ({ state: 'unclear' }));
      if (s.state === 'spent') results.push({ vout: c.vout, state: 'spent' });
      else if (s.state === 'unspent') add.push(c);
      else results.push({ vout: c.vout, state: 'failed', detail: 'couldn’t confirm it is unspent' });
    }
    if (add.length) {
      await t.internalize({
        tx: atomicBeefOf(rawTx, merklePath),
        outputs: add.map((c) => ({
          outputIndex: c.vout,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: c.derivationPrefix,
            derivationSuffix: c.derivationSuffix,
            senderIdentityKey: identityKey,
          },
        })),
        description: 'Change recovered from 12 words',
        labels: ['recovered'],
      });
      for (const c of add) results.push({ vout: c.vout, state: 'restored' });
    }
    return results;
  };

  return {
    keyDeriver: w.wallet.keyDeriver,
    storageOutpoints,
    seedAddresses: async () => [...(await w.seedAddresses())].filter((a) => !!a && !!p2pkhHex(a)),
    addressHistory,
    spentBy,
    getRawTx: (txid) => t.getRawTx(txid),
    claim,
    pushBackups: t.pushBackups,
    refusal: () => (w.storage.isActiveStorageProvider() ? undefined : REMOTE_ACTIVE_REFUSAL),
    fresh: w.fresh,
    kv: w.kv,
    now: w.now,
    progress: w.progress,
    log: w.log,
    runMs: w.runMs,
    maxDepth: w.maxDepth,
    maxTxs: w.maxTxs,
  };
}

/**
 * Scan progress in chrome.storage.local (the mobile and web builds shim it), else localStorage; one key per identity.
 * Only public data is kept: outpoints, txids, amounts and counters (never keys or derivations).
 */
export function seedChangeKV(identityKey: string): SeedChangeKV {
  const key = `bwx.seedChange.v1.${identityKey.slice(0, 16)}`;
  type ChromeLocal = {
    get: (k: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  };
  const local = (globalThis as { chrome?: { storage?: { local?: ChromeLocal } } }).chrome?.storage?.local;
  return {
    load: async () => {
      if (local) return ((await local.get(key))[key] as SeedChangeState | undefined) ?? null;
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? (JSON.parse(raw) as SeedChangeState) : null;
    },
    save: async (s) => {
      if (local) await local.set({ [key]: s });
      else globalThis.localStorage?.setItem(key, JSON.stringify(s));
    },
  };
}
