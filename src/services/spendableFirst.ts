/**
 * Instant restore ("spendable-first"), wallet side, behind a flag that is OFF by default (owner, 20 Nov 2026).
 *
 * The restore on 5.2.59 copied every row from the 1Sat backup, then asked WhatsOnChain about each coin: about four
 * minutes before a balance on the owner's iPhone, then "Retry moving this account to this device" and "Arriving from
 * your other device". Our own storage server (bwalletx-storage, SNAPSHOT_SERVER_URL) serves a lean snapshot of the
 * spendable coins instead: 18 s for a 100k-transaction wallet. API: bwalletx-storage docs/spendable-first-restore.md.
 *
 * With the flag on, when our server advertises `spendableSnapshot` v1 and this device has never synced with it:
 *  1. Lean snapshot: pages of coin rows (derivations and scripts, no raw transactions, no proofs) are checked here
 *     (checkLeanPage) and merged into this device's store with the toolbox's processSyncChunk under a sync state of
 *     their own (`<serverKey>#spendable-snapshot`), never the real cursor. The balance and coin list show.
 *  2. Pay before the rest arrives (installSnapshotBeef): when a payment needs the BEEF of a coin whose transaction has
 *     no raw bytes or proof on this device, just those coins' BEEF is fetched (getBeefForOutpoints) and VERIFIED before
 *     anything is signed: every transaction checked by the SDK's SPV verify against the wallet's own chain tracker
 *     (headers from a second source), and every coin's satoshis and script equal to its transaction's output. Unverified
 *     BEEF is never handed to the signer.
 *  3. Full snapshot in the background (lean:false pages): every proof is checked against headers BEFORE the page is
 *     merged (checkFullPage); a page with a bad proof is refused whole, and the coins taken in unverified are held back
 *     (holdUnverified) for the ordinary pull and the chain to decide, as today.
 *  4. The ordinary device-sync pull then runs from the start, as today (natural-key merges: no duplicates).
 * Any failure, a missing or older server, no user there, an empty snapshot, or one behind the 1Sat backup: today's
 * path runs instead. With the flag off nothing here runs at all.
 *
 * What the inbound guard (services/inboundSync.ts) checks with the chain before a backup coin becomes spendable is, for
 * snapshot coins, checked at signing instead (2 above). Not checked before signing: that the coin is still unspent. A
 * coin spent elsewhere fails at broadcast and is rolled back, as any double spend is today.
 */
import { Beef, MerklePath, Transaction, Utils } from '@bsv/sdk';
import { ancestorsOnly, txidOfRaw } from './beefAncestors';
import { freshProofState, isWalletChange, tokenFacts, unguardedProcessSyncChunk } from './inboundSync';
import { withTimeout } from './restoreProgress';

/** Our storage server (bwalletx-storage), a BACKUP beside 1Sat when the flag is on. */
export const SNAPSHOT_SERVER_URL = 'https://storage.bwalletx.com';
/** chrome.storage.local key: `true` turns the restore on for this device (default off). */
export const SPENDABLE_FIRST_KEY = 'bwxSpendableFirstRestore';
/** The snapshot's own sync state: never the device's real cursor for that server. */
export const SNAPSHOT_SYNC_SUFFIX = '#spendable-snapshot';
/** Lean transaction rows are stamped this old, so the full snapshot's and the history sync's rows win the merge. */
export const LEAN_STAMP = new Date('1970-01-01T00:00:01Z');
export { SNAPSHOT_LOADING_LINE } from './balanceTruth';
/** A payment refused while the snapshot's first pages are still coming in. */
export const SNAPSHOT_SEND_WAIT = 'Loading your wallet. Nothing was sent. You can send in a moment.';

const CAPS_MS = 8_000;
const PAGE_MS = 60_000;
const BEEF_MS = 30_000;
/** A runaway cursor never loops: 20,000 pages of 5,000 coins is far beyond any wallet. */
const MAX_PAGES = 20_000;

type Env = Record<string, string | undefined> | undefined;
const buildEnv: Env = (import.meta as { env?: Env }).env;

/** Build-time switch for a private test build: VITE_SPENDABLE_FIRST_RESTORE=1. Off otherwise. */
export const buildFlagOn = (env: Env = buildEnv): boolean => env?.VITE_SPENDABLE_FIRST_RESTORE === '1';

type Kv = { get(key: string): Promise<Record<string, unknown> | undefined> };
/** On for this device? Build switch, or `true` under SPENDABLE_FIRST_KEY. Anything else (or no store): off. */
export async function spendableFirstOn(kv: Kv | undefined, env: Env = buildEnv): Promise<boolean> {
  if (buildFlagOn(env)) return true;
  try {
    return (await kv?.get(SPENDABLE_FIRST_KEY))?.[SPENDABLE_FIRST_KEY] === true;
  } catch {
    return false;
  }
}

type StoreConfig = { activeRemote?: string; remotes?: string[]; [k: string]: unknown };
/**
 * The account's storage config with our server added as a BACKUP remote (README Phase 1): only with the flag on, and
 * only once this device's store is the active one (a remote-active account gets it when the restore moves it here,
 * so the toolbox's switch never copies one server into the other). Returns the same object when nothing changes.
 */
export function withSnapshotRemote<T extends StoreConfig | undefined>(config: T, on: boolean): T {
  if (!on || !config || config.activeRemote) return config;
  if (config.remotes?.includes(SNAPSHOT_SERVER_URL)) return config;
  return { ...config, remotes: [...(config.remotes ?? []), SNAPSHOT_SERVER_URL] };
}

/**
 * The backups to connect: our server only with the flag on (review, 20 Nov 2026). An earlier session with the flag on
 * may have saved it in the account's remotes; with the flag off it is never connected or pushed to.
 */
export function backupsFor(urls: string[] | undefined, on: boolean): string[] | undefined {
  return on || !urls ? urls : urls.filter((u) => u !== SNAPSHOT_SERVER_URL);
}

export type SnapshotLimits = { leanPageMax?: number; fullPageMax?: number; beefMaxOutpoints?: number };
/** Our server's capability, or undefined (1Sat, an older server, ours with the methods off). */
export function snapshotCapability(caps: unknown): SnapshotLimits | undefined {
  const c = (caps as { spendableSnapshot?: { version?: unknown; methods?: unknown; limits?: unknown } } | null)
    ?.spendableSnapshot;
  if (!c || c.version !== 1 || !Array.isArray(c.methods)) return undefined;
  if (!c.methods.includes('getSpendableSnapshot') || !c.methods.includes('getBeefForOutpoints')) return undefined;
  return (c.limits && typeof c.limits === 'object' ? c.limits : {}) as SnapshotLimits;
}

// ── rows ──

type Bytes = number[] | Uint8Array;
export type SnapOutput = {
  outputId?: number;
  transactionId?: number;
  basketId?: number | null;
  spentBy?: number | null;
  txid?: string | null;
  vout: number;
  satoshis: number;
  spendable?: boolean;
  change?: boolean;
  lockingScript?: Bytes | null;
  updated_at?: Date;
  [k: string]: unknown;
};
export type SnapTx = {
  transactionId?: number;
  txid?: string | null;
  status?: string;
  rawTx?: Bytes | null;
  inputBEEF?: Bytes | null;
  provenTxId?: number | null;
  updated_at?: Date;
  [k: string]: unknown;
};
export type SnapProven = {
  provenTxId?: number;
  txid: string;
  height: number;
  index: number;
  merklePath: Bytes;
  rawTx: Bytes;
  blockHash: string;
  merkleRoot: string;
  [k: string]: unknown;
};
export type SnapReq = {
  txid?: string;
  status?: string;
  rawTx?: Bytes | null;
  inputBEEF?: Bytes | null;
  [k: string]: unknown;
};
export type SnapChunk = {
  fromStorageIdentityKey?: string;
  toStorageIdentityKey?: string;
  userIdentityKey?: string;
  user?: unknown;
  provenTxs?: SnapProven[];
  provenTxReqs?: SnapReq[];
  outputBaskets?: { basketId?: number; name?: string; [k: string]: unknown }[];
  outputTags?: unknown[];
  txLabels?: unknown[];
  transactions?: SnapTx[];
  txLabelMaps?: unknown[];
  commissions?: unknown[];
  outputs?: SnapOutput[];
  outputTagMaps?: unknown[];
  certificates?: unknown[];
  certificateFields?: unknown[];
};
export type SnapshotPage = { version: number; lean: boolean; chunk: SnapChunk; next: number | null };

/** The page refused: nothing of it is merged. */
export class SnapshotRefused extends Error {
  constructor(why: string) {
    super(`snapshot refused: ${why}`);
    this.name = 'SnapshotRefused';
  }
}

const ENTITY_KEYS = [
  'provenTxs',
  'provenTxReqs',
  'outputBaskets',
  'outputTags',
  'txLabels',
  'transactions',
  'txLabelMaps',
  'commissions',
  'outputs',
  'outputTagMaps',
  'certificates',
  'certificateFields',
] as const;

/** As the toolbox's own client does for a pulled page (validateSyncChunkEntities, not exported by 2.14.5). */
export function normalizeChunk(raw: unknown): SnapChunk {
  if (!raw || typeof raw !== 'object') throw new SnapshotRefused('no chunk');
  const c = raw as Record<string, unknown>;
  for (const k of ENTITY_KEYS) {
    const v = c[k];
    if (v == null) continue;
    if (!Array.isArray(v)) throw new SnapshotRefused(`${k} is not a list`);
    c[k] = v.map((e) => normalizeEntity(e));
  }
  return c as SnapChunk;
}
function normalizeEntity(e: unknown): unknown {
  if (!e || typeof e !== 'object') throw new SnapshotRefused('a row is not an object');
  const o = e as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === null) o[k] = undefined;
    else if (v instanceof Uint8Array) o[k] = Array.from(v);
  }
  for (const k of ['created_at', 'updated_at']) if (o[k] !== undefined) o[k] = toDate(o[k]);
  return o;
}
const toDate = (v: unknown): Date => {
  const d = v instanceof Date ? v : new Date(v as string | number);
  if (Number.isNaN(d.getTime())) throw new SnapshotRefused('a row has a bad date');
  return d;
};

const HEX64 = /^[0-9a-f]{64}$/i;
const hexOf = (b: Bytes | null | undefined) => (b && b.length ? Utils.toHex(Array.from(b)) : '');

/** A page's identity, cursor and unexpected rows. Returns its normalised chunk. */
function checkEnvelope(
  raw: unknown,
  want: { lean: boolean; identityKey: string; after: number },
): {
  chunk: SnapChunk;
  next: number | null;
} {
  const p = raw as Partial<SnapshotPage> | null;
  if (!p || typeof p !== 'object' || p.version !== 1) throw new SnapshotRefused('not a version 1 page');
  if (p.lean !== want.lean) throw new SnapshotRefused('the page is not the kind asked for');
  const next = p.next ?? null;
  if (next !== null && (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= want.after))
    throw new SnapshotRefused('the cursor does not move forward');
  const chunk = normalizeChunk(p.chunk);
  if (chunk.userIdentityKey !== undefined && chunk.userIdentityKey !== want.identityKey)
    throw new SnapshotRefused('the page is for another identity');
  // A snapshot copies coins: it never changes which store is active (no user row), and carries nothing else.
  delete chunk.user;
  for (const k of ['txLabels', 'txLabelMaps', 'commissions', 'certificates', 'certificateFields'] as const)
    if (chunk[k]?.length) throw new SnapshotRefused(`unexpected ${k}`);
  if (want.lean && (chunk.provenTxs?.length || chunk.provenTxReqs?.length))
    throw new SnapshotRefused('a lean page carries proofs');
  return { chunk, next };
}

/** Is this coin a token (BSV-20/21) by its script? Such a coin is never spent as change. */
const bearsToken = (o: SnapOutput) => {
  const hex = hexOf(o.lockingScript);
  return !!hex && tokenFacts(hex, o.txid, o.vout) !== null;
};

export type PageReport = {
  /** Coins taken in as spendable. */
  coins: string[];
  /** Coins taken in held back (not spendable): anything but wallet change, tokens, no script, a mismatch. */
  held: number;
  sats: number;
  /** Coins in the default basket, held or not (compared with the 1Sat backup's count). */
  defaultCoins: number;
  /** Rows this device already holds that their verified transaction contradicts: held after the merge. */
  holds?: { outputId: number; updated_at?: Date }[];
};

/**
 * Output rows new to the device: shape, own transaction, spendable, no spend link. Only wallet change (the toolbox's
 * own BRC-29 change, no token script) arrives spendable; every other coin (a site's output, a token, an inscription, a
 * coin with no script) arrives held, not spendable, and today's checks admit it (the ordinary pull puts it on the
 * admission list: inboundSync.admissibleRow, recordAgrees, then the chain). `mismatch`: coins whose verified
 * transaction says otherwise, held too (review, 20 Nov 2026).
 */
function checkNewOutputs(
  chunk: SnapChunk,
  outputs: SnapOutput[],
  report: PageReport,
  txById: Map<number, SnapTx>,
  mismatch?: Set<SnapOutput>,
) {
  const basketName = new Map<number, string>();
  for (const b of chunk.outputBaskets ?? [])
    if (typeof b.basketId === 'number' && typeof b.name === 'string') basketName.set(b.basketId, b.name);
  for (const o of outputs) {
    if (typeof o.transactionId !== 'number') throw new SnapshotRefused('a coin has no transaction');
    const t = txById.get(o.transactionId);
    if (!t?.txid || !HEX64.test(t.txid)) throw new SnapshotRefused('a coin whose transaction is not on its page');
    if (o.txid && o.txid.toLowerCase() !== t.txid.toLowerCase()) throw new SnapshotRefused('a coin names another txid');
    o.txid = t.txid.toLowerCase();
    if (!Number.isSafeInteger(o.vout) || o.vout < 0) throw new SnapshotRefused('a coin has a bad output index');
    if (!Number.isSafeInteger(o.satoshis) || o.satoshis < 0) throw new SnapshotRefused('a coin has a bad amount');
    if (o.spendable !== true) throw new SnapshotRefused('a snapshot coin that is not spendable');
    o.spentBy = undefined;
    const name = typeof o.basketId === 'number' ? basketName.get(o.basketId) : undefined;
    // How complete the server's snapshot is (compared with the 1Sat backup's count), held or not.
    if (name === 'default') report.defaultCoins++;
    if (!o.lockingScript?.length || !isWalletChange(o as never) || bearsToken(o) || mismatch?.has(o)) {
      o.spendable = false;
      report.held++;
      continue;
    }
    report.coins.push(`${o.txid}.${o.vout}`);
    report.sats += o.satoshis;
  }
}

const txMap = (chunk: SnapChunk) => {
  const m = new Map<number, SnapTx>();
  for (const t of chunk.transactions ?? []) {
    if (typeof t.transactionId !== 'number' || !t.txid || !HEX64.test(t.txid))
      throw new SnapshotRefused('a transaction row without an id or txid');
    m.set(t.transactionId, t);
  }
  return m;
};

/**
 * A lean page as this device takes it in. Transactions: no bytes, no proof link, stamped old. Coins: see
 * checkNewOutputs. Mutates and returns the chunk; throws SnapshotRefused (nothing merged).
 */
export function checkLeanPage(raw: unknown, want: { identityKey: string; after: number }) {
  const { chunk, next } = checkEnvelope(raw, { ...want, lean: true });
  const txById = txMap(chunk);
  for (const t of txById.values()) {
    t.rawTx = undefined;
    t.inputBEEF = undefined;
    t.provenTxId = undefined;
    t.updated_at = LEAN_STAMP;
  }
  const report: PageReport = { coins: [], held: 0, sats: 0, defaultCoins: 0 };
  checkNewOutputs(chunk, chunk.outputs ?? [], report, txById);
  return { chunk, next, report };
}

export type ChainTrackerLike = { isValidRootForHeight(root: string, height: number): Promise<boolean> };

/**
 * One proof row, as the toolbox's validateSyncProof checks it (not exported by 2.14.5): its raw transaction hashes to
 * its txid, its Merkle path is at its height and holds the txid at its index, the path's root is the row's, and the
 * wallet's own chain tracker (headers from a second source) knows that root at that height.
 */
export async function verifyProvenRow(p: SnapProven, tracker: ChainTrackerLike): Promise<void> {
  const bad = (why: string): never => {
    throw new SnapshotRefused(`proof for ${String(p?.txid).slice(0, 12)}…: ${why}`);
  };
  if (!p || typeof p.txid !== 'string' || !HEX64.test(p.txid)) bad('no txid');
  const txid = p.txid.toLowerCase();
  if (!Number.isSafeInteger(p.height) || p.height < 0) bad('bad height');
  if (!Number.isSafeInteger(p.index) || p.index < 0) bad('bad index');
  if (txidOfRaw(p.rawTx) !== txid) bad('raw transaction is not this txid');
  let path: MerklePath;
  try {
    path = MerklePath.fromBinary(Array.from(p.merklePath ?? []));
  } catch {
    return bad('unreadable Merkle path');
  }
  if (path.blockHeight !== p.height) bad('Merkle path is at another height');
  const leaf = path.path[0]?.find((l) => l.txid === true && l.hash === txid);
  if (leaf?.offset !== p.index) bad('Merkle path does not hold the txid at its index');
  let root: string;
  try {
    root = path.computeRoot(txid);
  } catch {
    return bad('Merkle path does not compute');
  }
  if (typeof p.merkleRoot !== 'string' || root !== p.merkleRoot.toLowerCase()) bad('root differs from the record');
  let ok = false;
  try {
    ok = (await tracker.isValidRootForHeight(root, p.height)) === true;
  } catch {
    ok = false;
  }
  if (!ok) bad('the block headers do not have this root at this height');
}

/** What the full-page check reads from the device store. */
export type HeldLookup = {
  /** The device's row for this txid, if any (no bytes). */
  tx(txid: string): Promise<{ rawTx?: Bytes | null; provenTxId?: number | null } | undefined>;
  /** The device's row for this coin (any state), if it holds it. */
  row(txid: string, vout: number): Promise<SnapOutput | undefined>;
  /** The transaction as this device holds it (its own or already-verified bytes), if it does. */
  raw(txid: string): Promise<Transaction | undefined>;
  /** Does the device hold a proof request for this txid? */
  hasReq(txid: string): Promise<boolean>;
};

/**
 * A full page as this device takes it in: every proof verified against the headers first (one bad proof refuses the
 * whole page); broadcast records new to the device with their bytes checked, SPV-verified, cut to their ancestors and
 * arriving as 'nosend' (the Monitor never sends one on a page's word); rows the device already holds keep the device's
 * version (stamped old, so the merge only maps their ids), except a lean stub, which takes the real row; new coins as
 * in a lean page.
 */
export async function checkFullPage(
  raw: unknown,
  want: { identityKey: string; after: number },
  tracker: ChainTrackerLike,
  held: HeldLookup,
  owns?: (row: SnapOutput, scriptHex: string) => Promise<boolean>,
) {
  const { chunk, next } = checkEnvelope(raw, { ...want, lean: false });
  /** Transactions whose bytes this page proves: by proof against the headers, or by SPV with their input BEEF. */
  const verified = new Map<string, Transaction>();
  for (const p of chunk.provenTxs ?? []) {
    await verifyProvenRow(p, tracker);
    verified.set(p.txid.toLowerCase(), Transaction.fromBinary(Array.from(p.rawTx)));
  }
  const reqs: SnapReq[] = [];
  for (const q of chunk.provenTxReqs ?? []) {
    const txid = q.txid?.toLowerCase();
    if (!txid || txidOfRaw(q.rawTx) !== txid)
      throw new SnapshotRefused('a broadcast record whose bytes are not its txid');
    if (await held.hasReq(txid)) continue;
    if (['failed', 'invalid', 'doubleSpend', 'unfail'].includes(String(q.status)))
      throw new SnapshotRefused('a spendable coin from a failed transaction');
    q.inputBEEF = q.inputBEEF?.length ? ancestorsOnly(q.inputBEEF, q.rawTx) : undefined;
    if (!(await spvValid(txid, q.rawTx!, q.inputBEEF ?? undefined, tracker)))
      throw new SnapshotRefused('a broadcast record that does not verify against the headers');
    verified.set(txid, Transaction.fromBinary(Array.from(q.rawTx!)));
    q.history = '{}';
    q.batch = undefined;
    if (q.status !== 'completed') {
      q.status = 'nosend';
      freshProofState(q as never);
    }
    reqs.push(q);
  }
  chunk.provenTxReqs = reqs;
  const txById = txMap(chunk);
  for (const t of txById.values()) {
    if (t.rawTx?.length && txidOfRaw(t.rawTx) !== t.txid!.toLowerCase())
      throw new SnapshotRefused('a transaction row whose bytes are not its txid');
    t.inputBEEF = t.inputBEEF?.length ? ancestorsOnly(t.inputBEEF, t.rawTx) : undefined;
    const d = await held.tx(t.txid!.toLowerCase());
    const leanStub = d && !d.rawTx?.length && d.provenTxId == null;
    if (d && !leanStub) t.updated_at = LEAN_STAMP;
  }
  const report: PageReport = { coins: [], held: 0, sats: 0, defaultCoins: 0, holds: [] };
  const fresh: SnapOutput[] = [];
  const mismatch = new Set<SnapOutput>();
  /** Does this coin row say what its verified transaction says (amount, script, and it pays this wallet)? */
  const agrees = async (row: SnapOutput, tx: Transaction) => {
    const out = tx.outputs[row.vout];
    if (!out || out.satoshis !== row.satoshis) return false;
    const script = out.lockingScript.toHex();
    if (row.lockingScript?.length && hexOf(row.lockingScript) !== script) return false;
    if (owns && isWalletChange(row as never) && !(await owns(row, script).catch(() => false))) return false;
    return true;
  };
  for (const o of chunk.outputs ?? []) {
    const t = typeof o.transactionId === 'number' ? txById.get(o.transactionId) : undefined;
    const txid = t?.txid?.toLowerCase();
    const mine = txid ? await held.row(txid, o.vout) : undefined;
    // From here on this device builds the coin's BEEF from its own data and no spend-time check runs again (stage 2),
    // so the coin is checked now against the transaction this page (or the device) has verified (review, 20 Nov 2026).
    const tx = txid
      ? (verified.get(txid) ??
        (t?.rawTx?.length ? Transaction.fromBinary(Array.from(t.rawTx)) : undefined) ??
        (await held.raw(txid)))
      : undefined;
    if (mine) {
      // The device's own row stands (a payment may have spent it since): the merge only maps it.
      o.updated_at = LEAN_STAMP;
      o.spentBy = undefined;
      if (mine.spendable && tx && typeof mine.outputId === 'number' && !(await agrees(mine, tx)))
        report.holds!.push({ outputId: mine.outputId, updated_at: mine.updated_at });
      continue;
    }
    if (tx && !(await agrees(o, tx))) mismatch.add(o);
    fresh.push(o);
  }
  checkNewOutputs(chunk, fresh, report, txById, mismatch);
  return { chunk, next, report };
}

/** An unproven transaction with its input BEEF: full SPV (scripts and every ancestor's proof) against the headers. */
async function spvValid(txid: string, rawTx: Bytes, inputBEEF: Bytes | undefined, tracker: ChainTrackerLike) {
  try {
    const beef = inputBEEF?.length ? Beef.fromBinary(Array.from(inputBEEF)) : new Beef();
    beef.mergeRawTx(Array.from(rawTx));
    const tx = beef.findAtomicTransaction(txid);
    if (!tx) return false;
    return (await tx.verify(tracker as never)) === true;
  } catch {
    return false;
  }
}

// ── the device store ──

/** The StorageIdb calls used here. */
export type SnapshotDevice = {
  getSettings(): { storageIdentityKey: string };
  findOrInsertUser(identityKey: string): Promise<{ user: { userId: number } }>;
  findOrInsertSyncStateAuth(
    auth: { identityKey: string; userId: number },
    storageIdentityKey: string,
    storageName: string,
  ): Promise<{ syncState: { syncStateId?: number } }>;
  findSyncStates(a: { partial: Record<string, unknown> }): Promise<unknown[]>;
  findOutputs(a: {
    partial: Record<string, unknown>;
    noScript?: boolean;
    paged?: { limit: number; offset?: number };
  }): Promise<SnapOutput[]>;
  findTransactions(a: {
    partial: Record<string, unknown>;
    noRawTx?: boolean;
    paged?: { limit: number; offset?: number };
  }): Promise<SnapTx[]>;
  findProvenTxReqs(a: { partial: Record<string, unknown> }): Promise<unknown[]>;
  getProvenOrRawTx(txid: string): Promise<{ proven?: unknown; rawTx?: Bytes }>;
  updateOutput(id: number, update: Record<string, unknown>): Promise<unknown>;
};

/** Our server's client (StorageClient: rpcCall is protected in its types, public at run time). */
export type SnapshotClient = {
  rpcCall(method: string, params: unknown[]): Promise<unknown>;
  getSettings?(): { storageIdentityKey?: string } | undefined;
};

/**
 * A device that has never synced with our server: no sync state for it (the real one), and nothing in its store but
 * what an earlier snapshot run left (its own sync state then exists; the run starts again, merges are idempotent).
 */
export async function freshForSnapshot(device: SnapshotDevice, userId: number, serverSik: string): Promise<boolean> {
  const real = await device.findSyncStates({ partial: { userId, storageIdentityKey: serverSik } });
  if (real.length) return false;
  const snap = await device.findSyncStates({
    partial: { userId, storageIdentityKey: serverSik + SNAPSHOT_SYNC_SUFFIX },
  });
  if (snap.length) return true;
  const outs = await device.findOutputs({ partial: { userId }, noScript: true, paged: { limit: 1 } });
  const txs = await device.findTransactions({ partial: { userId }, noRawTx: true, paged: { limit: 1 } });
  return outs.length === 0 && txs.length === 0;
}

type RunArgs = {
  client: SnapshotClient;
  device: SnapshotDevice;
  identityKey: string;
  serverSik: string;
  lean: boolean;
  /** Required for full pages: the wallet's own chain tracker. */
  tracker?: ChainTrackerLike;
  /** Does a script pay the wallet's key from the row's derivation (inboundSync.walletOwnership)? Full pages. */
  owns?: (row: SnapOutput, scriptHex: string) => Promise<boolean>;
  /** Each page's merge (and its holds) runs inside this: the storage manager's locks (review, 20 Nov 2026). */
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  after?: number;
  limit?: number;
  /** After each merged page: the cursor to resume from (null = done) and what it brought. */
  onPage?: (next: number | null, report: PageReport) => void | Promise<void>;
  pageMs?: number;
};

/** Pull and merge snapshot pages until the server says there are no more. Throws on any refusal or failure. */
export async function runSnapshot(a: RunArgs): Promise<PageReport> {
  const deviceSik = a.device.getSettings().storageIdentityKey;
  const name = a.serverSik + SNAPSHOT_SYNC_SUFFIX;
  const { user } = await a.device.findOrInsertUser(a.identityKey);
  const { syncState } = await a.device.findOrInsertSyncStateAuth(
    { identityKey: a.identityKey, userId: user.userId },
    name,
    name,
  );
  const merge = unguardedProcessSyncChunk(a.device);
  const total: PageReport = { coins: [], held: 0, sats: 0, defaultCoins: 0 };
  const held: HeldLookup = {
    tx: async (txid) =>
      (await a.device.findTransactions({ partial: { userId: user.userId, txid }, noRawTx: false }))[0] as never,
    row: async (txid, vout) => (await a.device.findOutputs({ partial: { userId: user.userId, txid, vout } }))[0],
    raw: async (txid) => {
      const r = await a.device
        .getProvenOrRawTx(txid)
        .catch(() => ({}) as { proven?: { rawTx?: Bytes }; rawTx?: Bytes });
      const bytes = (r.proven as { rawTx?: Bytes } | undefined)?.rawTx ?? r.rawTx;
      return bytes?.length ? Transaction.fromBinary(Array.from(bytes)) : undefined;
    },
    hasReq: async (txid) => (await a.device.findProvenTxReqs({ partial: { txid } })).length > 0,
  };
  let after = a.after ?? 0;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_PAGES) throw new SnapshotRefused('too many pages');
    const raw = await withTimeout(
      a.client.rpcCall('getSpendableSnapshot', [
        {
          lean: a.lean,
          after,
          ...(a.limit ? { limit: a.limit } : {}),
          toStorageIdentityKey: deviceSik,
          identityKey: a.identityKey,
        },
      ]),
      a.pageMs ?? PAGE_MS,
      'our storage server (snapshot page)',
    );
    const want = { identityKey: a.identityKey, after };
    let checked;
    if (a.lean) checked = checkLeanPage(raw, want);
    else {
      if (!a.tracker) throw new Error('a full snapshot needs the chain tracker');
      checked = await checkFullPage(raw, want, a.tracker, held, a.owns);
    }
    const { chunk, next, report } = checked;
    const rows = ENTITY_KEYS.reduce((n, k) => n + (chunk[k]?.length ?? 0), 0);
    const lock = a.withLock ?? (<T>(fn: () => Promise<T>) => fn());
    await lock(async () => {
      if (rows)
        await merge(
          {
            fromStorageIdentityKey: name,
            toStorageIdentityKey: deviceSik,
            identityKey: a.identityKey,
            since: undefined,
            maxRoughSize: 0,
            maxItems: 0,
            offsets: [],
            syncStateId: syncState.syncStateId,
          },
          { ...chunk, fromStorageIdentityKey: name, toStorageIdentityKey: deviceSik, userIdentityKey: a.identityKey },
        );
      for (const h of report.holds ?? []) await holdRow(a.device, h);
    });
    total.coins.push(...report.coins);
    total.held += report.held;
    total.sats += report.sats;
    total.defaultCoins += report.defaultCoins;
    await a.onPage?.(next, report);
    if (next === null) return total;
    after = next;
  }
}

/**
 * After a refused or abandoned snapshot: every spendable coin whose transaction has no raw bytes or proof on this
 * device (what the snapshot brought unverified) is held back, not spendable. The ordinary pull then puts them on the
 * admission list and the chain decides, exactly as for a restore without the snapshot. Returns how many.
 */
export async function holdUnverified(device: SnapshotDevice, userId: number): Promise<number> {
  const PAGE = 500;
  const ids: { outputId: number; updated_at?: Date }[] = [];
  const known = new Map<string, boolean>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await device.findOutputs({
      partial: { userId, spendable: true },
      noScript: true,
      paged: { limit: PAGE, offset },
    });
    for (const o of page) {
      const txid = o.txid?.toLowerCase();
      if (!txid || typeof o.outputId !== 'number') continue;
      if (!known.has(txid)) {
        const r = await device.getProvenOrRawTx(txid).catch(() => ({}) as { proven?: unknown; rawTx?: Bytes });
        known.set(txid, !!r.proven || !!r.rawTx?.length);
      }
      if (!known.get(txid)) ids.push({ outputId: o.outputId, updated_at: o.updated_at });
    }
    if (page.length < PAGE) break;
  }
  for (const id of ids) await holdRow(device, id);
  return ids.length;
}

/**
 * Hold one coin on this device only: not spendable, its own time kept (review, 20 Nov 2026). A new time would make
 * every later push carry "not spendable" to our server, to 1Sat and to the owner's other devices; with the row's own
 * time a backup's equal copy wins nothing and keeps its own word, and this device's ordinary pull still puts the coin
 * on its admission list (inboundSync: a coin held here that a backup calls spendable).
 */
export async function holdRow(device: SnapshotDevice, row: { outputId: number; updated_at?: Date }): Promise<void> {
  await device.updateOutput(row.outputId, {
    spendable: false,
    ...(row.updated_at ? { updated_at: row.updated_at } : {}),
  });
}

// ── 2. pay before the rest arrives ──

type BeefAnswer = {
  version?: number;
  beef?: Bytes | null;
  included?: string[];
  notFound?: string[];
  spent?: string[];
  deferred?: string[];
  tooLarge?: string[];
  unavailable?: string[];
};

export type SnapshotBeefDeps = {
  client: () => SnapshotClient | undefined;
  tracker: () => Promise<ChainTrackerLike>;
  identityKey: () => Promise<string>;
  /** Optional: does this script pay a key the wallet derives from the row's own derivation? */
  owns?: (row: SnapOutput, scriptHex: string) => Promise<boolean>;
  maxOutpoints?: number;
  log?: (...a: unknown[]) => void;
};

type GetBeefs = (this: unknown, txids: string[], options?: { mergeToBeef?: Beef | number[] }) => Promise<Beef>;
type GetBeef = (this: unknown, txid: string, options?: { mergeToBeef?: Beef | number[] }) => Promise<Beef>;
const HOOKED = Symbol.for('bwx.spendableFirst.beef');

/**
 * Fetch the BEEF of `txids` (coins this device holds without their transaction's bytes) from our server, and verify
 * it before anything may use it. Throws SnapshotRefused on anything that does not verify.
 */
export async function fetchVerifiedBeef(
  device: SnapshotDevice,
  userId: number,
  txids: string[],
  d: SnapshotBeefDeps,
): Promise<Beef> {
  const client = d.client();
  if (!client) throw new SnapshotRefused('our storage server is not connected');
  const rows = new Map<string, SnapOutput[]>();
  const outpoints: string[] = [];
  for (const txid of txids) {
    const outs = await device.findOutputs({ partial: { userId, txid } });
    if (!outs.length) throw new SnapshotRefused(`no coin of ${txid.slice(0, 12)}… on this device`);
    rows.set(txid, outs);
    for (const o of outs) outpoints.push(`${txid}.${o.vout}`);
  }
  const max = Math.max(1, d.maxOutpoints ?? 25);
  const identityKey = await d.identityKey();
  const beef = new Beef();
  for (let i = 0; i < outpoints.length; i += max) {
    const r = (await withTimeout(
      client.rpcCall('getBeefForOutpoints', [{ outpoints: outpoints.slice(i, i + max), identityKey }]),
      BEEF_MS,
      'our storage server (coin data)',
    )) as BeefAnswer;
    if (r?.version !== 1) throw new SnapshotRefused('not a version 1 answer');
    if (r.beef && (r.beef as Bytes).length) beef.mergeBeef(Array.from(r.beef as Bytes));
  }
  const tracker = await d.tracker();
  const out = new Beef();
  for (const txid of txids) {
    let tx: Transaction | undefined;
    try {
      tx = beef.findAtomicTransaction(txid);
    } catch {
      tx = undefined;
    }
    if (!tx || tx.id('hex') !== txid) throw new SnapshotRefused(`no data for ${txid.slice(0, 12)}…`);
    let ok = false;
    try {
      ok = (await tx.verify(tracker as never)) === true;
    } catch (e) {
      d.log?.('[spendable-first] coin data did not verify:', e);
      ok = false;
    }
    if (!ok) throw new SnapshotRefused(`coin data for ${txid.slice(0, 12)}… does not verify against the headers`);
    for (const row of rows.get(txid) ?? []) {
      // A coin its verified transaction contradicts is refused AND held (review, 20 Nov 2026): never offered again.
      const refuse = (why: string): never => {
        throw Object.assign(new SnapshotRefused(`${txid.slice(0, 12)}…:${row.vout} ${why}`), { hold: [row] });
      };
      const o = tx.outputs[row.vout];
      if (!o) refuse('has no such output');
      if (o.satoshis !== row.satoshis) refuse('amount differs');
      const script = o.lockingScript.toHex();
      if (row.lockingScript?.length && hexOf(row.lockingScript) !== script) refuse('script differs');
      if (d.owns && isWalletChange(row as never) && !(await d.owns(row, script).catch(() => false)))
        refuse('does not pay this wallet');
    }
    // Only this transaction and its ancestors (beefAncestors.ts): nothing else rides along to the broadcaster.
    out.mergeTransaction(tx);
  }
  return out;
}

/**
 * Hook the device store's BEEF builders (StorageIdb getBeefForTransaction(s): createAction's coin data, listOutputs'
 * entire transactions). A txid whose transaction this device holds without raw bytes or proof, which today ends in
 * "valid transaction on chain" (createAction asks storage only), is fetched from our server and verified first
 * (fetchVerifiedBeef); everything else goes to the toolbox as before. A failure throws: nothing is signed. Returns the
 * uninstall. Idempotent per store.
 */
export function installSnapshotBeef(device: SnapshotDevice, d: SnapshotBeefDeps): () => void {
  const s = device as unknown as Record<string | symbol, unknown> & {
    getBeefForTransactions?: GetBeefs;
    getBeefForTransaction?: GetBeef;
  };
  if (s[HOOKED]) return () => undefined;
  const many = s.getBeefForTransactions;
  const one = s.getBeefForTransaction;
  const create = (s as { createAction?: (...a: unknown[]) => Promise<unknown> }).createAction;
  if (typeof many !== 'function' || typeof one !== 'function') return () => undefined;
  s[HOOKED] = true;
  /**
   * Coins a refusal holds. Inside createAction the hold waits for it to end: the toolbox frees a failed payment's inputs
   * (spendable again) in its own error path, after this throw, and the hold must come after that.
   */
  const pending: SnapOutput[] = [];
  let inCreate = 0;
  const flush = async () => {
    while (pending.length) {
      const row = pending.shift()!;
      if (typeof row.outputId === 'number')
        await holdRow(device, { outputId: row.outputId, updated_at: row.updated_at }).catch((e: unknown) =>
          d.log?.('[spendable-first] a refused coin was not held:', e),
        );
    }
  };
  const verifiedBeef = async (need: string[]) => {
    try {
      return await fetchVerifiedBeef(device, await userId(), need, d);
    } catch (e) {
      const hold = (e as { hold?: SnapOutput[] }).hold;
      if (hold?.length) {
        pending.push(...hold);
        if (!inCreate) await flush();
      }
      throw e;
    }
  };
  if (typeof create === 'function')
    (s as { createAction?: unknown }).createAction = async function (this: unknown, ...args: unknown[]) {
      inCreate++;
      try {
        return await create.apply(this, args);
      } finally {
        if (--inCreate === 0) await flush();
      }
    };
  const userId = async () => (await device.findOrInsertUser(await d.identityKey())).user.userId;
  /** The txids this device can't build BEEF for from its own data. */
  const lacking = async (txids: string[]) => {
    const out: string[] = [];
    for (const t of txids) {
      const r = await device.getProvenOrRawTx(t).catch(() => ({}) as { proven?: unknown; rawTx?: Bytes });
      if (r.proven || r.rawTx?.length) continue;
      const uid = await userId();
      if ((await device.findTransactions({ partial: { userId: uid, txid: t }, noRawTx: true })).length) out.push(t);
    }
    return out;
  };
  const into = (b: Beef, options?: { mergeToBeef?: Beef | number[] }) => {
    const m = options?.mergeToBeef;
    if (!m) return b;
    const target = Array.isArray(m) ? Beef.fromBinary(m) : m;
    target.mergeBeef(b);
    return target;
  };
  s.getBeefForTransactions = async function (this: unknown, txids: string[], options) {
    const need = await lacking(txids);
    if (!need.length) return many.call(this, txids, options);
    const fetched = await verifiedBeef(need);
    const rest = txids.filter((t) => !need.includes(t));
    const beef = rest.length ? await many.call(this, rest, { ...options, mergeToBeef: undefined }) : new Beef();
    beef.mergeBeef(fetched);
    return into(beef, options);
  };
  s.getBeefForTransaction = async function (this: unknown, txid: string, options) {
    const need = await lacking([txid]);
    if (!need.length) return one.call(this, txid, options);
    return into(await verifiedBeef(need), options);
  };
  return () => {
    s.getBeefForTransactions = many;
    s.getBeefForTransaction = one;
    if (typeof create === 'function') (s as { createAction?: unknown }).createAction = create;
    delete s[HOOKED];
  };
}

// ── 1. the restore ──

export type SpendableFirstOutcome =
  | { used: true; coins: number; sats: number; held: number }
  | { used: false; reason: string };

export type SpendableFirstDeps = {
  /** The flag (spendableFirstOn). Off: nothing else is asked. */
  enabled: () => Promise<boolean>;
  /** A client for our server, connected (BRC-103 session); undefined or throws = no server. */
  client: () => Promise<SnapshotClient | undefined>;
  device: () => SnapshotDevice | undefined;
  identityKey: () => Promise<string>;
  /** The 1Sat backup's count of spendable default-basket coins, if cheap to know (else undefined). */
  backupDefaultCoins?: () => Promise<number | undefined>;
  /** Make this device's store the active one without copying the backup (remote-active accounts only). */
  makeDeviceActive?: () => Promise<void>;
  onPhase?: (phase: 'lean' | null) => void;
  log?: (...a: unknown[]) => void;
};

/**
 * Stage 1. Never throws: { used: false } means today's path runs, and in that case nothing the snapshot brought stays
 * spendable (holdUnverified).
 */
export async function restoreSpendableFirst(d: SpendableFirstDeps): Promise<SpendableFirstOutcome> {
  const log = d.log ?? (() => undefined);
  const no = (reason: string): SpendableFirstOutcome => {
    log('[spendable-first] not used:', reason);
    return { used: false, reason };
  };
  try {
    if (!(await d.enabled())) return { used: false, reason: 'off' };
  } catch {
    return { used: false, reason: 'off' };
  }
  let client: SnapshotClient | undefined;
  try {
    client = await d.client();
  } catch (e) {
    return no(`our server is not reachable: ${String(e)}`);
  }
  if (!client) return no('our server is not reachable');
  try {
    const caps = await withTimeout(client.rpcCall('getCapabilities', []), CAPS_MS, 'our storage server');
    if (!snapshotCapability(caps)) return no('our server does not offer the snapshot');
  } catch (e) {
    return no(`capabilities: ${String(e)}`);
  }
  const device = d.device();
  const serverSik = client.getSettings?.()?.storageIdentityKey;
  if (!device || !serverSik) return no('no device store or server key');
  let identityKey: string;
  let userId: number;
  try {
    identityKey = await d.identityKey();
    userId = (await device.findOrInsertUser(identityKey)).user.userId;
    if (!(await freshForSnapshot(device, userId, serverSik))) return no('this device has synced before');
  } catch (e) {
    return no(`device store: ${String(e)}`);
  }
  // From here on rows may land: any failure holds them back before today's path runs.
  let merged = false;
  const fallBack = async (reason: string) => {
    if (merged) {
      const n = await holdUnverified(device, userId).catch(() => 0);
      log(`[spendable-first] ${n} snapshot coin(s) held back for the ordinary checks`);
    }
    return no(reason);
  };
  d.onPhase?.('lean');
  try {
    const backupCount = d.backupDefaultCoins ? d.backupDefaultCoins().catch(() => undefined) : undefined;
    const total = await runSnapshot({
      client,
      device,
      identityKey,
      serverSik,
      lean: true,
      onPage: (_next, r) => {
        if (r.coins.length || r.held) merged = true;
      },
    });
    if (!total.coins.length && !total.held) return await fallBack('our server holds no coins for this wallet');
    const theirs = await backupCount;
    if (typeof theirs === 'number' && total.defaultCoins < theirs)
      return await fallBack(`our server is behind the backup (${total.defaultCoins} of ${theirs} coins)`);
    if (d.makeDeviceActive) await d.makeDeviceActive();
    log(`[spendable-first] ${total.coins.length} coin(s), ${total.sats} sats from the snapshot; ${total.held} held`);
    return { used: true, coins: total.coins.length, sats: total.sats, held: total.held };
  } catch (e) {
    return await fallBack(e instanceof Error ? e.message : String(e));
  } finally {
    d.onPhase?.(null);
  }
}

// ── 3. the full snapshot, in the background ──

export type SnapshotMark = { stage: 'full' | 'done' | 'refused'; after: number; at: number };
export const SNAPSHOT_MARK_KEY = (identityAddress: string) => `bwxSpendableSnapshot:${identityAddress}`;

/**
 * Stage 3, resumable: lean:false pages from `mark.after`, each proof checked before its page merges. A refused page
 * ends it ('refused') and holds back what is still unverified; a network failure leaves the mark where it got to.
 */
export async function runFullSnapshot(a: {
  client: SnapshotClient;
  device: SnapshotDevice;
  identityKey: string;
  serverSik: string;
  tracker: ChainTrackerLike;
  owns?: (row: SnapOutput, scriptHex: string) => Promise<boolean>;
  withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  mark: SnapshotMark;
  save: (m: SnapshotMark) => Promise<void>;
  log?: (...a: unknown[]) => void;
}): Promise<SnapshotMark> {
  let mark = a.mark;
  try {
    await runSnapshot({
      client: a.client,
      device: a.device,
      identityKey: a.identityKey,
      serverSik: a.serverSik,
      lean: false,
      tracker: a.tracker,
      owns: a.owns,
      withLock: a.withLock,
      after: mark.after,
      onPage: async (next) => {
        mark =
          next === null ? { stage: 'done', after: 0, at: Date.now() } : { stage: 'full', after: next, at: Date.now() };
        await a.save(mark);
      },
    });
    return mark;
  } catch (e) {
    if (!(e instanceof SnapshotRefused)) {
      a.log?.('[spendable-first] background snapshot paused:', e);
      return mark;
    }
    a.log?.('[spendable-first] background snapshot refused; holding unverified coins:', e.message);
    const { user } = await a.device.findOrInsertUser(a.identityKey);
    await holdUnverified(a.device, user.userId).catch(() => 0);
    mark = { stage: 'refused', after: 0, at: Date.now() };
    await a.save(mark);
    return mark;
  }
}
