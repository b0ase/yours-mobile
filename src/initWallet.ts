import { missingLogKV, repairNullTxids, type NullTxidRepairReport } from './services/nullTxidRepair';
import { openAccountPermissionStore } from './services/accountPermissionStore';
import { openSpendLedger, withLocalSpendLedger } from './services/spendLedger';
import { rememberRefusals } from './services/broadcastRefusals';
import { knownOnChain, recoverMinedFailedActions, type RecoverReport } from './services/recoverFailed';
import { singleFlight } from './services/addressResync';
import {
  allOneSat,
  deriveSyncKeys,
  makeCoinIntake,
  outputsPaying,
  pkhHex,
  runPrioritySync,
  type CoinIntake,
} from './services/prioritySyncRun';
import { createInternalizeLock } from './services/internalizeLock';
import {
  createPullTrigger,
  createReceiveWatch,
  ownerSyncReader,
  watchFrom,
  type TxClass,
} from './services/receiveWatch';
import { makeSpendCheck, wocSpendLookup } from './services/spendCheck';
import { createTakenRecheck } from './services/takenRecheck';
import { recordAutoCleared } from './services/autoCoinResync';
import { wocSpentStatus } from './services/coinPreflight';
import { guardIntake } from './services/guardIntake';
import { sizeAwareBroadcast } from './services/bigBroadcast';
import {
  releaseStuckSends,
  resolveUnsent,
  type QueuedSend,
  type ReleaseReport,
  type UnsentOutcome,
} from './services/stuckSends';
import { hardenWalletServices } from './services/wocResilience';
import { cacheBlockHeaders, prefetchHeadersOnInternalize } from './services/headerPrefetch';
import {
  backupBeforeSend,
  createDeviceSync,
  FOREGROUND_STALE_MS,
  PULL_STALE_MS,
  PULL_TIMER_MS,
  notifyOnWalletChanges,
  pullThenAdmitSoon,
  type BackupBeforeSend,
  type DeviceSyncResult,
} from './services/deviceSync';
import {
  createChangeWriteAhead,
  onBroadcast,
  watchStorage,
  type ChangeWriteAhead,
  type UnbackedRecord,
  type WriteAheadStorage,
} from './services/changeWriteAhead';
import { forceLegacyActionBatch, requireLegacyForNoSend } from './services/actionBatchMode';
import { requireLocalStoreForChange } from './services/localFirst';
import { ensureBackupConnected, keepDeviceStoreActive, switchActiveAs } from './services/deviceActive';
import { loadMayBeOut, recheckRefusals } from './services/refusalRecheck';
import { installCoinPreflightForWallet } from './services/coinPreflight';
import {
  createWebWallet,
  createIndexedDbTaskStateStore,
  type WebWalletConfig,
  Wallet,
  WalletStorageManager,
  StorageClient,
  StorageIdb,
  LocalWalletPermissionsManager,
  IndexedDbPermissionStore,
} from '@1sat/wallet-browser';
import { preserveOriginalErrors } from './services/permissionAbortGuard';
import { guardReservedBaskets, revokeReservedBasketGrants } from './services/reservedBaskets';
import { guardSpendRecipients } from './services/spendRecipients';
import { guardLabelsOnSpend } from './services/labelsOnSpend';
import { chromeConsentStore, guardSiteTokens } from './services/siteTokens';
import { guardReservedProtocols, revokeReservedProtocolGrants } from './services/reservedProtocols';
import { guardAllowance } from './services/allowanceGuard';
import { ALLOWANCES_ENABLED } from './services/allowanceFlag';
import { guardEverySpendAsks, revokeStoredSpendingGrants } from './services/everySpendAsks';
import { guardPModuleSpends } from './services/pModuleSpendGate';
import { guardAssetIdLoads } from './services/assetIdCheck';
import { eitherChainSource, oneSatChainLookups, type ChainLookups } from './services/chainSources';
import {
  installInboundSyncGuard,
  registerInboundVerifier,
  admitPending,
  requeueHeldTokenCoins,
  walletOwnership,
  walletRecords,
  type AdmitOptions,
  type AdmitReport,
  type AdmitStore,
  type InboundVerifier,
  pendingAdmissions,
} from './services/inboundSync';
import { syncErrorDetail, tagStorageClientErrors } from './services/syncErrorDetail';
import {
  backupFullNotice,
  refuseBackupStorageAutoPay,
  refuseStorageAuthFetchPayments,
  refuseStorageClientPayments,
  storagePaymentHook,
} from './services/storagePaymentGuard';
import { KNOWN_PROVIDERS } from './components/storageProviders';
import {
  FULL_PASS_NEXT_SLICE_MS,
  passLooksStuck,
  paymentYields,
  requestFullPass,
  requestTailPass,
  syncStateFor,
  withDeadlines,
  withFullPassMode,
  type FullPassPlan,
} from './services/fullPass';
import { afterPull, recordedPullOkAt } from './services/pullIntegrity';
import { createPullRecord, createSyncHealth, registerSyncHealth, type SyncHealth } from './services/syncHealth';
import { ownPayments } from './services/ownPayments';
import { retryOnceOnIdbAbort } from './services/idbAbortRetry';
import { createInFlight, makeBackupPush, type InFlight } from './services/pushView';
import { isPhone, onWifi } from './services/networkKind';
import { chromeEnvelopeBackend, EnvelopeStore, guardEnvelopes } from './services/envelopes';
import { ENVELOPES_ENABLED, THEME_STORE_PAID_ENABLED } from './mobile/storeBuild';
import { guardCrossSiteSigning } from './services/crossSiteSignGuard';
import { normalizeOriginator, parsePrivateKey, type StoragePaymentHook } from '@1sat/wallet';
import { guardSpending } from './mobile/config/killSwitch';
import {
  syncMessages,
  sweepDeposit,
  internalizeBeef,
  signP2PKHInput,
  deriveDepositAddresses,
  ProcessedTxStoreIdb,
  createContext as createActionContext,
} from '@1sat/actions';
import { BSV21_BASKET, DEPOSIT_BASKET, FUNDING_BASKET, ONESAT_BASKET, ONESAT_PROTOCOL } from '@1sat/types';
import { createAssetPermissionModules } from '@1sat/permission-module';
import { Beef, Transaction, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import { rescueStuckOutputs, type DepositDerivation } from './services/receiveRescue';
import { ChromeStorageService } from './services/ChromeStorage.service';
import { MESSAGEBOX_URL } from './utils/constants';
import type { Account, StorageConfig } from './services/types/chromeStorage.types';
import { decrypt } from './utils/crypto';
import type { Keys } from './utils/keys';
import { initSyncContext, type SyncContext } from './initSyncContext';
import { refileLegacyBaskets } from './services/legacyBaskets';
import { installLegacySigner, legacyOrdKey, legacyPayKey, syncLegacyOrd } from './services/legacyOrd';
import { readReconcileRecord, reconcileStorage } from './services/storageReconcileBackground';
import { shouldResumeReconcile } from './services/storageReconcile';
import { showOneSatPrompt } from './services/oneSatPrompt';
import {
  runSpendPass,
  runStaleFix,
  runUnseenHeal,
  runStartupTokenHeal,
  runTokenRecovery,
  type TokenHealArgs,
} from './services/tokenRecoveryWallet';
import type { HealAction, SpendPassReport, StaleFixResult, UnseenHealReport } from './services/tokenSendHeal';
import { planAddressScan, resetSyncCursor } from './services/addressScan';
import {
  checkReceiveAddresses,
  markMoved,
  movedEntries,
  normOutpoint,
  restoreMoved,
  setArriving,
  arrivingCoins,
  arrivingOutputs,
} from './services/receiveGuard';
import {
  accountedVia,
  carriesVia,
  waitingVia,
  knownTxids,
  outpointStates,
  ownPendingTxids,
  type DeviceReads,
  type HeldStore,
  type OutpointState,
} from './services/heldOutpoints';
import { balanceSplit, type BalanceSplit } from './services/depositBalance';
import { internalizeBackoff } from './services/internalizeBackoff';
import { fixUtxoStatus, utxoStatusFromTxo } from './services/utxoStatus';
import { restorePaymailHistory, type PaymailRestoreReport } from './mobile/names/paymail';
import { makeRecoverDeps, runRecoverOnce } from './services/recoverFailedWiring';
import { makeMissingCoinsDeps } from './services/findMissingCoinsWiring';
import {
  restoreMissingCoins,
  scanMissingCoins,
  type MissingCoin,
  type RestoreReport,
  type ScanReport,
} from './services/findMissingCoins';
import { recoverPaymentByTxid, type TxidRecoverReport } from './services/recoverByTxid';
import { makePostageReconcileWiring, makeTxidRecoverDeps, sweepCandidateTxids } from './services/recoverByTxidWiring';
import {
  recoverSeedChange,
  registerWalletOriginator,
  wocChainLookups,
  type SeedChangeReport,
} from './services/seedChange';
import { makeSeedChangeDeps, seedChangeKV } from './services/seedChangeWiring';
import { reconcilePostage, wocIsMined, type PostageReconcileReport } from './services/postageReconcile';
import { runUnsentExpiry, storageKV, type ExpiryReport } from './services/unsentExpiry';
import { makeExpiryDeps } from './services/unsentExpiryWiring';
import { chainActive } from './services/dappChain';
import { healthStatus, SYNC_HEALTH_KEY } from './services/storageHealth';
import {
  arrivingFromAdmissions,
  DEVICE_SYNC_KEY,
  heldPayments,
  nextDeviceSyncHealth,
  STUCK_SHOW_MS,
  type BalanceTruth,
  type DeviceSyncHealth,
  type TruthStore,
} from './services/balanceTruth';
import type { TokenRecoveryOptions, TokenRecoveryResult } from './services/tokenRecovery';
import { settleWithin } from './utils/settleWithin';

/** Longest close() waits for the receive watch's two processed-tx stores (closed alongside the wallet's own storage). */
const WATCH_STORES_CLOSE_CAP_MS = 2000;
/**
 * The last wallet close's steps with their times (ms from the start of the close). An account-switch reload sends them
 * to the page's boot trace (background.ts CLOSE_FOR_RELOAD), so a close that hangs shows which step it hung on
 * (owner's iPhone, 13 Nov 2026: a switch whose close hit the cap reloaded into a black screen).
 */
export const lastCloseSteps: string[] = [];

// Admin originator for the extension (bypasses all permission checks). The bare
// extension ID, as ChromeCWI sends it: toolbox permission checks reject a URL
// scheme. ⚠ A web page CAN have this host (http://<extid>/ on a network that resolves
// single-label names), so the background router grants admin only to the extension's own
// pages and refuses this originator from any other sender (services/adminOriginator.ts).
export const ADMIN_ORIGINATOR = chrome.runtime.id;

/**
 * Wrap a wallet so every method call pre-binds `originator` to the supplied
 * value. Used to route internal-wallet calls (background sync, etc.) through
 * the permissions manager as the admin originator — encryption/decryption
 * still applies, permission prompts are short-circuited via the
 * `isAdminOriginator` check inside the manager.
 */
function withOriginator(wallet: WalletInterface, originator: string): WalletInterface {
  return new Proxy(wallet, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return function (...args: unknown[]) {
        if (args.length < 2 || args[1] === undefined) {
          return (value as (...a: unknown[]) => unknown).call(target, args[0], originator);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as WalletInterface;
}

/**
 * Decrypt keys from chrome storage using the passKey from session storage.
 * Throws if account or passKey is missing (caller should ensure authentication first).
 */
const decryptKeys = async (chromeStorageService: ChromeStorageService): Promise<Keys> => {
  const { account } = chromeStorageService.getCurrentAccountObject();
  const passKey = await chromeStorageService.getPassKey();

  if (!account?.encryptedKeys) {
    throw new Error('No account found - wallet not initialized');
  }
  if (!passKey) {
    throw new Error('No passKey found - user not authenticated');
  }

  const decrypted = await decrypt(account.encryptedKeys, passKey);
  return JSON.parse(decrypted) as Keys;
};

/**
 * Account context containing wallet and necessary sync components.
 * All components share the same lifecycle (account-specific).
 */
/** The receive guard's stuck-output rescue broadcast (receiveRescue.ts). Off: see runReceiveGuard. */
const RESCUE_AUTO_BROADCAST = false as boolean;

type IdbStoreLike = { get?: (k: number) => Promise<unknown>; delete?: (k: number) => Promise<void> };

export interface AccountContext {
  wallet: LocalWalletPermissionsManager;
  baseWallet: Wallet;
  syncContext: SyncContext;
  storage: WalletStorageManager;
  remoteStorage?: StorageClient;
  /** The grant store the permissions manager reads (one-sheet connect writes the monthly allowance here). */
  permissionStore: IndexedDbPermissionStore;
  /** Per-site envelopes (services/envelopes.ts): the only payments that go through without a sheet. */
  envelopes: EnvelopeStore;
  setActiveStorage: (target: 'local' | string) => Promise<void>;
  addRemote: (url: string) => Promise<void>;
  /** Find and import token outputs the wallet owns on chain but has no record of (tokenRecovery.ts). */
  recoverTokens: (options?: TokenRecoveryOptions) => Promise<TokenRecoveryResult>;
  /** "Fix and send": one token's spent records dropped and its valid change imported (tokenSendHeal.ts). */
  fixStaleToken: (tokenId: string) => Promise<StaleFixResult>;
  /** Repair Sync's final pass: relinquish token outputs the overlay or chain reports spent. */
  dropSpentTokens: () => Promise<SpendPassReport>;
  /** Token outputs the overlay doesn't know: submit, rebroadcast, or relinquish (all tokens, or one). */
  healUnseenTokens: (tokenId?: string, keysOnly?: boolean) => Promise<UnseenHealReport>;
  /** Run the address sync now, or join the run already in flight (services/addressResync.ts). Quiet = no spinner. */
  resyncAddresses: (options?: { quiet?: boolean }) => Promise<void>;
  /** When the last address sync finished (ms since epoch), 0 before the first. */
  lastAddressSyncAt: () => number;
  /** True while an address sync is running. */
  addressSyncBusy: () => boolean;
  /** Move anything waiting in the deposit basket into the funding basket (sweepDeposit). */
  sweepDeposits: () => Promise<{ swept?: number }>;
  /** Credit payments seen on chain at our receive addresses that storage lacks (receive guard), now. */
  creditArriving: () => Promise<void>;
  /**
   * The balance the wallet shows and how much of it is pending (services/depositBalance.ts balanceSplit). Money on chain
   * that storage lacks is checked against the device store on every read, so nothing counts twice (owner, 5 Nov 2026).
   */
  balanceSplit: () => Promise<BalanceSplit>;
  /**
   * The balance card's truth lines (services/balanceTruth.ts): payments holding coins unsent, coins arriving from the
   * other device, the last device-sync pull. Reads only.
   */
  balanceTruth: () => Promise<BalanceTruth>;
  /**
   * Instant receive (services/receiveWatch.ts): the UI in front (APP_FOREGROUND) watches the receive addresses every
   * ~3 s; APP_BACKGROUND stops it.
   */
  receiveWatch: { foreground: (on: boolean) => void };
  /** Pull the owner's other devices' changes from the backup, then push this one's (services/deviceSync.ts). */
  syncDevices: () => Promise<DeviceSyncResult>;
  /**
   * Work through what the inbound check left for the chain to settle on this device (services/inboundSync.ts
   * admitPending), whichever store is active: after a restore copy, before its counts are compared.
   */
  admitBackupRows: () => Promise<AdmitReport | undefined>;
  /** Push this device's rows to the backup now; a Store payment is broadcast only when this is ok (deviceSync.ts). */
  backupBeforeSend: () => Promise<BackupBeforeSend>;
  /** The backup's state for the honest copy: configured, a push waiting, failures, the last good push. */
  backupState: () => {
    backupConfigured: boolean;
    pendingPush: boolean;
    failures: number;
    lastPushOkAt: number;
    /** The backup is set aside (it stopped answering during a merge) and reconnects on a back-off. */
    paused: boolean;
    /** A heal or a device sync is running: it holds the storage locks, so a coin check would only queue behind it. */
    storageBusy: boolean;
    /** How the pulls from the backup are doing (services/syncHealth.ts): last caught-up pull, stuck, coins missing. */
    health?: SyncHealth;
  };
  /** Restore actions storage marked failed whose transaction is mined (services/recoverFailed.ts). */
  recoverFailed: () => Promise<RecoverReport>;
  /** Recover one mined payment by txid from the derivation any reachable store holds (services/recoverByTxid.ts). */
  recoverTxid: (txid: string, progress?: (step: string) => void) => Promise<TxidRecoverReport>;
  /**
   * Settings › Troubleshooting › Recover change from my 12 words: walk the chain from every coin and seed address this
   * wallet knows, and add the deterministic change it finds (services/seedChange.ts). Read only on chain; resumable.
   */
  recoverSeedChange: (progress?: (step: string) => void, options?: { fresh?: boolean }) => Promise<SeedChangeReport>;
  /** Settings › Storage › Find missing coins: read-only scan of every store (services/findMissingCoins.ts). */
  findMissingCoins: () => Promise<ScanReport>;
  /** Add back coins a scan found (after the user confirmed). Never broadcasts. */
  restoreMissingCoins: (coins: MissingCoin[]) => Promise<RestoreReport>;
  /** Settle bMail postage held as nosend/unsent whose tx the chain says is mined (services/postageReconcile.ts). */
  reconcilePostage: (force?: boolean) => Promise<PostageReconcileReport>;
  /**
   * BRC-177 deadlines for nosend actions: release one only after the chain shows it was never broadcast and its
   * inputs are unspent; watch releases in case it turns up later (services/unsentExpiry.ts).
   */
  /** `storageBusy`: the background's storage switch is under way (no detach or abort meanwhile). */
  expireUnsent: (force?: boolean, o?: { storageBusy?: () => boolean }) => Promise<ExpiryReport>;
  /** Sweep txids from this wallet's own records, for Find mined payments (recoverByTxidWiring.ts). */
  sweepCandidates: () => Promise<string[]>;
  /** Re-internalize paymail receipts the server recorded that this device lacks (restore from seed, 14 Oct 2026). */
  restorePaymails: () => Promise<PaymailRestoreReport>;
  /** Cancel queued sends that never reached the network after GIVE_UP_MS, releasing inputs (stuckSends.ts). */
  releaseStuckSends: () => Promise<ReleaseReport>;
  /** Send one queued payment now, or cancel it when the network never got it (services/stuckSends.ts). */
  resolveUnsent: (txid: string, how: 'send' | 'cancel') => Promise<UnsentOutcome>;
  /** The queued (not yet accepted) sends, read only. */
  listUnsent: () => Promise<QueuedSend[]>;
  /** Run the Monitor's SendWaiting task now (a big send was queued: services/bigDelayed.ts). */
  sendWaitingNow: () => Promise<string>;
  /** Bytes storage holds for an action reference (unsigned tx + input BEEF), 0 when unknown. */
  referenceBytes: (reference: string) => Promise<number>;
  /** True when the network already knows this txid (never abort such an action). */
  knownOnChain: (txid: string) => Promise<boolean>;
  /** Fix spendable outputs with no txid and abort stale unsigned actions on the local store (nullTxidRepair.ts). */
  repairNullTxids: () => Promise<NullTxidRepairReport>;
  /** Call to stop sync and destroy wallet */
  close: () => Promise<void>;
}

/**
 * Resolve a per-account storage config into the flat fields the SDK factory
 * expects. Missing storageConfig → local-only (no remotes).
 */
const resolveStorageConfig = (
  storageConfig: StorageConfig | undefined,
): { activeRemote?: string; backups?: string[] } => {
  if (!storageConfig) {
    return {};
  }
  const { activeRemote, remotes = [] } = storageConfig;
  // `remotes[]` holds every configured remote including the active; filter
  // the active out before passing to the factory so it doesn't double-connect.
  const backups = activeRemote ? remotes.filter((url) => url !== activeRemote) : remotes;
  return { activeRemote, backups };
};

/**
 * Read the per-install storageIdentityKey from chrome storage, generating
 * and persisting a new random value on first use. Shared across all
 * accounts on this install — the identity is a property of the local
 * IndexedDB, not of any individual account. Distinct from other installs
 * of the same account on the same remote so `WalletStorageManager` can
 * correctly identify which local store is authoritative.
 */
const ensureStorageIdentityKey = async (chromeStorageService: ChromeStorageService): Promise<string> => {
  const existing = chromeStorageService.getCurrentAccountObject().storageIdentityKey;
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const key = `yours-${hex}`;
  await chromeStorageService.update({ storageIdentityKey: key });
  return key;
};

export interface InitWalletOptions {
  onTransactionBroadcasted?: (txid: string) => void;
  onTransactionProven?: (txid: string) => void;
  /**
   * Runs once the wallet and storage are ready but BEFORE the address and
   * message syncs start. Work that needs the toolbox's exclusive sync lock
   * (a pending backup import) must happen here: the address sync holds
   * reader/writer locks almost continuously and the sync lock waits for all
   * of them, so an import started after it never gets in.
   */
  beforeSync?: (ctx: { storage: WalletStorageManager }) => Promise<void>;
  /** Runs once the address sync has completed (not on its failure). Errors are logged, never thrown. */
  afterSync?: (ctx: { storage: WalletStorageManager }) => Promise<void>;
  /**
   * The address and message-box syncs start once the returned promise resolves (default: at once). The extension
   * holds them back while a site waits for its approval sheet, so the sheet's permission check is not queued behind
   * their storage locks (services/sheetFirst.ts).
   */
  startSyncsAfter?: () => Promise<void>;
  /**
   * Make this device's store the active one (verify or create its copy, then switch). Asked before any payment that
   * would build change while the remote store is active; resolves true once the device store is active
   * (services/localFirst.ts). Without it such a payment is refused.
   */
  ensureLocalStore?: () => Promise<boolean>;
  /** A one-line notice for the owner (the extension shows it on the balance card's sync line). */
  notice?: (text: string) => void;
}

// A backup call that fails names itself and its page in the sync log (services/syncErrorDetail.ts, 6 Nov 2026).
tagStorageClientErrors(StorageClient);

/**
 * Storage top-ups (HTTP 507) are never paid without a check (services/storagePaymentGuard.ts, b-Aware 12 Nov 2026).
 * A backup store's 507 never starts a payment; the active store's goes through storagePaymentHook, passed on every
 * wallet created here (the factory treats a missing hook as yes).
 */
let storageNotice: ((text: string) => void) | undefined;
refuseBackupStorageAutoPay(StorageClient, (url) => backupFullNotice(storageNotice)(url));
// …and no storage server is paid through HTTP 402: a StorageClient's AuthFetch can't create actions.
refuseStorageClientPayments(StorageClient);
type WalletConfigWithStorageHook = WebWalletConfig & { onStoragePaymentRequired: StoragePaymentHook };
/** Every storage URL this wallet may talk to: a BRC-105 (402) payment to any of them is refused. */
const storageUrls =
  (storage: unknown, config: { activeRemote?: string; backups?: string[] }) => (): (string | undefined)[] => [
    config.activeRemote,
    ...(config.backups ?? []),
    ...KNOWN_PROVIDERS.flatMap((p) => [p.url, p.accountUrl]),
    ...((storage as { _stores?: { storage?: { endpointUrl?: string } }[] })._stores ?? []).map(
      (m) => m.storage?.endpointUrl,
    ),
  ];

/**
 * Rows a backup store sends become spendable on this device only when the chain or this account's own keys say so
 * (services/inboundSync.ts, b-Aware A3). Set up BEFORE the wallet factory runs: it merges a store that disagrees about
 * which is active into the device store at boot. Returns the unregister, and the check itself: admitPending runs
 * with it, and initWallet adds its scheduling (onQueued) and the mined-payment repair (recover) once they exist.
 */
const checkBackupRows = (keys: Keys, account: Account | undefined, storageIdentityKey: string) => {
  installInboundSyncGuard(StorageIdb);
  const root = parsePrivateKey(keys.identityWif);
  const verifier: InboundVerifier = {
    owns: walletOwnership(root, [
      legacyOrdKey(keys.ordWif, account?.addresses?.ordAddress),
      legacyPayKey(keys.walletWif, account?.addresses?.bsvAddress),
    ]),
    // Two WhatsOnChain questions per coin, one pacer: together ~3 calls a second (anonymous WoC).
    // WhatsOnChain first; when it has no clear answer, the 1Sat stack (once the factory has made its services): one
    // outage never decides an honest coin (review 16d, D2).
    ...eitherChainSource(wocChainLookups(), () => second),
    readRecord: walletRecords(root),
    log: (...a) => console.warn(...a),
  };
  const stop = registerInboundVerifier(storageIdentityKey, root.toPublicKey().toString(), verifier);
  let second: ChainLookups | undefined;
  return Object.assign(stop, {
    verifier,
    useSecondSource: (s: ChainLookups | undefined) => {
      second = s;
    },
  });
};

/**
 * Open storage for the *currently selected* account for master backup only.
 * No address sync, permissions UI, or accountContext side effects.
 * Caller must set selectedAccount before calling, and await close() when done.
 */
export const openAccountStorageForBackup = async (
  chromeStorageService: ChromeStorageService,
): Promise<{ storage: WalletStorageManager; close: () => Promise<void> }> => {
  await chromeStorageService.getAndSetStorage();
  const keys = await decryptKeys(chromeStorageService);
  if (!keys.identityWif) {
    throw new Error('No identity key found in decrypted keys');
  }

  const { account } = chromeStorageService.getCurrentAccountObject();
  const { activeRemote, backups } = resolveStorageConfig(account?.storageConfig);
  const storageIdentityKey = await ensureStorageIdentityKey(chromeStorageService);
  const stopBackupCheck = checkBackupRows(keys, account, storageIdentityKey);

  const backupConfig: WalletConfigWithStorageHook = {
    privateKey: keys.identityWif,
    chain: 'main',
    feeModel: { model: 'sat/kb', value: chromeStorageService.getCustomFeeRate() },
    activeRemote,
    backups,
    storageIdentityKey,
    taskStateStore: createIndexedDbTaskStateStore(),
    // No boot runOnce: its BackupSync (which now also runs for a remote active store; toolbox patch) would contend
    // with the backup's getSyncChunk. stopTasks below only ends a task loop; it cannot recall a runOnce in flight.
    skipInitialMonitor: true,
    onStoragePaymentRequired: storagePaymentHook(),
  };
  const { storage, destroy, monitor, wallet: backupWallet } = await createWebWallet(backupConfig);
  if (!refuseStorageAuthFetchPayments(backupWallet, storageUrls(storage, { activeRemote, backups })))
    console.error('[initWallet] storage 402 payments are not refused');

  // Stop monitor work so BackupSync/runOnce does not contend with getSyncChunk.
  try {
    monitor.stopTasks();
  } catch {
    // ignore
  }

  return {
    storage,
    close: async () => {
      await destroy();
      stopBackupCheck();
    },
  };
};

/**
 * Initialize the Wallet instance with all sync components.
 *
 * Uses remote storage as the sole storage backend — no local IndexedDB.
 * The server handles transaction lifecycle (broadcasting, proof checking).
 *
 * Throws if account or passKey is missing (caller should ensure authentication first).
 * Call this after user authentication (unlock).
 */
export const initWallet = async (
  chromeStorageService: ChromeStorageService,
  options?: InitWalletOptions,
): Promise<AccountContext> => {
  // Ensure storage is loaded
  await chromeStorageService.getAndSetStorage();

  // 1. BROWSER-SPECIFIC: Decrypt keys
  const keys = await decryptKeys(chromeStorageService);
  if (!keys.identityWif) {
    throw new Error('No identity key found in decrypted keys');
  }

  const chain = 'main' as const;

  // 2. Create wallet using browser factory. Storage topology comes from the
  // current account's persisted storageConfig. storageIdentityKey is
  // per-install and lazily materialized.
  const { account } = chromeStorageService.getCurrentAccountObject();
  const { activeRemote, backups } = resolveStorageConfig(account?.storageConfig);
  const storageIdentityKey = await ensureStorageIdentityKey(chromeStorageService);
  const stopBackupCheck = checkBackupRows(keys, account, storageIdentityKey);

  if (options?.notice) storageNotice = options.notice;
  const walletConfig: WalletConfigWithStorageHook = {
    privateKey: keys.identityWif,
    chain,
    feeModel: { model: 'sat/kb', value: chromeStorageService.getCustomFeeRate() },
    activeRemote,
    backups,
    storageIdentityKey,
    taskStateStore: createIndexedDbTaskStateStore(),
    onStoragePaymentRequired: storagePaymentHook({ notice: options?.notice }),
  };

  const t0 = Date.now();
  const mark = (step: string) => console.log(`[initWallet] +${Date.now() - t0}ms ${step}`);
  mark(`createWebWallet start (activeRemote=${activeRemote ?? 'local'}, backups=${backups?.length ?? 0})`);
  const {
    wallet: baseWallet,
    destroy: destroyWallet,
    storage,
    remoteStorage,
    setActiveStorage,
    addRemote,
    monitor: walletMonitor,
    services: toolboxServices,
  } = await createWebWallet(walletConfig).catch(async (err: unknown) => {
    // A backup that won't connect (e.g. 1Sat answering HTTP 400 to the iPhone WebView's auth
    // handshake) must not take the whole wallet down: the device's own copy is authoritative when
    // it's active. Open without backups; the address sync still finds funds on chain.
    if (activeRemote || !backups?.length) throw err;
    console.warn('[initWallet] backup storage failed to connect; opening without it:', err);
    return createWebWallet({ ...walletConfig, backups: [] });
  });
  // The factory's own storage calls (/account/status, /account/payment) never pay a 402 (storagePaymentGuard.ts).
  if (!refuseStorageAuthFetchPayments(baseWallet, storageUrls(storage, { activeRemote, backups })))
    console.error('[initWallet] storage 402 payments are not refused');
  // This device's store stays the enabled active store for its payments, receipts and backup pushes, whatever another
  // device wrote into the backup (P0, 5 Nov 2026: the owner's 1p test was refused with WERR_NOT_ACTIVE after the backup
  // connected late; services/deviceActive.ts). First on the manager, so the later wrappers (the coin check) run over it.
  const openedAccount = account?.addresses?.identityAddress;
  /** This device's own store and its storage identity key (the merges' writer), from the manager's stores. */
  const ownStore = () =>
    (storage as unknown as { _stores?: { storage: unknown }[] })._stores
      ?.map((m) => m.storage)
      .find((s): s is StorageIdb => s instanceof StorageIdb);
  const ownSik = () => ownStore()?.getSettings().storageIdentityKey;
  /**
   * A full re-pull from a backup when one is due (services/fullPass.ts): a daily one, a store's first, or one a failure
   * asked for. Never in the way of the sync itself: a failure here is logged and the sync goes on.
   */
  const fullPassIfDue = async (readerSik: string | undefined, failed = false): Promise<FullPassPlan | undefined> => {
    const own = ownStore();
    if (!own || !readerSik) return undefined;
    try {
      const { identityKey } = await storage.getAuth();
      const r = await requestFullPass({
        manager: storage,
        store: own as never,
        identityKey,
        readerSik,
        failed,
        phone: isPhone(),
        wifi: onWifi,
        // A phone off Wi-Fi 14 days: the weekly pass runs once on mobile data, and says so in one line.
        onMobileData: (mb) => options?.notice?.(`Checking your whole wallet over mobile data, about ${mb} MB`),
      });
      if (r === 'started')
        console.warn('[deviceSync] pulling the backup again from the start (a full pass, in slices)');
      if (r === 'deep')
        console.warn('[deviceSync] pulling the last 48 hours of the backup again (the daily deep pull)');
      if (r === 'abandoned')
        console.warn('[deviceSync] a pull from the start had stopped moving: given up, the ordinary pulls run again');
      if (r === 'stuck')
        console.warn('[deviceSync] a pull has not moved for 30 minutes of uptime; it keeps being retried (syncHealth)');
      return r;
    } catch (e) {
      console.warn('[deviceSync] a full pass could not be asked for:', e);
      return undefined;
    }
  };
  /** The last heal's merge failed: the next heal asks for a full pass (b). */
  let healFailed = false;
  const keepActive = keepDeviceStoreActive(storage, {
    deviceIntended: () => {
      const current = chromeStorageService.getCurrentAccountObject().account;
      return !!current && current.addresses.identityAddress === openedAccount && !current.storageConfig?.activeRemote;
    },
    // A heal stays short: a full pass is asked for here when due but left to the device-sync pulls (fullPass.ts).
    setDeviceActive: async () => {
      let conflicting: string[] = [];
      try {
        conflicting = storage.getConflictingStores();
      } catch {
        // not available
      }
      for (const sik of conflicting) await fullPassIfDue(sik, healFailed);
      try {
        await withFullPassMode(ownSik(), 'defer', () => setActiveStorage('local'));
        healFailed = false;
      } catch (e) {
        healFailed = true;
        throw e;
      }
    },
  });
  if (!keepActive) console.error("[initWallet] this device's store is not kept active (no storage manager to wrap)");
  // No payment may live only in memory: every noSend action is written to storage at signing (P0, 3 Nov 2026: the
  // owner's $1 theme test lost its change on a reload; services/actionBatchMode.ts).
  if (!forceLegacyActionBatch(baseWallet))
    console.error('[initWallet] action batches could not be set to legacy: noSend payments are refused');
  // …and if that ever fails, a noSend payment is refused rather than held in memory (review 4 Nov 2026, F10).
  requireLegacyForNoSend(baseWallet);
  // An NFT's tracking id loads exactly one asset for every send, burn, listing cancel and name adopt (review 16c, C2).
  if (!guardAssetIdLoads(baseWallet)) console.error('[initWallet] loads by tracking id are not checked');
  mark(
    `createWebWallet done; active=${storage.getActiveStoreName?.() ?? '?'} stores=${JSON.stringify(
      storage.getStores?.().map((s) => ({ name: s.storageName, active: s.isActive, enabled: s.isEnabled })) ?? [],
    )}`,
  );

  // WhatsOnChain 429s: backoff with jitter, optional VITE_WOC_API_KEY, 1sat -> toolbox provider fallback for raw
  // tx and proofs (services/wocResilience.ts; owner's $2 send, 28 Oct 2026).
  // Our own transactions (an unconfirmed change coin) are read from local storage before any network lookup. Read
  // straight from the active provider, never through the manager's locks: the toolbox can ask services for a raw tx
  // while it holds the writer lock, and a locked read here would wait on it forever (TERRORNODE audit, 29 Oct 2026).
  const localRawTx = async (txid: string): Promise<number[] | undefined> => {
    if (!storage.isActiveStorageProvider()) return undefined;
    const sp = storage.getActive() as unknown as {
      getProvenOrRawTx?: (t: string) => Promise<{ rawTx?: number[]; proven?: { rawTx?: number[] } }>;
    };
    const r = await sp.getProvenOrRawTx?.(txid);
    const raw = r?.rawTx ?? r?.proven?.rawTx;
    return raw?.length ? Array.from(raw) : undefined;
  };
  if (!hardenWalletServices(toolboxServices, undefined, { localRawTx }))
    console.warn('[initWallet] chain-data services not hardened');
  // A mined transaction's block header, fetched inside internalizeAction's IndexedDB transaction, ended that
  // transaction ("The transaction finished"): 0.698 BSV never reached the iPhone balance (services/headerPrefetch.ts).
  if (!cacheBlockHeaders(toolboxServices) || !prefetchHeadersOnInternalize(baseWallet, toolboxServices))
    console.warn('[initWallet] block headers are not prefetched before internalize');
  // This device and the owner's others meet only in the backup: push soon after every change, pull on open
  // (services/deviceSync.ts; the extension showed $0.16 after the phone swept, 2 Nov 2026).
  const managed = storage as unknown as { _backups?: { storage: unknown }[]; _stores?: { storage: unknown }[] };
  // The device's own store, active or not (during a restore the backup is active and this is the copy's target).
  const deviceStore = (): AdmitStore | undefined =>
    managed._stores?.map((m) => m.storage).find((s): s is StorageIdb => s instanceof StorageIdb) as never;
  stopBackupCheck.useSecondSource(oneSatChainLookups(toolboxServices));
  // A held BSV-21 coin the chain calls unspent: the token overlay's word, read through tokenOverlayVerdict (fix 7). Only
  // its 'spent' holds the coin back; an error or an unfunded overlay never does. Set before the first admission run
  // is scheduled (onQueued below), from the factory's 1Sat services.
  stopBackupCheck.verifier.tokenState = async (tokenId, outpoint) => {
    const bsv21 = (
      toolboxServices as unknown as {
        bsv21?: { getOutputStatus?: (id: string, ops: string[]) => Promise<{ outpoint: string; state: string }[]> };
      }
    ).bsv21;
    if (typeof bsv21?.getOutputStatus !== 'function') return undefined;
    const [s] = await bsv21.getOutputStatus(tokenId, [outpoint]);
    return s?.state;
  };
  let admitClosed = false;
  let admitTimer: ReturnType<typeof setTimeout> | undefined;
  let admitAt = Infinity;
  /** Run admission in `ms` (or sooner, if a run is already due sooner). The service worker's alarm and the app coming
   *  to the front run it too (background.ts), for when a sleeping worker drops this timer (review 16d, D2). */
  const admitIn = (ms: number) => {
    if (admitClosed) return;
    const at = Date.now() + Math.min(Math.max(ms, 2_000), 6 * 3_600_000);
    if (admitTimer && admitAt <= at) return;
    if (admitTimer) clearTimeout(admitTimer);
    admitAt = at;
    admitTimer = setTimeout(() => {
      admitTimer = undefined;
      admitAt = Infinity;
      void admitBackupRows();
    }, at - Date.now());
  };
  /** Set by every device-sync pull: what that pull lists is retried every few seconds for a while (inboundSync.ts). */
  let admitPrompt: AdmitOptions['prompt'];
  const PROMPT_ADMIT_MS = 2 * 60_000;
  /**
   * Token coins this device holds as not spendable with no spender go back on the admission list at most every 6 hours
   * (fix 7, 13 Nov 2026: the extension's 2a5d3e03:0 stayed not spendable while the phone's copy was spendable). The
   * chain then decides them like any backup coin. The time is kept across service-worker restarts; no store: every run.
   */
  const HELD_TOKENS_EVERY_MS = 6 * 3_600_000;
  const requeueHeldTokensIfDue = async (device: AdmitStore, identityKey: string) => {
    const key = `bwxHeldTokenRecheckAt:${identityKey}`;
    try {
      const last = Number((await chrome.storage?.local?.get(key))?.[key] ?? 0);
      if (Date.now() - last < HELD_TOKENS_EVERY_MS) return;
      await chrome.storage?.local?.set({ [key]: Date.now() });
    } catch {
      // no store to remember the time in: check anyway (local reads; listed entries keep their back-off)
    }
    try {
      const n = await requeueHeldTokenCoins(device, identityKey);
      if (n) console.warn(`[inbound-sync] ${n} token coin(s) held not spendable here: asking the chain again`);
    } catch (e) {
      console.warn('[inbound-sync] held token coins not listed:', e);
    }
  };
  const admitBackupRows = async (): Promise<AdmitReport | undefined> => {
    const device = deviceStore();
    if (!device || admitClosed) return undefined;
    const { identityKey } = await storage.getAuth();
    await requeueHeldTokensIfDue(device, identityKey);
    const r = await admitPending(device, identityKey, stopBackupCheck.verifier, { prompt: admitPrompt }).catch(
      (e: unknown) => {
        console.warn('[inbound-sync] admission list not worked through:', e);
        return undefined;
      },
    );
    // Anything left waits for its next try: run again then, never "only at the next unlock" (D2).
    if (r?.nextAt !== undefined) admitIn(r.nextAt - Date.now());
    return r;
  };
  // Any merge that left something for the chain (the boot merge, F-C, the Monitor's backup sync): soon after it.
  stopBackupCheck.verifier.onQueued = () => admitIn(2_000);
  stopBackupCheck.verifier.onQueued(); // and once at open, for anything left from before
  // updateBackups as the device sync runs it (services/pushView.ts): each backup's cycle whole, a deadline on each
  // request, no second request to a backup still answering a timed-out one, and own payments first only before a cycle
  // or between backups (owner's seal and its review, 7 Nov 2026).
  const pushInFlight = new WeakMap<object, InFlight>();
  const pushInFlightFor = (backup: object) => {
    let f = pushInFlight.get(backup);
    if (!f) pushInFlight.set(backup, (f = createInFlight()));
    return f;
  };
  const backupPush = makeBackupPush({
    storage: storage as unknown as Parameters<typeof makeBackupPush>[0]['storage'],
    backups: () => managed._backups ?? [],
    waiting: ownPayments.waiting,
    inFlightFor: pushInFlightFor,
  });
  /** A payment's rows reach the backup before it is broadcast (services/changeWriteAhead.ts); set up below. */
  let writeAhead: ChangeWriteAhead | undefined;
  // How the pulls are doing, for a one-line status (services/syncHealth.ts): the last pull that caught up, stuck.
  const pullHealth = createSyncHealth();
  const unregisterPullHealth = registerSyncHealth(pullHealth);
  /** The backup's storage identity key, once it is connected. */
  const backupSikNow = (): string | undefined => {
    try {
      return (
        managed._backups?.[0]?.storage as { getSettings?: () => { storageIdentityKey?: string } } | undefined
      )?.getSettings?.()?.storageIdentityKey;
    } catch {
      return undefined; // not connected yet
    }
  };
  /** The last caught-up pull as recorded in this device store: lastPullOkAt isn't 0 until the first pull ends. */
  const hydratePullHealth = async (readerSik = backupSikNow()) => {
    const own = ownStore();
    if (!own || !readerSik) return;
    try {
      const { identityKey } = await storage.getAuth();
      pullHealth.hydrate(await recordedPullOkAt(own as never, identityKey, readerSik));
    } catch {
      // a status line only
    }
  };
  void hydratePullHealth();
  // The same, per account, where the balance card's sync line reads it (DEVICE_SYNC_KEY: deviceSyncPull:<address>).
  const pullRecord = createPullRecord(
    {
      get: (k) => chrome.storage.local.get(k) as Promise<Record<string, unknown>>,
      set: (items) => chrome.storage.local.set(items),
    },
    keys.identityAddress,
  );
  /** The backup's output rows for one of its transactions (the coin check after a pull, services/pullIntegrity.ts). */
  const backupOutputsOf = async (backupTxId: number) => {
    const m = managed._backups?.[0] as
      | {
          storage: {
            findOutputsAuth(
              auth: { identityKey: string; userId?: number },
              args: { partial: { transactionId: number }; noScript: boolean },
            ): Promise<{ vout: number; updated_at?: unknown }[]>;
          };
          user?: { userId: number };
        }
      | undefined;
    if (!m) throw new Error('backup storage is not connected');
    const { identityKey } = await storage.getAuth();
    return m.storage.findOutputsAuth(
      { identityKey, userId: m.user?.userId },
      { partial: { transactionId: backupTxId }, noScript: true },
    );
  };
  const deviceSync = createDeviceSync({
    applies: () => storage.isActiveStorageProvider() && (backups?.length ?? 0) > 0,
    // A backup naming another store is healed first; a set-aside one only reconnects on its probe and back-off, never
    // as a second connection (services/deviceActive.ts, review 19 F1/F5).
    ensureBackup: () => ensureBackupConnected({ storage, keep: keepActive, url: backups?.[0], addRemote }),
    // What the pull left for the chain to settle runs soon after, outside every storage lock; not awaited here (F-A).
    pull: pullThenAdmitSoon(
      async () => {
        pullHealth.attempt();
        void pullRecord({ attemptAt: Date.now() });
        try {
          const reader = managed._backups?.[0]?.storage;
          if (!reader) throw new Error('backup storage is not connected');
          const { identityKey } = await storage.getAuth();
          // What this pull lists is asked about every few seconds for a while, not after the 1-minute doubling: a sweep
          // the other device made must not hide its dollar here for minutes (review 20, M5; services/inboundSync.ts).
          admitPrompt = { from: Date.now(), until: Date.now() + PROMPT_ADMIT_MS };
          // Once a day (and on a store's first open, or when a failure asked) the pull starts from the beginning; such
          // a pass runs in slices so payments never wait on it (services/fullPass.ts).
          const backupSik = (reader as { getSettings?: () => { storageIdentityKey?: string } }).getSettings?.()
            ?.storageIdentityKey;
          if (pullHealth.get().lastPullOkAt === 0) await hydratePullHealth(backupSik);
          pullHealth.plan(await fullPassIfDue(backupSik));
          // Rows another copy pushed late, with times older than the cursor (extension, 6 Nov 2026: 8734977f never
          // arrived): every TAIL_CHECK_EVERY_MS, found by the backup's insert order with one-row probes, and pulled from
          // the first one (services/pullTail.ts). Its own deadlines; never while a pass is under way.
          const own = ownStore();
          if (own && backupSik) {
            const plan = await requestTailPass({
              manager: storage,
              store: own as never,
              identityKey,
              readerSik: backupSik,
              reader: withDeadlines(reader as object) as never,
            }).catch(() => 'unknown');
            if (plan === 'tail')
              console.warn(
                '[deviceSync] the backup has rows this device never had (pushed late): pulling from the first',
              );
          }
          // Each backup request has a deadline, so a stalled backup frees the storage locks in seconds (review 23, M2).
          const bounded = withDeadlines(reader as object) as Parameters<typeof storage.syncFromReader>[1];
          // Own payments go first (fullPass afterPage): a pull that ended for one carries on in this run after it.
          const yieldsBefore = paymentYields();
          await withFullPassMode(ownSik(), 'slice', () => storage.syncFromReader(identityKey, bounded));
          // A pull can't half-arrive (services/pullIntegrity.ts): once it has caught up, payments it brought are checked
          // for their coins against the backup, and coins still missing are pulled again (a heal pass, in slices).
          if (own && backupSik) {
            const report = await afterPull({
              manager: storage,
              store: own as never,
              identityKey,
              readerSik: backupSik,
              backupOutputs: backupOutputsOf,
              stop: () => ownPayments.waiting() || deviceSync.pushWaiting(),
            }).catch((e: unknown) => {
              console.warn('[sync-integrity] the coin check after the pull did not run:', e);
              return undefined;
            });
            pullHealth.succeeded(report);
            void recordPullOk();
            if (report?.plan === 'healing') {
              console.warn(
                `[deviceSync] ${report.missingTx} payment(s) arrived without some of their coins: pulling them again`,
              );
              stopBackupCheck.verifier.onMore?.();
            } else if (report?.plan === 'full-due')
              console.warn(
                '[deviceSync] coins still missing after re-pulls: the backup is pulled again from the start',
              );
          } else {
            pullHealth.succeeded();
            void recordPullOk();
          }
          return paymentYields() > yieldsBefore ? ('yielded' as const) : undefined;
        } catch (e) {
          pullHealth.failed(e);
          void recordPullFailed(e);
          throw e;
        }
      },
      () => admitIn(0),
    ),
    push: async () => {
      // A push that went through carries every payment marked "change not backed up yet" before it started.
      const cap = writeAhead?.checkpoint();
      const r = await backupPush();
      if (r !== 'yielded' && cap !== undefined) writeAhead?.pushed(cap);
      return r;
    },
    yieldTo: ownPayments,
    busy: chainActive,
    log: (...a) => console.warn(...a),
    // The balance card's sync line is written by the pull itself (recordPullOk / recordPullFailed): one writer.
  });
  /**
   * The pull's outcome for the balance card (services/balanceTruth.ts), through the one writer of deviceSyncPull. A pull
   * that went through while its pass from the start has not moved for STUCK_SHOW_MS (fullPass.ts stuckMs), or while
   * syncHealth says stuck, keeps the last good time and reads as stuck (8 Nov 2026 freeze).
   */
  async function recordPullOk() {
    let stuck = false;
    try {
      const own = ownStore();
      const backupSik = backupSikNow();
      if (own && backupSik) {
        const { identityKey } = await storage.getAuth();
        // Read after the pull: a pull that moved the pass's offsets is progress, whatever the mark said before it.
        stuck = passLooksStuck(await syncStateFor(own as never, identityKey, backupSik), STUCK_SHOW_MS);
      }
    } catch {
      // can't tell: the pull went through, so it counts
    }
    stuck = stuck || pullHealth.get().stuck;
    await pullRecord((p) => nextDeviceSyncHealth(p as DeviceSyncHealth, { ok: true, stuck }, Date.now()));
  }
  function recordPullFailed(e: unknown) {
    const now = Date.now();
    const error = e instanceof Error ? e.message : String(e);
    return pullRecord((p) => ({
      ...nextDeviceSyncHealth(p as DeviceSyncHealth, { ok: false, error }, now),
      failAt: now,
      ...(pullHealth.get().stuck ? { stuck: true } : {}),
    }));
  }
  // Pulls also when the last good one is an hour old, while the wallet stays open (review of fix 5: a phone app, web
  // tab or extension worker could go hours without the other devices' changes). Paced; a site mid-action defers it.
  const stalePullTimer = setInterval(() => {
    // Never before the held-back syncs may start (startSyncsAfter), never on a closed wallet.
    if (!admitClosed && syncsOpen) void deviceSync.pullIfStale(PULL_STALE_MS)?.catch(() => undefined);
  }, PULL_TIMER_MS);
  (stalePullTimer as { unref?: () => void }).unref?.();
  // A full pass paused (a slice used up, or a heal left it): the next slice a moment later, sends in between.
  let moreTimer: ReturnType<typeof setTimeout> | undefined;
  stopBackupCheck.verifier.onMore = () => {
    if (moreTimer || admitClosed) return;
    moreTimer = setTimeout(() => {
      moreTimer = undefined;
      void deviceSync.syncNow();
    }, FULL_PASS_NEXT_SLICE_MS);
  };
  if (!notifyOnWalletChanges(baseWallet, deviceSync.changed))
    console.warn('[initWallet] wallet changes do not update the backup');
  // A payment's change reaches the backup BEFORE it is broadcast (balance integrity plan, fix 4): the push runs inside
  // the broadcast step with an 8 s limit. Backup down or slow: the payment still goes, flagged "change not backed up
  // yet" (balance card, syncHealth) and pushed again urgently until it lands. Hooked to the broadcaster below.
  const unbackedKey = `changeUnbacked:${keys.identityAddress}`;
  writeAhead = createChangeWriteAhead({
    applies: () => storage.isActiveStorageProvider() && (backups?.length ?? 0) > 0,
    backups: () => managed._backups ?? [],
    storage: storage as unknown as WriteAheadStorage,
    inFlightFor: pushInFlightFor,
    pushNow: () => deviceSync.pushNow(),
    onChange: (n) => pullHealth.changeNotBackedUp(n),
    kv: {
      load: async () => ((await chrome.storage.local.get(unbackedKey))?.[unbackedKey] as UnbackedRecord) ?? null,
      save: (r) => (r ? chrome.storage.local.set({ [unbackedKey]: r }) : chrome.storage.local.remove(unbackedKey)),
    },
  });
  void writeAhead.hydrate();
  if (!watchStorage(storage, writeAhead)) console.warn('[initWallet] payments are not backed up before broadcast');
  // Big mints need longer than the broadcaster's fixed 30 s to upload (services/bigBroadcast.ts, vexvoid 12 Oct 2026).
  if (!sizeAwareBroadcast(toolboxServices)) console.warn('[initWallet] broadcaster timeout not tunable');
  // Every payment ends here: our screens and dApps through the permissions manager, send-all and background jobs
  // directly. The `spending` kill switch pauses createAction/signAction on it (mobile/config/killSwitch.ts).
  guardSpending(baseWallet);
  // HARD RULE (P0, 3 Nov 2026): no payment builds change on the remote store; this device's store first, else refused
  // (services/localFirst.ts: wallet.1sat.app builds its own random change; seed-derived change exists only here).
  if (
    !requireLocalStoreForChange(baseWallet, {
      isLocal: () => storage.isActiveStorageProvider(),
      ensureLocal: options?.ensureLocalStore,
    })
  )
    console.error('[initWallet] payments are not held to the device store');
  // The wallet's own calls (its pages, via the admin originator) may name inputs and still get change the 12 words can
  // find (sweeps); a site naming inputs gets random change, so it can't replay old inputs as an oracle (services/seedChange.ts).
  registerWalletOriginator(ADMIN_ORIGINATOR);
  // The legacy ord address (paymail ordinals go there) and legacy pay address: each key signs under its own
  // wallet-only protocol, so the NFTs, names, tokens and BSV the sync takes in from them spend like any other
  // (services/legacyOrd.ts). No key for an address (passkey/seedless): that address is skipped.
  const legacyOrdAddress = account?.addresses?.ordAddress;
  const ordKey = legacyOrdKey(keys.ordWif, legacyOrdAddress);
  const legacyPayAddress = account?.addresses?.bsvAddress;
  const payKey = legacyPayKey(keys.walletWif, legacyPayAddress);
  if (ordKey || payKey) installLegacySigner(baseWallet, { ord: ordKey, pay: payKey });
  // A refusal is checked against the chain before the toolbox fails the tx and frees its inputs (refusalRecheck.ts).
  if (!recheckRefusals(toolboxServices)) console.warn('[initWallet] broadcast refusals are not chain-checked');
  // Resumed Store payments marked "may be out" survive a service-worker restart (06c M1).
  void loadMayBeOut();
  if (!rememberRefusals(toolboxServices)) console.warn('[initWallet] broadcast refusals not recorded');
  // Last postBeef wrapper (outermost): the backup push before a payment's broadcast is not timed as the broadcast.
  if (!onBroadcast(toolboxServices, writeAhead)) console.warn('[initWallet] payments are not backed up before broadcast');
  // UnFail's output verdicts read getUtxoStatus: parse api.1sat.app's "txid.vout" (dkg, 14 Oct 2026; services/utxoStatus.ts).
  if (!fixUtxoStatus(toolboxServices)) console.warn('[initWallet] getUtxoStatus not patched (no txo client)');
  // The wallet's own sends check the coins storage picked against the chain before signing; coins another device
  // spent are cleared and storage picks again once (services/coinPreflight.ts; owner's iPhone, 4 Nov 2026).
  if (
    !installCoinPreflightForWallet(storage, toolboxServices, {
      identityKey: account?.pubKeys?.identityPubKey ?? '',
      chain,
      kv: { get: (k) => chrome.storage.local.get(k), set: (items) => chrome.storage.local.set(items) },
    })
  )
    console.warn('[initWallet] coins are not checked against the chain before a send');

  // 3. Build the IndexedDB-backed permission store used by
  //    LocalWalletPermissionsManager for basket/cert/spending grants.
  //    One store per account (b-Aware report, 23-24 Oct 2026): grants and allowances never cross accounts.
  const accountId =
    chromeStorageService.getCurrentAccountObject().selectedAccount || account?.addresses?.identityAddress;
  // No account yet (fresh install): a store of its own, never the legacy shared one, so start-up cannot fail here.
  const permissionStore = await openAccountPermissionStore(
    accountId || 'no-account',
    chromeStorageService.getAllAccounts().length,
  );

  // Month-to-date app spend kept on this device, per account, so a remote storage server cannot under-report it
  // and let payments past a monthly allowance through (services/spendLedger.ts, b-Aware report 23 Oct 2026).
  const spendLedger = await openSpendLedger(accountId || 'no-account');
  // Envelopes (owner, 24 Oct 2026): earmarks in this account's own storage, never coins moved (services/envelopes.ts).
  const envelopes = new EnvelopeStore(chromeEnvelopeBackend(accountId || 'no-account'));

  // 4. Build per-asset permission modules (1sat / opns / bsv21 / lock).
  //    Shared toolkit; separate BRC-99 scheme ids. Base wallet is used for
  //    internal apply crypto so createSignature does not re-prompt.
  const assetModules = createAssetPermissionModules({
    wallet: baseWallet,
    promptHandler: showOneSatPrompt,
    adminOriginator: ADMIN_ORIGINATOR,
    // Reuse the same permission store the LocalWalletPermissionsManager
    // uses, so basket grants persisted via the grouped-permission popup
    // are picked up by the module's basket-access checks (and vice versa).
    permissionStore,
  });
  // The one permissions manager every site call goes through. A "p <scheme>" label or basket hands a site's action to
  // the asset modules above, which finish it on the base wallet; the action now passes the wallet's spend gate first,
  // and a site can't name the wallet's own assets for a module to sign (services/pModuleSpendGate.ts, b-Aware D-L).
  const sitePermissions = guardPModuleSpends(
    new LocalWalletPermissionsManager(
      baseWallet,
      ADMIN_ORIGINATOR,
      { permissionModules: assetModules },
      { store: permissionStore },
    ),
    { adminOriginator: ADMIN_ORIGINATOR },
  );

  // 5. Wrap with permissions manager for external app access control.
  // Grants persist in IndexedDB (off-chain) via LocalWalletPermissionsManager.
  // Wallet-internal protocols (bTrust, Locks, funds, presign…) are refused to every outside originator before any
  // prompt (services/reservedProtocols.ts, security audit 19 Oct 2026 C1).
  // The wallet's own baskets (coins, ordinals, tokens, locks, names) likewise (services/reservedBaskets.ts).
  // A new label on a site's payment shows as a line on that payment's sheet, not a sheet of its own
  // (services/labelsOnSpend.ts, TokenBlaster playtest 25 Oct 2026).
  // Outermost: sites deliver bought BSV-21 tokens to receive keys the wallet picks, and sell them with the wallet
  // signing its own token inputs behind one sheet; onesat stays reserved (services/siteTokens.ts, docs/SITE-TOKENS.md).
  // A payment's sheet lists where its outputs go (services/spendRecipients.ts, b-Aware 26 Oct 2026 N3-3).
  const wallet = guardSiteTokens(
    guardSpendRecipients(
      guardLabelsOnSpend(
        guardReservedBaskets(
          guardReservedProtocols(
            // A message naming another site (a login challenge fetched from good.com) is never signed for evil.com
            // (services/crossSiteSignGuard.ts, payment-safety audit 24 Oct 2026 B1).
            guardCrossSiteSigning(
              preserveOriginalErrors(
                withLocalSpendLedger(
                  // Envelopes by default: a site's payment goes through without a sheet only when it fits that site's
                  // envelope; stored allowances grant nothing (services/envelopes.ts, owner 24 Oct 2026). With
                  // ALLOWANCES_ENABLED, the old monthly allowance with its per-payment cap and payee allowlist
                  // (services/allowanceGuard.ts, payment-safety audit 24 Oct 2026 B2).
                  ALLOWANCES_ENABLED
                    ? guardAllowance(sitePermissions, {
                        store: permissionStore,
                        adminOriginator: ADMIN_ORIGINATOR,
                        normalize: normalizeOriginator,
                      })
                    : ENVELOPES_ENABLED
                      ? guardEnvelopes(sitePermissions, {
                          envelopes,
                          adminOriginator: ADMIN_ORIGINATOR,
                          normalize: normalizeOriginator,
                        })
                      : // Store builds have no envelopes (storeBuild.ts ENVELOPES_ENABLED): every payment shows its sheet,
                        // whatever old monthly grant is stored (services/everySpendAsks.ts, owner 25 Oct 2026).
                        guardEverySpendAsks(sitePermissions, {
                          adminOriginator: ADMIN_ORIGINATOR,
                          normalize: normalizeOriginator,
                        }),
                  spendLedger,
                ),
              ),
              ADMIN_ORIGINATOR,
            ),
            ADMIN_ORIGINATOR,
          ),
          ADMIN_ORIGINATOR,
        ),
        { adminOriginator: ADMIN_ORIGINATOR, normalize: normalizeOriginator },
      ),
      { adminOriginator: ADMIN_ORIGINATOR, normalize: normalizeOriginator },
    ),
    {
      adminOriginator: ADMIN_ORIGINATOR,
      normalize: normalizeOriginator,
      prompt: showOneSatPrompt,
      listConsent: chromeConsentStore(),
    },
  );
  // Upgrade migration (C1): grants a site already holds for a reserved protocol are removed. Idempotent.
  await revokeReservedProtocolGrants(permissionStore, ADMIN_ORIGINATOR)
    .then((n) => n && console.warn(`[initWallet] revoked ${n} app grant(s) for wallet-internal protocols`))
    .catch((e: unknown) => console.warn('[initWallet] reserved-protocol grant cleanup failed:', e));
  // Upgrade migration (owner 25 Oct 2026): old stored monthly spending grants are removed, so no build can pay a site
  // without a sheet even if a guard were bypassed. Allowances (ALLOWANCES_ENABLED, off in every build) keep theirs.
  if (!ALLOWANCES_ENABLED)
    await revokeStoredSpendingGrants(permissionStore, ADMIN_ORIGINATOR)
      .then(
        (n) =>
          n && console.warn(`[initWallet] revoked ${n} stored site spending grant(s): every payment shows its sheet`),
      )
      .catch((e: unknown) => console.warn('[initWallet] stored spending grant cleanup failed:', e));
  await revokeReservedBasketGrants(permissionStore, ADMIN_ORIGINATOR)
    .then((n) => n && console.warn(`[initWallet] revoked ${n} app grant(s) for wallet-internal baskets`))
    .catch((e: unknown) => console.warn('[initWallet] reserved-basket grant cleanup failed:', e));

  // 5. Initialize sync context (derives addresses, creates services, queue, addressManager).
  // Background sync calls go through the manager-wrapped wallet (admin
  // originator pre-bound) so internalizeAction encrypts customInstructions
  // consistently with dApp-initiated writes. Without this wrap, sync would
  // bypass the manager entirely and produce plaintext customInstructions —
  // creating mixed-encoding rows that break later reads.
  const adminWallet = withOriginator(wallet, ADMIN_ORIGINATOR);

  mark('permissions + sync context ready');

  const maxKeyIndex = account?.settings?.maxKeyIndex ?? 4; // default: 0-4 = 5 addresses
  const syncContext = await initSyncContext({
    wallet: adminWallet,
    chain,
    maxKeyIndex,
  });

  // 5b. Persist the primary address so other accounts can display it in the UI.
  // Only set it if the account doesn't already have one — preserve the user's
  // selection from the receive screen across lock/unlock and account switches.
  if (!account?.primaryAddress) {
    const primaryAddress = syncContext.addressManager.getPrimaryAddress();
    if (primaryAddress) {
      const identityAddress = keys.identityAddress;
      chromeStorageService.updateNested('accounts', {
        [identityAddress]: { primaryAddress } as unknown as Account,
      });
    }
  }

  // 6. Run address sync via syncAddresses action (fire-and-forget)
  const actionCtx = createActionContext(adminWallet, { chain, services: syncContext.services });

  const sendSyncStatus = (data: { status: string; [key: string]: unknown }) => {
    // Remember the outcome for the storage badge on Settings (services/storageHealth.ts).
    if (['complete', 'error', 'sweep-failed', 'receive-failed', 'arriving'].includes(data.status)) {
      const error =
        typeof data.message === 'string' ? data.message : typeof data.error === 'string' ? data.error : undefined;
      const health = {
        status: healthStatus(data.status, error),
        at: Date.now(),
        error,
        satoshis: typeof data.satoshis === 'number' ? data.satoshis : undefined,
      };
      chrome.storage.local.set({ [SYNC_HEALTH_KEY(keys.identityAddress)]: health }).catch(() => undefined);
      // Which step failed, and how, in the sync log (the banner shows the message alone; owner's iPhone, 6 Nov 2026).
      if (health.status !== 'complete' && health.status !== 'offline' && health.status !== 'arriving')
        console.warn(
          `[deviceSync] wallet sync failing (${data.status}): ${typeof data.detail === 'string' ? data.detail : (error ?? '')}`,
        );
    }
    chrome.runtime
      .sendMessage({
        action: 'syncStatusUpdate',
        data,
      })
      .catch(() => {
        // Ignore errors if popup is not open
      });
  };

  if (options?.beforeSync) {
    mark('beforeSync start');
    try {
      await options.beforeSync({ storage });
    } catch (err) {
      console.error('[initWallet] beforeSync failed:', err);
    }
    mark('beforeSync done');
  }

  // Wallet-data migrations. After beforeSync so a restored backup's data is in
  // storage before they look at it, and before the address sync, whose locks
  // would keep the reconcile's sync lock waiting.
  const stampDataVersion = (dataVersion: number) =>
    chromeStorageService.updateNested('accounts', {
      [keys.identityAddress]: { dataVersion } as unknown as Account,
    });
  // Steps run in order; each stamps its own version (see ACCOUNT_DATA_VERSION).
  let dataVersion = account?.dataVersion ?? 0;

  if (dataVersion < 1) {
    mark('legacy basket migration start');
    try {
      await refileLegacyBaskets(storage);
      await stampDataVersion(1);
      dataVersion = 1;
    } catch (err) {
      console.error('[initWallet] legacy basket migration failed; will retry next open', err);
    }
    mark('legacy basket migration done');
  }

  // Runs once whatever the outcome: a failed run leaves its record for
  // Settings > Troubleshooting, where the user can retry. Only a run the
  // worker never finished (no stamp) is tried again on the next open.
  if (dataVersion === 1) {
    const config = account?.storageConfig;
    const remoteUrl = config?.activeRemote || config?.remotes?.[0];
    if (remoteUrl) {
      mark('storage reconcile migration start');
      await reconcileStorage(storage, syncContext.services, remoteUrl, 'migration').catch((err) =>
        console.error('[initWallet] storage reconcile migration failed:', err),
      );
      mark('storage reconcile migration done');
    }
    await stampDataVersion(2);
  }

  // A repair the extension worker was stopped in the middle of (not one that failed) runs again
  // on the next open, even if its notice was dismissed, up to MAX_RECONCILE_RESUMES times.
  // The repair overlay shows its progress while it runs.
  if (dataVersion >= 1) {
    const config = account?.storageConfig;
    const remoteUrl = config?.activeRemote || config?.remotes?.[0];
    const previous = remoteUrl ? await readReconcileRecord().catch(() => undefined) : undefined;
    if (remoteUrl && previous && shouldResumeReconcile(previous)) {
      mark('storage reconcile resume start');
      await reconcileStorage(
        storage,
        syncContext.services,
        remoteUrl,
        previous.trigger,
        (previous.resumeAttempts ?? 0) + 1,
      ).catch((err) => console.error('[initWallet] resumed storage reconcile failed:', err));
      mark('storage reconcile resume done');
    }
  }

  const recoverTokens = (recoveryOptions?: TokenRecoveryOptions) =>
    runTokenRecovery({
      wallet: adminWallet,
      services: syncContext.services,
      identityWif: keys.identityWif,
      chain,
      options: recoveryOptions,
      addresses: () => [...syncContext.addressManager.getAddresses(), keys.identityAddress],
    });

  const tokenHealArgs: TokenHealArgs & { addresses: () => string[] } = {
    wallet: adminWallet,
    listFailedActions: async () =>
      (
        await baseWallet.listFailedActions(
          { labels: [], includeOutputs: true, includeOutputLockingScripts: true, limit: 200 },
          false,
        )
      ).actions as unknown as HealAction[],
    services: syncContext.services,
    identityWif: keys.identityWif,
    chain,
    addresses: () => [...syncContext.addressManager.getAddresses(), keys.identityAddress],
  };
  const fixStaleToken = (tokenId: string) => runStaleFix(tokenHealArgs, tokenId);
  const dropSpentTokens = () => runSpendPass(tokenHealArgs);
  const healUnseenTokens = (tokenId?: string, keysOnly?: boolean) =>
    runUnseenHeal(tokenHealArgs, { tokenId, keysOnly });
  let tokenHealDone = false;
  /** Once per open: token sends broadcast but left unfinished (a suspended Safari tab), then the usual walk. */
  const startupTokenHeal = async () => {
    if (tokenHealDone) return;
    tokenHealDone = true;
    try {
      const r = await runStartupTokenHeal(tokenHealArgs);
      if (r.imported.length || r.errors.length || r.journalled.length) console.log('[initWallet] token send heal:', r);
    } catch (err) {
      console.error('[initWallet] token send heal failed:', err);
    }
  };

  // Scan past maxKeyIndex (addresses handed out on other devices) and rescan history once whenever that window
  // reaches indexes this device never scanned: the sync's one resume cursor would otherwise skip their payments
  // (owner, 10 Oct 2026: 0.254 BSV at a fresh address never showed). services/addressScan.ts.
  const scanPlan = planAddressScan(maxKeyIndex, account?.settings?.addressScanThrough);
  if (scanPlan.resetCursor) {
    try {
      const { publicKey: idKey } = await adminWallet.getPublicKey({ identityKey: true });
      const reset = await resetSyncCursor(idKey);
      console.log(
        `[initWallet] Address scan widened to ${scanPlan.count}; history rescan ${reset ? 'queued' : 'not needed'}`,
      );
    } catch (err) {
      console.error('[initWallet] sync cursor reset failed:', err);
    }
  }
  const persistScanThrough = () => {
    const { account: acct, selectedAccount } = chromeStorageService.getCurrentAccountObject();
    if (!acct || !selectedAccount || (acct.settings?.addressScanThrough ?? -1) >= scanPlan.through) return;
    chromeStorageService
      .updateNested('accounts', {
        [selectedAccount]: {
          settings: { ...acct.settings, addressScanThrough: scanPlan.through },
        } as unknown as Account,
      })
      .catch((err: unknown) => console.error('[initWallet] saving addressScanThrough failed:', err));
  };

  // Sweep anything already waiting in the deposit basket now, not only after a sync that finds new payments: a
  // sweep that failed before (or never ran) otherwise leaves received money unspendable until the next payment
  // arrives (owner, 10 Oct 2026, the new $vexvoid account). The balance counts the basket either way
  // (services/depositBalance.ts).
  sweepDeposit
    .execute(actionCtx, {})
    .then((r) => {
      if (r.swept) console.log(`[initWallet] Swept ${r.swept} waiting deposit(s) into the wallet`, r.txid);
    })
    .catch((err: unknown) => {
      console.error('[initWallet] deposit sweep failed:', err);
      sendSyncStatus({
        status: 'sweep-failed',
        error: err instanceof Error ? err.message : String(err),
        detail: `deposit sweep: ${syncErrorDetail(err)}`,
      });
    });

  // Deposit derivation for one of our addresses: the address manager's window first, then a wider scan (an
  // address handed out past this device's maxKeyIndex), which is added to the manager so sync and the guard see it.
  const stuckSince = new Map<string, number>();
  // Outputs the wallet already moved, kept across service-worker restarts (services/receiveGuard.ts markMoved).
  const MOVED_KEY = 'bwxMovedOutpoints';
  const rememberMoved = (outpoints: string[]) => {
    markMoved(outpoints);
    chrome.storage?.local
      ?.set({ [MOVED_KEY]: movedEntries() })
      .catch((err: unknown) => console.error('[receiveGuard] saving moved outputs failed:', err));
  };
  try {
    const stored = await chrome.storage?.local?.get(MOVED_KEY);
    restoreMoved(stored?.[MOVED_KEY]);
  } catch {
    /* nothing remembered yet */
  }
  const DERIVATION_SEARCH_LIMIT = 200;
  let derivationSearchedThrough = -1;
  const depositDerivationFor = async (address: string): Promise<DepositDerivation | null> => {
    const am = syncContext.addressManager;
    const known = am.getDerivation(address);
    if (known) return { address, derivationPrefix: known.derivationPrefix, derivationSuffix: known.derivationSuffix };
    const start = Math.max(am.getMaxKeyIndex() + 1, derivationSearchedThrough + 1);
    if (start > DERIVATION_SEARCH_LIMIT) return null;
    const { derivations } = await deriveDepositAddresses.execute(
      { wallet: adminWallet, services: syncContext.services, chain, isBaseWallet: true },
      { startIndex: start, count: DERIVATION_SEARCH_LIMIT - start + 1 },
    );
    derivationSearchedThrough = DERIVATION_SEARCH_LIMIT;
    const hit = derivations.find((d) => d.address === address);
    if (!hit) return null;
    am.addAddress(hit);
    console.log(`[receiveGuard] ${address} is deposit index ${hit.index}; added to the address manager`);
    return { address, derivationPrefix: hit.derivationPrefix, derivationSuffix: hit.derivationSuffix };
  };

  // What the device store holds for an outpoint, spent or not (services/heldOutpoints.ts). Read straight from the active
  // provider, never through the manager's locks (as localRawTx). The remote store active: none (arriving counts as before).
  const deviceReads: DeviceReads = async () => {
    if (!storage.isActiveStorageProvider()) return undefined;
    const { userId } = await storage.getAuth();
    if (typeof userId !== 'number') return undefined;
    return { store: storage.getActive() as unknown as HeldStore, userId };
  };
  // Owner, 5 Nov 2026 ($3.42 for $2.42): the sweep had spent the payment, listOutputs no longer listed it, the indexer
  // still did, and it counted as arriving on top of the sweep's change. The guard and the balance ask storage itself.
  const accountedFor = accountedVia(deviceReads);
  /** What the device store holds for each outpoint; undefined with the remote store active (no device store to ask). */
  const deviceStates = async (outpoints: string[]): Promise<Map<string, OutpointState> | undefined> => {
    const r = await deviceReads();
    return r ? outpointStates(r.store, r.userId, outpoints) : undefined;
  };
  // No device store: every outpoint reads as held, so the watcher takes nothing in (it never runs then anyway).
  const statesOf = async (outpoints: string[]): Promise<Map<string, OutpointState>> =>
    (await deviceStates(outpoints)) ?? new Map(outpoints.map((o) => [normOutpoint(o), 'stored' as OutpointState]));
  /** Of these txids, the ones storage holds (our own spends). No device store: all, so nothing asks for a pull. */
  const heldTxids = async (txids: string[]) => {
    const r = await deviceReads();
    return r ? knownTxids(r.store, r.userId, txids) : new Set(txids);
  };
  // Spent already, mempool included? The owner stream lists a spend only once it is mined, so a payment the other copy
  // of this wallet swept seconds ago still looks unspent there (review 20, H1 and M2; services/spendCheck.ts). The 1sat
  // spend index first (batched, 429 back-off), WhatsOnChain second (paced app-wide, services/wocLimiter.ts).
  const txoSpends = (syncContext.services as unknown as { txo?: { getSpends?: (o: string[]) => Promise<unknown[]> } })
    .txo;
  const spendIndex = txoSpends?.getSpends
    ? (b: string[]) => txoSpends.getSpends!(b) as Promise<(string | null | undefined)[]>
    : undefined;
  // coinPreflight's hardened lookup, its request aborted after 3 s (review 20 re-check, N1: a bare fetch that never
  // answered stalled the watcher, the guard and the address sync's coin queue).
  const wocSpender = wocSpendLookup(3_000);
  /** The receive guard and the watcher: few outputs, both sources each. */
  const spendsAll = makeSpendCheck({ index: spendIndex, woc: wocSpender, wocFor: 'all' });
  /**
   * The address sync, which may take in hundreds of coins at a restore: one batched lookup for all of them first, kept
   * two minutes (N3); WhatsOnChain only where the index can't tell. What it takes in is re-checked (takenRecheck below).
   */
  const spendsSync = makeSpendCheck({ index: spendIndex, woc: wocSpender, wocFor: 'unanswered', cacheMs: 120_000 });
  // Another copy of this wallet spent one of our receive outputs: a device-sync pull, throttled (services/receiveWatch.ts);
  // then a guard run, so a payment whose spender's change now waits here for admission shows meanwhile (M5).
  let guardSoon: () => void = () => undefined;
  const askPull = createPullTrigger({
    pull: () => deviceSync.syncNow().then(() => guardSoon()),
    log: (...a) => console.warn(...a),
  });
  /**
   * Mark a coin another copy of this wallet spent as spent here: spendability only goes down, on this device's store
   * only, and the automatic coin check re-checks it (its cleared list) and puts it back if both sources later call it
   * unspent (services/autoCoinResync.ts). Review 20 re-check, H1.
   */
  const markSpentHere = async (outpoint: string, spender: string): Promise<number> => {
    if (!storage.isActiveStorageProvider()) return 0;
    const { userId } = await storage.getAuth();
    const [txid, vout] = normOutpoint(outpoint).split('.');
    const n = await storage.runAsStorageProvider(async (sp) => {
      const by = (await sp.findTransactions({ partial: { userId, txid: spender }, noRawTx: true }))[0];
      let changed = 0;
      for (const o of await sp.findOutputs({
        partial: { userId, txid, vout: Number(vout), spendable: true },
        noScript: true,
      }))
        changed += await sp.updateOutput(o.outputId, {
          spendable: false,
          ...(by ? { spentBy: by.transactionId } : {}),
        });
      return changed;
    });
    if (n)
      await recordAutoCleared(
        { get: (k) => chrome.storage.local.get(k), set: (items) => chrome.storage.local.set(items) },
        account?.pubKeys?.identityPubKey ?? '',
        { [`${txid}_${vout}`]: spender },
      );
    return n;
  };
  /** Put back a coin the re-check marked whose spender was dropped: only a row still as the mark left it. */
  const markUnspentHere = async (outpoint: string, spender: string): Promise<number> => {
    if (!storage.isActiveStorageProvider()) return 0;
    const { userId } = await storage.getAuth();
    const [txid, vout] = normOutpoint(outpoint).split('.');
    return storage.runAsStorageProvider(async (sp) => {
      const by = (await sp.findTransactions({ partial: { userId, txid: spender }, noRawTx: true }))[0];
      let changed = 0;
      for (const o of await sp.findOutputs({
        partial: { userId, txid, vout: Number(vout), spendable: false },
        noScript: true,
      }))
        if (o.spentBy == null || (by && o.spentBy === by.transactionId))
          changed += await sp.updateOutput(o.outputId, { spendable: true, spentBy: undefined });
      return changed;
    });
  };
  // The automatic coin check's rule, not a new one (review 20, second re-check, Q1): the index first, in batches;
  // WhatsOnChain (3 s, then "can't tell") only to confirm a spender the index names; never our own unfinished actions.
  const recheck = createTakenRecheck({
    index: spendIndex ?? (async () => Promise.reject(new Error('no spend index'))),
    woc: (op) => wocSpentStatus(op, AbortSignal.timeout(3_000)),
    ownPendingTxids: async () => {
      const r = await deviceReads();
      return r ? ownPendingTxids(r.store, r.userId) : new Set<string>();
    },
    heldTxids: (t) => heldTxids(t),
    markSpent: markSpentHere,
    markUnspent: markUnspentHere,
    askPull: (sp) => askPull(sp),
    log: (...a) => console.warn(...a),
  });
  const pullForForeign = async (spenders: string[] | undefined) => {
    if (!spenders?.length) return;
    const ours = await heldTxids(spenders).catch(() => new Set(spenders));
    const foreign = spenders.filter((t) => !ours.has(t));
    if (foreign.length) askPull(foreign);
  };
  // One internalize at a time across the address sync, the receive guard and the receive watcher; each checks "already
  // in?" inside it, so a payment two of them find in the same seconds is taken in once (services/internalizeLock.ts).
  const internalizeLock = createInternalizeLock();

  // The address the Receive screen shows must always count (services/receiveGuard.ts; owner, 10 Oct 2026:
  // $5 at the $vexvoid receive address never showed). Runs after every address sync, clean or not.
  const receiveGuardOnce = async () => {
    // When this run's look at the indexer began: a stale result never wipes what the watcher added since (review 20, L2).
    const since = Date.now();
    // Never between the steps of a connected site's multi-step action (services/dappChain.ts).
    if (chainActive()) {
      console.log('[receiveGuard] a site action is in progress; check deferred');
      return;
    }
    // Coins taken in on an "unspent" that may have been the index lagging: asked about again (H1). Not waited for.
    void recheck.run().catch(() => undefined);
    const shown = chromeStorageService.getCurrentAccountObject().account?.primaryAddress;
    const addresses = [...(shown ? [shown] : []), ...syncContext.addressManager.getAddresses()];
    const walletOutpoints = async () => {
      const all: string[] = [];
      for (const basket of [FUNDING_BASKET, DEPOSIT_BASKET, ONESAT_BASKET, BSV21_BASKET]) {
        try {
          const r = await baseWallet.listOutputs({ basket, limit: 10000 });
          for (const o of r.outputs) all.push(o.outpoint);
        } catch {
          /* a basket that can't be read just isn't counted as known */
        }
      }
      return all;
    };
    const outputSats = async (outpoint: string) => {
      const [txid, vout] = normOutpoint(outpoint).split('.');
      const raw = await syncContext.services.beef.getRawTx(txid);
      return Transaction.fromBinary(Array.from(raw)).outputs[Number(vout)]?.satoshis ?? 0;
    };
    const first = await checkReceiveAddresses(addresses, {
      ownerSync: (a) => syncContext.services.owner.sync(a),
      outputSats,
      walletOutpoints,
      accountedFor,
      spends: spendsAll,
      waitingSpenders: waitingVia(deviceReads),
    });
    void pullForForeign(first.spenders);
    if (!first.satoshis) {
      setArriving([], since);
      return;
    }
    console.warn(
      `[receiveGuard] ${first.satoshis} sats at our receive addresses missing from storage; retrying`,
      first,
    );
    const { publicKey: senderIdentityKey } = await adminWallet.getPublicKey({ identityKey: true });
    const derivations = new Map<string, unknown>();
    for (const address of syncContext.addressManager.getAddresses()) {
      const d = syncContext.addressManager.getDerivation(address);
      if (!d) continue;
      derivations.set(address, {
        outputIndex: 0,
        derivationPrefix: d.derivationPrefix,
        derivationSuffix: d.derivationSuffix,
        senderIdentityKey,
        protocolID: ONESAT_PROTOCOL as WalletProtocol,
        counterparty: 'self',
      });
    }
    // Each missing transaction, directly (services/guardIntake.ts): not what the device store already holds (L3), and as
    // before with the remote store active (M1); under the shared internalize lock, re-checked inside it.
    for (const r of await guardIntake(first.outputs, {
      states: deviceStates,
      getBeef: async (txid) => syncContext.services.beef.getBeef(txid),
      internalize: (beef) =>
        internalizeBeef({
          beef: Uint8Array.from(beef),
          addressDerivations: derivations as Parameters<typeof internalizeBeef>[0]['addressDerivations'],
          wallet: adminWallet,
          services: syncContext.services,
          chain,
        }),
      lock: internalizeLock,
      backoff: internalizeBackoff,
      // What the guard takes in is re-checked too (review 20, second re-check, R3).
      onInternalized: (ops) => recheck.add(ops),
    })) {
      if (r.outcome === 'internalized') console.log(`[receiveGuard] internalized ${r.txid}`);
      else if (r.outcome === 'no-match') console.warn(`[receiveGuard] ${r.txid}: no output matched our derivations`);
      else if (r.outcome === 'held')
        console.warn(
          `[receiveGuard] ${r.txid}: held in storage but not counted (waiting on admission?); not rewritten`,
        );
      else if (r.outcome === 'failed') {
        const err = r.error;
        console.error(`[receiveGuard] internalize ${r.txid} failed:`, err);
        sendSyncStatus({
          status: 'receive-failed',
          txid: r.txid,
          error: err instanceof Error ? err.message : String(err),
          detail: `receive guard ${r.txid}: ${syncErrorDetail(err)}`,
        });
      }
    }
    await sweepDeposit
      .execute(actionCtx, {})
      .catch((err: unknown) => console.error('[receiveGuard] sweep failed:', err));
    const after = await checkReceiveAddresses(addresses, {
      ownerSync: (a) => syncContext.services.owner.sync(a),
      outputSats,
      walletOutpoints,
      accountedFor,
      spends: spendsAll,
      waitingSpenders: waitingVia(deviceReads),
    });
    // Still missing after a direct internalize: storage won't take this txid (services/receiveRescue.ts). Spend
    // each stuck output back to the same address in a fresh transaction and credit that one instead.
    let final = after;
    // Off (audit, 11 Oct 2026): the rescue broadcast outside storage and could double-spend an in-flight spend,
    // because walletOutpoints only lists spendable outputs. Stuck money now just counts as arriving.
    if (RESCUE_AUTO_BROADCAST && after.satoshis) {
      const rescued = await rescueStuckOutputs(after.outputs, {
        getRawTx: async (txid) => Array.from(await syncContext.services.beef.getRawTx(txid)),
        getBeef: async (txid) => Array.from(await syncContext.services.beef.getBeef(txid)),
        isConfirmed: async (txid) => {
          try {
            const b = Beef.fromBinary(Array.from(await syncContext.services.beef.getBeef(txid)));
            return b.findTxid(txid)?.bumpIndex !== undefined;
          } catch {
            return false;
          }
        },
        derivationFor: (address) => depositDerivationFor(address),
        signInput: async (tx, i, protocolID, keyID) => {
          const r = await signP2PKHInput(actionCtx, tx, i, protocolID, keyID, 'self');
          if (typeof r !== 'string') throw new Error(r.error);
          return r;
        },
        broadcast: async (tx) => {
          const r = await syncContext.services.submitToStack(tx.toBinary());
          if (['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'INVALID', 'MALFORMED'].includes(r.txStatus))
            throw new Error(`network refused the sweep (${r.txStatus}${r.extraInfo ? `: ${r.extraInfo}` : ''})`);
        },
        internalize: async (beef, ds) => {
          const map = new Map<string, unknown>();
          for (const [address, d] of ds)
            map.set(address, {
              outputIndex: 0,
              derivationPrefix: d.derivationPrefix,
              derivationSuffix: d.derivationSuffix,
              senderIdentityKey,
              protocolID: ONESAT_PROTOCOL as WalletProtocol,
              counterparty: 'self',
            });
          const r = await internalizeLock(() =>
            internalizeBeef({
              beef: Uint8Array.from(beef),
              addressDerivations: map as Parameters<typeof internalizeBeef>[0]['addressDerivations'],
              wallet: adminWallet,
              services: syncContext.services,
              chain,
            }),
          );
          return r.internalized;
        },
        protocolID: ONESAT_PROTOCOL as WalletProtocol,
        feeRate: chromeStorageService.getCustomFeeRate(),
        alreadySpent: (outpoint) => rememberMoved([outpoint]),
        firstSeen: (outpoint) => {
          const k = normOutpoint(outpoint);
          if (!stuckSince.has(k)) stuckSince.set(k, Date.now());
          return stuckSince.get(k) ?? Date.now();
        },
      });
      if (rescued.length) {
        rememberMoved(rescued.map((r) => r.from));
        await sweepDeposit
          .execute(actionCtx, {})
          .catch((err: unknown) => console.error('[receiveGuard] sweep after rescue failed:', err));
        final = await checkReceiveAddresses(addresses, {
          ownerSync: (a) => syncContext.services.owner.sync(a),
          outputSats,
          walletOutpoints,
          accountedFor,
          spends: spendsAll,
          waitingSpenders: waitingVia(deviceReads),
        });
      }
    }
    // Whatever is still missing counts as arriving, so the balance never shows $0 for it. Each balance read checks these
    // outpoints against storage again (services/receiveGuard.ts arrivingNow).
    // Money only: a 1-sat ordinal / marker still missing is never shown as BSV arriving (receiveGuard.ts isCoinSats).
    const stillArriving = arrivingCoins(final.outputs);
    setArriving(stillArriving.outputs, since);
    if (stillArriving.satoshis) sendSyncStatus({ status: 'arriving', satoshis: stillArriving.satoshis });
  };
  // One receive-guard run at a time: overlapping runs each internalized and swept the same outputs.
  const receiveGuardFlight = singleFlight(receiveGuardOnce);
  const runReceiveGuard = () => receiveGuardFlight.run();
  const guard = () => runReceiveGuard().catch((err) => console.error('[receiveGuard] failed:', err));
  guardSoon = () => void guard();

  // One address sync at a time, shared by the startup run, the background alarm and the refresh button
  // (services/addressResync.ts). A quiet run (the alarm) shows no spinner; its 'complete' still refreshes the balance.
  let quietRun = false;
  let afterSyncDone = false;
  const addressSync = singleFlight(async () => {
    const quiet = quietRun;
    if (!quiet) {
      console.log('[initWallet] Starting address sync...');
      sendSyncStatus({ status: 'start', addressCount: scanPlan.count });
    }
    // Coins first, then names/ordinals in the background, each part with its own progress and failures
    // (services/prioritySync.ts; owner, 25 Oct 2026: a big restored wallet's balance crept up for minutes).
    // A transaction WebKit aborted (the app suspended, 7 Nov 2026) runs once more before the banner says so
    // (services/idbAbortRetry.ts).
    await retryOnceOnIdbAbort(() =>
      runPrioritySync(actionCtx, {
        count: scanPlan.count,
        lock: internalizeLock,
        // A coin another copy of this wallet already swept is not taken in (review 20, H1); fails open when unclear.
        spends: spendsSync,
        knownTxids: heldTxids,
        foreignSpend: (spenders) => void askPull(spenders),
        onTaken: (ops) => recheck.add(ops),
        onProgress: (p) => {
          if (!quiet)
            sendSyncStatus({
              status: 'progress',
              pending: Math.max(0, p.total - p.done),
              done: p.done,
              failed: p.failed,
              part: p.part,
              total: p.total,
              message: p.message,
            });
        },
        onCoinsReady: (r) => {
          // The balance is complete now: let the Wallet tab read it while names keep loading.
          sendSyncStatus({ status: 'coins-ready', ...r });
          sweepDeposit
            .execute(actionCtx, {})
            .catch((err: unknown) => console.error('[initWallet] deposit sweep failed:', err));
        },
      }),
    )
      .then(async (result) => {
        await sweepDeposit
          .execute(actionCtx, {})
          .catch((err: unknown) => console.error('[initWallet] deposit sweep failed:', err));
        // Everything at the legacy addresses joins the wallet (NFTs, names, tokens, BSV; nothing is moved here).
        // Before 'complete' so the list refresh it triggers sees them.
        let legacyAdded = 0;
        const legacy = [
          ...(ordKey && legacyOrdAddress ? [{ kind: 'ord' as const, address: legacyOrdAddress }] : []),
          ...(payKey && legacyPayAddress ? [{ kind: 'pay' as const, address: legacyPayAddress }] : []),
        ];
        for (const { kind, address } of legacy) {
          await syncLegacyOrd({ wallet: adminWallet, services: syncContext.services, chain, address, kind })
            .then((r) => {
              legacyAdded += r.added;
              if (r.added) console.log(`[initWallet] legacy ${kind} address:`, r);
            })
            .catch((err) => console.warn(`[initWallet] legacy ${kind} sync failed:`, err));
        }
        // Plain BSV taken in sits in the deposit basket (already in the balance): move it into funding now, as
        // for any deposit, so it is spendable without waiting for the next unlock.
        if (legacyAdded) {
          await sweepDeposit
            .execute(actionCtx, {})
            .catch((err: unknown) => console.error('[initWallet] deposit sweep failed:', err));
        }
        sendSyncStatus({ status: 'complete', ...result });
        // Only a clean run counts as having read the new addresses' history; a failed one keeps the rescan pending.
        if (result.failed === 0) persistScanThrough();
        console.log('[initWallet] Address sync complete:', result);
        // Token outputs no address scan can see (change of a send this storage
        // never recorded). Cheap when there is nothing to find; cached per tx.
        void startupTokenHeal().then(() =>
          recoverTokens().catch((err) => console.error('[initWallet] token recovery failed:', err)),
        );
        void guard();
        // afterSync is a once-per-open hook, not for every background resync.
        if (options?.afterSync && !afterSyncDone) {
          afterSyncDone = true;
          try {
            await options.afterSync({ storage });
          } catch (err) {
            console.error('[initWallet] afterSync failed:', err);
          }
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        sendSyncStatus({ status: 'error', message, detail: `address sync: ${syncErrorDetail(error)}` });
        console.error('[initWallet] Address sync failed:', error);
        void guard();
        recoverTokens().catch((err) => console.error('[initWallet] token recovery failed:', err));
      });
  });
  const resyncAddresses = (options?: { quiet?: boolean }) => {
    if (!addressSync.busy()) quietRun = options?.quiet ?? false;
    return addressSync.run();
  };
  // Closed (locked, account switched) before the gate opened: the held-back syncs never start on a closed wallet.
  let walletClosed = false;
  const syncsMayStart = (options?.startSyncsAfter?.() ?? Promise.resolve()).then(() => {
    if (walletClosed) throw new Error('wallet closed before its syncs started');
  });
  void syncsMayStart.then(
    () => resyncAddresses(),
    () => undefined,
  );
  // Bring in what the owner's other devices did since this one last looked (services/deviceSync.ts).
  void syncsMayStart.then(
    () => deviceSync.syncNow(),
    () => undefined,
  );

  // Instant receive (services/receiveWatch.ts; owner, 5 Nov 2026: the iPhone showed neither $1 after 20 minutes in front).
  // The address sync's own coin intake, made on first use (it derives the keys), recording in its processed-tx store.
  let watchKit:
    | Promise<{ intake: CoinIntake; store: ProcessedTxStoreIdb; classified: ProcessedTxStoreIdb; hashes: Set<string> }>
    | undefined;
  const watchIntake = () =>
    (watchKit ??= (async () => {
      const keys = await deriveSyncKeys(actionCtx.wallet, scanPlan.count);
      const store = new ProcessedTxStoreIdb(keys.identityKey);
      // The address sync's own store of transactions known to pay us only 1-sat items (names, tokens): never downloaded.
      const classified = new ProcessedTxStoreIdb(`${keys.identityKey}:classified-1sat`);
      const intake = makeCoinIntake({
        wallet: actionCtx.wallet,
        keyByHash: keys.keyByHash,
        processed: store,
        lock: internalizeLock,
        spends: spendsAll,
        knownTxids: heldTxids,
        foreignSpend: (spenders) => void askPull(spenders),
        unknownSpend: 'skip',
        onTaken: (ops) => recheck.add(ops),
      });
      return { intake, store, classified, hashes: keys.hashes };
    })().catch((e: unknown) => {
      watchKit = undefined;
      throw e;
    }));
  /** Raw transactions classified per look (each a payment's few hundred bytes, or an untagged mint's more). */
  const RAW_PER_LOOK = 6;
  const ownerBase = (syncContext.services.owner as unknown as { baseUrl?: string }).baseUrl;
  const watchStream = ownerBase ? ownerSyncReader(ownerBase) : undefined;
  let tip = { height: 0, at: 0 };
  // Held back with the other syncs while a site waits for its sheet (startSyncsAfter, services/sheetFirst.ts).
  let syncsOpen = false;
  void syncsMayStart.then(
    () => void (syncsOpen = true),
    () => undefined,
  );
  const receiveWatchAddresses = () => {
    const shown = chromeStorageService.getCurrentAccountObject().account?.primaryAddress;
    return [...(shown ? [shown] : []), ...syncContext.addressManager.getAddresses()];
  };
  const receiveWatch = createReceiveWatch({
    // This device's store only, never between a site's steps (as the receive guard), never before the syncs may start.
    active: () => syncsOpen && !walletClosed && storage.isActiveStorageProvider() && !chainActive(),
    addresses: () => receiveWatchAddresses(),
    // The tip, at most once a minute; the watcher gives this a deadline (review 20, M3).
    from: async () => {
      if (Date.now() - tip.at > 60_000)
        await baseWallet
          .getHeight({})
          .then(({ height }) => void (tip = { height, at: Date.now() }))
          .catch(() => undefined);
      return watchFrom(tip.height, Date.now());
    },
    // Read with an AbortSignal, so a look that runs out of time closes its request (M3).
    stream: (a, from, signal) =>
      watchStream ? watchStream(a, from, signal) : syncContext.services.owner.sync(a, from),
    states: statesOf,
    knownTxids: heldTxids,
    processed: async (txid) => (await watchIntake()).store.has(txid),
    // Payments first, names never downloaded (review 20, M4): the address sync's classified store; then the indexer's
    // tags, one call for every candidate (kept for this run only: the watcher sees only the receive outputs, not the
    // whole transaction); then the raw transaction, a few per look, against every key the address sync scans and the
    // receive addresses (a verdict "pays us no coin" is then the address sync's own, and is kept in its store).
    classify: async (txids, byTxid) => {
      const kit = await watchIntake();
      const out = new Map<string, TxClass>();
      const rest: string[] = [];
      for (const t of txids) {
        if (await kit.classified.has(t).catch(() => false)) out.set(t, 'not-coin');
        else rest.push(t);
      }
      const ops = rest.flatMap((t) => byTxid.get(t) ?? []);
      if (ops.length) {
        const rows = await syncContext.services.txo.getBatch(ops, { tags: ['*'] }).catch(() => undefined as unknown);
        if (Array.isArray(rows) && rows.length === ops.length) {
          let i = 0;
          for (const t of rest) {
            const n = (byTxid.get(t) ?? []).length;
            if (allOneSat(rows.slice(i, i + n) as Parameters<typeof allOneSat>[0])) out.set(t, 'not-coin');
            i += n;
          }
        }
      }
      const hashes = new Set([...kit.hashes, ...receiveWatchAddresses().map(pkhHex)]);
      let raw = 0;
      for (const t of rest) {
        if (out.has(t)) continue;
        if (raw++ >= RAW_PER_LOOK) {
          out.set(t, 'later');
          continue;
        }
        try {
          if (outputsPaying(await syncContext.services.beef.getRawTx(t), hashes).some((v) => v > 1)) out.set(t, 'coin');
          else {
            out.set(t, 'not-coin');
            await kit.classified.add(t).catch(() => undefined);
          }
        } catch {
          out.set(t, 'later');
        }
      }
      return out;
    },
    spends: spendsAll,
    askPull,
    recheck: () => recheck.run(),
    backoff: internalizeBackoff,
    fetchBeef: async (txid) => {
      const beef = await syncContext.services.beef.getBeef(txid);
      if (!beef) throw new Error(`Failed to load BEEF for ${txid}`);
      return Array.from(beef);
    },
    intake: async () => (await watchIntake()).intake,
    changed: (found) => sendSyncStatus({ status: 'coins-ready', found, failed: 0 }),
    // warn: the iPhone's worker relays warn and error only (review 20, L10).
    log: (...a) => console.warn(...a),
  });

  // Sync incoming paymail payments from the message box (fire-and-forget)
  void syncsMayStart
    .then(() => syncMessages.execute(actionCtx, { messageboxUrl: MESSAGEBOX_URL }))
    .then((result) => {
      if (result.processed > 0 || result.failed > 0) {
        console.log('[initWallet] Message box sync complete:', result);
      }
    })
    .catch((error: unknown) => {
      if (walletClosed) return;
      console.error('[initWallet] Message box sync failed:', error);
    });

  // Create close function
  /** The queued-send review and the by-hand send/cancel share these (services/stuckSends.ts). */
  const stuckDeps: Parameters<typeof releaseStuckSends>[0] & { listQueued: () => Promise<QueuedSend[]> } = {
    listQueued: () =>
      storage.runAsStorageProvider(async (sp) => {
        const out: QueuedSend[] = [];
        for (const t of await sp.findTransactions({
          partial: { status: 'sending', isOutgoing: true },
          noRawTx: true,
        })) {
          if (!t.txid) continue;
          const [req] = await sp.findProvenTxReqs({ partial: { txid: t.txid } });
          out.push({
            transactionId: t.transactionId,
            txid: t.txid,
            createdAt: new Date(t.created_at).getTime(),
            attempts: req?.attempts ?? 0,
            reqStatus: req?.status,
            description: t.description,
            satoshis: t.satoshis,
          });
        }
        return out;
      }),
    knownOnChain: (txid) => knownOnChain(txid),
    cancel: (q) =>
      storage.runAsStorageProvider(async (sp) => {
        for (const req of await sp.findProvenTxReqs({ partial: { txid: q.txid } }))
          await sp.updateProvenTxReq(req.provenTxReqId, { status: 'invalid' });
        await sp.updateTransactionStatus('failed', q.transactionId);
      }),
    available: () => storage.isActiveStorageProvider(),
  };

  const recoverTxidImpl = (txid: string, progress?: (step: string) => void) =>
    recoverPaymentByTxid(
      txid,
      makeTxidRecoverDeps({
        progress,
        storage,
        wallet: baseWallet as never,
        services: toolboxServices as never,
        legacyAddresses: (() => {
          const a = chromeStorageService.getCurrentAccountObject().account?.addresses;
          return a
            ? [
                { label: 'identity', address: a.identityAddress },
                { label: 'legacy BSV', address: a.bsvAddress },
                { label: 'legacy ordinals', address: a.ordAddress },
              ].filter((x) => !!x.address)
            : [];
        })(),
      }),
    ).then((r) => {
      if (r.result === 'restored') internalizeBackoff.clear(r.txid);
      return r;
    });
  // A payment this device holds as failed that the backup says went through and the chain has: repaired the way
  // Settings › Find mined payments repairs it, never by taking the backup's word (services/inboundSync.ts).
  stopBackupCheck.verifier.recover = async (txid) => {
    const r = await recoverTxidImpl(txid);
    if (r.result === 'restored') return 'restored';
    return r.result === 'not-mined' || r.result === 'error' ? 'wait' : 'done';
  };

  // Settings › Troubleshooting › Recover change from my 12 words (services/seedChange.ts).
  const recoverSeedChangeImpl = (progress?: (step: string) => void, options?: { fresh?: boolean }) =>
    recoverSeedChange(
      makeSeedChangeDeps({
        progress,
        fresh: options?.fresh,
        storage,
        wallet: baseWallet as never,
        services: toolboxServices as never,
        // Addresses the seed makes: identity, legacy pay and ordinals, and the deposit addresses handed out.
        seedAddresses: () => {
          const a = chromeStorageService.getCurrentAccountObject().account?.addresses;
          return [
            a?.identityAddress,
            a?.bsvAddress,
            a?.ordAddress,
            ...syncContext.addressManager.getAddresses(),
          ].filter((x): x is string => !!x);
        },
        kv: seedChangeKV(baseWallet.keyDeriver.identityKey),
      }),
    ).then((r) => {
      console.log('[seedChange]', r);
      return r;
    });

  // Settings › Storage › Find missing coins (services/findMissingCoins.ts).
  const missingCoins = () =>
    makeMissingCoinsDeps({
      storage,
      identityKey: baseWallet.keyDeriver.identityKey,
      services: toolboxServices as never,
      // The toolbox's own repair for a record the active store holds: proven-tx request -> 'unfail', TaskUnFail.
      unfail: storage.isActiveStorageProvider()
        ? async (txids) => {
            const d = makeRecoverDeps({
              storage,
              wallet: baseWallet,
              services: toolboxServices,
              monitor: walletMonitor,
            });
            const n = await d.queueUnfail(txids);
            if (n) console.log(`[bwx-recover] ${(await d.runUnFail()).trim() || 'UnFail done'}`);
            return n;
          }
        : undefined,
      recoverTxid: (txid) => recoverTxidImpl(txid),
    });

  const close = async () => {
    const c0 = Date.now();
    lastCloseSteps.length = 0;
    const step = (name: string) => void lastCloseSteps.push(`${Date.now() - c0}ms ${name}`);
    step('start');
    walletClosed = true;
    admitClosed = true;
    clearInterval(stalePullTimer);
    writeAhead?.stop();
    unregisterPullHealth();
    receiveWatch.stop();
    // The receive watch's processed-tx stores close with the wallet, capped so a stuck one never holds the close
    // (an account-switch reload waits on this; mobile/account/closeForReload.ts).
    const watchStoresClosed = settleWithin(
      () =>
        watchKit?.then(async (k) => {
          await k.store.close();
          await k.classified.close();
        }),
      WATCH_STORES_CLOSE_CAP_MS,
    );
    keepActive?.stop();
    if (admitTimer) clearTimeout(admitTimer);
    admitTimer = undefined;
    if (moreTimer) clearTimeout(moreTimer);
    moreTimer = undefined;
    step('destroy: monitor tasks + wallet');
    await destroyWallet();
    step('destroy done');
    stopBackupCheck();
    await watchStoresClosed;
    step('watch stores closed');
  };

  return {
    wallet,
    baseWallet,
    syncContext,
    storage,
    remoteStorage,
    permissionStore,
    envelopes,
    // Settings › Storage, Restore from backup and the move to this device: no pending heal undoes them (review 19, F3).
    setActiveStorage: switchActiveAs(keepActive, setActiveStorage),
    addRemote,
    recoverTokens,
    fixStaleToken,
    dropSpentTokens,
    healUnseenTokens,
    resyncAddresses,
    lastAddressSyncAt: addressSync.lastFinishedAt,
    addressSyncBusy: addressSync.busy,
    sweepDeposits: () => sweepDeposit.execute(actionCtx, {}),
    creditArriving: () => runReceiveGuard(),
    balanceSplit: () => balanceSplit(baseWallet, { accountedFor, spenderCarries: carriesVia(deviceReads) }),
    balanceTruth: async () => {
      const now = Date.now();
      const r = await deviceReads().catch(() => undefined);
      const store = r?.store as unknown as TruthStore | undefined;
      // What the headline already counts as arriving (receive guard): never counted again in either line.
      const arriving = arrivingOutputs();
      const arrivingOutpoints = arriving.map((o) => o.outpoint);
      // Each part on its own: one that can't be read shows nothing, never hides the others.
      const held = store && r ? await heldPayments(store, r.userId, now, arrivingOutpoints).catch(() => []) : [];
      let arrivingSats = 0;
      const device = deviceStore();
      if (store && r && device) {
        try {
          const { identityKey } = await storage.getAuth();
          const entries = await pendingAdmissions(device, identityKey);
          arrivingSats = await arrivingFromAdmissions(store, r.userId, entries, {
            outpoints: arrivingOutpoints,
            spenders: arriving.map((o) => o.spender),
          });
        } catch {
          arrivingSats = 0;
        }
      }
      const key = DEVICE_SYNC_KEY(keys.identityAddress);
      const got: Record<string, unknown> = await chrome.storage.local.get(key).catch(() => ({}));
      const sync = (got[key] ?? null) as DeviceSyncHealth | null;
      return {
        held,
        arrivingSats,
        syncApplies: storage.isActiveStorageProvider() && (backups?.length ?? 0) > 0,
        sync,
        changeUnbacked: writeAhead?.count() ?? 0,
      };
    },
    receiveWatch: {
      foreground: (on) => {
        receiveWatch.foreground(on);
        // A wallet page in front (APP_FOREGROUND, every 30 s while visible): a pull when the last good one is 5 min old.
        if (on && syncsOpen && !admitClosed) void deviceSync.pullIfStale(FOREGROUND_STALE_MS)?.catch(() => undefined);
      },
    },
    syncDevices: () => deviceSync.syncNow(),
    admitBackupRows,
    backupState: () => {
      const st = deviceSync.state();
      return {
        backupConfigured: (backups?.length ?? 0) > 0,
        pendingPush: st.pendingPush || st.scheduled || st.running,
        failures: st.failures,
        lastPushOkAt: st.lastPushOkAt,
        // A backup set aside after a failed merge, reconnecting on its back-off (review 19, F4).
        paused: keepActive?.paused().paused ?? false,
        storageBusy: (keepActive?.healing() ?? false) || st.running,
        // The pulls: the last one that caught up, stuck, payments still waiting for coins (services/syncHealth.ts).
        health: pullHealth.get(),
      };
    },
    backupBeforeSend: () =>
      backupBeforeSend({
        deviceActive: () => storage.isActiveStorageProvider(),
        backupConfigured: () => (backups?.length ?? 0) > 0,
        pushNow: () => deviceSync.pushNow(),
      }),
    recoverFailed: () =>
      runRecoverOnce(() =>
        recoverMinedFailedActions(
          makeRecoverDeps({
            storage,
            wallet: baseWallet,
            services: toolboxServices,
            monitor: walletMonitor,
          }),
        ),
      ).then((r) => {
        // A restored action may now be internalizable (its status was 'failed'): let the receive guard retry it.
        for (const txid of r.restored) internalizeBackoff.clear(txid);
        return r;
      }),
    recoverTxid: recoverTxidImpl,
    recoverSeedChange: recoverSeedChangeImpl,
    findMissingCoins: () => scanMissingCoins(missingCoins().scan),
    restoreMissingCoins: (coins: MissingCoin[]) =>
      restoreMissingCoins(coins, missingCoins().restore).then((r) => {
        for (const x of r.restored) internalizeBackoff.clear(x.txid);
        return r;
      }),
    reconcilePostage: (force?: boolean) =>
      reconcilePostage(
        {
          ...makePostageReconcileWiring({ storage, wallet: baseWallet as never, services: toolboxServices as never }),
          isMined: (txid) => wocIsMined(txid),
        },
        { force },
      ),
    expireUnsent: (force?: boolean, expiryOpts: { storageBusy?: () => boolean } = {}) =>
      runUnsentExpiry(
        // One wiring for the app and the two-device simulation (services/unsentExpiryWiring.ts).
        makeExpiryDeps({
          wallet: baseWallet,
          storage,
          services: toolboxServices,
          identityKey: baseWallet.keyDeriver.identityKey,
          kv: storageKV(baseWallet.keyDeriver.identityKey),
          recordCleared: (outpoint, spender) =>
            recordAutoCleared(
              { get: (k) => chrome.storage.local.get(k), set: (items) => chrome.storage.local.set(items) },
              account?.pubKeys?.identityPubKey ?? '',
              { [outpoint]: spender },
            ),
          recoverLate: (txid) => recoverTxidImpl(txid),
          storageBusy: expiryOpts.storageBusy,
          storePaid: THEME_STORE_PAID_ENABLED,
        }),
        { force },
      ),
    sweepCandidates: () => {
      const txo = (toolboxServices as unknown as { txo?: { getSpends?: (o: string[]) => Promise<(string | null)[]> } })
        .txo;
      return sweepCandidateTxids(storage, txo?.getSpends ? (o) => txo.getSpends!.call(txo, o) : undefined);
    },
    restorePaymails: async () => {
      const held = new Set<string>();
      for (let offset = 0; ; offset += 1000) {
        const page = await baseWallet.listOutputs({ basket: 'default', limit: 1000, offset });
        for (const o of page.outputs) held.add(o.outpoint);
        if (page.outputs.length < 1000) break;
      }
      const txo = (toolboxServices as unknown as { txo?: { get?: (o: string) => Promise<never> } }).txo;
      return restorePaymailHistory((u, i) => fetch(u, i), baseWallet, {
        hasOutput: async (txid, vout) => held.has(`${txid}.${vout}`),
        isUnspent: async (txid, vout) => {
          const get = txo?.get;
          if (!get) return undefined;
          const r = await utxoStatusFromTxo((o) => get.call(txo, o), `${txid}.${vout}`);
          return r.status === 'success' ? r.isUtxo : undefined;
        },
        fetchBeef: async (txid) => (await toolboxServices.getBeefForTxid(txid)).toBinary(),
      });
    },
    knownOnChain: (txid) => knownOnChain(txid),
    repairNullTxids: async () => {
      // Local store only: never edit the remote's rows from here.
      if (!storage.isActiveStorageProvider()) return { txidFilled: 0, setAside: 0, aborted: 0, skipped: 0 };
      const { userId } = await storage.getAuth();
      return repairNullTxids({
        spendableOutputs: () =>
          storage.runAsStorageProvider(async (sp) =>
            (await sp.findOutputs({ partial: { userId, spendable: true }, noScript: true })).map((o) => ({
              outputId: o.outputId,
              transactionId: o.transactionId,
              txid: o.txid,
              spendable: o.spendable,
            })),
          ),
        transaction: (transactionId) =>
          storage.runAsStorageProvider(async (sp) => {
            const [t] = await sp.findTransactions({ partial: { transactionId }, noRawTx: true });
            return t ? { transactionId, txid: t.txid, status: t.status, reference: t.reference } : undefined;
          }),
        pendingActions: () =>
          storage.runAsStorageProvider(async (sp) =>
            (
              await sp.findTransactions({ partial: { userId }, status: ['unsigned', 'unprocessed'], noRawTx: true })
            ).map((t) => ({
              transactionId: t.transactionId,
              txid: t.txid,
              status: t.status,
              reference: t.reference,
              updated_at: t.updated_at,
            })),
          ),
        updateOutput: async (id, patch) => {
          await storage.runAsStorageProvider((sp) => sp.updateOutput(id, patch));
        },
        abortAction: async (reference) => {
          await baseWallet.abortAction({ reference });
        },
        // StorageIdb keeps batch reservations in action_batch_outputs keyed by outputId (patched toolbox).
        releaseReservation: (outputId) =>
          storage.runAsStorageProvider(async (sp) => {
            const idb = sp as unknown as {
              toDbTrx?: (s: string[], m: string) => { objectStore: (n: string) => IdbStoreLike; done: Promise<void> };
            };
            if (!idb.toDbTrx) return false;
            const tx = idb.toDbTrx(['action_batch_outputs'], 'readwrite');
            const store = tx.objectStore('action_batch_outputs');
            const held = (await store.get?.(outputId)) != null;
            if (held) await store.delete?.(outputId);
            await tx.done;
            return held;
          }),
        knownOnChain: (txid) => knownOnChain(txid),
        // A signed action is aborted only after repeated "not found" answers over 30+ minutes (review 4 Nov, F5).
        missingLog: missingLogKV(baseWallet.keyDeriver.identityKey),
        log: (m, d) => console.warn(m, d ?? ''),
      });
    },
    sendWaitingNow: async () => (walletMonitor ? await walletMonitor.runTask('SendWaiting') : ''),
    referenceBytes: (reference) =>
      storage.runAsStorageProvider(async (sp) => {
        const [t] = await sp.findTransactions({ partial: { reference } });
        return (t?.rawTx?.length ?? 0) + (t?.inputBEEF?.length ?? 0);
      }),
    releaseStuckSends: () => releaseStuckSends(stuckDeps),
    listUnsent: () => stuckDeps.listQueued(),
    resolveUnsent: (txid: string, how: 'send' | 'cancel') =>
      resolveUnsent(
        { ...stuckDeps, sendWaiting: async () => (walletMonitor ? await walletMonitor.runTask('SendWaiting') : '') },
        txid,
        how,
      ),
    close,
  };
};
