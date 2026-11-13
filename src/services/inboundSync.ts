/**
 * Nothing that comes from another store becomes spendable on this device unless the chain or the wallet's own keys say
 * so (b-Aware A3, 0xzero, 25 Oct 2026).
 *
 * Every row a backup store (wallet.1sat.app, or any remote the account names) sends reaches this device through the
 * toolbox's sync merge: StorageIdb.processSyncChunk, the writer side of syncFromReader and syncToWriter. That covers
 * the device-sync pull on every open (services/deviceSync.ts), F-C's pull into the device store (services/localFirst.ts),
 * the restore switch (services/restoreFromRemote.ts), a backup import, the Monitor's backup sync while the remote is
 * active, and the merge the wallet factory runs at boot when the stores disagree about which is active. The merge
 * trusted the sender: a newer row overwrote the device's (spendable, spentBy, basket, change role, script, sender key,
 * record), and a new row went in as sent.
 *
 * The design (review 16c, replacing three rounds of patches): a merge only ever lowers what is spendable. It never
 * makes a coin spendable, never changes what a coin is or how the wallet signs for it, and asks nothing of the network.
 * What only the chain can settle goes on this device's admission list, a database of its own that no sync writes, and
 * admitPending works through that list after the merge, outside the storage locks, re-running every check first.
 *
 * Per page, before the toolbox merges it (verifyInboundChunk):
 *  1. A row this device already holds keeps what the coin is and how the wallet signs for it: script (and offsets),
 *     sender key, record (customInstructions), change role. (The toolbox never merges derivations or amounts.)
 *  2. Its spendability only goes down. Another store may mark it spent; a coin the device holds as spent or not
 *     spendable stays so, and the backup's "spendable" goes on the admission list. A spend link is never removed,
 *     moved to another transaction, or put on a coin the device holds as not spendable: the toolbox frees a coin when
 *     the transaction linked to it fails (reviewStatus, abortAction), so a link is a "spendable later".
 *  3. A row the device has never seen arrives not spendable. Claimed spendable: on the admission list. Linked: only to
 *     a completed transaction (which never fails). Anything that could come back must be the output its transaction
 *     says and pass the token-record and change-key checks, or it is quarantined: not spendable, no link, in no
 *     basket, not change, so nothing lists, sends or funds from it whatever frees it later.
 *  4. Transactions it holds keep their txid and raw bytes. A move to or from failed is the chain's to settle (admission
 *     list); a proven or completed one is never undone. A failed (or 'unfail') proof request arrives to be checked
 *     again.
 *  5. Token tags must match the script (F2); a tracking id (id:) loads one asset (R2), and never comes off one (C2).
 * admitPending (after each device-sync pull, during a restore, and soon after any merge that queued something):
 * transactions first (to failed when the chain has never seen it; from failed once it has, through the wallet's own
 * mined-payment repair), then coins: the row as the device holds it must match its raw transaction, pass the checks
 * in 3, not be an output of a failed transaction or spent by a payment not yet on the network, and the chain must know
 * its transaction and say it is unspent. 25 entries a run, stopping at the first unclear answer; a waiting entry backs
 * off (1 minute, doubling to 6 hours) and is dropped after 3 days, its coin left not spendable.
 *
 * Release rules kept: legacy batch mode (services/actionBatchMode.ts) and "no change on the remote store"
 * (services/localFirst.ts) are untouched; F-C's pull keeps the device store active (this only filters what it merges).
 */
import {
  Beef,
  CachedKeyDeriver,
  Hash,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Script,
  Transaction,
  Utils,
  type WalletProtocol,
} from '@bsv/sdk';
import { BSV20, BSV21 } from '@1sat/templates';
import { TAIL_ENTITIES } from './pullTail';
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client';
import type { SpendState } from './unsentExpiry';
import { readPushPage, type ParentStore, type PushArgs, type PushPage } from './pushParents';
import {
  abandonTail,
  afterPage,
  beforePage,
  finishTail,
  markOf,
  onDemandAllowed,
  overlapped,
  passFromStart,
  rewind,
  rewindDeep,
  syncStateFor,
  tailUnderWay,
  updateMark,
  type SyncStateRow,
} from './fullPass';

/** The toolbox's BRC-29 payment protocol (change and received payments). */
const BRC29: [2, string] = [2, '3241645161d8'];
/**
 * Records written through the permissions manager are encrypted under its metadata protocol (a private static in the
 * typings, read as the toolbox defines it). Missing: records can't be read here and such rows go to the chain check.
 */
const METADATA_PROTOCOL = (WalletPermissionsManager as unknown as { METADATA_ENCRYPTION_PROTOCOL?: WalletProtocol })
  .METADATA_ENCRYPTION_PROTOCOL;

export const UNCHECKED_PAGE =
  "A page from your backup couldn't be checked, so none of it was taken. It is tried again later.";
export const NO_VERIFIER = 'This device store only takes in backup rows it can check; none is set up for this account';
export const UNFILED_PAGE =
  'A page from your backup names a payment this device has no record of, so none of it was taken. It is tried again later.';

type Bytes = number[] | Uint8Array;
export type OutputRow = {
  outputId?: number;
  userId?: number;
  transactionId?: number;
  basketId?: number | null;
  spentBy?: number | null;
  txid?: string | null;
  vout: number;
  satoshis?: number;
  spendable?: boolean;
  change?: boolean;
  type?: string;
  providedBy?: string;
  purpose?: string;
  derivationPrefix?: string | null;
  derivationSuffix?: string | null;
  senderIdentityKey?: string | null;
  customInstructions?: string | null;
  lockingScript?: Bytes | null;
  scriptLength?: number | null;
  scriptOffset?: number | null;
  spendingDescription?: string | null;
  updated_at?: Date;
};
type TxRow = {
  inputBEEF?: Bytes | null;
  transactionId?: number;
  txid?: string | null;
  reference?: string | null;
  status?: string;
  rawTx?: Bytes | null;
  provenTxId?: number | null;
  noSendExpiryState?: string | null;
  updated_at?: Date;
};
type ProvenRow = { txid?: string; rawTx?: Bytes | null };
type ReqRow = { txid?: string; status?: string };
/** Transaction states of a payment this device has made but the network may not have yet ('unfail': being re-checked). */
export const IN_FLIGHT = new Set(['nosend', 'unsigned', 'unprocessed', 'sending', 'unproven', 'nonfinal', 'unfail']);
/** Proof-request states in which the toolbox's monitor fails the transaction. */
const REQ_FAILED = new Set(['invalid', 'doubleSpend']);
type TagRow = { outputTagId?: number; tag?: string };
type TagMapRow = { outputId?: number; outputTagId?: number; isDeleted?: boolean; updated_at?: Date };
export type SyncChunk = {
  outputs?: OutputRow[];
  transactions?: TxRow[];
  provenTxs?: ProvenRow[];
  outputTags?: TagRow[];
  outputTagMaps?: TagMapRow[];
  provenTxReqs?: ReqRow[];
};
type SyncArgs = {
  identityKey?: string;
  fromStorageIdentityKey?: string;
  toStorageIdentityKey?: string;
  /** The pass's cursor: rows the reader changed at or after this (none: a pass from the start). */
  since?: Date | string;
  /** The writer's sync state for this reader (what the toolbox reloads). */
  syncStateId?: number;
  maxItems?: number;
  maxRoughSize?: number;
  /** Set by the toolbox's own sync loops (syncFromReader, syncToWriter), never by an export or a USB backup. */
  includeNextCheckpoint?: boolean;
};

/** The storage provider calls this needs (StorageIdb). */
export type DeviceStore = {
  findUsers(a: { partial: { identityKey: string } }): Promise<{ userId: number }[]>;
  findSyncStates(a: { partial: { storageIdentityKey: string; userId: number } }): Promise<{ syncMap?: unknown }[]>;
  findTransactions(a: { partial: Record<string, unknown>; noRawTx?: boolean; trx?: unknown }): Promise<TxRow[]>;
  findOutputs(a: { partial: Record<string, unknown>; trx?: unknown }): Promise<OutputRow[]>;
  getProvenOrRawTx?(txid: string): Promise<{ rawTx?: Bytes; proven?: { rawTx?: Bytes } }>;
  findOutputTags?(a: { partial: Record<string, unknown> }): Promise<TagRow[]>;
  findOutputTagMaps?(a: { partial: Record<string, unknown> }): Promise<TagMapRow[]>;
  findProvenTxReqs?(a: { partial: Record<string, unknown> }): Promise<ReqRow[]>;
  getSettings?(): { storageIdentityKey?: string };
};

export type InboundVerifier = {
  /** Does `scriptHex` pay a key the wallet derives itself from this row's own derivation or record? */
  owns(row: OutputRow, scriptHex: string): Promise<boolean>;
  /** The chain's word on an outpoint "txid.vout" (WhatsOnChain /spent). */
  spent(outpoint: string): Promise<SpendState>;
  /** A row's record (customInstructions) as JSON, decrypting what the permissions manager encrypted. */
  readRecord?(customInstructions: string): Promise<Record<string, unknown> | undefined>;
  /**
   * Does the chain know this transaction (WhatsOnChain /tx/hash)? WoC answers /spent with 404 for an outpoint it has
   * never seen, so "unspent" only counts for a transaction the chain knows (review 16, F4). Absent: never known.
   */
  txKnown?(txid: string): Promise<'known' | 'unknown' | 'unclear'>;
  /**
   * The transaction as the chain has it (review 16d, D5): a coin the device has no raw transaction for is admitted
   * only if the chain's output has the row's script and satoshis. Absent: such a coin waits.
   */
  chainTx?(txid: string): Promise<ChainTx>;
  /**
   * The wallet's own repair for a payment it holds as failed that the chain has (services/recoverByTxid.ts): proof,
   * status and outputs, each checked. 'wait': not mined yet, or no answer. Absent: the status alone becomes 'unproven'.
   */
  recover?(txid: string): Promise<'restored' | 'done' | 'wait'>;
  /**
   * The token overlay's word on one BSV-21 coin "txid.vout" (fix 7, 13 Nov 2026), asked only once the chain has called
   * the coin unspent. Read through tokenOverlayVerdict: only 'spent' holds the coin back, and it is asked again later.
   * Any other answer, an error, an overlay that isn't funded or can't be reached, never holds a coin: spendability is
   * the chain's to decide, and a token's validity is checked when it is sent. Absent: the chain alone decides.
   */
  tokenState?(tokenId: string, outpoint: string): Promise<unknown>;
  /** A merge put something on the admission list: run admitPending soon (initWallet schedules it). */
  onQueued?: () => void;
  /** A pass from the start we started paused (a slice used up, or a heal left it): pull again soon (initWallet). */
  onMore?: () => void;
  log?: (...a: unknown[]) => void;
};

/** A transaction as the chain has it: its raw bytes (which must hash to the txid), not there, or no clear answer. */
export type ChainTx = { state: 'found'; rawTx: number[] } | { state: 'unknown' } | { state: 'unclear' };

/** What only the chain can settle: a coin the backup says is spendable, or a status it gives a transaction. */
export type Admission =
  | { kind: 'coin'; txid: string; vout: number; claim?: undefined }
  | {
      kind: 'tx';
      txid: string;
      claim: string;
      vout?: undefined;
    };

export type InboundReport = {
  /** Rows the device holds, kept exactly as it has them (a revival, an unlink or relink, a rewritten txid). */
  kept: number;
  /** New rows that fail a check: not spendable, no link, no basket, not change. */
  quarantined: number;
  /** Coins the backup says are spendable, left not spendable here and put on the admission list. */
  queued: number;
  pinned: number;
  /** Token tags (amt:, bsv21:, sym:, dec:) its script doesn't bear out, and id tags that would load a second asset. */
  tagsDropped: number;
  /** Spend links not taken (onto a coin the device holds as not spendable; a new row's, unless to a completed one). */
  linksDropped: number;
  /** Transaction rows kept as the device has them, and failed proof requests taken as to be checked again. */
  keptTx: number;
  /**
   * Wallet change the backup holds as spendable that this page leaves NOT spendable here (kept spent, held, not taken).
   * For the log: the restore switch checks the device's store itself (restoreFromRemote.outpointsOnDevice).
   */
  withheldOutputs: number;
  withheldSats: number;
  /** For the admission list (the guard writes them before the merge). */
  admissions: Admission[];
};

/** Wallet change: what the toolbox's funding picks on its own (managedChangeOutputFields + both derivation halves). */
export const isWalletChange = (o: OutputRow): boolean =>
  o.type === 'P2PKH' &&
  o.change === true &&
  o.providedBy === 'storage' &&
  o.purpose === 'change' &&
  typeof o.derivationPrefix === 'string' &&
  o.derivationPrefix.length > 0 &&
  typeof o.derivationSuffix === 'string' &&
  o.derivationSuffix.length > 0;

/** A row time as ms; NaN when it can't be read (callers treat that as "maybe newer"). */
const time = (d: unknown): number => (d instanceof Date ? d.getTime() : new Date(String(d)).getTime());

const hex = (b: Bytes | null | undefined): string | undefined =>
  b && b.length ? Utils.toHex(Array.from(b)).toLowerCase() : undefined;

/** Fields that say what a coin is and how the wallet signs for it: the device's copy wins (rule 1). */
const PINNED = [
  'lockingScript',
  'scriptLength',
  'scriptOffset',
  'senderIdentityKey',
  'customInstructions',
  'change',
  'type',
  'providedBy',
  'purpose',
] as const;

type IdMaps = {
  transaction?: { idMap?: Record<string, number> };
  output?: { idMap?: Record<string, number> };
  outputTag?: { idMap?: Record<string, number> };
};

// ── tokens: what a script says, which is what the chain enforces ──

export type TokenFacts = {
  kind: 'bsv21' | 'bsv20';
  /** BSV-21 token id (txid_vout), lowercase; a deploy's is its own outpoint. */
  id?: string;
  /** BSV-20 ticker, lowercase. */
  tick?: string;
  amt: string;
  /** deploy+mint / deploy+auth: the inscription itself carries sym and dec. */
  deploy: boolean;
  auth: boolean;
  sym?: string;
  dec?: string;
};
const normId = (id: string) => id.trim().replace('.', '_').toLowerCase();

/** The token an output script carries (BSV-21, else BSV-20), or null. */
export function tokenFacts(scriptHex: string, txid?: string | null, vout?: number): TokenFacts | null {
  let script: Script;
  try {
    script = Script.fromHex(scriptHex);
  } catch {
    return null;
  }
  try {
    const d = BSV21.decode(script);
    if (d) {
      const td = d.tokenData as { op?: string; id?: string; sym?: string };
      const op = String(td.op ?? '');
      const deploy = op === 'deploy+mint' || op === 'deploy+auth';
      const id = td.id
        ? normId(td.id)
        : deploy && txid && typeof vout === 'number'
          ? normId(`${txid}_${vout}`)
          : undefined;
      return {
        kind: 'bsv21',
        id,
        amt: d.getAmount().toString(),
        deploy,
        auth: op === 'auth' || op === 'deploy+auth',
        sym: deploy && td.sym != null ? String(td.sym) : undefined,
        dec: deploy ? String(d.getDecimals()) : undefined,
      };
    }
  } catch {
    // not BSV-21
  }
  try {
    const d = BSV20.decode(script);
    if (d) {
      const td = d.tokenData as { tick?: string };
      return {
        kind: 'bsv20',
        tick: td.tick ? String(td.tick).toLowerCase() : undefined,
        amt: d.getAmount().toString(),
        deploy: false,
        auth: false,
      };
    }
  } catch {
    // not BSV-20
  }
  return null;
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

/** A record's token fields (where present) say what the script says. Fields a transfer script can't show pass. */
export function recordAgrees(rec: Record<string, unknown>, f: TokenFacts): boolean {
  const amt = str(rec.amt);
  if (amt !== undefined && amt !== f.amt) return false;
  if (f.kind === 'bsv21') {
    const id = str(rec.id);
    if (id !== undefined && (!f.id || normId(id) !== f.id)) return false;
    if (f.deploy) {
      const sym = str(rec.sym);
      const dec = str(rec.dec);
      if (sym !== undefined && f.sym !== undefined && sym !== f.sym) return false;
      if (dec !== undefined && f.dec !== undefined && dec !== f.dec) return false;
    }
  } else {
    const tick = str(rec.tick);
    if (tick !== undefined && tick.toLowerCase() !== f.tick) return false;
  }
  return true;
}

const TOKEN_TAG = /^(amt|bsv21|sym|dec):/i;
/** Record fields only a token's record carries (@1sat/actions writes {id, amt, op}; BSV-20 names a tick). */
const TOKEN_RECORD_FIELDS = ['amt', 'id', 'op', 'tick'] as const;
/** A tag id no sync map ever holds (ids start at 1): EntityOutputTagMap.mergeFind skips the row. */
const UNMAPPED_ID = -1;
/** A managed tracking id (@1sat/types readAssetIdTag): sends and listings load "this" asset by it. */
const ID_TAG = /^id:/i;
/** A token tag (amount, id, symbol, decimals) the script bears out. sym/dec are only on a deploy inscription. */
export function tagAgrees(tag: string, f: TokenFacts | null): boolean {
  const at = tag.indexOf(':');
  const kind = tag.slice(0, at).toLowerCase();
  const value = tag.slice(at + 1);
  if (!f) return false;
  if (kind === 'amt') return value === f.amt;
  if (kind === 'bsv21') {
    if (f.kind !== 'bsv21') return false;
    if (value.toLowerCase() === 'deploy') return f.deploy;
    if (value.toLowerCase() === 'auth') return f.auth;
    return !!f.id && normId(value) === f.id;
  }
  if (kind === 'sym') return f.kind === 'bsv21' ? f.deploy && f.sym === value : f.tick === value.toLowerCase();
  if (kind === 'dec') return f.kind === 'bsv21' && f.deploy && f.dec === value;
  return false;
}

const parseSyncMap = (raw: unknown): IdMaps | undefined => {
  if (!raw) return undefined;
  if (typeof raw === 'object') return raw as never;
  try {
    return JSON.parse(String(raw));
  } catch {
    return undefined;
  }
};

/** A record as JSON (the verifier decrypts what the manager encrypted); undefined when it can't be read. */
async function recordOf(v: InboundVerifier, ci: string): Promise<Record<string, unknown> | undefined> {
  try {
    const o = JSON.parse(ci) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : undefined;
  } catch {
    return v.readRecord ? v.readRecord(ci).catch(() => undefined) : undefined;
  }
}

/**
 * May this row (with this script) become spendable, before asking the chain? A token's record must say what its script
 * says (F2: a forged amount burns tokens on the next send), and wallet change must pay the wallet's own key exactly
 * (F4a: funding would pick a coin the wallet can't sign). Other rows (a site's outputs) then go to the chain.
 */
async function admissibleRow(v: InboundVerifier, row: OutputRow, script: string): Promise<'refuse' | 'check'> {
  const facts = tokenFacts(script, row.txid, row.vout);
  if (typeof row.customInstructions === 'string' && row.customInstructions) {
    const rec = await recordOf(v, row.customInstructions);
    if (facts) {
      if (!rec || !recordAgrees(rec, facts)) return 'refuse';
    } else if (rec && TOKEN_RECORD_FIELDS.some((k) => rec[k] !== undefined && rec[k] !== null)) {
      // A token record on a script that carries no token (D4): a send reads the record, so it would count as tokens.
      return 'refuse';
    }
  }
  if (!isWalletChange(row)) return 'check';
  return (await v.owns(row, script).catch(() => false)) ? 'check' : 'refuse';
}

const parseRawTx = (raw: Bytes | undefined, txid: string): Transaction | undefined => {
  if (!raw?.length) return undefined;
  try {
    const tx = Transaction.fromBinary(Array.from(raw));
    return tx.id('hex') === txid ? tx : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Make one page safe to merge, in place (rows are rewritten, never removed, so the toolbox's paging is unchanged).
 * Nothing here asks the network: what only the chain can settle is returned in `report.admissions`, which the guard
 * writes to the device's admission list before the merge and admitPending works through after it (review 16c).
 */
export async function verifyInboundChunk(
  store: DeviceStore,
  args: SyncArgs,
  chunk: SyncChunk,
  v: InboundVerifier,
  opts: {
    /**
     * A pass from the start (review 23 re-check, N3): a coin the backup holds as spendable that this device holds as
     * not spendable and unlinked goes on the admission list again, even when the rows are equal (an admission given up
     * after 3 days). The chain still decides.
     */
    requeueHeld?: boolean;
  } = {},
): Promise<InboundReport> {
  const report: InboundReport = {
    kept: 0,
    quarantined: 0,
    queued: 0,
    pinned: 0,
    tagsDropped: 0,
    linksDropped: 0,
    keptTx: 0,
    withheldOutputs: 0,
    withheldSats: 0,
    admissions: [],
  };
  const outputs = chunk?.outputs ?? [];
  if (
    (!outputs.length &&
      !chunk?.outputTagMaps?.length &&
      !chunk?.transactions?.length &&
      !chunk?.provenTxReqs?.length) ||
    !args?.identityKey
  )
    return report;
  const user = (await store.findUsers({ partial: { identityKey: args.identityKey } }))[0];
  if (!user) return report; // the toolbox refuses a page for an unknown user on its own
  const userId = user.userId;
  const state = args.fromStorageIdentityKey
    ? (await store.findSyncStates({ partial: { storageIdentityKey: args.fromStorageIdentityKey, userId } }))[0]
    : undefined;
  const maps = parseSyncMap(state?.syncMap);
  const idMap = maps?.transaction?.idMap ?? {};
  const pageTx = new Map<number, TxRow>();
  for (const t of chunk.transactions ?? []) if (typeof t.transactionId === 'number') pageTx.set(t.transactionId, t);

  /** The device transaction the merge will file this row's transaction under (EntityTransaction.mergeFind). */
  const txCache = new Map<number, Promise<{ id?: number; txid?: string }>>();
  const deviceTx = (remoteId: number | null | undefined): Promise<{ id?: number; txid?: string }> => {
    if (typeof remoteId !== 'number') return Promise.resolve({});
    if (!txCache.has(remoteId)) txCache.set(remoteId, lookupTx(remoteId));
    return txCache.get(remoteId)!;
  };
  const lookupTx = async (remoteId: number): Promise<{ id?: number; txid?: string }> => {
    const t = pageTx.get(remoteId);
    if (t) {
      let local = t.txid
        ? (await store.findTransactions({ partial: { userId, txid: t.txid }, noRawTx: true }))[0]
        : undefined;
      if (!local && t.reference)
        local = (await store.findTransactions({ partial: { userId, reference: t.reference }, noRawTx: true }))[0];
      return { id: local?.transactionId, txid: t.txid ?? local?.txid ?? undefined };
    }
    const id = idMap[String(remoteId)];
    if (typeof id !== 'number') return {};
    const local = (await store.findTransactions({ partial: { userId, transactionId: id }, noRawTx: true }))[0];
    return { id, txid: local?.txid ?? undefined };
  };
  const deviceTxStatus = async (transactionId: number | null | undefined): Promise<string | undefined> =>
    typeof transactionId === 'number'
      ? (await store.findTransactions({ partial: { userId, transactionId }, noRawTx: true }))[0]?.status
      : undefined;

  /** A raw transaction for `txid` whose bytes really hash to it: from this page, else from the device. */
  const pageRaw = new Map<string, Bytes>();
  for (const t of [...(chunk.provenTxs ?? []), ...(chunk.transactions ?? [])])
    if (t.txid && t.rawTx?.length && !pageRaw.has(t.txid)) pageRaw.set(t.txid, t.rawTx);
  const parsed = new Map<string, Promise<Transaction | undefined>>();
  const rawTxFor = (txid: string): Promise<Transaction | undefined> => {
    if (!parsed.has(txid)) parsed.set(txid, readRawTx(txid));
    return parsed.get(txid)!;
  };
  const readRawTx = async (txid: string): Promise<Transaction | undefined> => {
    let raw: Bytes | undefined = pageRaw.get(txid);
    if (!raw && typeof store.getProvenOrRawTx === 'function') {
      const r = await store.getProvenOrRawTx(txid).catch(() => undefined);
      raw = r?.rawTx ?? r?.proven?.rawTx;
    }
    return parseRawTx(raw, txid);
  };

  /** The script this row really locks, or null when the row contradicts its own transaction. */
  const scriptOf = async (o: OutputRow): Promise<string | null | undefined> => {
    const said = hex(o.lockingScript);
    const tx = o.txid ? await rawTxFor(o.txid) : undefined;
    const out = tx?.outputs[o.vout];
    if (tx && !out) return null;
    if (out) {
      const real = out.lockingScript.toHex().toLowerCase();
      if (said && said !== real) return null;
      if (typeof o.satoshis === 'number' && out.satoshis !== o.satoshis) return null;
      return real;
    }
    return said;
  };

  /** The backup counts this row as spendable wallet change and this device doesn't (yet): for the log. */
  const withheld = (o: OutputRow, asFiled: OutputRow) => {
    if (o.spendable !== true || !isWalletChange(asFiled)) return;
    report.withheldOutputs++;
    report.withheldSats += typeof o.satoshis === 'number' ? o.satoshis : 0;
  };
  const keep = (o: OutputRow, filed?: OutputRow) => {
    if (filed && filed.spendable !== true) withheld(o, filed);
    o.updated_at = new Date(0); // EntityOutput.mergeExisting only applies a strictly newer row: the device's stays
    report.kept++;
  };
  /**
   * Not spendable, no link, in no basket, not change: nothing lists, sends or funds from it, even if a toolbox repair
   * later frees it. Kept (the row stays in the page), so the restore check still finds the outpoint on the device.
   */
  const quarantine = (o: OutputRow) => {
    withheld(o, o);
    o.spendable = false;
    o.spentBy = undefined;
    o.basketId = undefined;
    o.change = false;
    report.quarantined++;
  };
  const admitLater = (txid: string, vout: number) => {
    report.admissions.push({ kind: 'coin', txid, vout });
    report.queued++;
  };

  // Transactions the device already holds (review 16, F4; 16b, R3): their txid and raw bytes stay the device's. A move
  // between failed and not failed is the chain's to settle: the device's status stays and the backup's goes on the
  // admission list. A proven or completed transaction is never undone from a backup, and none is set to 'unfail' (a
  // re-check that restores its outputs on the chain's word alone).
  const keptTx = new Set<number>();
  for (const t of chunk.transactions ?? []) {
    if (!t) continue;
    let d = t.txid ? (await store.findTransactions({ partial: { userId, txid: t.txid } }))[0] : undefined;
    if (!d && t.reference) d = (await store.findTransactions({ partial: { userId, reference: t.reference } }))[0];
    if (!d) continue;
    const keepTx = () => {
      t.updated_at = new Date(0);
      t.provenTxId = undefined; // no "proof evidence" path around the time check (EntityTransaction.mergeExisting)
      t.noSendExpiryState = d.noSendExpiryState;
      if (typeof t.transactionId === 'number') keptTx.add(t.transactionId);
      report.keptTx++;
    };
    if (d.txid && t.txid && d.txid !== t.txid) {
      keepTx();
      continue;
    }
    if (d.rawTx?.length && t.rawTx?.length && hex(d.rawTx) !== hex(t.rawTx)) t.rawTx = d.rawTx;
    const txid = d.txid ?? t.txid;
    if (t.status === 'unfail' && d.status !== 'unfail') {
      keepTx();
      continue;
    }
    if (d.status === 'failed' && t.status !== undefined && t.status !== 'failed') {
      keepTx();
      if (txid) report.admissions.push({ kind: 'tx', txid, claim: t.status });
      continue;
    }
    const toFailed = t.status === 'failed' && d.status !== 'failed';
    const offCompleted = d.status === 'completed' && t.status !== undefined && t.status !== 'completed';
    const dropsProof = d.provenTxId != null && t.provenTxId == null && t.status !== undefined;
    if (toFailed || offCompleted || dropsProof) {
      keepTx();
      if (toFailed && !offCompleted && d.provenTxId == null && txid)
        report.admissions.push({ kind: 'tx', txid, claim: 'failed' });
    }
  }

  // A proof request is what the device's monitor fails a transaction by ('invalid' -> failed, which frees the coins
  // linked to it), and 'unfail' restores a failed one's outputs on the chain's word alone. Such a request, new to the
  // device, arrives as one to be checked again (R3): for a transaction the device holds or this page brings, and any
  // 'unfail'. A request the device has keeps its own status (EntityProvenTxReq.mergeExisting never changes it).
  const pageTxids = new Set((chunk.transactions ?? []).map((t) => t?.txid).filter((x): x is string => !!x));
  for (const q of chunk.provenTxReqs ?? []) {
    if (!q?.txid) continue;
    const status = String(q.status);
    if (!REQ_FAILED.has(status) && status !== 'unfail') continue;
    if (
      typeof store.findProvenTxReqs === 'function' &&
      (await store.findProvenTxReqs({ partial: { txid: q.txid } }))[0]
    )
      continue;
    if (
      status !== 'unfail' &&
      !pageTxids.has(q.txid) &&
      !(await store.findTransactions({ partial: { userId, txid: q.txid }, noRawTx: true }))[0]
    )
      continue;
    q.status = 'unknown';
    report.keptTx++;
  }

  /** The status a row's spender has once this page is merged: this page's row, unless it was kept; else the device's. */
  const spenderStatus = async (remoteTxId: number): Promise<string | undefined> => {
    const page = pageTx.get(remoteTxId);
    if (page && !keptTx.has(remoteTxId)) return page.status;
    return deviceTxStatus((await deviceTx(remoteTxId)).id);
  };

  /** Remote output id → this page's row and the device row the merge files it under. */
  const pageRows = new Map<number, { row: OutputRow; deviceOutputId?: number }>();
  for (const o of outputs) {
    if (!o || typeof o.vout !== 'number') continue;
    const tx = await deviceTx(o.transactionId);
    const filed =
      typeof tx.id === 'number'
        ? (await store.findOutputs({ partial: { userId, transactionId: tx.id, vout: o.vout } }))[0]
        : undefined;
    if (typeof o.outputId === 'number') pageRows.set(o.outputId, { row: o, deviceOutputId: filed?.outputId });
    if (filed) {
      // Rule 1: what the coin is and how it is signed for stays the device's.
      let changed = false;
      for (const k of PINNED) {
        const mine = (filed as Record<string, unknown>)[k];
        const theirs = (o as Record<string, unknown>)[k];
        const same = k === 'lockingScript' ? hex(mine as Bytes) === hex(theirs as Bytes) : mine === theirs;
        if (!same) {
          (o as Record<string, unknown>)[k] = mine;
          changed = true;
        }
      }
      if (changed) report.pinned++;
      if (o.txid && filed.txid && o.txid !== filed.txid) {
        keep(o, filed);
        continue;
      }
      // A row the merge won't apply changes nothing; one whose time can't be read is treated as newer.
      if (time(o.updated_at) <= time(filed.updated_at)) {
        // Only a row carrying the backup's own time (an admission given up on). A row the device lowered itself
        // (heal, already-off, orphan, hold) is newer and keeps its own both-lookups undo as the only way back (R1).
        // Equal times with a different spendable come from a merge that lowered the row on arrival (rule 3: StorageIdb
        // stamps every local write with its own time). Fix 7, 13 Nov 2026: the extension held the 1-sat BSV-21 coin
        // 2a5d3e03:0 not spendable at the phone's exact time while the phone held it spendable, and no later pull
        // asked the chain again. So in every pass (not only one from the start), a row in a basket seen again at the
        // same time goes back on the admission list: the chain decides, the same way on every device.
        if (
          (opts.requeueHeld || filed.basketId != null) &&
          time(o.updated_at) === time(filed.updated_at) &&
          o.spendable === true &&
          filed.spendable !== true &&
          filed.spentBy == null
        ) {
          const txid = filed.txid ?? tx.txid;
          if (txid) admitLater(txid, filed.vout);
        }
        continue;
      }
      // Rule 2: spendability only goes down. A coin the device holds as spent or not spendable stays as the device
      // has it; the backup's "spendable" is for the chain to settle (C1: no marker the backup can set decides it).
      if (o.spendable === true && (filed.spendable !== true || filed.spentBy != null)) {
        keep(o, filed);
        const txid = filed.txid ?? tx.txid; // a row that came without its txid (D1)
        if (txid) admitLater(txid, filed.vout);
        continue;
      }
      // A spend link is kept, never removed or moved: the toolbox frees a coin when its linked transaction fails, so
      // unlinking a coin the device's unsent payment spends (16c H2) or moving it to a transaction the backup then
      // fails would free it unchecked. Nor does a link go on a coin the device holds as not spendable (N1).
      if (filed.spentBy != null) {
        const to = o.spentBy != null ? (await deviceTx(o.spentBy)).id : undefined;
        if (to !== filed.spentBy) keep(o, filed);
      } else if (o.spentBy != null && filed.spendable !== true) {
        o.spentBy = undefined;
        report.linksDropped++;
      }
      continue;
    }
    // Rule 3: a row the device has never seen arrives not spendable.
    // A row pushed without its txid (the 30 Oct "A truthy value is required" rows) takes its transaction's (D1), and is
    // then checked against that transaction like any other.
    if (!o.txid && tx.txid) o.txid = tx.txid;
    const claimed = o.spendable === true;
    if (!claimed && o.spentBy != null) {
      // Linked to a completed transaction: spent for good (a completed transaction never fails). Any other link could
      // free it later without a check (N1: a backup's failed transaction with no proof request), so it goes.
      if ((await spenderStatus(o.spentBy)) === 'completed') continue;
      o.spentBy = undefined;
      report.linksDropped++;
    }
    const twin = o.txid ? (await store.findOutputs({ partial: { userId, txid: o.txid, vout: o.vout } }))[0] : undefined;
    if (twin || (tx.txid && o.txid && tx.txid !== o.txid) || !o.txid) {
      quarantine(o); // a second row for an outpoint the device files elsewhere, or a row at odds with its transaction
      continue;
    }
    const script = await scriptOf(o);
    if (!script || (await admissibleRow(v, o, script)) === 'refuse') {
      quarantine(o);
      continue;
    }
    if (claimed) {
      // Even the wallet's own coins are asked of the chain (review 16, F4d): a backup can hand back spent change.
      withheld(o, o);
      o.spendable = false;
      o.spentBy = undefined;
      admitLater(o.txid, o.vout);
    }
  }

  // Token tags (amt:, bsv21:, sym:, dec:) are where a send falls back to when a record has no amount or id: one
  // that would newly apply to an output must be borne out by that output's script, or it arrives deleted.
  // Tracking ids (id:<x>) are how a send, burn or listing loads "this" asset (limit 1): one id, one output (R2, C2).
  const outputOf = async (
    remoteId: number,
  ): Promise<{ script?: string; txid?: string | null; vout: number; deviceOutputId?: number } | undefined> => {
    const page = pageRows.get(remoteId);
    if (page) {
      const script = await scriptOf(page.row);
      return {
        script: script ?? undefined,
        txid: page.row.txid,
        vout: page.row.vout,
        deviceOutputId: page.deviceOutputId,
      };
    }
    const local = maps?.output?.idMap?.[String(remoteId)];
    if (typeof local !== 'number') return undefined;
    const [d] = await store.findOutputs({ partial: { userId, outputId: local } });
    return d ? { script: hex(d.lockingScript), txid: d.txid, vout: d.vout, deviceOutputId: local } : undefined;
  };
  const tagNameOf = async (remoteTagId: number): Promise<string | undefined> => {
    const page = chunk.outputTags?.find((t) => t.outputTagId === remoteTagId)?.tag;
    if (typeof page === 'string') return page;
    const local = maps?.outputTag?.idMap?.[String(remoteTagId)];
    if (typeof local !== 'number' || typeof store.findOutputTags !== 'function') return undefined;
    return (await store.findOutputTags({ partial: { outputTagId: local } }))[0]?.tag;
  };
  const deviceTagId = async (remoteTagId: number, tag: string): Promise<number | undefined> => {
    const local = maps?.outputTag?.idMap?.[String(remoteTagId)];
    if (typeof local === 'number') return local;
    if (typeof store.findOutputTags !== 'function') return undefined;
    return (await store.findOutputTags({ partial: { userId, tag } }))[0]?.outputTagId;
  };
  const deviceMap = async (deviceOutputId: number | undefined, localTag: number | undefined) =>
    deviceOutputId !== undefined && localTag !== undefined && typeof store.findOutputTagMaps === 'function'
      ? (await store.findOutputTagMaps({ partial: { outputId: deviceOutputId, outputTagId: localTag } }))[0]
      : undefined;
  const pageIds = new Map<string, number>(); // id tag (lowercase) -> remote output it went to on this page
  const pageIdOf = new Map<number, string>(); // remote output -> the id tag it got on this page
  /**
   * Would this id tag point at a second asset? Another device output carries it, the target already has a different
   * id, or this page gives it twice. Deleted maps count (C2): the device store's tag queries ignore isDeleted
   * (StorageIdb.outputMatchesTags), so a deleted `id:` map still loads by that id.
   */
  const idTagTaken = async (
    tag: string,
    remoteOutputId: number,
    deviceOutputId: number | undefined,
    localTag: number | undefined,
  ): Promise<boolean> => {
    const pageOwner = pageIds.get(tag);
    const pageTag = pageIdOf.get(remoteOutputId);
    if ((pageOwner !== undefined && pageOwner !== remoteOutputId) || (pageTag !== undefined && pageTag !== tag))
      return true;
    if (typeof store.findOutputTagMaps === 'function') {
      if (localTag !== undefined) {
        const holders = await store.findOutputTagMaps({ partial: { outputTagId: localTag } });
        if (holders.some((h) => h.outputId !== deviceOutputId)) return true;
      }
      if (deviceOutputId !== undefined && typeof store.findOutputTags === 'function') {
        for (const m of await store.findOutputTagMaps({ partial: { outputId: deviceOutputId } })) {
          if (typeof m.outputTagId !== 'number' || m.outputTagId === localTag) continue;
          const name = (await store.findOutputTags({ partial: { outputTagId: m.outputTagId } }))[0]?.tag;
          if (name && ID_TAG.test(name) && name.toLowerCase() !== tag) return true;
        }
      }
    }
    pageIds.set(tag, remoteOutputId);
    pageIdOf.set(remoteOutputId, tag);
    return false;
  };
  /**
   * Take no part of this tag map. A soft delete is not enough: the device store's tag queries ignore isDeleted
   * (StorageIdb.outputMatchesTags), so a deleted `id:` map still loads by that id. A map whose tag id the sync can't
   * map is skipped by the (patched) toolbox merge, and the row stays in the page, so paging is unchanged.
   */
  const dropTagMap = (tm: TagMapRow) => {
    tm.outputTagId = UNMAPPED_ID;
    tm.isDeleted = true;
    report.tagsDropped++;
  };
  for (const tm of chunk.outputTagMaps ?? []) {
    if (!tm || typeof tm.outputTagId !== 'number' || typeof tm.outputId !== 'number') continue;
    const tag = await tagNameOf(tm.outputTagId);
    if (tm.isDeleted === true) {
      // A tracking id comes off an asset only on this device (C2): taken off from a backup, it could then be put on
      // another NFT, while the old map still matches every load by that id. Nothing honest removes one.
      if (tag !== undefined && ID_TAG.test(tag)) {
        const out = await outputOf(tm.outputId);
        const had = await deviceMap(out?.deviceOutputId, await deviceTagId(tm.outputTagId, tag));
        if (had && had.isDeleted !== true) dropTagMap(tm);
      }
      continue;
    }
    if (tag === undefined) {
      dropTagMap(tm); // a tag the device can't name: never a live token tag or id
      continue;
    }
    const isId = ID_TAG.test(tag);
    if (!isId && !TOKEN_TAG.test(tag)) continue;
    const out = await outputOf(tm.outputId);
    const localTag = await deviceTagId(tm.outputTagId, tag);
    if (await deviceMap(out?.deviceOutputId, localTag)) continue; // this pair is already on the device
    const refuse = isId
      ? await idTagTaken(tag.toLowerCase(), tm.outputId, out?.deviceOutputId, localTag)
      : !tagAgrees(tag, out?.script ? tokenFacts(out.script, out.txid, out.vout) : null);
    if (refuse) dropTagMap(tm);
  }
  if (
    report.kept ||
    report.quarantined ||
    report.queued ||
    report.tagsDropped ||
    report.linksDropped ||
    report.keptTx ||
    report.admissions.length
  )
    v.log?.(
      `[inbound-sync] backup page: kept ${report.kept} device row(s) and ${report.keptTx} transaction(s), quarantined ${report.quarantined} new row(s), ${report.admissions.length} for the chain to settle, dropped ${report.linksDropped} spend link(s) and ${report.tagsDropped} tag(s)`,
    );
  return report;
}

// ── the admission list: this device's own, never written by a sync ──

/** A coin a backup says is spendable, or a transaction status only the chain can settle, waiting on this device. */
export type PendingAdmission = Admission & {
  key: string;
  identityKey: string;
  firstAt: number;
  nextAt: number;
  tries: number;
  /** When the chain first said this coin is spent: asked once more an hour later (a mempool spend can be dropped). */
  spentAt?: number;
  /**
   * What the last wait was for: 'row' when this device had no row for it yet (its page not merged), else 'other'.
   * Missing on entries written before 6 Nov 2026.
   */
  waitingFor?: 'row' | 'other';
};

export type AdmissionList = {
  /**
   * Add these. An entry already there keeps its first time; one that waited for its row is due again at once with its
   * tries reset: the page carrying it again is news its back-off never saw (6 Nov 2026: a coin whose row had not merged
   * yet kept a 4-hour wait after the row came). One waiting on the chain keeps its back-off. A transaction's claim is
   * updated.
   */
  add(identityKey: string, items: Admission[], now: number, opts?: { delayMs?: number }): Promise<void>;
  list(identityKey: string): Promise<PendingAdmission[]>;
  put(e: PendingAdmission): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * Small numbers this device keeps per account beside the list (fix 7 review): the held-token check's cursor, and when
   * each coin was last refused. In a store of their own, so the list's entries are never mixed with them.
   */
  notes(identityKey: string): Promise<Map<string, number>>;
  setNote(identityKey: string, name: string, value: number | undefined): Promise<void>;
};

const admissionKey = (identityKey: string, a: Admission) =>
  a.kind === 'coin' ? `${identityKey}|coin|${a.txid}.${a.vout}` : `${identityKey}|tx|${a.txid}`;

/** Its own IndexedDB database per device store: the toolbox sync only writes the wallet's own tables. */
export const admissionDbName = (storageIdentityKey: string) => `bwx-inbound-admission-${storageIdentityKey}`;
const ADMISSION_STORE = 'pending';
const NOTES_STORE = 'notes';

const idbRequest = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function idbAdmissionList(name: string): AdmissionList {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name, 2);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(ADMISSION_STORE))
          r.result.createObjectStore(ADMISSION_STORE, { keyPath: 'key' });
        if (!r.result.objectStoreNames.contains(NOTES_STORE))
          r.result.createObjectStore(NOTES_STORE, { keyPath: 'key' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }).catch((e: unknown) => {
      opened = undefined;
      throw e;
    }));
  const withStore = async <T>(
    mode: IDBTransactionMode,
    body: (s: IDBObjectStore) => Promise<T>,
    storeName: string = ADMISSION_STORE,
  ): Promise<T> => {
    const t = (await db()).transaction(storeName, mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
    const out = await body(t.objectStore(storeName));
    await done;
    return out;
  };
  return {
    add: (identityKey, items, now, opts) =>
      withStore('readwrite', async (s) => {
        for (const a of items) {
          const key = admissionKey(identityKey, a);
          const had = (await idbRequest(s.get(key))) as PendingAdmission | undefined;
          // Only an entry that waited for its row (or one from before the reason was kept) starts again: one waiting on
          // the chain keeps its back-off, so WhatsOnChain is not asked again early (review, 6 Nov 2026).
          const fresh = had && (had.waitingFor === undefined || had.waitingFor === 'row');
          s.put(
            had
              ? {
                  ...had,
                  ...(a.kind === 'tx' ? { claim: a.claim } : {}),
                  ...(fresh ? { tries: 0, nextAt: Math.min(had.nextAt, now) } : {}),
                }
              : { ...a, key, identityKey, firstAt: now, nextAt: now + Math.max(0, opts?.delayMs ?? 0), tries: 0 },
          );
        }
      }),
    list: (identityKey) =>
      withStore('readonly', async (s) =>
        ((await idbRequest(s.getAll())) as PendingAdmission[]).filter((e) => e.identityKey === identityKey),
      ),
    put: (e) => withStore('readwrite', async (s) => void (await idbRequest(s.put(e)))),
    remove: (key) => withStore('readwrite', async (s) => void (await idbRequest(s.delete(key)))),
    notes: (identityKey) =>
      withStore(
        'readonly',
        async (s) => {
          const out = new Map<string, number>();
          const prefix = `${identityKey}|`;
          for (const n of (await idbRequest(s.getAll())) as { key: string; value: number }[])
            if (n.key.startsWith(prefix)) out.set(n.key.slice(prefix.length), n.value);
          return out;
        },
        NOTES_STORE,
      ),
    setNote: (identityKey, name, value) =>
      withStore(
        'readwrite',
        async (s) => {
          const key = `${identityKey}|${name}`;
          if (value === undefined) await idbRequest(s.delete(key));
          else await idbRequest(s.put({ key, value }));
        },
        NOTES_STORE,
      ),
  };
}

const lists = new Map<string, AdmissionList>();
/** The admission list of the device store with this storage identity key. */
export function admissionListFor(storageIdentityKey: string): AdmissionList {
  let l = lists.get(storageIdentityKey);
  if (!l) lists.set(storageIdentityKey, (l = idbAdmissionList(admissionDbName(storageIdentityKey))));
  return l;
}

/** What is waiting on this device for this account (Settings diagnostics, tests). */
export const pendingAdmissions = (store: { getSettings(): { storageIdentityKey: string } }, identityKey: string) =>
  admissionListFor(store.getSettings().storageIdentityKey).list(identityKey);

// ── admitPending: the only way a coin from another store becomes spendable here ──

type Trx = unknown;
/** The device store calls admitPending needs (StorageIdb). */
export type AdmitStore = Omit<DeviceStore, 'getSettings'> & {
  getSettings(): { storageIdentityKey: string };
  transaction<T>(scope: (trx: Trx) => Promise<T>): Promise<T>;
  updateOutput(id: number, update: Record<string, unknown>, trx?: Trx): Promise<unknown>;
  updateTransaction(id: number, update: Record<string, unknown>, trx?: Trx): Promise<unknown>;
  findOutputBaskets?(a: { partial: Record<string, unknown> }): Promise<{ basketId?: number; name?: string }[]>;
};

export type AdmitReport = {
  /** Coins made spendable. */
  admitted: number;
  /** Transaction statuses settled (failed on the chain's word, or a mined payment repaired). */
  applied: number;
  /** Entries dropped: the row failed a check, the chain says spent or on chain, or nothing is left to settle. */
  refused: number;
  /** Entries asked about and left for later. */
  waiting: number;
  /**
   * Entries given up on after 3 days of waiting on THIS device's own state (a spender of its own still in flight, an
   * output of a transaction it holds failed with nothing queued to settle it). Never one waiting on the chain (D2).
   */
  retired: number;
  /** The run stopped at an unclear chain answer: the rest waits for the next run. */
  deferred: boolean;
  /** Entries still on the list after this run. */
  left: number;
  /** Of those, transactions the backup counts as actions that this device still holds as failed (restore check). */
  pendingActions: number;
  /** When the next entry is due (ms), if any are left: the caller runs again then (D2). */
  nextAt?: number;
};

/** Entries one run looks at. Each costs at most three chain calls, and an unclear answer ends the run. */
const RUN_LIMIT = 25;
const FIRST_WAIT_MS = 60_000;
const MAX_WAIT_MS = 6 * 3_600_000;
const SPENT_RECHECK_MS = 3_600_000;
const LOCAL_GIVE_UP_MS = 3 * 24 * 3_600_000;
/**
 * Inside a prompt window (opts.prompt): an entry that arrived with that pull is asked again after this, not after the
 * 1-minute-doubling wait, and its tries are not counted. Owner, 5 Nov 2026: the phone's watcher sees the extension sweep
 * a payment and pulls at once; the sweep's change must then show within seconds, not minutes. Every check is the same.
 */
export const PROMPT_RETRY_MS = 5_000;
/** A device transaction that may already be on the network: sent, or being sent, by this device's monitor. */
const BROADCAST = new Set(['sending', 'unproven', 'unprocessed']);

const runs = new Map<string, Promise<unknown>>();
/** The last entry whose row each list's pre-pass looked up, by store and account: the next run goes on after it. */
const lastLooked = new Map<string, string>();

/**
 * Work through this device's admission list for this account, outside the storage locks (C5): reads, then the
 * chain's word, then one IndexedDB transaction that writes only if the row is still as it was read. Runs one at a
 * time per store and account. Transactions first, so a coin whose spender another device aborted is free (C3).
 */
export type AdmitOptions = {
  now?: () => number;
  limit?: number;
  /** Entries first listed at or after `from` are retried every PROMPT_RETRY_MS until `until` (a watcher's pull). */
  prompt?: { from: number; until: number };
};

export function admitPending(
  store: AdmitStore,
  identityKey: string,
  v: InboundVerifier,
  opts: AdmitOptions = {},
): Promise<AdmitReport> {
  const key = `${store.getSettings().storageIdentityKey}|${identityKey}`;
  const run = (runs.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => admitOnce(store, identityKey, v, opts));
  runs.set(key, run);
  run.then(
    () => runs.get(key) === run && runs.delete(key),
    () => runs.get(key) === run && runs.delete(key),
  );
  return run;
}

type Waiting = 'chain' | 'local';

/**
 * Outpoints a transaction of this device's not yet settled on the network spends (fix 7 review, finding 1): every
 * transaction in an IN_FLIGHT state, read from its own bytes. Such a coin may have reached this device with its spend
 * link dropped (rule 3 and N1 drop a link to a payment that isn't completed), so its row alone says nothing. A
 * transaction with no bytes yet (unsigned) reserves every output of each transaction its input BEEF carries.
 */
export async function reservedByInFlight(
  store: Pick<DeviceStore, 'findTransactions'>,
  userId: number,
): Promise<{ outpoints: Set<string>; txids: Set<string> }> {
  const outpoints = new Set<string>();
  const txids = new Set<string>();
  for (const status of IN_FLIGHT) {
    for (const t of await store.findTransactions({ partial: { userId, status } })) {
      let read = false;
      if (t.rawTx?.length) {
        try {
          for (const i of Transaction.fromBinary(Array.from(t.rawTx)).inputs)
            if (i.sourceTXID) outpoints.add(`${i.sourceTXID.toLowerCase()}.${i.sourceOutputIndex}`);
          read = true;
        } catch {
          // unreadable bytes: fall back to the input BEEF
        }
      }
      if (read) continue;
      if (t.inputBEEF?.length) {
        try {
          for (const b of Beef.fromBinary(Array.from(t.inputBEEF)).txs) txids.add(b.txid.toLowerCase());
        } catch {
          // nothing readable: nothing reserved by it
        }
      }
    }
  }
  return { outpoints, txids };
}
const isReserved = (r: { outpoints: Set<string>; txids: Set<string> }, txid: string, vout: number) =>
  r.outpoints.has(`${txid.toLowerCase()}.${vout}`) || r.txids.has(txid.toLowerCase());

/** This device holds a row for the entry: its transaction (a tx entry), or that transaction's output (a coin). */
async function hasRow(store: AdmitStore, userId: number, e: PendingAdmission): Promise<boolean> {
  const [t] = await store.findTransactions({ partial: { userId, txid: e.txid }, noRawTx: true });
  if (e.kind === 'tx') return !!t && typeof t.transactionId === 'number';
  const rows =
    t && typeof t.transactionId === 'number'
      ? await store.findOutputs({ partial: { userId, transactionId: t.transactionId, vout: e.vout } })
      : await store.findOutputs({ partial: { userId, txid: e.txid, vout: e.vout } });
  return rows.some((r) => typeof r.outputId === 'number');
}

async function admitOnce(
  store: AdmitStore,
  identityKey: string,
  v: InboundVerifier,
  opts: AdmitOptions,
): Promise<AdmitReport> {
  const now = opts.now?.() ?? Date.now();
  const list = admissionListFor(store.getSettings().storageIdentityKey);
  const report: AdmitReport = {
    admitted: 0,
    applied: 0,
    refused: 0,
    waiting: 0,
    retired: 0,
    deferred: false,
    left: 0,
    pendingActions: 0,
  };
  const count = async () => {
    const left = await list.list(identityKey);
    report.left = left.length;
    report.pendingActions = left.filter((e) => e.kind === 'tx' && e.claim !== 'failed').length;
    report.nextAt = left.length ? Math.min(...left.map((e) => e.nextAt)) : undefined;
    return report;
  };
  const user = (await store.findUsers({ partial: { identityKey } }))[0];
  if (!user) return count();
  const userId = user.userId;
  const all = await list.list(identityKey);
  // An entry waiting for its row (its page not merged then) is due once the row is here, its back-off reset: the
  // back-off counted tries that could never succeed (6 Nov 2026: the phone's f8e91f14:0 and a1972e3f:0, 12.1M sats, held
  // not spendable for hours after the deep pull merged their rows). Entries from before the reason was kept are looked
  // at once. Only reads of this device's store here (a bounded number per run); every check still runs below.
  // The look-ups go round the list (by key, starting after the last one looked at), so a long list is covered over
  // a few runs rather than its first entries every time.
  const candidates = all
    .filter((e) => e.nextAt > now && e.tries > 0 && (e.waitingFor === undefined || e.waitingFor === 'row'))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const key = `${store.getSettings().storageIdentityKey}|${identityKey}`;
  const last = lastLooked.get(key);
  const start =
    last === undefined
      ? 0
      : Math.max(
          0,
          candidates.findIndex((e) => e.key > last),
        );
  const turn = [...candidates.slice(start), ...candidates.slice(0, start)].slice(0, 4 * (opts.limit ?? RUN_LIMIT));
  for (const e of turn) {
    lastLooked.set(key, e.key);
    if (await hasRow(store, userId, e)) {
      e.nextAt = now;
      e.tries = 0;
    }
  }
  const due = all
    .filter((e) => e.nextAt <= now)
    .sort((a, b) => (a.kind !== b.kind ? (a.kind === 'tx' ? -1 : 1) : a.nextAt - b.nextAt))
    .slice(0, opts.limit ?? RUN_LIMIT);
  /** Transactions still to be settled: a coin of one of them waits as long as its transaction does. */
  const txQueued = new Set(all.filter((e) => e.kind === 'tx').map((e) => e.txid));

  const finish = async (e: PendingAdmission, outcome: 'admitted' | 'applied' | 'refused') => {
    await list.remove(e.key);
    if (e.kind === 'tx') txQueued.delete(e.txid);
    report[outcome]++;
  };
  /**
   * Ask again later. An entry waiting on the chain is never given up on (D2): its row passed every local check, and
   * an honest coin must come back however long WhatsOnChain and the 1Sat stack take. One waiting on this device's own
   * state is dropped after 3 days, its coin left not spendable (the device's own repairs see it).
   */
  const wait = async (e: PendingAdmission, why: Waiting, at?: number, waitingFor: 'row' | 'other' = 'other') => {
    if (why === 'local' && now - e.firstAt >= LOCAL_GIVE_UP_MS) {
      await list.remove(e.key);
      report.retired++;
      v.log?.(`[inbound-sync] gave up on ${e.kind} ${e.txid}${e.kind === 'coin' ? `.${e.vout}` : ''}: left as is`);
      return;
    }
    const prompt = at === undefined && !!opts.prompt && e.firstAt >= opts.prompt.from && now < opts.prompt.until;
    await list.put(
      prompt
        ? { ...e, waitingFor, nextAt: now + PROMPT_RETRY_MS }
        : {
            ...e,
            waitingFor,
            tries: e.tries + 1,
            nextAt: at ?? now + Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.min(e.tries, 20)),
          },
    );
    report.waiting++;
  };
  const cache = <T>(ask: (txid: string) => Promise<T>) => {
    const m = new Map<string, Promise<T>>();
    return (txid: string) => {
      if (!m.has(txid)) m.set(txid, ask(txid));
      return m.get(txid)!;
    };
  };
  const known = cache((txid) =>
    v.txKnown ? v.txKnown(txid).catch((): 'unclear' => 'unclear') : Promise.resolve<'unknown'>('unknown'),
  );
  const chainTx = cache((txid) =>
    v.chainTx
      ? v.chainTx(txid).catch((): ChainTx => ({ state: 'unclear' }))
      : Promise.resolve<ChainTx>({ state: 'unclear' }),
  );
  const txStatus = async (transactionId: number | null | undefined) =>
    typeof transactionId === 'number'
      ? (await store.findTransactions({ partial: { userId, transactionId }, noRawTx: true }))[0]?.status
      : undefined;
  /**
   * The raw transaction for `txid` the device holds: its proof's or request's bytes, else its transaction row's. Any
   * bytes that hash to the txid are that transaction, wherever they came from; bytes that don't are null (refused).
   */
  const deviceTx = async (txid: string) => {
    const r =
      typeof store.getProvenOrRawTx === 'function'
        ? await store.getProvenOrRawTx(txid).catch(() => undefined)
        : undefined;
    let raw = r?.rawTx ?? r?.proven?.rawTx;
    if (!raw?.length) raw = (await store.findTransactions({ partial: { userId, txid } }))[0]?.rawTx ?? undefined;
    return raw?.length ? (parseRawTx(raw, txid) ?? null) : undefined;
  };

  /**
   * The chain has a transaction this device holds as failed (C4, D6): not failed. Its status becomes 'unproven' (the
   * monitor proves it from there) and the coins it spends are marked spent by it, all only if it is still as read.
   */
  const settleMined = async (t: TxRow, txid: string) => {
    let tx = await deviceTx(txid);
    if (!tx) {
      const c = await chainTx(txid);
      tx = c.state === 'found' ? parseRawTx(c.rawTx, txid) : undefined;
    }
    return store.transaction(async (trx) => {
      const [cur] = await store.findTransactions({
        partial: { userId, transactionId: t.transactionId },
        noRawTx: true,
        trx,
      });
      if (!cur || cur.status !== 'failed' || (cur.provenTxId ?? null) !== (t.provenTxId ?? null)) return false;
      await store.updateTransaction(t.transactionId!, { status: 'unproven' }, trx);
      for (const input of tx?.inputs ?? []) {
        if (!input.sourceTXID) continue;
        const [spent] = await store.findOutputs({
          partial: { userId, txid: input.sourceTXID, vout: input.sourceOutputIndex },
          trx,
        });
        if (spent?.outputId !== undefined && (spent.spendable === true || spent.spentBy == null))
          await store.updateOutput(spent.outputId, { spendable: false, spentBy: t.transactionId }, trx);
      }
      return true;
    });
  };
  /** Set a transaction's status if it is still as it was read. */
  const setStatus = (t: TxRow, status: string) =>
    store.transaction(async (trx) => {
      const [cur] = await store.findTransactions({
        partial: { userId, transactionId: t.transactionId },
        noRawTx: true,
        trx,
      });
      if (!cur || cur.status !== t.status || (cur.provenTxId ?? null) !== (t.provenTxId ?? null)) return false;
      await store.updateTransaction(t.transactionId!, { status }, trx);
      return true;
    });
  /** This device is tracking the transaction itself: its own proof request, still live (not failed). */
  const ownRequestLive = async (txid: string) =>
    typeof store.findProvenTxReqs === 'function' &&
    (await store.findProvenTxReqs({ partial: { txid } })).some((q) => !REQ_FAILED.has(String(q.status)));

  const settleTx = async (e: PendingAdmission) => {
    const [t] = await store.findTransactions({ partial: { userId, txid: e.txid }, noRawTx: true });
    // Not there (yet): its page may still be merging, or the app was stopped mid-merge (D3). Asked again shortly.
    if (!t || typeof t.transactionId !== 'number') return wait(e, 'local', undefined, 'row');
    const toFailed = e.claim === 'failed';
    if (toFailed ? t.status === 'failed' || t.status === 'completed' || t.provenTxId != null : t.status !== 'failed')
      return finish(e, 'refused'); // settled already, or a transaction never undone from a backup
    // This device's own payment, sent or being sent and still tracked by its monitor: its monitor decides, not a
    // backup on WhatsOnChain's word (D7: WoC can take minutes to index a broadcast).
    if (toFailed && BROADCAST.has(String(t.status)) && (await ownRequestLive(e.txid))) return finish(e, 'refused');
    const k = await known(e.txid);
    if (k === 'unclear') {
      report.deferred = true;
      return wait(e, 'chain');
    }
    // To failed: only when the chain has never seen it (a payment another device saw refused or aborted).
    if (toFailed)
      return k === 'unknown' && (await setStatus(t, 'failed')) ? finish(e, 'applied') : finish(e, 'refused');
    // From failed: only once the chain has it, through the wallet's own mined-payment repair when there is one.
    if (k !== 'known') return wait(e, 'chain');
    if (v.recover) {
      const r = await v.recover(e.txid).catch((): 'wait' => 'wait');
      if (r === 'wait') return wait(e, 'chain');
      if (r === 'restored') return finish(e, 'applied');
      // Nothing of ours to restore (its change spent elsewhere, or none): the chain still has it, so not failed (D6).
    }
    return (await settleMined(t, e.txid)) ? finish(e, 'applied') : finish(e, 'refused');
  };

  /** The device's row for a coin entry: by its transaction and vout (a row may have no txid: D1), else by outpoint. */
  const coinRow = async (e: PendingAdmission): Promise<OutputRow | 'many' | undefined> => {
    const [t] = await store.findTransactions({ partial: { userId, txid: e.txid }, noRawTx: true });
    const rows =
      t && typeof t.transactionId === 'number'
        ? await store.findOutputs({ partial: { userId, transactionId: t.transactionId, vout: e.vout } })
        : await store.findOutputs({ partial: { userId, txid: e.txid, vout: e.vout } });
    return rows.length > 1 ? 'many' : rows[0];
  };
  const sameOutput = (out: { lockingScript: Script; satoshis?: number } | undefined, row: OutputRow, script: string) =>
    !!out &&
    out.lockingScript.toHex().toLowerCase() === script &&
    (typeof row.satoshis !== 'number' || out.satoshis === row.satoshis);

  /**
   * A coin entry dropped, its row left not spendable: why, in the log (fix 7: the extension's 2a5d3e03:0 left no
   * trace), and noted, so the held-token check doesn't list it again for REFUSED_SKIP_MS (fix 7 review, finding 2).
   */
  const refuse = async (e: PendingAdmission, why: string) => {
    v.log?.(`[inbound-sync] ${e.txid}.${e.vout ?? 0} not admitted: ${why}`);
    await list.setNote(identityKey, `refused|${e.txid}.${e.vout ?? 0}`, now).catch(() => undefined);
    return finish(e, 'refused');
  };
  let reserved: Promise<{ outpoints: Set<string>; txids: Set<string> }> | undefined;
  const settleCoin = async (e: PendingAdmission) => {
    const vout = e.vout ?? 0;
    const row = await coinRow(e);
    if (row === 'many') return refuse(e, 'more than one row for the outpoint');
    // Not there (yet): its page may still be merging (D3). Asked again shortly.
    if (!row || typeof row.outputId !== 'number') return wait(e, 'local', undefined, 'row');
    if (row.spendable === true) return finish(e, 'refused');
    // In no basket: a quarantined row, or not the wallet's coin.
    if (row.basketId == null) return refuse(e, 'in no basket');
    // An output of a transaction this device holds as failed: WhatsOnChain's 404 is no proof (F4). It waits as long as
    // that transaction is queued to be settled.
    if ((await txStatus(row.transactionId)) === 'failed') return wait(e, txQueued.has(e.txid) ? 'chain' : 'local');
    // Spent by a payment of this device's not yet on the network (R5, C7): the chain hasn't seen that spend.
    const spender = row.spentBy != null ? await txStatus(row.spentBy) : undefined;
    if (spender !== undefined && IN_FLIGHT.has(spender)) return wait(e, 'local');
    // …or by one whose link this row lost on its way here (fix 7 review, finding 1): read from that payment's bytes.
    reserved ??= reservedByInFlight(store, userId);
    if (isReserved(await reserved, e.txid, vout)) return wait(e, 'local');
    const script = hex(row.lockingScript);
    if (!script) return refuse(e, 'no locking script');
    if ((await admissibleRow(v, row, script)) === 'refuse')
      return refuse(e, "its record or key doesn't match its script"); // C1, D4
    // What the output really locks and holds (D5): the device's raw transaction, else the chain's. Never the row's word.
    const local = await deviceTx(e.txid);
    if (local === null) return refuse(e, "the stored transaction doesn't hash to its txid");
    if (local && !sameOutput(local.outputs[vout], row, script))
      return refuse(e, 'the row differs from its transaction');
    const st = await v.spent(`${e.txid}.${vout}`).catch((): SpendState => ({ state: 'unclear' }));
    if (st.state === 'unclear') {
      report.deferred = true;
      return wait(e, 'chain');
    }
    if (st.state === 'spent') {
      if (e.spentAt !== undefined && now - e.spentAt >= SPENT_RECHECK_MS) return refuse(e, 'the chain says spent');
      return wait({ ...e, spentAt: e.spentAt ?? now }, 'chain', (e.spentAt ?? now) + SPENT_RECHECK_MS);
    }
    if (!local) {
      const c = await chainTx(e.txid);
      if (c.state === 'unclear') report.deferred = true;
      if (c.state !== 'found') return wait(e, 'chain');
      if (!sameOutput(parseRawTx(c.rawTx, e.txid)?.outputs[vout], row, script))
        return refuse(e, "the chain's transaction differs from the row");
    } else {
      // WhatsOnChain answers /spent with 404 for an outpoint it has never seen (F4b): unspent only for a known one.
      const k = await known(e.txid);
      if (k === 'unclear') report.deferred = true;
      if (k !== 'known') return wait(e, 'chain');
    }
    // A BSV-21 coin the chain calls unspent: the token overlay is asked last (fix 7). Only its 'spent' holds the coin
    // back, asked again later (never given up on); an error, 'unknown', 'queued' or an unfunded overlay never does.
    const token = tokenFacts(script, e.txid, vout);
    if (token?.kind === 'bsv21' && token.id && v.tokenState) {
      const said = await v.tokenState(token.id, `${e.txid}.${vout}`).catch(() => undefined);
      if (tokenOverlayVerdict(said) === 'spent') return wait(e, 'chain');
    }
    const ok = await store.transaction(async (trx) => {
      const [cur] = await store.findOutputs({ partial: { userId, outputId: row.outputId }, trx });
      if (
        !cur ||
        cur.spendable === true ||
        (cur.spentBy ?? null) !== (row.spentBy ?? null) ||
        hex(cur.lockingScript) !== script
      )
        return false;
      // A row that came without its txid gets it (D1), as nullTxidRepair gives the device's own.
      await store.updateOutput(
        row.outputId!,
        { spendable: true, spentBy: undefined, ...(cur.txid ? {} : { txid: e.txid }) },
        trx,
      );
      return true;
    });
    return finish(e, ok ? 'admitted' : 'refused');
  };

  for (const e of due) {
    if (report.deferred) break;
    await (e.kind === 'tx' ? settleTx(e) : settleCoin(e));
  }
  if (report.admitted || report.applied || report.retired)
    v.log?.(
      `[inbound-sync] admitted ${report.admitted} coin(s), settled ${report.applied} transaction(s), gave up on ${report.retired}`,
    );
  return count();
}

// ── token coins held not spendable: asked of the chain again (fix 7, 13 Nov 2026) ──

/**
 * What the token overlay's answer about one coin means for its spendability. The overlay
 * (POST /bsv21/:tokenId/outputs/status) answers valid, spent, queued or unknown; a lookup can also fail, time out, or
 * find the token's overlay not funded ("not-active"). Only 'spent' is a verdict against the coin. 'valid' and 'queued'
 * are for it. Everything else (unknown: never submitted, or not indexed yet; an error; an unfunded or unreachable
 * overlay; a missing answer) is no verdict at all, and never holds a coin back or takes one away.
 */
export function tokenOverlayVerdict(state: unknown): 'spent' | 'valid' | 'unclear' {
  const s = typeof state === 'string' ? state.toLowerCase() : '';
  if (s === 'spent') return 'spent';
  if (s === 'valid' || s === 'queued') return 'valid';
  return 'unclear';
}

/** The wallet's token baskets: 'bsv21' (@1sat/types BSV21_BASKET) and its legacy name (services/legacyBaskets.ts). */
export const TOKEN_BASKETS = ['bsv21', 'p 1sat bsv21'];
/** Transactions whose outputs can be on the chain now: a coin of any other is left to its own transaction's checks. */
const SETTLED_TX = new Set(['completed', 'unproven']);
/** A coin admission refused is not listed again by the held-token check for this long. */
export const REFUSED_SKIP_MS = 7 * 24 * 3_600_000;
/**
 * Entries the held-token check lists wait this long first, so a pull's own entries (due at once, or every few seconds
 * in a prompt window) and fresh sweep change are asked about before them (fix 7 review, finding 3).
 */
export const HELD_TOKEN_DELAY_MS = 60_000;

/**
 * Token coins this device holds as not spendable with no spend recorded, in a token basket, of a transaction that is
 * completed or unproven, go on the admission list (fix 7). The extension held the 1-sat BSV-21 coin 2a5d3e03:0 (unspent,
 * paid to the account's primary address) not spendable while the phone held the same row spendable: the row arrived
 * through the backup merge at the phone's time (most likely: equal times can only come from a merge), lowered on
 * arrival (rule 3), and its admission entry was gone, so no later pull asked the chain again. admitPending then decides
 * every one exactly as it decides a backup's coin: the row must match its raw transaction and pass the record checks,
 * no payment of this device's not yet settled may spend it, the chain must know its transaction and call it unspent
 * (WhatsOnChain, then the 1Sat stack), and the token overlay must not call it spent. A coin the chain calls spent stays
 * not spendable; one it can't answer for waits. Lowering still travels by sync (rule 2), raising never does: each
 * device asks the chain itself, so both arrive at the chain's answer.
 *
 * Never listed: a coin linked to a spending transaction (spentBy: the toolbox frees it if that payment fails), one an
 * in-flight transaction of this device spends (its link may have been dropped on the way here), and one refused in
 * the last REFUSED_SKIP_MS. At most `limit` a run, going round the rows by output id from a cursor kept beside the list,
 * so dead rows can't take every slot for ever. Entries already on the list keep their back-off; new ones wait
 * HELD_TOKEN_DELAY_MS. Returns how many coins were listed (new or already waiting).
 */
export async function requeueHeldTokenCoins(
  store: AdmitStore,
  identityKey: string,
  opts: { baskets?: string[]; now?: () => number; limit?: number } = {},
): Promise<number> {
  const user = (await store.findUsers({ partial: { identityKey } }))[0];
  if (!user || typeof store.findOutputBaskets !== 'function') return 0;
  const userId = user.userId;
  const now = opts.now?.() ?? Date.now();
  const limit = Math.max(1, opts.limit ?? 200);
  const list = admissionListFor(store.getSettings().storageIdentityKey);
  const notes = await list.notes(identityKey);
  const reserved = await reservedByInFlight(store, userId);
  const statusOf = new Map<number, string | undefined>();
  const candidates: (OutputRow & { outputId: number; txid: string; transactionId: number })[] = [];
  for (const name of opts.baskets ?? TOKEN_BASKETS) {
    const basket = (await store.findOutputBaskets({ partial: { userId, name } }))[0];
    if (typeof basket?.basketId !== 'number') continue;
    for (const r of await store.findOutputs({ partial: { userId, basketId: basket.basketId, spendable: false } })) {
      if (r.spendable === true || r.spentBy != null) continue;
      if (typeof r.outputId !== 'number' || typeof r.transactionId !== 'number' || !r.txid) continue;
      if (isReserved(reserved, r.txid, r.vout)) continue;
      const refusedAt = notes.get(`refused|${r.txid}.${r.vout}`);
      if (refusedAt !== undefined && now - refusedAt < REFUSED_SKIP_MS) continue;
      candidates.push(r as never);
    }
  }
  candidates.sort((x, y) => x.outputId - y.outputId);
  const cursor = notes.get('heldTokenCursor') ?? 0;
  const start = candidates.findIndex((r) => r.outputId > cursor);
  const ordered = start < 0 ? candidates : [...candidates.slice(start), ...candidates.slice(0, start)];
  const held: Admission[] = [];
  let last: number | undefined;
  for (const r of ordered) {
    if (held.length >= limit) break;
    if (!statusOf.has(r.transactionId))
      statusOf.set(
        r.transactionId,
        (await store.findTransactions({ partial: { userId, transactionId: r.transactionId }, noRawTx: true }))[0]
          ?.status,
      );
    last = r.outputId;
    const t = statusOf.get(r.transactionId);
    if (!t || !SETTLED_TX.has(t)) continue;
    held.push({ kind: 'coin', txid: r.txid, vout: r.vout });
  }
  // Next run goes on after the last row looked at; a run that looked at every row starts from the beginning again.
  await list.setNote(identityKey, 'heldTokenCursor', held.length >= limit ? last : undefined).catch(() => undefined);
  if (!held.length) return 0;
  await list.add(identityKey, held, now, { delayMs: HELD_TOKEN_DELAY_MS });
  return held.length;
}

// ── the wallet's own keys ──

const hash160Hex = (pub: PublicKey) => Utils.toHex(Hash.hash160(pub.encode(true) as number[])).toLowerCase();
const p2pkhHex = (pub: PublicKey) => `76a914${hash160Hex(pub)}88ac`;
/** The script carries this key: its hash (P2PKH, lock, inscription + P2PKH) or the key itself (PushDrop, multisig). */
const carries = (script: string, pub: PublicKey) =>
  script.includes(`14${hash160Hex(pub)}`) || script.includes(`21${pub.toString().toLowerCase()}`);

type Record_ = { protocolID: [0 | 1 | 2, string]; keyID: string; counterparty?: string };

/** A record (customInstructions) as a JSON object: plaintext, or decrypted as the permissions manager encrypts it. */
async function readJson(proto: ProtoWallet, ci: unknown): Promise<Record<string, unknown> | undefined> {
  if (typeof ci !== 'string' || !ci) return undefined;
  let text = ci;
  try {
    JSON.parse(text);
  } catch {
    if (!METADATA_PROTOCOL) return undefined;
    try {
      const { plaintext } = await proto.decrypt({
        ciphertext: Utils.toArray(ci, 'base64'),
        protocolID: METADATA_PROTOCOL,
        keyID: '1',
      });
      text = Utils.toUTF8(plaintext);
    } catch {
      return undefined;
    }
  }
  try {
    const o = JSON.parse(text) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function readRecord(proto: ProtoWallet, ci: unknown): Promise<Record_ | undefined> {
  const o = (await readJson(proto, ci)) as Partial<Record_> | undefined;
  return o && Array.isArray(o.protocolID) && typeof o.keyID === 'string' ? (o as Record_) : undefined;
}

/** `readRecord` for the verifier: the account's records, decrypted with its own key (held in this closure). */
export function walletRecords(rootKey: PrivateKey) {
  const proto = new ProtoWallet(rootKey);
  return (ci: string) => readJson(proto, ci);
}

/**
 * `owns` from the wallet's root key and the account's legacy keys (services/legacyOrd.ts), all held in this closure.
 * Change: exactly P2PKH of the BRC-29 key the toolbox signs it with (counterparty = its sender, else the wallet itself).
 */
export function walletOwnership(rootKey: PrivateKey, legacyKeys: (PrivateKey | undefined)[] = []) {
  const kd = new CachedKeyDeriver(rootKey);
  const proto = new ProtoWallet(rootKey);
  const legacy = legacyKeys.filter((k): k is PrivateKey => !!k).map((k) => k.toPublicKey());
  return async (row: OutputRow, scriptHex: string): Promise<boolean> => {
    const script = scriptHex.toLowerCase();
    const change = isWalletChange(row);
    if (row.derivationPrefix && row.derivationSuffix) {
      try {
        const counterparty = row.senderIdentityKey ? PublicKey.fromString(row.senderIdentityKey) : 'self';
        const pub = kd.derivePublicKey(BRC29, `${row.derivationPrefix} ${row.derivationSuffix}`, counterparty, true);
        if (change) return script === p2pkhHex(pub);
        if (carries(script, pub)) return true;
      } catch {
        if (change) return false;
      }
    }
    if (change) return false;
    const rec = await readRecord(proto, row.customInstructions);
    if (rec)
      try {
        const pub = kd.derivePublicKey(rec.protocolID, rec.keyID, rec.counterparty ?? 'self', true);
        if (carries(script, pub)) return true;
      } catch {
        // an odd record: not the wallet's key
      }
    return legacy.some((pub) => carries(script, pub));
  };
}

// ── rows filed under a transaction this device was never sent (6 Nov 2026) ──
//
// The toolbox pulls a backup incrementally: each pass asks for rows changed at or after the newest time it has seen
// (the sync state's `when`), and a row's time is the time on the device that wrote it. Another copy of the wallet
// (the owner's extension) pushes its rows later than it makes them, so a payment it made before this device's last
// pull arrives on the backup with an older time and no later pass sends it. When that copy then spends the payment's
// coin, the coin's row is newer and comes alone: the toolbox files a row under its transaction through the sync map
// (EntityOutput.mergeFind), finds none, and refuses the whole page ("args.partial.transactionId ... must be not
// undefined"). Every merge from that backup then stops at the same page, so this device never takes the other's coins
// in and never pushes its own (the iPhone, 5 Nov 09:47Z onwards).
// Such a page is not merged: the cursor goes back to the start and the same sync carries on from there, so the missing
// transactions come first and every row is checked as usual. A pass from the start that still can't file a row stops.

/**
 * This device's sync state for the page's reader: the row the toolbox's processSyncChunk reloads, by the page's
 * syncStateId when it names one (review 23, L4: a stray second row is never the one rewound).
 */
const readerSyncState = (store: DeviceStore, args: SyncArgs): Promise<SyncStateRow | undefined> =>
  syncStateFor(store, args?.identityKey, args?.fromStorageIdentityKey, args?.syncStateId);

/**
 * The reader's transaction ids this page files rows under (outputs, commissions: the merges that refuse a page for an
 * unknown one) that neither this page nor the sync map knows.
 */
export async function unfiledTransactions(
  store: DeviceStore,
  args: SyncArgs,
  chunk: SyncChunk,
  row?: SyncStateRow,
): Promise<number[]> {
  const rows = [
    ...(chunk?.outputs ?? []),
    ...((chunk as { commissions?: { transactionId?: number }[] })?.commissions ?? []),
  ];
  if (!rows.length) return [];
  const idMap = parseSyncMap((row ?? (await readerSyncState(store, args)))?.syncMap)?.transaction?.idMap ?? {};
  const onPage = new Set((chunk.transactions ?? []).map((t) => t?.transactionId));
  const unfiled = new Set<number>();
  for (const r of rows) {
    const id = r?.transactionId;
    if (typeof id === 'number' && !onPage.has(id) && typeof idMap[String(id)] !== 'number') unfiled.add(id);
  }
  return [...unfiled];
}

// ── installation ──

/**
 * By account (identity key), not by store: the device database keeps the storage identity key it was created with,
 * which an older install may not share with the one the account now names, and a check keyed by it would be skipped.
 * Every StorageIdb merge for a registered account is checked; in the app the device store is the only StorageIdb that
 * takes merges (the USB backup reader only reads; backups are StorageClients).
 */
const verifiers = new Map<string, InboundVerifier[]>();
/** A page refused because it couldn't be checked (its admissions not written): a pause, not a broken backup (F5). */
export const isUncheckedPage = (e: unknown): boolean =>
  String((e as { message?: unknown } | null)?.message ?? e).includes(UNCHECKED_PAGE);
/** Device stores that take only checked rows: a page for an account with no verifier is refused, never let through. */
const deviceStores = new Set<string>();

/** Check rows from other stores merged into this device's store for this account. Returns the unregister. */
export function registerInboundVerifier(storageIdentityKey: string, identityKey: string, v: InboundVerifier) {
  if (storageIdentityKey) deviceStores.add(storageIdentityKey);
  verifiers.set(identityKey, [...(verifiers.get(identityKey) ?? []), v]);
  return () => {
    const left = (verifiers.get(identityKey) ?? []).filter((x) => x !== v);
    if (left.length) verifiers.set(identityKey, left);
    else verifiers.delete(identityKey);
  };
}

const INSTALLED = Symbol.for('bwx.inboundSync.original');
const READER = Symbol.for('bwx.inboundSync.reader');
const CHECKPOINT = Symbol.for('bwx.inboundSync.checkpoint');
/** Passes rewound by an unfiled page and not finished yet, by device and reader: one rewind per pass (L4). */
const rewound = new Set<string>();
type ProcessSyncChunk = (this: DeviceStore, args: SyncArgs, chunk: SyncChunk) => Promise<unknown>;
type GetSyncChunk = (this: DeviceStore, args: unknown) => Promise<SyncChunk>;

/**
 * Wrap processSyncChunk on the device store class (StorageIdb) so every merge for a registered account is checked first,
 * including the one the wallet factory runs before initWallet can touch the instance. A merge into a registered device
 * store for an account with no check is refused. Anything else passes as before. A device store's pages to a backup
 * carry the rows their own are filed under (services/pushParents.ts). Idempotent; returns the uninstall.
 */
export function installInboundSyncGuard(cls: { prototype: object }): () => void {
  const proto = cls.prototype as Record<string | symbol, unknown>;
  if (proto[INSTALLED]) return () => undefined;
  const own = Object.prototype.hasOwnProperty.call(proto, 'processSyncChunk');
  const original = proto.processSyncChunk as ProcessSyncChunk | undefined;
  if (typeof original !== 'function') return () => undefined;
  proto[INSTALLED] = original;
  const ownRead = Object.prototype.hasOwnProperty.call(proto, 'getSyncChunk');
  const read = proto.getSyncChunk as GetSyncChunk | undefined;
  if (typeof read === 'function') {
    proto[READER] = read;
    /**
     * The same gap going the other way: this device's pages to a backup. A transaction this device took in from a backup
     * keeps its old time, so a push from the backup's cursor never sends it, while the coins under it (spent since, newer)
     * are sent; the backup's merge can't file them and refuses the push (setActive's propagate, updateBackups). Each push
     * page therefore carries the rows its own are filed under (services/pushParents.ts: review 23's L1 and L2 kept).
     * Only in a toolbox sync to another store (L3): an export, a USB backup or a Repair Sync index reads the store as it is.
     * Not tied to the account's registration (owner's iPhone, 7 Nov 2026: the failing push page carried no parent at all
     * while this check waited on it): the store's own identity says what a push from it is.
     */
    proto.getSyncChunk = async function (this: DeviceStore, args: unknown) {
      // A provider stand-in in tests (_mergeUnchecked) serves pages as wallet.1sat.app does: as they are.
      const own = (this as unknown as Record<string, unknown>).processSyncChunk;
      if (Object.prototype.hasOwnProperty.call(this, 'processSyncChunk') && own === original)
        return (await read.call(this, args)) as SyncChunk;
      return (await readPushPage(
        this as unknown as ParentStore,
        args as PushArgs,
        async (a) => (await read.call(this, a)) as PushPage,
      )) as SyncChunk;
    };
  }
  // A pull starts a little before the newest time it has seen (review 23, M1): a row another copy pushed a few minutes
  // late, with its own older time, still comes. Rows this device holds come again as no-ops (an equal time).
  const ownCheckpoint = Object.prototype.hasOwnProperty.call(proto, 'getSyncCheckpoint');
  const checkpoint = proto.getSyncCheckpoint as ((...a: unknown[]) => Promise<{ since?: Date }>) | undefined;
  if (typeof checkpoint === 'function') {
    proto[CHECKPOINT] = checkpoint;
    proto.getSyncCheckpoint = async function (this: DeviceStore, ...a: unknown[]) {
      const c = await checkpoint.apply(this, a);
      const sik = this.getSettings?.()?.storageIdentityKey;
      return sik && deviceStores.has(sik) && c ? { ...c, since: overlapped(c.since) } : c;
    };
  }
  proto.processSyncChunk = async function (this: DeviceStore, args: SyncArgs, chunk: SyncChunk) {
    const identityKey = args?.identityKey ?? '';
    const list = verifiers.get(identityKey);
    const v = list?.[list.length - 1];
    if (!v) {
      const sik = this.getSettings?.()?.storageIdentityKey;
      if ((sik && deviceStores.has(sik)) || (args?.toStorageIdentityKey && deviceStores.has(args.toStorageIdentityKey)))
        throw new Error(NO_VERIFIER);
      return original.call(this, args, chunk);
    }
    const deviceSik = this.getSettings?.()?.storageIdentityKey ?? '';
    const passKey = `${deviceSik}|${args?.fromStorageIdentityKey ?? ''}`;
    let row = await readerSyncState(this, args);
    const fromStart = args?.since == null;
    const more = () => {
      try {
        v.onMore?.();
      } catch {
        // scheduling only
      }
    };
    const mark = markOf(row);
    /** A tail pass (rows that reached the backup late with old times: services/pullTail.ts), not one from the start. */
    const tail = fromStart && tailUnderWay(mark);
    /** A deep, full or tail pass this device started: the device-sync pulls carry it (services/fullPass.ts). */
    const ours = fromStart ? typeof mark.startedAt === 'number' || tail : typeof mark.deepStartedAt === 'number';
    // A heal, or a merge with no mode (the factory's at open), leaves it to the pulls (review 23, M2; re-check N2).
    if (beforePage(deviceSik, { fromStart, ours }) === 'stop') {
      more();
      return { done: true, inserts: 0, updates: 0 }; // not merged: the checkpoint stays where it was
    }
    // A tail pass that ends where an entity too large to check begins (pullTail skipped): once the backup reaches it,
    // its rows (and every later entity's) are left out of this page, and the pass ends here.
    let endsHere = false;
    if (tail && mark.tailUntil) {
      const from = TAIL_ENTITIES.findIndex((e) => e.name === mark.tailUntil);
      const rows = chunk as unknown as Record<string, unknown[] | undefined>;
      for (const e of from < 0 ? [] : TAIL_ENTITIES.slice(from))
        if (rows[e.key]?.length) {
          rows[e.key] = [];
          endsHere = true;
        }
    }
    const unfiled = await unfiledTransactions(this, args, chunk, row);
    if (unfiled.length) {
      const id = typeof row?.syncStateId === 'number' ? row : undefined;
      // Escalate, never loop: an incremental pass goes back DEEP_OVERLAP_MS; a deep pass goes back to the start when
      // the 24 h limit for error-driven full passes allows (re-check N1); a pass from the start, or one whose rewind
      // didn't land in the row the toolbox reads (L4), stops here.
      const deep = !fromStart && !!id && !ours && !rewound.has(passKey);
      const full = !fromStart && !!id && ours && !mark.startedAt && onDemandAllowed(mark);
      if (!deep && !full) {
        const rows = (chunk.outputs ?? [])
          .filter((o) => typeof o?.transactionId === 'number' && unfiled.includes(o.transactionId))
          .map((o) => `${o.txid ?? '?'}.${o.vout} (backup transaction ${o.transactionId})`);
        // L5: a backup holding such a row never sends its transaction; a retry can't take it. Named for support.
        v.log?.(
          `[inbound-sync] backup page names ${unfiled.length} payment(s) this device has no record of and the backup doesn't send${fromStart && !tail ? ', even from the start' : ''}: ${rows.slice(0, 20).join(', ')}${rows.length > 20 ? ` and ${rows.length - 20} more` : ''}`,
        );
        // The next full pass for it: not before 24 h from now (a pass from the start that met it counts as one). A tail
        // pass that met it (its transaction lies before the tail) asks for a full pass when the 24 h limit allows.
        if (id && tail) await abandonTail(this, id, { due: 'unfiled' });
        else if (id)
          await updateMark(this, id, fromStart ? { due: 'unfiled', onDemandAt: Date.now() } : { due: 'unfiled' });
        throw new Error(UNFILED_PAGE);
      }
      if (deep) await rewindDeep(this, id!);
      else await rewind(this, id!, Date.now(), { onDemandAt: Date.now() });
      rewound.add(passKey);
      v.log?.(
        `[inbound-sync] backup page names ${unfiled.length} payment(s) an earlier pull skipped: pulling this backup again ${deep ? 'from 48 h back' : 'from the start'}`,
      );
      // Not merged, nothing queued. No checkpoint: the toolbox's sync loop reloads the rewound one and carries on, or
      // (a heal, the factory's merge) leaves it to the device-sync pulls.
      if (beforePage(deviceSik, { fromStart: !deep, ours: true }) === 'stop') {
        more();
        return { done: true, inserts: 0, updates: 0 };
      }
      return { done: false, inserts: 0, updates: 0 };
    }
    const report = await verifyInboundChunk(this, args, chunk, v, { requeueHeld: fromStart });
    if (report.admissions.length) {
      // Written before the merge: a page whose admissions can't be kept is not taken (it is fetched again).
      const sik = this.getSettings?.()?.storageIdentityKey;
      try {
        if (!sik) throw new Error('no storage identity key');
        await admissionListFor(sik).add(identityKey, report.admissions, Date.now());
      } catch (e) {
        v.log?.('[inbound-sync] admission list not written:', e);
        throw new Error(UNCHECKED_PAGE);
      }
    }
    const merged = (await original.call(this, args, chunk)) as
      | { done?: boolean; nextCheckpoint?: { since?: Date } }
      | undefined;
    if (report.admissions.length)
      try {
        v.onQueued?.();
      } catch {
        // scheduling only
      }
    if (!merged) return merged;
    if (merged.done || endsHere) {
      rewound.delete(passKey);
      if (tail) {
        // A tail pass completed: the cursor goes back where it was; recorded as a tail pass, never as a full one.
        row = await readerSyncState(this, args);
        if (row && typeof row.syncStateId === 'number') await finishTail(this, row);
      } else if (fromStart || ours) {
        // A pass from the start (ours, or a store's first) or a deep pull completed: recorded for the schedule.
        row = await readerSyncState(this, args);
        const now = Date.now();
        if (row && typeof row.syncStateId === 'number' && !passFromStart(row))
          await updateMark(
            this,
            row,
            fromStart
              ? { doneAt: now, deepDoneAt: now, startedAt: undefined, deepStartedAt: undefined, due: undefined }
              : { deepDoneAt: now, deepStartedAt: undefined },
          );
      }
      return endsHere ? { ...merged, done: true } : merged;
    }
    // The same overlap as the checkpoint this pass started from (getSyncCheckpoint below, for the same stores): one
    // cursor per pass.
    const next =
      merged.nextCheckpoint && deviceStores.has(deviceSik)
        ? { ...merged.nextCheckpoint, since: overlapped(merged.nextCheckpoint.since) }
        : undefined;
    const out = next ? { ...merged, nextCheckpoint: next } : merged;
    if (afterPage(deviceSik) === 'yield') {
      more();
      return { ...out, done: true }; // this slice is used up: the checkpoint has this page, the next pull goes on
    }
    return out;
  };
  return () => {
    if (own) proto.processSyncChunk = original;
    else delete proto.processSyncChunk;
    delete proto[INSTALLED];
    if (typeof read === 'function') {
      if (ownRead) proto.getSyncChunk = read;
      else delete proto.getSyncChunk;
      delete proto[READER];
    }
    if (typeof checkpoint === 'function') {
      if (ownCheckpoint) proto.getSyncCheckpoint = checkpoint;
      else delete proto.getSyncCheckpoint;
      delete proto[CHECKPOINT];
    }
  };
}

/** Test hook: take the guard off this class again, whoever installed it (a test that ran the real initWallet). */
export const _uninstallInboundSyncGuard = (cls: { prototype: object }) => {
  const proto = cls.prototype as Record<string | symbol, unknown>;
  const original = proto[INSTALLED];
  if (typeof original !== 'function') return;
  if (
    Object.getPrototypeOf(proto) &&
    (Object.getPrototypeOf(proto) as Record<string, unknown>).processSyncChunk === original
  )
    delete proto.processSyncChunk;
  else proto.processSyncChunk = original;
  delete proto[INSTALLED];
  const parent = Object.getPrototypeOf(proto) as Record<string, unknown> | null;
  const read = proto[READER];
  if (typeof read === 'function') {
    if (parent && parent.getSyncChunk === read) delete proto.getSyncChunk;
    else proto.getSyncChunk = read;
    delete proto[READER];
  }
  const checkpoint = proto[CHECKPOINT];
  if (typeof checkpoint === 'function') {
    if (parent && parent.getSyncCheckpoint === checkpoint) delete proto.getSyncCheckpoint;
    else proto.getSyncCheckpoint = checkpoint;
    delete proto[CHECKPOINT];
  }
};

/** Test hook: forget every registration. */
export const _resetInboundVerifiers = () => {
  verifiers.clear();
  deviceStores.clear();
};

/** Test hook: this store merges unchecked (a stand-in for the provider, which in the app is a StorageClient). */
export const _mergeUnchecked = (store: object) => {
  const original = (Object.getPrototypeOf(store) as Record<symbol, unknown>)[INSTALLED];
  if (typeof original === 'function') (store as { processSyncChunk?: unknown }).processSyncChunk = original;
};
