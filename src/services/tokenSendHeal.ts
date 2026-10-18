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

// ---------------------------------------------------------------------------------------------------------------

/**
 * Token outputs the wallet lists but the overlay reports 'unknown' (SCAM, 16 Oct 2026; NAKAMOTO/TERANODE before).
 * The overlay only learns a transfer when someone submits it. sendBsv21 submits after broadcast, but only best
 * effort: a failed submit, or a tab suspended between the broadcast and the submit, leaves the change unknown for
 * good. Likewise a received or recovered transfer whose sender never submitted it, or a send the wallet signed and
 * kept but never got onto the chain. Each case per transaction:
 * - on chain: submit its BEEF to the overlay ('submitted');
 * - not on chain: rebroadcast the BEEF the wallet stored, then submit ('rebroadcast');
 * - the rebroadcast is refused because its inputs are already spent: the outputs can never exist, relinquish them
 *   ('dropped').
 */
export type UnseenOutput = LocalTokenOutput;

export type UnseenHealReport = {
  /** Outputs the overlay did not know when the pass began. */
  unseen: UnseenOutput[];
  /** Txids found on chain and submitted to the overlay. */
  submitted: string[];
  /** Txids that were never on chain, broadcast again from the wallet's copy, then submitted. */
  rebroadcast: string[];
  /** Outputs of transactions that can never be mined (inputs spent elsewhere), relinquished. */
  dropped: UnseenOutput[];
  /** Outputs still unknown to the overlay after the pass. */
  stillUnseen: UnseenOutput[];
  /** Key pass run first: outputs whose record named the wrong key, refiled or relinquished. */
  keysRepaired?: number;
  keysDropped?: number;
  errors: string[];
};

export type BroadcastOutcome = { ok: true } | { ok: false; inputsSpent: boolean; error: string };

export interface UnseenHealDeps {
  localOutputs(tokenId?: string): Promise<LocalTokenOutput[]>;
  overlayStatus(tokenId: string, outpoints: string[]): Promise<Map<string, string | undefined>>;
  /** BEEF of txid from the chain indexer, or null when the chain has no such transaction. */
  chainBeef(txid: string): Promise<number[] | null>;
  /** BEEF of txid as this wallet stored it, or null. */
  localBeef(txid: string): Promise<number[] | null>;
  broadcast(beef: number[], txid: string): Promise<BroadcastOutcome>;
  submitOverlay(beef: number[], tokenId: string): Promise<void>;
  relinquish(outpoint: string): Promise<void>;
  log?(msg: string): void;
}

export const isUnseenState = (state: string | undefined): boolean => state === undefined || state === 'unknown';

/** Broadcast errors that mean the transaction can never be mined. */
export const INPUTS_SPENT_ERROR =
  /double.?spen|missing.?inputs|inputs.?(?:already )?spent|txn-mempool-conflict|already spent|competing/i;

export async function healUnseenTokenOutputs(
  deps: UnseenHealDeps,
  opts: { tokenId?: string } = {},
): Promise<UnseenHealReport> {
  const report: UnseenHealReport = {
    unseen: [],
    submitted: [],
    rebroadcast: [],
    dropped: [],
    stillUnseen: [],
    errors: [],
  };
  const log = deps.log ?? (() => {});
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  let local: LocalTokenOutput[];
  try {
    local = (await deps.localOutputs(opts.tokenId)).map((o) => ({ ...o, outpoint: normOutpoint(o.outpoint) }));
  } catch (e) {
    report.errors.push(`listOutputs: ${msg(e)}`);
    return report;
  }
  if (opts.tokenId) local = local.filter((o) => normId(o.tokenId) === normId(opts.tokenId!));
  const byToken = new Map<string, LocalTokenOutput[]>();
  for (const o of local) byToken.set(o.tokenId, [...(byToken.get(o.tokenId) ?? []), o]);

  const unseenOf = async (tokenId: string, outs: LocalTokenOutput[]) => {
    const states = await deps.overlayStatus(
      tokenId,
      outs.map((o) => o.outpoint),
    );
    return outs.filter((o) => isUnseenState(states.get(o.outpoint)));
  };

  for (const [tokenId, outs] of byToken) {
    let unseen: LocalTokenOutput[];
    try {
      unseen = await unseenOf(tokenId, outs);
    } catch (e) {
      report.errors.push(`overlay ${tokenId.slice(0, 8)}: ${msg(e)}`);
      continue;
    }
    if (!unseen.length) continue;
    report.unseen.push(...unseen);

    const touched: LocalTokenOutput[] = [];
    for (const txid of [...new Set(unseen.map((o) => o.outpoint.split('.')[0]))]) {
      const outsOfTx = unseen.filter((o) => o.outpoint.startsWith(`${txid}.`));
      try {
        const onChain = await deps.chainBeef(txid);
        if (onChain) {
          await deps.submitOverlay(onChain, tokenId);
          report.submitted.push(txid);
          touched.push(...outsOfTx);
          log(`submitted ${txid} (${tokenId}) to the overlay`);
          continue;
        }
        const stored = await deps.localBeef(txid);
        if (!stored) {
          report.errors.push(`${txid.slice(0, 8)}: not on chain and no stored copy`);
          continue;
        }
        const sent = await deps.broadcast(stored, txid);
        if (sent.ok) {
          report.rebroadcast.push(txid);
          touched.push(...outsOfTx);
          log(`rebroadcast ${txid} (${tokenId})`);
          try {
            await deps.submitOverlay(stored, tokenId);
          } catch (e) {
            report.errors.push(`${txid.slice(0, 8)} overlay: ${msg(e)}`);
          }
          continue;
        }
        if (!sent.inputsSpent) {
          report.errors.push(`${txid.slice(0, 8)} broadcast: ${sent.error}`);
          continue;
        }
        for (const o of outsOfTx) {
          try {
            await deps.relinquish(o.outpoint);
            report.dropped.push(o);
            log(`relinquished ${o.outpoint}: ${txid} can never be mined (${sent.error})`);
          } catch (e) {
            report.errors.push(`relinquish ${o.outpoint}: ${msg(e)}`);
          }
        }
      } catch (e) {
        report.errors.push(`${txid.slice(0, 8)}: ${msg(e)}`);
      }
    }

    // What the overlay still doesn't know (it may need a moment after a submit).
    const dropped = new Set(report.dropped.map((o) => o.outpoint));
    const rest = unseen.filter((o) => !dropped.has(o.outpoint));
    if (!rest.length) continue;
    try {
      report.stillUnseen.push(...(touched.length ? await unseenOf(tokenId, rest) : rest));
    } catch {
      report.stillUnseen.push(...rest);
    }
  }
  return report;
}

/** "Sent 1 transfer to the indexer, removed 1 record that can never confirm". */
export const describeUnseenHeal = (
  r: Pick<UnseenHealReport, 'submitted' | 'rebroadcast' | 'dropped' | 'unseen'>,
): string => {
  const parts: string[] = [];
  const s = r.submitted.length;
  const b = r.rebroadcast.length;
  const d = r.dropped.length;
  if (s) parts.push(`sent ${s} transfer${s === 1 ? '' : 's'} to the indexer`);
  if (b) parts.push(`broadcast ${b} unfinished transfer${b === 1 ? '' : 's'} again`);
  if (d) parts.push(`removed ${d} record${d === 1 ? '' : 's'} that can never confirm`);
  if (!parts.length)
    return r.unseen.length
      ? "Couldn't fix the unvalidated tokens"
      : 'Nothing to fix: the indexer knows all your tokens';
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// ---------------------------------------------------------------------------------------------------------------

/**
 * Token outputs the wallet cannot sign (SCAM, 16 Oct 2026, 5.2.25: "inputs[0].unlockScript ... OP_DUP requires at
 * least one item to be on the stack"). The output's custom instructions name a key (protocolID, keyID,
 * counterparty) that does not derive the address in its locking script, so the signer leaves the unlock empty and
 * the whole send fails. For each output: derive the key the record names and compare it with the script's P2PKH
 * hash. On a mismatch try the usual slips (keyID outpoint written txid.vout vs txid_vout, counterparty self vs
 * anyone); if one matches, file the output again with the corrected record, else relinquish it so no send ever
 * picks it.
 *
 * Root cause found 18 Oct 2026 (F-3 follow-up): most failing records had a key that signs but NO `id:` tracking tag.
 * @1sat/actions builds its spends from that tag (sendBsv21: `spends = selected.map(readAssetIdTag)`, untagged inputs
 * dropped), so an untagged token output is added as an input and never unlocked: the same empty-unlock error. Our
 * own writers that bypass stampManagedOutputIds (creator vesting lock/claim, launchpad buy/sell change, purchase
 * recovery) wrote such records. They now stamp the tag (trackedTokenOutputs); this pass refiles old untagged records
 * with one.
 */
export type KeyedTokenOutput = LocalTokenOutput & {
  /** P2PKH hash160 the locking script pays, or null when it is not P2PKH (skipped). */
  hash160: string | null;
  /** Plaintext custom instructions, or undefined when unreadable (skipped). */
  customInstructions?: string;
  tags?: string[];
};

export type KeyRef = { protocolID: [number, string]; keyID: string; counterparty: string };

export interface KeyCheckDeps {
  localOutputs(tokenId?: string): Promise<KeyedTokenOutput[]>;
  /** hash160 (hex) of the wallet's public key for this derivation (forSelf). */
  derive(key: KeyRef): Promise<string>;
  /** Replace the output's record with corrected custom instructions and tags (always carrying an `id:` tag). */
  refile(output: KeyedTokenOutput, customInstructions: string, tags: string[]): Promise<void>;
  /** A fresh `id:` tracking tag (default: random). */
  newIdTag?(): string;
  relinquish(outpoint: string): Promise<void>;
  log?(msg: string): void;
}

export type KeyCheckReport = {
  checked: number;
  repaired: KeyedTokenOutput[];
  dropped: KeyedTokenOutput[];
  errors: string[];
};

const parseKeyRef = (ci: string | undefined): (KeyRef & { raw: Record<string, unknown> }) | null => {
  if (!ci) return null;
  try {
    const raw = JSON.parse(ci) as Record<string, unknown>;
    const { protocolID, keyID } = raw;
    if (!Array.isArray(protocolID) || protocolID.length !== 2 || typeof keyID !== 'string' || !keyID) return null;
    const counterparty = typeof raw.counterparty === 'string' && raw.counterparty ? raw.counterparty : 'self';
    return { protocolID: protocolID as [number, string], keyID, counterparty, raw };
  } catch {
    return null;
  }
};

/** The tracking tag @1sat/actions spends by (`id:<actionId>_<vout>`). */
export const hasTrackingId = (tags: string[] | undefined): boolean => !!tags?.some((t) => t.startsWith('id:'));

export const randomIdTag = (vout = 0): string => {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return `id:${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}_${vout}`;
};

/** tags with an `id:` tag added when they have none. */
export const withTrackingId = (tags: string[] | undefined, gen: () => string = randomIdTag): string[] =>
  hasTrackingId(tags) ? [...(tags ?? [])] : [...(tags ?? []), gen()];

/** The record's own key first, then the slips seen in practice. */
export const keyCandidates = (k: KeyRef): KeyRef[] => {
  const ids = [k.keyID];
  const m = /^(.*-[0-9a-f]{64})([._])(\d+)$/i.exec(k.keyID);
  if (m) ids.push(`${m[1]}${m[2] === '.' ? '_' : '.'}${m[3]}`);
  const parties = [...new Set([k.counterparty, 'self', 'anyone'])];
  const out: KeyRef[] = [];
  for (const keyID of ids)
    for (const counterparty of parties) out.push({ protocolID: k.protocolID, keyID, counterparty });
  return out;
};

export async function repairUnsignableTokenOutputs(
  deps: KeyCheckDeps,
  opts: { tokenId?: string; verified?: Set<string> } = {},
): Promise<KeyCheckReport> {
  const report: KeyCheckReport = { checked: 0, repaired: [], dropped: [], errors: [] };
  const log = deps.log ?? (() => {});
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let local: KeyedTokenOutput[];
  try {
    local = await deps.localOutputs(opts.tokenId);
  } catch (e) {
    report.errors.push(`listOutputs: ${msg(e)}`);
    return report;
  }
  if (opts.tokenId) local = local.filter((o) => normId(o.tokenId) === normId(opts.tokenId!));
  for (const o of local) {
    const ref = parseKeyRef(o.customInstructions);
    if (!ref || !o.hash160) continue; // unreadable record or not P2PKH: not ours to judge
    const seenKey = `${normOutpoint(o.outpoint)}|${o.customInstructions}|${hasTrackingId(o.tags)}`;
    if (opts.verified?.has(seenKey)) continue;
    report.checked++;
    try {
      const want = o.hash160.toLowerCase();
      let match: KeyRef | undefined;
      for (const c of keyCandidates(ref)) {
        if ((await deps.derive(c)).toLowerCase() === want) {
          match = c;
          break;
        }
      }
      const keyOk = !!match && match.keyID === ref.keyID && match.counterparty === ref.counterparty;
      if (keyOk && hasTrackingId(o.tags)) {
        opts.verified?.add(seenKey);
        continue;
      }
      if (match) {
        const fixed = keyOk
          ? o.customInstructions!
          : JSON.stringify({ ...ref.raw, keyID: match.keyID, counterparty: match.counterparty });
        await deps.refile(o, fixed, withTrackingId(o.tags, deps.newIdTag));
        report.repaired.push(o);
        log(
          keyOk
            ? `refiled ${o.outpoint} with an id: tracking tag (it had none, so no send could sign it)`
            : `refiled ${o.outpoint} with keyID ${match.keyID} (${match.counterparty})`,
        );
      } else {
        await deps.relinquish(normOutpoint(o.outpoint));
        report.dropped.push(o);
        log(`relinquished ${o.outpoint}: no key of this wallet signs it`);
      }
    } catch (e) {
      report.errors.push(`${o.outpoint}: ${msg(e)}`);
    }
  }
  return report;
}
