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
 *    in the map, so the rows under it file.
 *  - A parent older than the pass's cursor (the backup holds it already, or was sent it before) goes as a no-op: the
 *    epoch as its time, no proof id, no expiry state, no input BEEF. The backup's copy is never changed by it, so a
 *    completed transaction is never set back to unproven, whatever the clocks of the copies that wrote it. Nothing else
 *    is changed: status, txid, reference, amounts and raw bytes go as this device holds them (review 23, L1).
 *  - A parent at or after the cursor is a row this pass owes the backup anyway (the paging skipped it): it goes
 *    unchanged, with its proof row, so the backup gets the whole row.
 *  - The page's paging stays exact. The backup adds every row of a page to that entity's offset, so rows are added only
 *    to an entity this pass has already sent in full (getSyncChunk reads entities in order: a page holding outputs has
 *    read every transaction of the pass); one that isn't is checked against the store and left alone. A quarter of the
 *    page's items and of its rough size at most go to parents (L2): the page's rows end where that runs out, nothing
 *    after them goes, and the next page goes on from there.
 *  - This device writes nothing. Rows are read, copied and sent.
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
  getProvenTxsForUser(a: {
    userId: number;
    since?: Date | string;
    paged?: { limit: number; offset: number };
  }): Promise<Row[]>;
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
  /** Entities a parent was needed for but this pass hasn't sent in full: left alone (getSyncChunk never builds one). */
  notExhausted: string[];
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

/**
 * Add to `page` the parents its rows need and it doesn't hold (see the file comment). Reads only. Returns what was added.
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
  };
  const hasChildren = ['outputs', 'txLabelMaps', 'outputTagMaps', 'commissions'].some(
    (k) => (page[k as PageKey] as Rows)?.length,
  );
  if (!hasChildren || !args.identityKey) return report;
  const userId = num((await store.findUsers({ partial: { identityKey: args.identityKey } }))[0]?.userId);
  if (userId === undefined) return report;

  const since = args.since == null ? undefined : time(args.since);
  const inWindow = (r: Row) => since === undefined || time(r.updated_at) >= since;
  const ids = (key: PageKey, idKey: string) =>
    new Set(((page[key] as Rows) ?? []).map((r) => num(r?.[idKey])).filter((v): v is number => v !== undefined));
  const onPage = {
    transactions: ids('transactions', 'transactionId'),
    outputs: ids('outputs', 'outputId'),
    txLabels: ids('txLabels', 'txLabelId'),
    outputTags: ids('outputTags', 'outputTagId'),
    provenTxs: ids('provenTxs', 'provenTxId'),
  };
  const sentBefore = Object.fromEntries(ORDER.map(([k]) => [k, (page[k] as Rows)?.length])) as Record<
    PageKey,
    number | undefined
  >;

  // An entity takes added rows only if this pass has read all of it (else the backup's offset would skip real rows).
  const exhausted = new Map<PageKey, Promise<boolean>>();
  const isExhausted = (key: PageKey): Promise<boolean> => {
    let p = exhausted.get(key);
    if (!p) {
      p = (async () => {
        const sent = sentBefore[key];
        if (sent === undefined) return false; // getSyncChunk never reached it on this page
        const name = ORDER.find(([k]) => k === key)![1];
        const offset = (args.offsets?.find((o) => o.name === name)?.offset ?? 0) + sent;
        const paged = { limit: 1, offset };
        const more =
          key === 'provenTxs'
            ? await store.getProvenTxsForUser({ userId, since: args.since, paged })
            : key === 'transactions'
              ? await store.findTransactions({ partial: { userId }, since: args.since, paged })
              : key === 'outputs'
                ? await store.findOutputs({ partial: { userId }, since: args.since, paged })
                : key === 'txLabels'
                  ? await store.findTxLabels({ partial: { userId }, since: args.since, paged })
                  : await store.findOutputTags({ partial: { userId }, since: args.since, paged });
        if (more.length) report.notExhausted.push(key);
        return more.length === 0;
      })();
      exhausted.set(key, p);
    }
    return p;
  };

  const maxRows = Math.max(1, Math.floor((args.maxItems ?? 1_000) / 4));
  const maxSize = Math.max(64_000, Math.floor((args.maxRoughSize ?? 10_000_000) / 4));
  let rows = 0;
  let size = 0;
  type Pending = { key: PageKey; row: Row };

  /** Read a row by id; undefined if this device doesn't hold it. */
  const read = async (key: PageKey, id: number): Promise<Row | undefined> => {
    const one = (r: Row[]) => r[0];
    if (key === 'transactions') return one(await store.findTransactions({ partial: { userId, transactionId: id } }));
    if (key === 'outputs') return one(await store.findOutputs({ partial: { userId, outputId: id } }));
    if (key === 'txLabels') return one(await store.findTxLabels({ partial: { userId, txLabelId: id } }));
    if (key === 'outputTags') return one(await store.findOutputTags({ partial: { userId, outputTagId: id } }));
    if (key === 'provenTxs') return one(await store.findProvenTxs({ partial: { provenTxId: id } }));
    return undefined;
  };

  /** The copy that goes: unchanged in the pass's window, a no-op (L1) before it. */
  const copyOf = (key: PageKey, r: Row): Row => {
    if (inWindow(r)) return r;
    const c: Row = { ...r, updated_at: new Date(0) };
    if (key === 'transactions') {
      c.provenTxId = undefined;
      c.noSendExpiryState = undefined;
      c.inputBEEF = undefined;
    }
    return c;
  };

  const ID_KEY: Record<string, string> = {
    transactions: 'transactionId',
    outputs: 'outputId',
    txLabels: 'txLabelId',
    outputTags: 'outputTagId',
    provenTxs: 'provenTxId',
  };
  type ParentKey = keyof typeof onPage;

  /**
   * The parents one child row needs, deepest first (an output's transaction before the output). Rows already on the
   * page or already planned are skipped. `undefined`: a needed parent can't be added (its entity isn't sent in full).
   */
  const planned = new Map<string, Row>();
  const need = async (key: ParentKey, id: unknown, out: Pending[]): Promise<boolean> => {
    const n = num(id);
    if (n === undefined || onPage[key].has(n) || planned.has(`${key}:${n}`)) return true;
    if (opts.filed?.get(key)?.has(n)) return true; // an earlier page of this pass carried it: the backup has it filed
    if (out.some((p) => p.key === key && num(p.row[ID_KEY[key]]) === n)) return true;
    const row = await read(key, n);
    if (!row) return true; // this device doesn't hold it either: nothing to send (the toolbox decides as before)
    if (!(await isExhausted(key))) return false;
    const copy = copyOf(key, row);
    if (key === 'transactions' && copy.provenTxId != null) {
      if (!(await need('provenTxs', copy.provenTxId, out))) return false;
    }
    if (key === 'outputs') {
      if (!(await need('transactions', row.transactionId, out))) return false;
      if (row.spentBy != null && !(await need('transactions', row.spentBy, out))) return false;
    }
    out.push({ key, row: copy });
    return true;
  };

  /** Parents of each child kind, in page order. */
  const CHILDREN: [PageKey, (r: Row, out: Pending[]) => Promise<boolean>][] = [
    [
      'outputs',
      async (r, out) =>
        (await need('transactions', r.transactionId, out)) &&
        (r.spentBy == null || (await need('transactions', r.spentBy, out))),
    ],
    [
      'txLabelMaps',
      async (r, out) =>
        (await need('transactions', r.transactionId, out)) && (await need('txLabels', r.txLabelId, out)),
    ],
    [
      'outputTagMaps',
      async (r, out) => (await need('outputs', r.outputId, out)) && (await need('outputTags', r.outputTagId, out)),
    ],
    ['commissions', async (r, out) => need('transactions', r.transactionId, out)],
  ];

  const added: Pending[] = [];
  let cut: { key: PageKey; at: number } | undefined;
  outer: for (const [key, needs] of CHILDREN) {
    const children = (page[key] as Rows) ?? [];
    for (let i = 0; i < children.length; i++) {
      const out: Pending[] = [];
      if (!(await needs(children[i], out))) continue; // left as before; the page refuses as it would have
      if (!out.length) continue;
      const more = out.reduce((s, p) => s + sizeOf(p.row), 0);
      if (rows > 0 && (rows + out.length > maxRows || size + more > maxSize)) {
        cut = { key, at: i };
        break outer;
      }
      for (const p of out) {
        planned.set(`${p.key}:${num(p.row[ID_KEY[p.key]])}`, p.row);
        added.push(p);
      }
      rows += out.length;
      size += more;
    }
  }

  if (cut) {
    // This child and everything after it in getSyncChunk's order goes on the next page (the offsets resume there).
    const from = ORDER.findIndex(([k]) => k === cut!.key);
    const kept = (page[cut.key] as Row[]).slice(0, cut.at);
    report.deferred += (page[cut.key] as Row[]).length - kept.length;
    (page as Record<string, unknown>)[cut.key] = kept;
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
    report[p.key as ParentKey]++;
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

/**
 * One push pass as this device has sent it: how many rows it added to each entity on pages the backup committed (the
 * backup counts them into its offsets, so they are taken off again before the next page is read), and the ids those
 * pages carried (filed on the backup: never added again in this pass).
 */
type Pass = {
  since: number;
  added: Record<string, number>;
  filed: Map<string, Set<number>>;
  last?: { start: Record<string, number>; len: Record<string, number>; added: Record<string, number>; ids: Row[][] };
};
const passes = new Map<string, Pass>();
/** Test hook: forget every pass. */
export const _resetPushPasses = () => passes.clear();

const offsetsOf = (args: PushArgs) =>
  Object.fromEntries(ORDER.map(([, name]) => [name, args.offsets?.find((o) => o.name === name)?.offset ?? 0]));

/**
 * getSyncChunk for a push page, with its parents (addMissingParents) and with the paging kept exact: the backup's
 * offsets include the rows this pass added on committed pages, and those are taken off before the store is read. A
 * page the backup refused is not counted (the next page's offsets show which). Anything that isn't a push page is
 * read as it is.
 */
export async function readPushPage(
  store: ParentStore,
  args: PushArgs,
  read: (args: PushArgs) => Promise<PushPage>,
  log: (line: string) => void = (line) => console.log(line),
): Promise<PushPage> {
  if (!isPushPage(store, args)) return await read(args);
  const pairKey = `${args.fromStorageIdentityKey}|${args.toStorageIdentityKey}|${args.identityKey}`;
  const since = args.since == null ? -1 : time(args.since);
  const server = offsetsOf(args);
  let pass = passes.get(pairKey);
  const fresh = Object.values(server).every((o) => o === 0);
  if (!pass || pass.since !== since || fresh) {
    pass = { since, added: {}, filed: new Map() };
    passes.set(pairKey, pass);
  } else if (pass.last) {
    const { start, len, added, ids } = pass.last;
    const committed = ORDER.every(([, name]) => server[name] === start[name] + (len[name] ?? 0));
    if (committed) {
      for (const [name, n] of Object.entries(added)) pass.added[name] = (pass.added[name] ?? 0) + n;
      ORDER.forEach(([key], i) => {
        const idKey = ID_KEYS[key];
        if (!idKey) return;
        const set = pass!.filed.get(key) ?? new Set<number>();
        for (const r of ids[i] ?? []) {
          const id = num(r?.[idKey]);
          if (id !== undefined) set.add(id);
        }
        pass!.filed.set(key, set);
      });
    }
    pass.last = undefined;
  }
  const own = Object.fromEntries(
    ORDER.map(([, name]) => [name, Math.max(0, server[name] - (pass!.added[name] ?? 0))]),
  ) as Record<string, number>;
  const ownArgs: PushArgs = { ...args, offsets: ORDER.map(([, name]) => ({ name, offset: own[name] })) };
  const page = await read(ownArgs);
  const report = await addMissingParents(store, ownArgs, page, { filed: pass.filed });
  const added: Record<string, number> = {};
  for (const [key, name] of ORDER) {
    const n = (report as unknown as Record<string, number>)[key];
    if (typeof n === 'number' && n > 0) added[name] = n;
  }
  pass.last = {
    start: server,
    len: Object.fromEntries(ORDER.map(([key, name]) => [name, (page[key] as Rows)?.length ?? 0])),
    added,
    ids: ORDER.map(([key]) => [...((page[key] as Rows) ?? [])]),
  };
  const line = describeParents(report);
  if (line) log(line);
  return page;
}

const ID_KEYS: Partial<Record<PageKey, string>> = {
  provenTxs: 'provenTxId',
  outputTags: 'outputTagId',
  txLabels: 'txLabelId',
  transactions: 'transactionId',
  outputs: 'outputId',
};
