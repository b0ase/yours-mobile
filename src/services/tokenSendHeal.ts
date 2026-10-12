/**
 * BSV-21 sends that went out but were never fully recorded, and local token records the chain has already spent.
 *
 * TERANODE, 12 Oct 2026 (web.bwalletx.com, iOS Safari, 5.2.13): the first transfer 75f04ce8… was mined, its change
 * (20,999,000 at 1BjTE7Az…, output .1) is valid on the overlay, and the mint output it spent is spent. The wallet
 * still listed the mint as spendable and had no record of the change, most likely because Safari suspended the tab
 * between the broadcast and the wallet recording the action. Every later send then stopped with "stale", Repair
 * Sync said OK, and the loop had no way out.
 *
 * Three pieces, each read-only on chain and bounded:
 * - healTokenSends: token sends whose action storage holds as not finished (unsigned / nosend / unprocessed /
 *   sending / failed). Their change output's keyID is in storage (custom instructions), so no key search is needed:
 *   look the change address up on the indexer and import any valid unspent output of that token found there.
 *   Also runs for sends the send view journalled (TOKEN_SEND_JOURNAL_KEY) but never marked done.
 * - fixStaleToken: one token. Relinquish local outputs the overlay reports spent, then heal and recover its change,
 *   and report what changed.
 * - dropSpentTokenOutputs: Repair Sync's final pass. The storage merge is a union, so it can bring a spent output
 *   back; relinquish every token output the overlay or chain reports spent.
 */

export const TOKEN_SEND_JOURNAL_KEY = 'tokenSendJournal';
/** Journal entries older than this are dropped even if never healed. */
export const JOURNAL_MAX_AGE_MS = 7 * 24 * 3600_000;

export type TokenSendJournalEntry = {
  id: string;
  tokenId: string;
  startedAt: number;
  /** Set as soon as sendBsv21 returns a txid. */
  txid?: string;
  /** The send view finished handling the result. */
  done?: boolean;
};

/** Statuses of an action storage has not finished. */
export const UNFINISHED_STATUSES = new Set(['unsigned', 'nosend', 'unprocessed', 'sending', 'failed']);
/** @1sat/actions sendBsv21's action description. */
export const TOKEN_SEND_DESC = /^Send .+ to \d+ recipients?$/;

export type HealActionOutput = {
  outputIndex: number;
  lockingScript?: string;
  customInstructions?: string;
};
export type HealAction = {
  txid?: string;
  status?: string;
  description?: string;
  outputs?: HealActionOutput[];
};

export type ParsedTokenOutput = { tokenId: string; amt: string; hash160: string | null };

export type StrandedChange = { tokenId: string; keyID: string; hash160: string; amt: string; actionTxid?: string };

const normId = (id: string) => id.replace('.', '_');
export const normOutpoint = (o: string): string => o.replace('_', '.');

const keyIDOf = (ci: string | undefined): string | undefined => {
  if (!ci) return undefined;
  try {
    const j = JSON.parse(ci) as { keyID?: unknown };
    return typeof j.keyID === 'string' && j.keyID ? j.keyID : undefined;
  } catch {
    return undefined;
  }
};

/** Token outputs (with their keyIDs) of token-send actions storage never finished. */
export const strandedChangeOutputs = (
  actions: HealAction[],
  parse: (lockingScript: string) => ParsedTokenOutput | null,
  tokenId?: string,
): StrandedChange[] => {
  const out: StrandedChange[] = [];
  for (const a of actions) {
    if (!UNFINISHED_STATUSES.has(a.status ?? '') || !TOKEN_SEND_DESC.test(a.description ?? '')) continue;
    for (const o of a.outputs ?? []) {
      const keyID = keyIDOf(o.customInstructions);
      if (!keyID || !o.lockingScript) continue;
      const t = parse(o.lockingScript);
      if (!t?.hash160) continue;
      if (tokenId && normId(t.tokenId) !== normId(tokenId)) continue;
      out.push({ tokenId: t.tokenId, keyID, hash160: t.hash160, amt: t.amt, actionTxid: a.txid });
    }
  }
  return out;
};

export type ImportedToken = { outpoint: string; tokenId: string; amt: string };

export interface TokenSendHealDeps {
  /** Every action, including failed ones. */
  listActions(): Promise<HealAction[]>;
  parse(lockingScript: string): ParsedTokenOutput | null;
  /** Unspent outputs of tokenId at the P2PKH hash160 that the overlay reports valid (or queued). */
  findValidUnspent(tokenId: string, hash160: string): Promise<{ outpoint: string; amt: string }[]>;
  /** The wallet already lists this outpoint (txid.vout) as spendable. */
  haveOutput(outpoint: string): Promise<boolean>;
  importOutput(args: { txid: string; vout: number; keyID: string; tokenId: string; hash160: string }): Promise<void>;
  journal?: {
    read(): Promise<TokenSendJournalEntry[]>;
    write(entries: TokenSendJournalEntry[]): Promise<void>;
  };
  now(): number;
  log?(msg: string): void;
}

export type TokenSendHealReport = { imported: ImportedToken[]; checked: number; errors: string[] };

export async function healTokenSends(
  deps: TokenSendHealDeps,
  opts: { tokenId?: string } = {},
): Promise<TokenSendHealReport> {
  const report: TokenSendHealReport = { imported: [], checked: 0, errors: [] };
  const log = deps.log ?? (() => {});
  let actions: HealAction[] = [];
  try {
    actions = await deps.listActions();
  } catch (e) {
    report.errors.push(`listActions: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }
  const stranded = strandedChangeOutputs(actions, deps.parse, opts.tokenId);
  const seen = new Set<string>();
  for (const s of stranded) {
    const key = `${s.tokenId}:${s.hash160}`;
    if (seen.has(key)) continue;
    seen.add(key);
    report.checked++;
    try {
      for (const u of await deps.findValidUnspent(s.tokenId, s.hash160)) {
        const outpoint = normOutpoint(u.outpoint);
        if (await deps.haveOutput(outpoint)) continue;
        const [txid, vout] = outpoint.split('.');
        await deps.importOutput({ txid, vout: Number(vout), keyID: s.keyID, tokenId: s.tokenId, hash160: s.hash160 });
        report.imported.push({ outpoint, tokenId: s.tokenId, amt: u.amt });
        log(`imported ${outpoint} (${s.tokenId}) from unfinished send ${s.actionTxid ?? '?'}`);
      }
    } catch (e) {
      report.errors.push(`${s.tokenId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Journal: done or expired entries go; the rest stay for the next start.
  if (deps.journal) {
    try {
      const entries = await deps.journal.read();
      const now = deps.now();
      const keep = entries.filter((e) => !e.done && now - e.startedAt < JOURNAL_MAX_AGE_MS);
      if (keep.length !== entries.length) await deps.journal.write(keep);
    } catch (e) {
      report.errors.push(`journal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

/** Journal entries still open: their token needs a heal pass. */
export const openJournalTokens = (entries: TokenSendJournalEntry[], now: number): string[] => [
  ...new Set(entries.filter((e) => !e.done && now - e.startedAt < JOURNAL_MAX_AGE_MS).map((e) => e.tokenId)),
];

// ---------------------------------------------------------------------------------------------------------------

export type LocalTokenOutput = { outpoint: string; tokenId: string; amt: string };

export interface SpendPassDeps {
  /** Spendable bsv21-basket outputs in the wallet. */
  localOutputs(tokenId?: string): Promise<LocalTokenOutput[]>;
  /** Overlay state per outpoint (txid.vout) for one token. */
  overlayStatus(tokenId: string, outpoints: string[]): Promise<Map<string, string | undefined>>;
  /** Spending txid per outpoint (txid.vout), null when unspent. Optional: overlay only when absent. */
  chainSpends?(outpoints: string[]): Promise<Map<string, string | null>>;
  relinquish(outpoint: string): Promise<void>;
  log?(msg: string): void;
}

export type SpendPassReport = { dropped: LocalTokenOutput[]; checked: number; errors: string[] };

/** Relinquish token outputs the overlay or the chain reports spent. Never throws. */
export async function dropSpentTokenOutputs(
  deps: SpendPassDeps,
  opts: { tokenId?: string } = {},
): Promise<SpendPassReport> {
  const report: SpendPassReport = { dropped: [], checked: 0, errors: [] };
  let local: LocalTokenOutput[];
  try {
    local = (await deps.localOutputs(opts.tokenId)).map((o) => ({ ...o, outpoint: normOutpoint(o.outpoint) }));
  } catch (e) {
    report.errors.push(`listOutputs: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }
  if (opts.tokenId) local = local.filter((o) => normId(o.tokenId) === normId(opts.tokenId!));
  report.checked = local.length;
  const byToken = new Map<string, LocalTokenOutput[]>();
  for (const o of local) byToken.set(o.tokenId, [...(byToken.get(o.tokenId) ?? []), o]);

  const spent = new Set<string>();
  for (const [tokenId, outs] of byToken) {
    try {
      const states = await deps.overlayStatus(
        tokenId,
        outs.map((o) => o.outpoint),
      );
      for (const o of outs) if (states.get(o.outpoint) === 'spent') spent.add(o.outpoint);
    } catch (e) {
      report.errors.push(`overlay ${tokenId.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (deps.chainSpends) {
    const rest = local.filter((o) => !spent.has(o.outpoint)).map((o) => o.outpoint);
    if (rest.length) {
      try {
        const spends = await deps.chainSpends(rest);
        for (const o of rest) if (spends.get(o)) spent.add(o);
      } catch (e) {
        report.errors.push(`chain: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  for (const o of local) {
    if (!spent.has(o.outpoint)) continue;
    try {
      await deps.relinquish(o.outpoint);
      report.dropped.push(o);
    } catch (e) {
      report.errors.push(`relinquish ${o.outpoint}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

// ---------------------------------------------------------------------------------------------------------------

export type StaleFixResult = {
  dropped: LocalTokenOutput[];
  imported: ImportedToken[];
  errors: string[];
};

export interface StaleFixDeps {
  spendPass(tokenId: string): Promise<SpendPassReport>;
  healSends(tokenId: string): Promise<TokenSendHealReport>;
  /** The chain walk (tokenRecovery.ts), thorough and widened, restricted to tokenId in the result. */
  recover(tokenId: string): Promise<ImportedToken[]>;
}

/** "Fix and send": one token's local records made to match the overlay. */
export async function fixStaleToken(deps: StaleFixDeps, tokenId: string): Promise<StaleFixResult> {
  const pass = await deps.spendPass(tokenId);
  const errors = [...pass.errors];
  const imported: ImportedToken[] = [];
  const add = (list: ImportedToken[]) => {
    for (const i of list) {
      if (normId(i.tokenId) !== normId(tokenId)) continue;
      if (!imported.some((x) => normOutpoint(x.outpoint) === normOutpoint(i.outpoint))) imported.push(i);
    }
  };
  try {
    const healed = await deps.healSends(tokenId);
    errors.push(...healed.errors);
    add(healed.imported);
  } catch (e) {
    errors.push(`heal: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    add(await deps.recover(tokenId));
  } catch (e) {
    errors.push(`recover: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { dropped: pass.dropped, imported, errors };
}

/** "Removed 1 already-spent record, added 20,999,000 TERANODE". */
export const describeStaleFix = (
  r: Pick<StaleFixResult, 'dropped' | 'imported'>,
  fmt: (atomic: bigint) => string,
  ticker: string,
): string => {
  const parts: string[] = [];
  const n = r.dropped.length;
  if (n) parts.push(`Removed ${n} already-spent record${n === 1 ? '' : 's'}`);
  const added = r.imported.reduce((s, i) => s + BigInt(i.amt || '0'), 0n);
  if (r.imported.length) parts.push(`${n ? 'added' : 'Added'} ${fmt(added)} ${ticker}`);
  return parts.length ? parts.join(', ') : 'Nothing to fix: this wallet already matches the indexer';
};

// ---------------------------------------------------------------------------------------------------------------

export type JournalStore = {
  get(): Promise<TokenSendJournalEntry[]>;
  set(entries: TokenSendJournalEntry[]): Promise<void>;
};

/** chrome.storage.local (the web edition's shim included); every call swallows errors (journal only). */
export const chromeJournalStore: JournalStore = {
  async get() {
    try {
      const r = await chrome.storage.local.get(TOKEN_SEND_JOURNAL_KEY);
      return (r?.[TOKEN_SEND_JOURNAL_KEY] as TokenSendJournalEntry[] | undefined) ?? [];
    } catch {
      return [];
    }
  },
  async set(entries) {
    try {
      await chrome.storage.local.set({ [TOKEN_SEND_JOURNAL_KEY]: entries });
    } catch {
      // journal only
    }
  },
};

/**
 * The send view's journal: an entry before sendBsv21 runs, closed the moment a txid comes back. An entry still open
 * at the next start means the page stopped mid-send (a suspended Safari tab); startup heals that token.
 */
export const journalSendStart = async (store: JournalStore, tokenId: string, now = Date.now()): Promise<string> => {
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entries = (await store.get()).filter((e) => now - e.startedAt < JOURNAL_MAX_AGE_MS);
  await store.set([...entries, { id, tokenId, startedAt: now }].slice(-50));
  return id;
};

export const journalSendEnd = async (store: JournalStore, id: string, txid?: string): Promise<void> => {
  const entries = await store.get();
  // A txid means the send went out and sendBsv21 recorded it; no txid (an error before broadcast) means nothing went out.
  await store.set(entries.map((e) => (e.id === id ? { ...e, ...(txid ? { txid } : {}), done: true } : e)));
};
