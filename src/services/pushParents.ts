/**
 * Every push page this device sends a backup carries the rows its own rows are filed under (owner's iPhone, 6-7 Nov
 * 2026: every push to wallet.1sat.app failed with "An internal error has occurred.").
 *
 * The toolbox files a pushed row under its parent through the backup's sync map for this device: an output under
 * `syncMap.transaction.idMap[output.transactionId]`, a label link under the transaction's and the label's, a tag link
 * under the output's and the tag's. The map only learns a parent from a page that carried it. A transaction this device
 * took in from a backup keeps the backup's (older) time, so a push from the backup's cursor never carries it, while the
 * coins under it, changed here since (admitted, spent), are carried. The backup then looks the coin up with
 * `transactionId: undefined`: knex refuses the query, the server answers WERR_INTERNAL, and the push never gets past
 * that page. The phone's failing page: 34 of its 47 outputs belonged to transactions 416-425, all taken in from the
 * backup at ~02:36 on 6 Nov with times from 3-5 Nov.
 *
 * So, before a page goes:
 *  - Every parent a row on the page needs and the page doesn't hold is added: the transaction of each output, txLabelMap
 *    and commission, and the spender each output names; the label of each txLabelMap; the output (and its parents) and
 *    the tag of each outputTagMap. The backup finds each by its txid, label, tag or (transaction, vout), and records it
 *    in the map, so the rows under it file. Parents are read by key; nothing is scanned.
 *  - A parent older than the pass's cursor (the backup holds it already, or was sent it before) goes as a no-op: the
 *    epoch as its time, no proof id, no expiry state, no input BEEF. The backup's copy is never changed by it, so a
 *    completed transaction is never set back to unproven, whatever the clocks of the copies that wrote it. Nothing else
 *    is changed: status, txid, reference, amounts and raw bytes go as this device holds them (review 23, L1).
 *  - A no-op parent transaction goes in any state but unsigned or unprocessed: a backup that lacks it would fail those
 *    as abandoned and free their inputs. A row whose parent is one of those ends the page just before it: the rows
 *    before it go, it and the rest are not counted as read, and the pass waits there. Those states don't last on this
 *    device: the wallet's own TaskFailAbandoned fails such a transaction once it is 5 minutes old (abandonedMsecs,
 *    @1sat/wallet's factory), at the next monitor run (each wallet open), and a failed one goes. A page that would
 *    carry nothing is not sent: the push ends and the device sync retries on its back-off (reviews of 13196734,
 *    96f2cda1 and 721a7a7d).
 *  - A parent at or after the cursor is a row this pass owes the backup anyway (the paging skipped it): it goes
 *    unchanged, with its proof row, so the backup gets the whole row.
 *  - The page's paging stays exact. The backup adds every row of a page to that entity's offset, so rows are added only
 *    to an entity this pass has already read in full (getSyncChunk reads entities in order: a later entity's list on
 *    the page shows it). A quarter of the page's items and of its rough size at most go to parents (L2): the page's rows
 *    end where that runs out, nothing after them goes, and the next page goes on from there. What a page added is
 *    kept, before the page goes, in a small database of this file's own, and taken off the backup's offsets before the
 *    next page is read: a relaunch goes on exactly where the pass was. Only when that record doesn't fit the backup's
 *    offsets (or is lost) are the five entities that take parents read again from the pass's start (their rows come
 *    again as no-ops; none is skipped).
 *  - The wallet's own rows are never written: they are read, copied and sent.
 */

type Bytes = number[] | Uint8Array;
type Row = Record<string, unknown> & { updated_at?: Date | string };
type Rows = Row[] | undefined;

/** A sync page as getSyncChunk builds it (the entities this file reads or extends). */
export type PushPage = {
  user?: Row;
  provenTxs?: Row[];
  outputBaskets?: Row[];
  outputTags?: Row[];
  txLabels?: Row[];
  transactions?: Row[];
  outputs?: Row[];
  txLabelMaps?: Row[];
  outputTagMaps?: Row[];
  certificates?: Row[];
  certificateFields?: Row[];
  commissions?: Row[];
  provenTxReqs?: Row[];
};

export type PushArgs = {
  identityKey?: string;
  fromStorageIdentityKey?: string;
  toStorageIdentityKey?: string;
  since?: Date | string;
  offsets?: { name: string; offset: number }[];
  maxItems?: number;
  maxRoughSize?: number;
  includeNextCheckpoint?: boolean;
};

type Paged = { partial: Record<string, unknown>; since?: Date | string; paged?: { limit: number; offset: number } };

/** The reads this needs from the device store (StorageIdb). */
export type ParentStore = {
  getSettings?(): { storageIdentityKey?: string } | undefined;
  findUsers(a: { partial: { identityKey: string } }): Promise<{ userId?: number }[]>;
  findTransactions(a: Paged): Promise<Row[]>;
  findOutputs(a: Paged): Promise<Row[]>;
  findTxLabels(a: Paged): Promise<Row[]>;
  findOutputTags(a: Paged): Promise<Row[]>;
  findProvenTxs(a: Paged): Promise<Row[]>;
};

/** What a page was given. */
export type ParentsReport = {
  transactions: number;
  provenTxs: number;
  txLabels: number;
  outputTags: number;
  outputs: number;
  /** Of the rows above, those older than the cursor (sent as no-ops). */
  older: number;
  /** Children cut from the page for the next one (the parents' share of the page ran out). */
  deferred: number;
  /** Entities a parent was needed for but this pass hasn't read in full: left alone (getSyncChunk never builds one). */
  notExhausted: string[];
  /** The page ends before a row whose parent can't go yet: that parent. */
  waitsFor?: { txid: string; status: string };
  /** Per entity: rows added to the page. Goes into the offsets. */
  net: Partial<Record<PageKey, number>>;
};

/** A toolbox sync loop (syncToWriter) reading this store for another store: a push page. Never an export or a backup. */
export function isPushPage(store: ParentStore, args: PushArgs | undefined): boolean {
  const sik = store.getSettings?.()?.storageIdentityKey;
  return (
    !!sik &&
    args?.includeNextCheckpoint === true &&
    args.fromStorageIdentityKey === sik &&
    !!args.toStorageIdentityKey &&
    args.toStorageIdentityKey !== sik
  );
}

/** getSyncChunk's entity order: the page key and the offset name of each. */
const ORDER = [
  ['provenTxs', 'provenTx'],
  ['outputBaskets', 'outputBasket'],
  ['outputTags', 'outputTag'],
  ['txLabels', 'txLabel'],
  ['transactions', 'transaction'],
  ['outputs', 'output'],
  ['txLabelMaps', 'txLabelMap'],
  ['outputTagMaps', 'outputTagMap'],
  ['certificates', 'certificate'],
  ['certificateFields', 'certificateField'],
  ['commissions', 'commission'],
  ['provenTxReqs', 'provenTxReq'],
] as const;
type PageKey = (typeof ORDER)[number][0];
const NAME = Object.fromEntries(ORDER) as Record<PageKey, string>;
/** The entities that take parents: read again from the pass's start when the record of the pass is lost. */
const PARENT_ENTITIES = ['provenTx', 'outputTag', 'txLabel', 'transaction', 'output'];

/** A no-op parent may go in any state the backup's TaskFailAbandoned leaves alone (it fails aged unsigned and unprocessed). */
const sendableAsNoOp = (t: Row): boolean => t.status !== 'unsigned' && t.status !== 'unprocessed';

const time = (d: unknown): number =>
  d instanceof Date ? d.getTime() : d == null ? NaN : new Date(d as string).getTime();
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const sizeOf = (r: Row): number => {
  let n = 256;
  for (const k of ['rawTx', 'inputBEEF', 'lockingScript', 'merklePath'] as const) {
    const v = r[k] as Bytes | undefined;
    if (v && typeof v.length === 'number') n += v.length * 4; // a byte goes as up to 4 JSON characters
  }
  return n;
};
const ID_KEY: Partial<Record<PageKey, string>> = {
  provenTxs: 'provenTxId',
  outputTags: 'outputTagId',
  txLabels: 'txLabelId',
  transactions: 'transactionId',
  outputs: 'outputId',
};
type ParentKey = 'transactions' | 'outputs' | 'txLabels' | 'outputTags' | 'provenTxs';
type ChildKey = 'outputs' | 'txLabelMaps' | 'outputTagMaps' | 'commissions';

/**
 * Add to `page` the parents its rows need and it doesn't hold, and end the page before a row whose parent can't go yet
 * (see the file comment). Reads only.
 */
export async function addMissingParents(
  store: ParentStore,
  args: PushArgs,
  page: PushPage,
  opts: { filed?: Map<string, Set<number>> } = {},
): Promise<ParentsReport> {
  const report: ParentsReport = {
    transactions: 0,
    provenTxs: 0,
    txLabels: 0,
    outputTags: 0,
    outputs: 0,
    older: 0,
    deferred: 0,
    notExhausted: [],
    net: {},
  };
  const CHILD_KEYS: ChildKey[] = ['outputs', 'txLabelMaps', 'outputTagMaps', 'commissions'];
  const hasChildren = CHILD_KEYS.some((k) => (page[k] as Rows)?.length);
  if (!hasChildren || !args.identityKey) return report;
  const userId = num((await store.findUsers({ partial: { identityKey: args.identityKey } }))[0]?.userId);
  if (userId === undefined) return report;

  const since = args.since == null ? undefined : time(args.since);
  const inWindow = (r: Row) => since === undefined || time(r.updated_at) >= since;
  const ids = (key: PageKey) =>
    new Set(((page[key] as Rows) ?? []).map((r) => num(r?.[ID_KEY[key]!])).filter((v): v is number => v !== undefined));
  const onPage: Record<ParentKey, Set<number>> = {
    transactions: ids('transactions'),
    outputs: ids('outputs'),
    txLabels: ids('txLabels'),
    outputTags: ids('outputTags'),
    provenTxs: ids('provenTxs'),
  };
  const sentBefore = Object.fromEntries(ORDER.map(([k]) => [k, (page[k] as Rows)?.length])) as Record<
    PageKey,
    number | undefined
  >;
  const bump = (key: PageKey, n: number) => (report.net[key] = (report.net[key] ?? 0) + n);

  // An entity takes added rows only if this pass has read all of it (else the backup's offset would skip real rows).
  // getSyncChunk reads entities in order and starts the next one only once this one has no more rows for the pass: a
  // later entity's list on the page (even empty) shows it. No store reads: the page itself says so.
  const readInFull = (key: PageKey, note = true): boolean => {
    const at = ORDER.findIndex(([k]) => k === key);
    const ok = sentBefore[key] !== undefined && ORDER.slice(at + 1).some(([k]) => sentBefore[k] !== undefined);
    if (!ok && note && !report.notExhausted.includes(key)) report.notExhausted.push(key);
    return ok;
  };

  const maxRows = Math.max(1, Math.floor((args.maxItems ?? 1_000) / 4));
  const maxSize = Math.max(64_000, Math.floor((args.maxRoughSize ?? 10_000_000) / 4));
  let rows = 0;
  let size = 0;
  type Pending = { key: PageKey; row: Row };

  /** Read a row by key; undefined if this device doesn't hold it. */
  const read = async (key: ParentKey, id: number): Promise<Row | undefined> => {
    const one = (r: Row[]) => r[0];
    if (key === 'transactions') return one(await store.findTransactions({ partial: { userId, transactionId: id } }));
    if (key === 'outputs') return one(await store.findOutputs({ partial: { userId, outputId: id } }));
    if (key === 'txLabels') return one(await store.findTxLabels({ partial: { userId, txLabelId: id } }));
    if (key === 'outputTags') return one(await store.findOutputTags({ partial: { userId, outputTagId: id } }));
    return one(await store.findProvenTxs({ partial: { provenTxId: id } }));
  };
  /** The copy of a parent that goes: unchanged in the pass's window, a no-op (L1) before it. */
  const copyOf = (key: ParentKey, r: Row): Row => {
    if (inWindow(r)) return r;
    const c: Row = { ...r, updated_at: new Date(0) };
    if (key === 'transactions') {
      c.provenTxId = undefined;
      c.noSendExpiryState = undefined;
      c.inputBEEF = undefined;
    }
    return c;
  };

  /** ok: the parents (deepest first) are in `out` or need nothing; hold: one can't go yet; leave: not read in full. */
  type Need = { ok: true } | { ok: false; hold?: { txid: string; status: string } };
  const OK: Need = { ok: true };
  const planned = new Set<string>();
  const need = async (key: ParentKey, id: unknown, out: Pending[]): Promise<Need> => {
    const n = num(id);
    if (n === undefined || onPage[key].has(n) || planned.has(`${key}:${n}`)) return OK;
    if (opts.filed?.get(key)?.has(n)) return OK; // an earlier page of this pass carried it: the backup has it filed
    if (out.some((p) => p.key === key && num(p.row[ID_KEY[key]!]) === n)) return OK;
    const row = await read(key, n);
    if (!row) return OK; // this device doesn't hold it either: nothing to send (the toolbox decides as before)
    if (!readInFull(key)) return { ok: false };
    if (key === 'transactions' && !inWindow(row) && !sendableAsNoOp(row))
      return { ok: false, hold: { txid: String(row.txid ?? `#${n}`), status: String(row.status) } };
    const copy = copyOf(key, row);
    if (key === 'transactions' && copy.provenTxId != null) {
      const r = await need('provenTxs', copy.provenTxId, out);
      if (!r.ok) return r;
    }
    if (key === 'outputs') {
      for (const t of [row.transactionId, row.spentBy]) {
        if (t == null) continue;
        const r = await need('transactions', t, out);
        if (!r.ok) return r;
      }
    }
    out.push({ key, row: copy });
    return OK;
  };
  const all = async (...steps: (() => Promise<Need>)[]): Promise<Need> => {
    for (const s of steps) {
      const r = await s();
      if (!r.ok) return r;
    }
    return OK;
  };

  /** Parents of each child kind. */
  const NEEDS: Record<ChildKey, (r: Row, out: Pending[]) => Promise<Need>> = {
    outputs: (r, out) =>
      all(
        () => need('transactions', r.transactionId, out),
        () => (r.spentBy == null ? Promise.resolve(OK) : need('transactions', r.spentBy, out)),
      ),
    txLabelMaps: (r, out) =>
      all(
        () => need('transactions', r.transactionId, out),
        () => need('txLabels', r.txLabelId, out),
      ),
    outputTagMaps: (r, out) =>
      all(
        () => need('outputs', r.outputId, out),
        () => need('outputTags', r.outputTagId, out),
      ),
    commissions: (r, out) => need('transactions', r.transactionId, out),
  };
  const added: Pending[] = [];
  const take = (out: Pending[]) => {
    for (const p of out) {
      planned.add(`${p.key}:${num(p.row[ID_KEY[p.key]!])}`);
      added.push(p);
    }
    rows += out.length;
    size += out.reduce((s, p) => s + sizeOf(p.row), 0);
  };

  // This page's own rows.
  let cut: { key: PageKey; at: number } | undefined;
  outer: for (const key of CHILD_KEYS) {
    const children = (page[key] as Rows) ?? [];
    for (let i = 0; i < children.length; i++) {
      const out: Pending[] = [];
      const r = await NEEDS[key](children[i], out);
      if (!r.ok) {
        if (r.hold) {
          // The page ends here; this row and the rest wait (not counted as read) until its parent can go.
          report.waitsFor = r.hold;
          cut = { key, at: i };
          break outer;
        }
        continue; // not read in full (never with getSyncChunk): left as it was
      }
      if (!out.length) continue;
      const more = out.reduce((s, p) => s + sizeOf(p.row), 0);
      if (rows > 0 && (rows + out.length > maxRows || size + more > maxSize)) {
        cut = { key, at: i };
        break outer;
      }
      take(out);
    }
  }

  if (cut) {
    // This child and everything after it in getSyncChunk's order goes on the next page (the offsets resume there).
    const from = ORDER.findIndex(([k]) => k === cut!.key);
    report.deferred += (page[cut.key] as Row[]).length - cut.at;
    (page as Record<string, unknown>)[cut.key] = (page[cut.key] as Row[]).slice(0, cut.at);
    for (const [k] of ORDER.slice(from + 1)) {
      const r = page[k] as Rows;
      if (r?.length) {
        report.deferred += r.length;
        r.length = 0;
      }
    }
  }

  for (const p of added) {
    const list = ((page as Record<string, unknown>)[p.key] ??= []) as Row[];
    list.push(p.row);
    bump(p.key, 1);
    if (p.key in report && typeof (report as Record<string, unknown>)[p.key] === 'number')
      (report as unknown as Record<string, number>)[p.key]++;
    if (time(p.row.updated_at) === 0) report.older++;
  }
  return report;
}

/** One sync-log line for a page that was given parents (nothing when none were needed). */
export function describeParents(r: ParentsReport): string | undefined {
  const parts = (['transactions', 'outputs', 'txLabels', 'outputTags', 'provenTxs'] as const)
    .filter((k) => r[k] > 0)
    .map((k) => `${k} ${r[k]}`);
  if (!parts.length && !r.notExhausted.length) return undefined;
  const extra = [
    r.older ? `${r.older} older than the cursor (no-op copies)` : '',
    r.deferred ? `${r.deferred} row(s) moved to the next page` : '',
    r.notExhausted.length ? `not added (entity not sent in full): ${r.notExhausted.join(', ')}` : '',
  ].filter(Boolean);
  return `[deviceSync] push page carries the rows its own are filed under: ${parts.join(', ') || 'none'}${
    extra.length ? `; ${extra.join('; ')}` : ''
  }`;
}

// ── the record of a pass, kept before each page goes ──

/**
 * One push pass as this device has sent it: per entity, how far the backup's offset runs ahead of what this device has
 * read (rows added, on pages the backup committed), and the page last sent. Ids only, no rows.
 */
type Pass = {
  since: number;
  ahead: Record<string, number>;
  last?: { start: Record<string, number>; len: Record<string, number>; net: Record<string, number> };
};
type Kept = { pass?: Pass };

const DB_NAME = 'bwx-push-passes';
const STORE = 'kv';
const memory = new Map<string, Kept>();
/** Ids of rows committed pages carried, per pass (this process only: losing them only means a parent goes again). */
const filedBy = new Map<string, Map<string, Set<number>>>();
/** Ids the last page carried: filed once the next page's offsets show the backup committed it. */
const pendingIds = new Map<string, Map<string, number[]>>();
/** The last "waits for" line per pass, logged once a cycle (the device sync's back-off is minutes). */
const waitLogged = new Map<string, { line: string; at: number }>();
const WAIT_LOG_MS = 60_000;
let opened: Promise<IDBDatabase | undefined> | undefined;
const db = (): Promise<IDBDatabase | undefined> =>
  (opened ??= new Promise<IDBDatabase | undefined>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  }));
const tx = async <T>(mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
  const d = await db();
  if (!d) return undefined;
  return await new Promise<T | undefined>((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = body(t.objectStore(STORE));
    t.oncomplete = () => resolve(req.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
};
async function load(key: string): Promise<Kept> {
  const m = memory.get(key);
  if (m) return m;
  const stored = await tx<Kept | undefined>('readonly', (s) => s.get(key) as IDBRequest<Kept | undefined>).catch(
    () => undefined,
  );
  const k = stored ?? {};
  memory.set(key, k);
  return k;
}
/** Kept before the page goes; a failed write is retried by the next page and costs at most a re-read on relaunch. */
async function save(key: string, k: Kept) {
  memory.set(key, k);
  await tx('readwrite', (s) => s.put(k, key)).catch(() => undefined);
}

/** Test hook: a relaunch (this process forgets; the kept record stays). */
export const _forgetPushMemory = () => {
  memory.clear();
  filedBy.clear();
  pendingIds.clear();
  waitLogged.clear();
};
/** Test hook: forget every pass, kept records too. */
export const _resetPushPasses = async () => {
  _forgetPushMemory();
  await tx('readwrite', (s) => s.clear()).catch(() => undefined);
};

const offsetsOf = (args: PushArgs) =>
  Object.fromEntries(ORDER.map(([, name]) => [name, args.offsets?.find((o) => o.name === name)?.offset ?? 0]));

/**
 * getSyncChunk for a push page, with its parents (addMissingParents) and with the paging kept exact
 * (see the file comment). Anything that isn't a push page is read as it is.
 */
export async function readPushPage(
  store: ParentStore,
  args: PushArgs,
  read: (args: PushArgs) => Promise<PushPage>,
  log: (line: string) => void = (line) => console.log(line),
): Promise<PushPage> {
  if (!isPushPage(store, args)) return await read(args);
  const key = `${args.fromStorageIdentityKey}|${args.toStorageIdentityKey}|${args.identityKey}`;
  const since = args.since == null ? -1 : time(args.since);
  const server = offsetsOf(args);
  const kept = await load(key);
  let pass = kept.pass;
  const fresh = Object.values(server).every((o) => o === 0);
  /**
   * The record doesn't fit the backup's offsets (lost, or a pass that isn't this one): the entities that take parents,
   * and any the record had moved, are read again from the pass's start; their rows the backup holds come again as
   * no-ops (the merge applies only a strictly newer row), and none is skipped.
   */
  const rebase = () => {
    const ahead: Record<string, number> = {};
    for (const [, name] of ORDER) if (PARENT_ENTITIES.includes(name)) ahead[name] = server[name];
    filedBy.delete(key);
    pendingIds.delete(key);
    return { since, ahead } as Pass;
  };
  if (!pass || pass.since !== since) pass = fresh ? { since, ahead: {} } : rebase();
  else if (pass.last) {
    const { start, len, net } = pass.last;
    const committed = ORDER.every(([, name]) => server[name] === start[name] + (len[name] ?? 0));
    const refused = ORDER.every(([, name]) => server[name] === start[name]);
    if (committed) {
      const ahead = { ...pass.ahead };
      for (const [name, n] of Object.entries(net)) ahead[name] = (ahead[name] ?? 0) + n;
      pass = { since, ahead };
      const filed = filedBy.get(key) ?? new Map<string, Set<number>>();
      for (const [k, list] of pendingIds.get(key) ?? []) {
        const set = filed.get(k) ?? new Set<number>();
        for (const id of list) set.add(id);
        filed.set(k, set);
      }
      filedBy.set(key, filed);
    } else if (refused) pass = { since, ahead: pass.ahead };
    else pass = rebase();
  } else if (!fresh) pass = rebase();
  const current = pass;

  const own = Object.fromEntries(
    ORDER.map(([, name]) => [name, Math.max(0, server[name] - (current.ahead[name] ?? 0))]),
  );
  const ownArgs: PushArgs = { ...args, offsets: ORDER.map(([, name]) => ({ name, offset: own[name] })) };
  const page = await read(ownArgs);
  const report = await addMissingParents(store, ownArgs, page, { filed: filedBy.get(key) });

  // Ids this page carries: filed once the backup commits it (the next page's offsets show it).
  const carried = new Map<string, number[]>();
  for (const [k] of ORDER) {
    const idKey = ID_KEY[k];
    if (!idKey) continue;
    carried.set(
      k,
      ((page[k] as Rows) ?? []).map((r) => num(r?.[idKey])).filter((v): v is number => v !== undefined),
    );
  }
  pendingIds.set(key, carried);
  const net: Record<string, number> = {};
  for (const [k, n] of Object.entries(report.net)) if (n) net[NAME[k as PageKey]] = n;
  if (report.waitsFor) {
    const line = `[deviceSync] push waits for ${report.waitsFor.txid} (${report.waitsFor.status})`;
    const t = waitLogged.get(key);
    if (!t || t.line !== line || Date.now() - t.at > WAIT_LOG_MS) {
      waitLogged.set(key, { line, at: Date.now() });
      log(line);
    }
    // Nothing before it: no page goes (an empty page would end the pass and move the backup's cursor past the row).
    if (ORDER.every(([k]) => !(page[k] as Rows)?.length)) throw new Error(line.replace('[deviceSync] ', ''));
  }
  await save(key, {
    pass: {
      since,
      ahead: current.ahead,
      last: {
        start: server,
        len: Object.fromEntries(ORDER.map(([k, name]) => [name, (page[k] as Rows)?.length ?? 0])),
        net,
      },
    },
  });
  const line = describeParents(report);
  if (line) log(line);
  return page;
}
