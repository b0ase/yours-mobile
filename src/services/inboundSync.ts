/**
 * Nothing that comes from another store becomes spendable on this device unless the chain or the wallet's own keys say
 * so (b-Aware A3, 0xzero, 25 Oct 2026).
 *
 * Every row a backup store (wallet.1sat.app, or any remote the account names) sends reaches this device through the
 * toolbox's sync merge: StorageIdb.processSyncChunk, the writer side of syncFromReader and syncToWriter. That covers
 * the device-sync pull on every open (services/deviceSync.ts), F-C's pull into the device store (services/localFirst.ts),
 * the restore switch (services/restoreFromRemote.ts), a backup import, the Monitor's backup sync while the remote is
 * active, and the merge the wallet factory runs at boot when the stores disagree about which is active. The merge
 * trusted the sender: an output row with a newer updated_at overwrote the device's (spendable, spentBy, basket, change
 * role, script, sender key, record), and a new row went in as sent. So a hostile or compromised provider could turn a
 * spent coin spendable again, file a coin as wallet change, rewrite how a coin is signed for, or plant change that
 * isn't the wallet's.
 *
 * The rule, applied to each output row of each page BEFORE the toolbox merges it:
 *  1. A row this device already holds keeps what the coin is and how the wallet signs for it: its script (and offsets),
 *     sender key, record (customInstructions), change role (type, change, providedBy, purpose). Derivations and amounts
 *     are never merged by the toolbox. Another store may still mark it spent, move or relinquish it, or describe it.
 *  2. A coin the device holds as spent (or not spendable) comes back to spendable only when WhatsOnChain says its
 *     outpoint is unspent. Spent: the device keeps its own row. Unclear: that coin alone is held (not spendable,
 *     HELD_MARK) while the rest of the page lands, and releaseHeldRows asks again later (review 16b, R4).
 *  3. A row the device has never seen, arriving spendable, must pay a key the wallet derives itself from that row's own
 *     derivation (BRC-29 prefix/suffix with its sender, exactly as the toolbox signs change; or the protocol and key its
 *     record names; or one of the account's legacy keys), and must be the output it claims to be when the page or the
 *     device has its raw transaction. Wallet change (the only coins payments pick on their own) must be exactly that
 *     P2PKH. Anything else that fails the key check is asked of the chain, as in 2. A row that fails arrives NOT
 *     spendable: kept, visible to repairs, never picked.
 * Honest rows from the owner's other devices pass 3 offline (change and payments are the wallet's own keys), so the
 * chain is asked only about revivals and odd rows.
 *
 * Release rules kept: legacy batch mode (services/actionBatchMode.ts) and "no change on the remote store"
 * (services/localFirst.ts) are untouched; F-C's pull keeps the device store active (this only filters what it merges).
 */
import {
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
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client';
import type { SpendState } from './unsentExpiry';

/** The toolbox's BRC-29 payment protocol (change and received payments). */
const BRC29: [2, string] = [2, '3241645161d8'];
/**
 * Records written through the permissions manager are encrypted under its metadata protocol (a private static in the
 * typings, read as the toolbox defines it). Missing: records can't be read here and such rows go to the chain check.
 */
const METADATA_PROTOCOL = (WalletPermissionsManager as unknown as { METADATA_ENCRYPTION_PROTOCOL?: WalletProtocol })
  .METADATA_ENCRYPTION_PROTOCOL;

export const UNCHECKED_PAGE =
  "A page from your backup couldn't be checked against the chain, so none of it was taken. It is tried again later.";
export const NO_VERIFIER = 'This device store only takes in backup rows it can check; none is set up for this account';

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
type SyncArgs = { identityKey?: string; fromStorageIdentityKey?: string; toStorageIdentityKey?: string };

/** The storage provider calls this needs (StorageIdb). */
export type DeviceStore = {
  findUsers(a: { partial: { identityKey: string } }): Promise<{ userId: number }[]>;
  findSyncStates(a: { partial: { storageIdentityKey: string; userId: number } }): Promise<{ syncMap?: unknown }[]>;
  findTransactions(a: { partial: Record<string, unknown>; noRawTx?: boolean }): Promise<TxRow[]>;
  findOutputs(a: { partial: Record<string, unknown> }): Promise<OutputRow[]>;
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
  log?: (...a: unknown[]) => void;
};

export type InboundReport = {
  kept: number;
  quarantined: number;
  revived: number;
  pinned: number;
  /** Token tags (amt:, bsv21:, sym:, dec:) from another store that its script doesn't bear out, taken as deleted. */
  tagsDropped: number;
  /** New rows held (not spendable, marked HELD_MARK) because the chain doesn't know their transaction yet. */
  held: number;
  /** Transaction rows kept as the device has them (a failed one revived without chain proof, a rewritten txid). */
  keptTx: number;
  /**
   * Wallet change the backup holds as spendable that this page leaves NOT spendable here (kept spent, held, not taken).
   * For the log: the restore switch checks the device's store itself (restoreFromRemote.outpointsOnDevice).
   */
  withheldOutputs: number;
  withheldSats: number;
};

/** On a row held only because the chain didn't know its transaction yet: releaseHeldRows looks again later. */
export const HELD_MARK = 'bwx: waiting for the chain to show this coin';

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

/**
 * Check one page against the device store and make it safe to merge, in place (rows are rewritten, never removed, so
 * the toolbox's paging is unchanged). When the chain can't answer, only the coin in question is held (review 16b, R4).
 */
export async function verifyInboundChunk(
  store: DeviceStore,
  args: SyncArgs,
  chunk: SyncChunk,
  v: InboundVerifier,
): Promise<InboundReport> {
  const report: InboundReport = {
    kept: 0,
    quarantined: 0,
    revived: 0,
    pinned: 0,
    tagsDropped: 0,
    held: 0,
    keptTx: 0,
    withheldOutputs: 0,
    withheldSats: 0,
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
  const deviceTx = (remoteId: number | undefined): Promise<{ id?: number; txid?: string }> => {
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
    if (!raw?.length) return undefined;
    try {
      const tx = Transaction.fromBinary(Array.from(raw));
      return tx.id('hex') === txid ? tx : undefined;
    } catch {
      return undefined;
    }
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

  const deviceTxStatus = async (transactionId: number | undefined): Promise<string | undefined> =>
    typeof transactionId === 'number'
      ? (await store.findTransactions({ partial: { userId, transactionId }, noRawTx: true }))[0]?.status
      : undefined;

  const chain = chainChecks(v);
  /** The chain's word on an outpoint, or a refused page when it has none. */
  /** The chain's word on one coin. Unclear (WoC throttled or down) holds that coin only (review 16b, R4). */
  const chainVerdict = (txid: string, vout: number) => chain(txid, vout);
  /**
   * May this row (with this script) be spendable, before asking the chain? A token's record must say what its script says
   * (F2: a forged amount burns tokens on the next send), and wallet change must pay the wallet's own key exactly.
   * 'owned' rows and other rows (a site's outputs, which the wallet can't sign anyway) then go to the chain.
   */
  const admissible = async (row: OutputRow, script: string): Promise<'refuse' | 'check'> => {
    const facts = tokenFacts(script, row.txid, row.vout);
    if (facts && typeof row.customInstructions === 'string' && row.customInstructions) {
      const rec = await recordOf(row.customInstructions);
      if (!rec || !recordAgrees(rec, facts)) return 'refuse';
    }
    const owned = await v.owns(row, script).catch(() => false);
    return !owned && isWalletChange(row) ? 'refuse' : 'check';
  };

  /** The backup counts this row as spendable wallet change and this device won't: the restore switch adds it back. */
  const withheld = (o: OutputRow, asFiled: OutputRow) => {
    if (o.spendable !== true || !isWalletChange(asFiled)) return;
    const sats = typeof o.satoshis === 'number' ? o.satoshis : 0;
    report.withheldOutputs++;
    report.withheldSats += sats;
  };
  const keep = (o: OutputRow, filed?: OutputRow) => {
    if (filed && filed.spendable !== true) withheld(o, filed);
    o.updated_at = new Date(0); // EntityOutput.mergeExisting only applies a strictly newer row: the device's stays
    report.kept++;
  };
  const quarantine = (o: OutputRow) => {
    withheld(o, o);
    o.spendable = false;
    report.quarantined++;
  };
  /** Not spendable for now: the chain doesn't know its transaction yet. releaseHeldRows looks again. */
  const hold = (o: OutputRow) => {
    withheld(o, o);
    o.spendable = false;
    o.spendingDescription = HELD_MARK;
    report.held++;
  };

  /** A record as JSON (the verifier decrypts what the manager encrypted); undefined when it can't be read. */
  const recordOf = async (ci: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const o = JSON.parse(ci) as unknown;
      return o && typeof o === 'object' ? (o as Record<string, unknown>) : undefined;
    } catch {
      return v.readRecord ? v.readRecord(ci).catch(() => undefined) : undefined;
    }
  };
  /** Remote output id → this page's row and the device row the merge files it under. */
  const pageRows = new Map<number, { row: OutputRow; deviceOutputId?: number }>();
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
  /**
   * Would this id tag point at a second asset? Another device output already carries it, the target already has a
   * different id, or this page gives it twice. Any of these: refused, so "send / list this NFT" can't load another.
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
        if (holders.some((h) => h.isDeleted !== true && h.outputId !== deviceOutputId)) return true;
      }
      if (deviceOutputId !== undefined && typeof store.findOutputTags === 'function') {
        for (const m of await store.findOutputTagMaps({ partial: { outputId: deviceOutputId } })) {
          if (m.isDeleted === true || typeof m.outputTagId !== 'number' || m.outputTagId === localTag) continue;
          const name = (await store.findOutputTags({ partial: { outputTagId: m.outputTagId } }))[0]?.tag;
          if (name && ID_TAG.test(name) && name.toLowerCase() !== tag) return true;
        }
      }
    }
    pageIds.set(tag, remoteOutputId);
    pageIdOf.set(remoteOutputId, tag);
    return false;
  };
  const deviceTagId = async (remoteTagId: number, tag: string): Promise<number | undefined> => {
    const local = maps?.outputTag?.idMap?.[String(remoteTagId)];
    if (typeof local === 'number') return local;
    if (typeof store.findOutputTags !== 'function') return undefined;
    return (await store.findOutputTags({ partial: { userId, tag } }))[0]?.outputTagId;
  };

  // Transactions the device already holds (review 16, F4): their txid and raw bytes stay the device's, and one the
  // device holds as failed changes status only when the chain knows it. Otherwise a page could flip failed to
  // completed and a later page revive its outputs on WhatsOnChain's 404.
  for (const t of chunk.transactions ?? []) {
    if (!t) continue;
    let d = t.txid ? (await store.findTransactions({ partial: { userId, txid: t.txid } }))[0] : undefined;
    if (!d && t.reference) d = (await store.findTransactions({ partial: { userId, reference: t.reference } }))[0];
    if (!d) continue;
    const keepTx = () => {
      t.updated_at = new Date(0);
      t.provenTxId = undefined; // no "proof evidence" path around the time check (EntityTransaction.mergeExisting)
      t.noSendExpiryState = d.noSendExpiryState;
      report.keptTx++;
    };
    if (d.txid && t.txid && d.txid !== t.txid) {
      keepTx();
      continue;
    }
    if (d.rawTx?.length && t.rawTx?.length && hex(d.rawTx) !== hex(t.rawTx)) t.rawTx = d.rawTx;
    const txid = d.txid ?? t.txid;
    if (d.status === 'failed' && t.status !== undefined && t.status !== 'failed') {
      // Unknown or unclear: kept failed (no change without the chain's word; R4: never the whole page).
      if ((txid ? await chain.txKnown(txid) : 'unknown') !== 'known') keepTx();
      continue;
    }
    // The other way (review 16b, R3): a backup moving a transaction this device knows to failed, or off completed, or
    // dropping its proof. The device's monitor would then free the coins it spent (spent on chain) and hide the coins
    // it made. A transaction the device holds a proof for is never undone from a backup; one without a proof may be
    // failed only when the chain doesn't know it (a payment another device saw refused). Anything else: kept.
    const toFailed = t.status === 'failed' && d.status !== 'failed';
    const offCompleted = d.status === 'completed' && t.status !== undefined && t.status !== 'completed';
    const dropsProof = d.provenTxId != null && t.provenTxId == null && t.status !== undefined;
    if (toFailed || offCompleted || dropsProof) {
      if (d.provenTxId != null || offCompleted || !toFailed) {
        keepTx();
        continue;
      }
      const known = txid ? await chain.txKnown(txid) : 'unclear';
      if (known !== 'unknown') keepTx(); // known: it is on chain, not failed; unclear: no change without an answer
    }
  }

  // A proof request is what the device's monitor fails a transaction by ('invalid' -> failed). A new request in a
  // final failed state for a transaction the device already holds arrives as one to be checked again (R3).
  for (const q of chunk.provenTxReqs ?? []) {
    if (!q?.txid || !REQ_FAILED.has(String(q.status))) continue;
    if (!(await store.findTransactions({ partial: { userId, txid: q.txid }, noRawTx: true }))[0]) continue;
    if (
      typeof store.findProvenTxReqs === 'function' &&
      (await store.findProvenTxReqs({ partial: { txid: q.txid } }))[0]
    )
      continue; // the device has its own request: the toolbox merge keeps that request's status
    q.status = 'unknown';
    report.keptTx++;
  }

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
      // Rule 2: back to spendable only on the chain's word. (A row the merge won't apply needs no answer; one whose time
      // can't be read is checked.) WhatsOnChain answers "unspent" for an outpoint it has never seen, so an output of a
      // transaction this device holds as failed (never on the network) is not brought back from another store.
      const newer = !(time(o.updated_at) <= time(filed.updated_at));
      const reviving = o.spendable === true && (filed.spendable !== true || filed.spentBy != null);
      if (newer && reviving) {
        // The device's copy (rule 1 pinned it) must pass what a new row passes, then the chain must know it unspent:
        // a row that arrived not spendable can't be turned spendable on WhatsOnChain's word alone (review 16, F4).
        const failed = (await deviceTxStatus(filed.transactionId)) === 'failed';
        const script = hex(filed.lockingScript);
        const fit = !failed && !!filed.txid && !!script && (await admissible(filed, script)) === 'check';
        const verdict = fit ? await chainVerdict(filed.txid!, filed.vout) : 'refuse';
        if (verdict === 'unspent') report.revived++;
        else if (verdict === 'unclear') {
          // Held for the chain, as a new row would be (R4): not spendable, looked at again by releaseHeldRows.
          o.spendable = false;
          o.spendingDescription = HELD_MARK;
          report.held++;
        } else keep(o, filed);
      }
      continue;
    }
    if (o.spendable !== true) continue;
    // Rule 3: a row the device has never seen.
    const twin = o.txid ? (await store.findOutputs({ partial: { userId, txid: o.txid, vout: o.vout } }))[0] : undefined;
    if (twin || (tx.txid && o.txid && tx.txid !== o.txid) || !o.txid) {
      quarantine(o); // a second row for an outpoint the device files elsewhere, or a row at odds with its transaction
      continue;
    }
    const script = await scriptOf(o);
    if (!script) {
      quarantine(o);
      continue;
    }
    if ((await admissible(o, script)) === 'refuse') {
      quarantine(o);
      continue;
    }
    // Even the wallet's own coins are asked of the chain (review 16, F4): a backup can hand back spent change, or change
    // of a transaction never broadcast, both paying keys the wallet owns.
    const verdict = await chainVerdict(o.txid, o.vout);
    if (verdict === 'spent') quarantine(o);
    else if (verdict !== 'unspent') hold(o); // unknown to the chain yet, or no answer now: held, released later
  }

  // Token tags (amt:, bsv21:, sym:, dec:) are where a send falls back to when a record has no amount or id: one
  // that would newly apply to an output must be borne out by that output's script, or it arrives deleted.
  // Tracking ids (id:<x>) are how a send or listing loads "this" asset (limit 1): one id, one output (review 16b, R2).
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
  const pageIds = new Map<string, number>(); // id tag (lowercase) -> remote output it went to on this page
  const pageIdOf = new Map<number, string>(); // remote output -> the id tag it got on this page
  for (const tm of chunk.outputTagMaps ?? []) {
    if (!tm || tm.isDeleted === true || typeof tm.outputTagId !== 'number' || typeof tm.outputId !== 'number') continue;
    const tag = await tagNameOf(tm.outputTagId);
    if (tag === undefined) {
      dropTagMap(tm); // a tag the device can't name: never a live token tag or id
      continue;
    }
    const isId = ID_TAG.test(tag);
    if (!isId && !TOKEN_TAG.test(tag)) continue;
    const out = await outputOf(tm.outputId);
    const localTag = await deviceTagId(tm.outputTagId, tag);
    if (out?.deviceOutputId !== undefined && localTag !== undefined && typeof store.findOutputTagMaps === 'function') {
      const [had] = await store.findOutputTagMaps({ partial: { outputId: out.deviceOutputId, outputTagId: localTag } });
      if (had && had.isDeleted !== true) continue; // already on this device: nothing new
    }
    const refuse = isId
      ? await idTagTaken(tag.toLowerCase(), tm.outputId, out?.deviceOutputId, localTag)
      : !tagAgrees(tag, out?.script ? tokenFacts(out.script, out.txid, out.vout) : null);
    if (refuse) dropTagMap(tm);
  }
  if (report.kept || report.quarantined || report.revived || report.tagsDropped || report.held || report.keptTx)
    v.log?.(
      `[inbound-sync] backup page: kept ${report.kept} device row(s) and ${report.keptTx} transaction(s), took ${report.quarantined} new row(s) as not spendable, held ${report.held} for the chain, revived ${report.revived} on the chain's word, dropped ${report.tagsDropped} token tag(s)`,
    );
  return report;
}

/**
 * The chain's word on an outpoint: 'unspent' only when WhatsOnChain says so AND knows the transaction (its /spent
 * answers 404 for an outpoint it has never seen). Known transactions are remembered for the run.
 */
/**
 * "Spent" answers, kept for 10 minutes (review 16b, R4: fewer WhatsOnChain calls on retries). Only "spent": keeping
 * it can only keep a coin from being spendable for a while. "Known" is not kept: a mempool transaction can be dropped.
 */
const SPENT_TTL_MS = 10 * 60_000;
const spentSeen = new WeakMap<InboundVerifier, Map<string, number>>();

function chainChecks(v: InboundVerifier, now: () => number = Date.now) {
  let spent = spentSeen.get(v);
  if (!spent) spentSeen.set(v, (spent = new Map()));
  const seenSpent = spent;
  const known = new Map<string, Promise<'known' | 'unknown' | 'unclear'>>();
  const txKnown = (txid: string) => {
    if (!known.has(txid))
      known.set(
        txid,
        v.txKnown ? v.txKnown(txid).catch((): 'unclear' => 'unclear') : Promise.resolve<'unknown'>('unknown'),
      );
    return known.get(txid)!;
  };
  const verdict = async (txid: string, vout: number): Promise<'unspent' | 'spent' | 'unknown' | 'unclear'> => {
    const op = `${txid}.${vout}`;
    const at = seenSpent.get(op);
    if (at !== undefined && now() - at < SPENT_TTL_MS) return 'spent';
    const st = await v.spent(op).catch((): SpendState => ({ state: 'unclear' }));
    if (st.state === 'unclear') return 'unclear';
    if (st.state === 'spent') {
      seenSpent.set(op, now());
      return 'spent';
    }
    const k = await txKnown(txid);
    return k === 'known' ? 'unspent' : k;
  };
  return Object.assign(verdict, { txKnown });
}

type ReleaseStore = DeviceStore & { updateOutput(id: number, update: Record<string, unknown>): Promise<unknown> };

/**
 * Look again at rows held for the chain (HELD_MARK): spendable once the chain knows the transaction and the coin is
 * unspent; the mark goes once it is spent. Unclear: left for next time. Runs after each device-sync pull, so an honest
 * coin pulled before WhatsOnChain had its transaction is not stranded.
 */
export async function releaseHeldRows(
  store: ReleaseStore,
  identityKey: string,
  v: InboundVerifier,
): Promise<{ released: number; spent: number }> {
  const out = { released: 0, spent: 0 };
  const user = (await store.findUsers({ partial: { identityKey } }))[0];
  if (!user) return out;
  const held = (await store.findOutputs({ partial: { userId: user.userId, spendable: false } })).filter(
    (o) =>
      (o as { spendingDescription?: string }).spendingDescription === HELD_MARK &&
      o.spentBy == null &&
      typeof o.outputId === 'number' &&
      !!o.txid,
  );
  const chain = chainChecks(v);
  for (const o of held) {
    const verdict = await chain(o.txid!, o.vout);
    if (verdict === 'unspent') {
      await store.updateOutput(o.outputId!, { spendable: true, spendingDescription: null });
      out.released++;
    } else if (verdict === 'spent') {
      await store.updateOutput(o.outputId!, { spendingDescription: null });
      out.spent++;
    }
  }
  return out;
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

// ── installation ──

/**
 * By account (identity key), not by store: the device database keeps the storage identity key it was created with,
 * which an older install may not share with the one the account now names, and a check keyed by it would be skipped.
 * Every StorageIdb merge for a registered account is checked; in the app the device store is the only StorageIdb that
 * takes merges (the USB backup reader only reads; backups are StorageClients).
 */
const verifiers = new Map<string, InboundVerifier[]>();
/** A page refused because WhatsOnChain couldn't be asked: a pause, not a broken backup (review 16, F5). */
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
type ProcessSyncChunk = (this: DeviceStore, args: SyncArgs, chunk: SyncChunk) => Promise<unknown>;

/**
 * Wrap processSyncChunk on the device store class (StorageIdb) so every merge for a registered account is checked first,
 * including the one the wallet factory runs before initWallet can touch the instance. A merge into a registered device
 * store for an account with no check is refused. Anything else passes as before. Idempotent; returns the uninstall.
 */
export function installInboundSyncGuard(cls: { prototype: object }): () => void {
  const proto = cls.prototype as Record<string | symbol, unknown>;
  if (proto[INSTALLED]) return () => undefined;
  const own = Object.prototype.hasOwnProperty.call(proto, 'processSyncChunk');
  const original = proto.processSyncChunk as ProcessSyncChunk | undefined;
  if (typeof original !== 'function') return () => undefined;
  proto[INSTALLED] = original;
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
    await verifyInboundChunk(this, args, chunk, v);
    return original.call(this, args, chunk);
  };
  return () => {
    if (own) proto.processSyncChunk = original;
    else delete proto.processSyncChunk;
    delete proto[INSTALLED];
  };
}

/** Test hook: forget every registration. */
export const _resetInboundVerifiers = () => {
  verifiers.clear();
  deviceStores.clear();
};
