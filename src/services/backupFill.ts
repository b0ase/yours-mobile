/**
 * The first push to a new backup (our storage server, services/spendableFirst.ts), without holding the wallet up
 * (independent review of the instant restore, 20 Nov 2026, finding 4).
 *
 * The toolbox's push (WalletStorageManager.syncToWriter) holds every storage lock for its whole cycle, and a new
 * backup's first cycle is the whole wallet: minutes on a big wallet, with the balance and every payment waiting. A
 * cycle can't simply pause and resume (services/pushView.ts): with a `since`, a row a payment touches during the pause
 * moves into the filtered set ahead of the offset and another row is skipped for good. So the first fill is two passes:
 *  1. From the start, page by page, WITHOUT the locks, yielding to own payments between pages. With no `since` every
 *     row is already in the set and the store's cursors walk by primary key, so a write during a pause moves nothing
 *     ahead of the offset (an update stays in place, an insert goes to the end): no row is skipped. A row changed after
 *     its page went is stale on the backup until pass 2.
 *  2. Everything changed since pass 1 began (`since` = its start, less a margin), inside the locks as an ordinary push
 *     is: small, and nothing writes while it runs. The backup's cursor then sits past every row it holds.
 * A device restored FROM our snapshot starts at the restore point instead (pass 2 alone, since the restore began): our
 * server already holds what the snapshot brought. If that leaves the backup with no cursor (nothing changed since), the
 * two-pass fill runs, so the ordinary push never starts from the beginning inside the locks.
 * Offsets are counted per entity as the backup's own sync state counts them (rows received), so the device's push
 * pages (inboundSync readPushPage, with their parents) page exactly as in a toolbox push.
 *
 * A fill that can't finish says so and stops (mainnet 1p test, 22 Nov 2026: ~265 identical pages in 40 s, never
 * "done", until our server's 300-a-minute limit answered 429 and the fill was dropped):
 *  - a page that moves no offset, or carries exactly the rows of the page before, ends the fill ('stalled'), and no
 *    pass runs more pages than 2 per row the device holds (plus a few);
 *  - a refusal (429, 5xx) or any other error ends it at once: never a resend in a loop;
 *  - after every page our server acknowledged, the progress is handed to `onProgress`; a later fill given it as
 *    `resume` goes on from that page, if our server's checkpoint holds exactly those rows (else that pass starts again).
 *    A row counts as sent only once our server acknowledged its page. Every failure is a FillIncompleteError.
 */

/** Entity names in the toolbox's checkpoint order, and their keys in a sync chunk. */
const ENTITIES: [name: string, key: string][] = [
  ['provenTx', 'provenTxs'],
  ['outputBasket', 'outputBaskets'],
  ['outputTag', 'outputTags'],
  ['txLabel', 'txLabels'],
  ['transaction', 'transactions'],
  ['output', 'outputs'],
  ['txLabelMap', 'txLabelMaps'],
  ['outputTagMap', 'outputTagMaps'],
  ['certificate', 'certificates'],
  ['certificateField', 'certificateFields'],
  ['commission', 'commissions'],
  ['provenTxReq', 'provenTxReqs'],
];

/** The largest list offset any of our server's profiles accepts (the toolbox StorageServer's 'small' limit). */
const WRITER_MAX_OFFSET = 100_000;

/** Clock skew and in-flight writes: pass 2 starts this long before pass 1 did. */
export const FILL_MARGIN_MS = 30_000;

/** Baskets, tags and labels: the only entities a refs-only pass reads. */
const REFS = ['outputBasket', 'outputTag', 'txLabel'];
/** A refs-only pass's offset for every other entity: past any real list. Never added to (see the file comment). */
const PAST_END = Number.MAX_SAFE_INTEGER;
/**
 * The least time between any two pages of a fill, every pass alike (refs, restore, bulk, final): 150 a minute at most
 * for the whole fill, well inside our server's 300 requests a minute per IP, which the wallet's own snapshot and send
 * calls share. A since-pass starts again from its since on every try, so a burst that earned a 429 would earn it again
 * on every try (review of 82bdb7e3, 2).
 */
export const FILL_PAGE_GAP_MS = 400;
/** A pass that reads more pages than 2 per row the device holds, plus this, is not getting anywhere. */
const ROUNDS_SLACK = 20;
/** The cap when the device can't count its rows. */
const ROUNDS_FALLBACK = 5_000;

type Settings = { storageIdentityKey: string; storageName?: string };
type Offsets = { name: string; offset: number }[];
type Args = Record<string, unknown> & { since?: Date | string; offsets?: Offsets };
export type FillReader = {
  getSettings(): Settings;
  getSyncChunk(args: Args): Promise<Record<string, unknown>>;
};
export type FillWriter = {
  makeAvailable(): Promise<Settings>;
  processSyncChunk(args: Args, chunk: Record<string, unknown>): Promise<{ done?: boolean }>;
};
export type FillManager = {
  getAuth(): Promise<{ identityKey: string; userId?: number }>;
  loadSyncRequest(
    auth: unknown,
    writer: unknown,
    readerSettings: Settings,
    toStorageIdentityKey: string,
  ): Promise<Args>;
  runAsSync<T>(fn: (active: unknown) => Promise<T>): Promise<T>;
};

export type FillReport = {
  how: 'not-needed' | 'restore-point' | 'full';
  pages: number;
  /** Pass 1 (no locks): pages and wall time. */
  unlockedPages: number;
  unlockedMs: number;
  /** Each time the locks were held (pass 2, and a restore-point pass), ms. */
  lockedMs: number[];
};

/**
 * Where an unfinished fill stands, kept after every page the backup acknowledged: the pass it was in and the next
 * page's offsets. Only acknowledged pages count; the page that failed goes again.
 *  - refs: the refs-only pass before a restore-point pass; restore: that pass (`since`);
 *  - bulk: pass 1 (`finalSince`: where pass 2 will start); final: pass 2 (`since`).
 *  - restart: the fill is unfinished and starts again from the beginning (a stall).
 * Only a bulk pass goes on from its offsets. A pass with a `since` counts its offsets among the rows changed since: a
 * row behind the offset that changes between tries moves into the set ahead of it and would never be sent (review of
 * 30a4fbcd, 1), so a restore or final pass starts again from its since.
 */
export type FillStage = 'refs' | 'restore' | 'bulk' | 'final' | 'restart';
export type FillProgress = { stage: FillStage; since?: number; finalSince?: number; offsets: Offsets };

/**
 * The fill stopped before our server said "done". `refused`: the server answered 429 or 5xx (`retryAfterMs` from its
 * Retry-After); `stalled`: pages stopped moving the pass on (the same page again); `failed`: anything else.
 */
export class FillIncompleteError extends Error {
  readonly kind: 'refused' | 'stalled' | 'failed';
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(
    kind: FillIncompleteError['kind'],
    message: string,
    o: { retryAfterMs?: number; status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'FillIncompleteError';
    this.kind = kind;
    this.retryAfterMs = o.retryAfterMs;
    this.status = o.status;
    this.cause = o.cause;
  }
}

/** A server's refusal (the toolbox StorageClient's "network error 429" carries retryAfterMs) or any other failure. */
export function fillError(e: unknown): FillIncompleteError {
  if (e instanceof FillIncompleteError) return e;
  const o = (e ?? {}) as { message?: unknown; status?: unknown; retryAfterMs?: unknown };
  const message = typeof o.message === 'string' ? o.message : String(e);
  const status =
    typeof o.status === 'number' ? o.status : Number(/network error (\d{3})/.exec(message)?.[1] ?? NaN) || undefined;
  const after =
    typeof o.retryAfterMs === 'number' && Number.isFinite(o.retryAfterMs) ? Math.max(0, o.retryAfterMs) : undefined;
  if (status === 429 || (status !== undefined && status >= 500) || after !== undefined)
    return new FillIncompleteError('refused', message, { retryAfterMs: after, status, cause: e });
  return new FillIncompleteError('failed', message, { status, cause: e });
}

const zeros = (): Offsets => ENTITIES.map(([name]) => ({ name, offset: 0 }));
const sameOffsets = (a: Offsets | undefined, b: Offsets | undefined) =>
  !!a &&
  !!b &&
  ENTITIES.every(
    ([name]) => (a.find((o) => o.name === name)?.offset ?? 0) === (b.find((o) => o.name === name)?.offset ?? 0),
  );
/** A page's rows, without their bytes: two pages alike in this are the same page. */
const rowsOf = (chunk: Record<string, unknown>): string =>
  ENTITIES.map(([, key]) => {
    const rows = chunk[key];
    if (!Array.isArray(rows) || !rows.length) return '';
    return `${key}:${rows
      .map((r: Record<string, unknown>) =>
        Object.entries(r ?? {})
          .filter(([, v]) => v == null || typeof v !== 'object' || v instanceof Date)
          .map(([k, v]) => `${k}=${v instanceof Date ? v.getTime() : String(v)}`)
          .join(','),
      )
      .join(';')}`;
  })
    .filter(Boolean)
    .join('|');

/** Rows the device holds (every entity a fill reads), when its store can count them. */
async function deviceRows(reader: unknown): Promise<number | undefined> {
  const r = reader as Record<string, unknown>;
  const counts = [
    'countProvenTxs',
    'countOutputBaskets',
    'countOutputTags',
    'countTxLabels',
    'countTransactions',
    'countOutputs',
    'countTxLabelMaps',
    'countOutputTagMaps',
    'countCertificates',
    'countCertificateFields',
    'countCommissions',
    'countProvenTxReqs',
  ];
  if (!counts.every((c) => typeof r[c] === 'function')) return undefined;
  try {
    let n = 0;
    for (const c of counts)
      n += Number(await (r[c] as (a: unknown) => Promise<number>).call(reader, { partial: {} })) || 0;
    return n;
  } catch {
    return undefined;
  }
}

export async function fillBackup(d: {
  manager: FillManager;
  reader: FillReader;
  writer: FillWriter;
  /** A device restored from our snapshot: when the restore began. */
  restorePoint?: Date;
  /** Own payments waiting (ownPayments.waiting): pass 1 waits between pages while true. */
  yieldWhile?: () => boolean;
  /** Rows per page (default 200). */
  maxItems?: number;
  now?: () => number;
  /** How far before each pass's start its `since` goes (default FILL_MARGIN_MS). */
  marginMs?: number;
  /** Test hook: after each unlocked page. */
  afterPage?: () => Promise<void>;
  /** An unfinished fill's progress (from onProgress): it goes on from there if the server's checkpoint agrees. */
  resume?: FillProgress | null;
  /** After every acknowledged page (and each pass's start): the progress to keep. Null once the fill is done. */
  onProgress?: (p: FillProgress | null) => Promise<void> | void;
  /** A fill is known unfinished (kept state, even without progress): never "not-needed" on the backup's cursor. */
  unfinished?: boolean;
  /** The wallet closed: the fill ends before its next page. */
  stopped?: () => boolean;
  /** The least time between any two pages of the fill (default FILL_PAGE_GAP_MS). */
  pageGapMs?: number;
  /** Tests: how a pause is taken. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<FillReport> {
  try {
    return await fill(d);
  } catch (e) {
    throw fillError(e);
  }
}

async function fill(d: Parameters<typeof fillBackup>[0]): Promise<FillReport> {
  const now = d.now ?? Date.now;
  const report: FillReport = { how: 'not-needed', pages: 0, unlockedPages: 0, unlockedMs: 0, lockedMs: [] };
  const writerSettings = await d.writer.makeAvailable();
  const readerSettings = d.reader.getSettings();
  const auth = await d.manager.getAuth();
  const load = () => d.manager.loadSyncRequest(auth, d.writer, readerSettings, writerSettings.storageIdentityKey);
  const base = await load();
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const margin = d.marginMs ?? FILL_MARGIN_MS;
  const kept = d.resume ?? undefined;
  /**
   * Every stage but bulk runs after a pass that left the backup a cursor (refs or bulk said "done"), or after a stall
   * that may have: a kept refs, restore, final or restart stage on a backup with no cursor means it lost its state
   * (review of 82bdb7e3, 3). The fill then starts from scratch, the two-pass fill from the beginning: never a pass from
   * a restore point or a final pass, which both count on rows the backup no longer has. A bulk pass checks its offsets
   * against the backup's own (startOf).
   */
  const lost = !!kept && kept.stage !== 'bulk' && base.since == null;
  const resume = !kept || kept.stage === 'restart' || lost ? undefined : kept;
  /**
   * The backup has a cursor for this device: ordinary pushes from there. Not when our own fill is unfinished: a done
   * refs-only or bulk pass gives the backup a cursor long before the fill is (review of 30a4fbcd, 2). Nor, after an
   * instant restore, when that cursor is older than the restore point (a fill an older version left unfinished).
   */
  const sinceMs = base.since == null ? undefined : new Date(base.since).getTime();
  const restoredSince = d.restorePoint ? d.restorePoint.getTime() - margin : undefined;
  if (sinceMs !== undefined && !kept && !d.unfinished && (restoredSince === undefined || sinceMs >= restoredSince))
    return report;
  /**
   * Where a pass of `stage` starts. Only a bulk pass goes on from an unfinished fill's offsets, and only when the
   * backup's checkpoint holds exactly those rows (it counts every row it acknowledged; a page it took whose answer was
   * lost shows as a difference). A pass with a `since` always starts again from its since (see FillProgress).
   */
  const startOf = (stage: FillStage): Offsets =>
    resume?.stage === stage && stage === 'bulk' && sameOffsets(base.offsets, resume.offsets)
      ? resume.offsets.map((o) => ({ ...o }))
      : zeros();
  const save = async (p: FillProgress | null) => void (await d.onProgress?.(p));
  /** One budget for the whole fill: no page goes sooner than pageGapMs after the one before, whatever its pass. */
  const gap = d.pageGapMs ?? FILL_PAGE_GAP_MS;
  let lastSent: number | undefined;
  const paced = async () => {
    const wait = lastSent === undefined ? 0 : lastSent + gap - now();
    if (wait > 0) await sleep(wait);
    lastSent = now();
  };

  /**
   * A refs-only page: baskets, tags and labels read straight from the device, every other entity empty. Through
   * getSyncChunk its "past the end" offsets walked every other table, raw transactions included, inside the locks
   * (review of 30a4fbcd, 6). Undefined when the reader can't (getSyncChunk then, with those offsets).
   */
  const refsPage = async (offsets: Offsets, maxItems: number): Promise<Record<string, unknown> | undefined> => {
    const r = d.reader as unknown as Record<string, unknown>;
    const finds: [name: string, key: string, fn: string][] = [
      ['outputBasket', 'outputBaskets', 'findOutputBaskets'],
      ['outputTag', 'outputTags', 'findOutputTags'],
      ['txLabel', 'txLabels', 'findTxLabels'],
    ];
    if (auth.userId === undefined || !finds.every(([, , fn]) => typeof r[fn] === 'function')) return undefined;
    const page: Record<string, unknown> = {
      fromStorageIdentityKey: readerSettings.storageIdentityKey,
      toStorageIdentityKey: writerSettings.storageIdentityKey,
      userIdentityKey: auth.identityKey,
    };
    for (const [, key] of ENTITIES) page[key] = [];
    for (const [name, key, fn] of finds) {
      const offset = offsets.find((o) => o.name === name)?.offset ?? 0;
      page[key] = await (r[fn] as (a: unknown) => Promise<unknown[]>).call(d.reader, {
        partial: { userId: auth.userId },
        paged: { limit: maxItems, offset },
      });
    }
    return page;
  };

  let total: number | undefined;
  /**
   * One pass, page by page, until the backup says "done". `refsOnly`: baskets, tags and labels from the start, nothing
   * else (every other entity's offset past its end). A pass from a restore point files rows under baskets and tags it
   * doesn't send; the backup's sync map must know them.
   */
  const pass = async (stage: FillStage, offsets: Offsets, at: { since?: number; finalSince?: number } = {}) => {
    const refsOnly = stage === 'refs';
    if (refsOnly) for (const o of offsets) o.offset = REFS.includes(o.name) ? 0 : PAST_END;
    // Restore and final passes read from their `since`; a refs-only pass keeps the restore pass's for a resume.
    const since = (stage === 'restore' || stage === 'final') && at.since !== undefined ? new Date(at.since) : undefined;
    const progress = (): FillProgress => ({ stage, ...at, offsets: offsets.map((o) => ({ ...o })) });
    await save(progress());
    let rounds = 0;
    let cap: number | undefined;
    let last = '';
    for (;;) {
      if (d.stopped?.()) throw new FillIncompleteError('failed', 'the wallet closed: backup fill stopped');
      const args: Args = {
        ...base,
        since,
        offsets: offsets.map((o) => ({ ...o })),
        maxItems: d.maxItems ?? 200,
        includeNextCheckpoint: false,
      };
      // Read as a push page (pushParents.isPushPage): it carries the rows its own are filed under. A coin changed after
      // an instant restore has a transaction row older than the restore point; without it our server can't file the
      // coin ("Undefined binding(s)… transactionId") and the fill never lands (1p checks, 21 Nov 2026).
      // Never the refs-only pass: baskets, tags and labels have no parents, and its offsets past the end aren't a
      // push's. Read as a push, its first page (offsets not all 0, no record of the pass) was taken for a lost record
      // and every transaction and coin was read again from 0; MAX_SAFE_INTEGER plus those rows then lost precision,
      // the offsets stopped moving and the same page went until our server refused it (mainnet 1p test, 22 Nov 2026).
      const chunk = refsOnly
        ? ((await refsPage(offsets, args.maxItems as number)) ?? (await d.reader.getSyncChunk(args)))
        : await d.reader.getSyncChunk({ ...args, includeNextCheckpoint: true });
      // The writer only checks the offsets against its limits (no requireMatchingCheckpoint): our server refuses any over
      // its profile's maximum (100,000 to 10,000,000; "RPC list offsets must not exceed 1000000" on storage.bwalletx.com,
      // 1p checks 21 Nov 2026), and the refs-only pass's "past the end" is MAX_SAFE_INTEGER.
      await paced();
      const r = await d.writer.processSyncChunk(
        { ...args, offsets: offsets.map((o) => ({ name: o.name, offset: Math.min(o.offset, WRITER_MAX_OFFSET) })) },
        chunk,
      );
      // Acknowledged: only now do its rows count.
      report.pages++;
      let moved = 0;
      for (const [name, key] of ENTITIES) {
        const rows = chunk[key];
        if (!Array.isArray(rows) || !rows.length) continue;
        const o = offsets.find((x) => x.name === name)!;
        if (o.offset === PAST_END) continue; // a refs-only pass's "past the end" stays exactly that
        o.offset += rows.length;
        moved += rows.length;
      }
      if (r.done) return;
      await save(progress());
      // No progress: the next page would be this one again, and the backup would never say "done". Stop rather than
      // resend it (the mainnet 1p test sent ~265 of them in 40 s, until our server's per-IP limit refused them).
      const rows = rowsOf(chunk);
      if (!moved || rows === last)
        throw new FillIncompleteError('stalled', `backup fill made no progress (${stage} pass, page ${rounds + 1})`);
      last = rows;
      // A hard cap from the data: no pass needs more pages than 2 per row this device holds (rows read again once
      // after a lost record included). Counted again when reached: a snapshot may be adding rows meanwhile.
      const capOf = (rows: number | undefined) => (rows === undefined ? ROUNDS_FALLBACK : ROUNDS_SLACK + 2 * rows);
      if (cap === undefined) cap = capOf((total ??= await deviceRows(d.reader)));
      if (++rounds > cap) {
        cap = capOf((total = await deviceRows(d.reader)));
        if (rounds > cap)
          throw new FillIncompleteError('stalled', `backup fill passed ${cap} pages without finishing (${stage} pass)`);
      }
      if (stage === 'bulk') {
        report.unlockedPages++;
        await d.afterPage?.();
        while (d.yieldWhile?.()) await sleep(200);
        // Reads and payments get in between pages (the next page also waits for the fill's shared pace: paced()).
        await sleep(0);
      }
    }
  };
  const locked = async (body: () => Promise<void>) => {
    const t = now();
    await d.manager.runAsSync(body);
    report.lockedMs.push(now() - t);
  };
  const done = async (how: FillReport['how']) => {
    await save(null);
    return { ...report, how };
  };

  const restoreFrom = lost
    ? undefined
    : resume?.stage === 'refs' || resume?.stage === 'restore'
      ? resume.since
      : !resume && d.restorePoint
        ? d.restorePoint.getTime() - margin
        : undefined;
  if (restoreFrom !== undefined) {
    await locked(async () => {
      await pass('refs', zeros(), { since: restoreFrom });
      await pass('restore', startOf('restore'), { since: restoreFrom });
    });
    // The cursor must now sit at or past the restore point; one older (only old baskets went) would make the ordinary
    // push resend nearly everything inside the locks, so the two-pass fill runs instead.
    const since = (await load()).since;
    if (since != null && new Date(since).getTime() >= restoreFrom) return await done('restore-point');
  }
  if (resume?.stage === 'final' && resume.since !== undefined) {
    const from = resume.since;
    await locked(() => pass('final', startOf('final'), { since: from }));
    return await done('full');
  }
  const finalSince = resume?.stage === 'bulk' && resume.finalSince !== undefined ? resume.finalSince : now() - margin;
  const t1 = now();
  await pass('bulk', startOf('bulk'), { finalSince });
  report.unlockedMs = now() - t1;
  await locked(() => pass('final', zeros(), { since: finalSince }));
  return await done('full');
}
