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

type Settings = { storageIdentityKey: string; storageName?: string };
type Args = Record<string, unknown> & { since?: Date | string };
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
}): Promise<FillReport> {
  const now = d.now ?? Date.now;
  const report: FillReport = { how: 'not-needed', pages: 0, unlockedPages: 0, unlockedMs: 0, lockedMs: [] };
  const writerSettings = await d.writer.makeAvailable();
  const readerSettings = d.reader.getSettings();
  const auth = await d.manager.getAuth();
  const load = () => d.manager.loadSyncRequest(auth, d.writer, readerSettings, writerSettings.storageIdentityKey);
  const base = await load();
  if (base.since != null) return report; // the backup has a cursor for this device: ordinary pushes from there

  /**
   * `refsOnly`: baskets, tags and labels from the start, nothing else (every other entity's offset past its end). A
   * pass from a restore point files rows under baskets and tags it doesn't send; the backup's sync map must know them.
   */
  const pass = async (since: Date | undefined, refsOnly = false) => {
    const REFS = ['outputBasket', 'outputTag', 'txLabel'];
    const offsets = ENTITIES.map(([name]) => ({
      name,
      offset: refsOnly && !REFS.includes(name) ? Number.MAX_SAFE_INTEGER : 0,
    }));
    for (;;) {
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
      const chunk = await d.reader.getSyncChunk({ ...args, includeNextCheckpoint: true });
      // The writer only checks the offsets against its limits (no requireMatchingCheckpoint): our server refuses any over
      // its profile's maximum (100,000 to 10,000,000; "RPC list offsets must not exceed 1000000" on storage.bwalletx.com,
      // 1p checks 21 Nov 2026), and the refs-only pass's "past the end" is MAX_SAFE_INTEGER.
      const r = await d.writer.processSyncChunk(
        { ...args, offsets: offsets.map((o) => ({ name: o.name, offset: Math.min(o.offset, WRITER_MAX_OFFSET) })) },
        chunk,
      );
      report.pages++;
      for (const [name, key] of ENTITIES) {
        const rows = chunk[key];
        if (Array.isArray(rows)) offsets.find((o) => o.name === name)!.offset += rows.length;
      }
      if (r.done) return;
      if (since === undefined && !refsOnly) {
        report.unlockedPages++;
        await d.afterPage?.();
        while (d.yieldWhile?.()) await new Promise((res) => setTimeout(res, 200));
        await new Promise((res) => setTimeout(res, 0)); // let reads and payments in
      }
    }
  };
  const locked = async (since: Date, refsFirst = false) => {
    const t = now();
    await d.manager.runAsSync(async () => {
      if (refsFirst) await pass(undefined, true);
      await pass(since);
    });
    report.lockedMs.push(now() - t);
  };

  if (d.restorePoint) {
    const from = new Date(d.restorePoint.getTime() - (d.marginMs ?? FILL_MARGIN_MS));
    await locked(from, true);
    // The cursor must now sit at or past the restore point; one older (only old baskets went) would make the ordinary
    // push resend nearly everything inside the locks, so the two-pass fill runs instead.
    const since = (await load()).since;
    if (since != null && new Date(since).getTime() >= from.getTime()) return { ...report, how: 'restore-point' };
  }
  const started = new Date(now() - (d.marginMs ?? FILL_MARGIN_MS));
  const t1 = now();
  await pass(undefined);
  report.unlockedMs = now() - t1;
  await locked(started);
  return { ...report, how: 'full' };
}
