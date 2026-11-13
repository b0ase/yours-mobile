/**
 * unsentExpiry's deps as the wallet runs them (initWallet expireUnsent), in one place so the two-device simulation
 * (src/testing/twoDeviceSim/world.ts) runs exactly the app's wiring, not a hand copy that falls behind (13 Nov 2026:
 * the copy lacked the conflict / detach / Store-kind deps, so the sim kept failing after the fix had landed).
 *
 * Everything that reaches the network takes `fetch` (the sim's fake chain; the global fetch in the app); everything
 * that touches storage goes through the WalletStorageManager it is handed.
 */
import { Transaction } from '@bsv/sdk';
import { wocSpentStatus } from './coinPreflight';
import { eitherChainSource, oneSatChainLookups } from './chainSources';
import { wocChainLookups } from './seedChange';
import {
  conflictCheck,
  storageDetachInput,
  storageReaffirmSpent,
  wocHeight,
  wocSpent,
  type DetachProvider,
  type ExpiryDeps,
  type ExpiryKV,
  type NoSendAction,
} from './unsentExpiry';
import { expiryLookups } from './unsentGuard';
import { deadline } from '../utils/abortTimeout';
import { createdHereKV, storeAskFor, storeKindFor } from '../mobile/themeOrder/storeHeard';
import { withPayLock } from '../mobile/themeOrder/storePay';

type F = (url: string, init?: RequestInit) => Promise<Response>;

type ListedAction = {
  txid: string;
  labels?: string[];
  description?: string;
  inputs?: { sourceOutpoint: string }[];
  outputs?: { lockingScript?: string; satoshis?: number }[];
};

export type ExpiryWallet = {
  listNoSendActions: (args: {
    labels: string[];
    includeLabels: true;
    includeInputs: true;
    includeOutputs: true;
    includeOutputLockingScripts: true;
    limit: number;
    offset: number;
  }) => Promise<{ actions: ListedAction[] }>;
  abortAction: (args: { reference: string }) => Promise<unknown>;
  createAction: (args: {
    description: string;
    options: { sendWith: string[]; acceptDelayedBroadcast: false };
  }) => Promise<unknown>;
  getPublicKey: (args: { identityKey: true }) => Promise<{ publicKey: string }>;
  createSignature: (args: never) => Promise<{ signature: number[] }>;
};

export type ExpiryStorage = {
  isActiveStorageProvider: () => boolean;
  getAuth: () => Promise<{ userId?: number }>;
  runAsStorageProvider: <T>(fn: (sp: never) => Promise<T>) => Promise<T>;
  getActiveStore: () => string;
};

export type ExpiryWiring = {
  wallet: ExpiryWallet;
  storage: ExpiryStorage;
  /** The toolbox services (OneSatServices): txo.getSpends and beef.getRawTx, when it has them. */
  services: unknown;
  identityKey: string;
  kv: ExpiryKV;
  fetch?: F;
  /** WhatsOnChain client options for reading a spender's raw tx (pacing, retries); the sim passes fast ones. */
  woc?: Parameters<typeof wocChainLookups>[0];
  /** The automatic coin check's cleared list (autoCoinResync recordAutoCleared). */
  recordCleared?: (outpoint: string, spender: string) => Promise<void>;
  recoverLate?: (txid: string) => Promise<unknown>;
  /** The background's storage switch is under way. */
  storageBusy?: () => boolean;
  /** This build sells Store items (THEME_STORE_PAID_ENABLED): ask the Store, under the payment's lock. */
  storePaid: boolean;
  /** Overrides for the Store question and "made here" record (tests). */
  storeAsk?: ExpiryDeps['storeAsk'];
  createdKV?: Parameters<typeof storeKindFor>[0];
  /** Test timing (deadlines, retry delays). */
  extra?: Partial<ExpiryDeps>;
};

export function makeExpiryDeps(w: ExpiryWiring): ExpiryDeps {
  const f: F = w.fetch ?? ((u, i) => fetch(u, i));
  const txo = (w.services as { txo?: { getSpends?: (o: string[]) => Promise<(string | null | undefined)[]> } } | null)
    ?.txo;
  const store = {
    isActive: () => w.storage.isActiveStorageProvider(),
    userId: async () => (await w.storage.getAuth()).userId!,
    run: <T>(fn: (sp: DetachProvider) => Promise<T>) =>
      w.storage.runAsStorageProvider((sp: never) => fn(sp as unknown as DetachProvider)),
  };
  const chain = eitherChainSource(wocChainLookups({ fetch: f, ...w.woc }), () => oneSatChainLookups(w.services));
  return {
    listNoSend: async () => {
      const out: NoSendAction[] = [];
      for (let offset = 0; offset < 5000; offset += 500) {
        const page = await w.wallet.listNoSendActions({
          labels: [],
          includeLabels: true,
          includeInputs: true,
          // The description and memo output identify a Store payment (storeKind); the outputs also tell a copy of
          // this payment from a different spender (spenderOutputs).
          includeOutputs: true,
          includeOutputLockingScripts: true,
          limit: 500,
          offset,
        });
        for (const a of page.actions)
          out.push({
            txid: a.txid,
            labels: a.labels,
            inputs: (a.inputs ?? []).map((i) => ({ sourceOutpoint: i.sourceOutpoint })),
            description: a.description,
            outputs: (a.outputs ?? []).map((o) => ({ lockingScript: o.lockingScript, satoshis: o.satoshis })),
          });
        if (page.actions.length < 500) break;
      }
      return out;
    },
    abort: (txid) => w.wallet.abortAction({ reference: txid }),
    // 13 Nov 2026 (tx 446): an input a confirmed foreign transaction spent means the payment can never be mined. The
    // automatic coin check's rule decides "confirmed" (WhatsOnChain confirmed, or WhatsOnChain and the 1Sat index
    // naming the same spender); each WhatsOnChain lookup has a 5 s deadline (iOS 15-safe).
    conflict: conflictCheck({
      // The 1Sat index takes "txid_vout", as every other caller sends it (storageReconcileBackground).
      index: txo?.getSpends
        ? (o: string[]) =>
            txo.getSpends!.call(
              txo,
              o.map((x) => x.replace('.', '_')),
            )
        : undefined,
      woc: async (op) => {
        const d = deadline(5_000);
        try {
          return await wocSpentStatus(op.replace('.', '_'), d.signal, f as typeof fetch);
        } finally {
          d.clear();
        }
      },
    }),
    detachInput: storageDetachInput({ ...store, recordCleared: w.recordCleared }),
    reaffirmSpent: storageReaffirmSpent(store),
    // A payment whose every input is spent elsewhere is cancelled only when the spender isn't a copy of it.
    spenderOutputs: async (txid) => {
      const r = await chain.chainTx(txid);
      if (r.state !== 'found') return undefined;
      const tx = Transaction.fromBinary(Array.from(r.rawTx));
      if (tx.id('hex') !== txid) return undefined;
      return tx.outputs.map((o) => ({ lockingScript: o.lockingScript.toHex(), satoshis: o.satoshis ?? 0 }));
    },
    // Detach and abort only on this device's own active store, never during the background's storage switch; read
    // again between the two, so both land on the same store.
    storageGate: () => (w.storageBusy?.() || !w.storage.isActiveStorageProvider() ? null : w.storage.getActiveStore()),
    // Whose Store payment (this device's record of the ones it made), in every build: a payment synced from another
    // device is held 3 days, never released under that device's "Pay again".
    storeKind: storeKindFor(w.createdKV ?? createdHereKV(w.identityKey)),
    // This device's own Store payments the Store never heard of: released at the first run after STORE_MIN_AGE_S, on
    // every chain check, under the payment's lock (which this device's Pay takes too).
    ...(w.storePaid ? { storeAsk: w.storeAsk ?? storeAskFor(w.wallet as never, f), lock: withPayLock } : {}),
    sendWith: (txid) =>
      w.wallet.createAction({
        description: 'Payment the network has',
        options: { sendWith: [txid], acceptDelayedBroadcast: false },
      }),
    recoverLate: w.recoverLate,
    // A copy in 1Sat's BEEF store still leads to the wallet's own (chain-checked) send of that tx, never a release.
    lookups: expiryLookups(f),
    spent: wocSpent(f),
    // BRC-177 blockheight deadlines (b-Aware 26 Oct 2026, N1). Undefined on any failure: the action stays held.
    height: wocHeight(f),
    kv: w.kv,
    ...w.extra,
  };
}
