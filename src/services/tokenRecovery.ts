/**
 * Find BSV-21 token outputs this wallet owns on chain but has no record of,
 * and import them.
 *
 * Why it is needed: @1sat/actions sendBsv21 sends token change to a key whose
 * keyID is `${tokenId}-${Date.now()}`. Only wallet storage remembers that
 * keyID. A browser (or phone) whose storage never recorded the send shows the
 * spent input or nothing at all, and the address scan cannot find the change
 * because it is not one of the deposit addresses.
 *
 * How: start from every token output the wallet's storage knows (spent or
 * not), ask the indexer which transaction spent it, and look at that
 * transaction's token outputs. The last output of the same token is where
 * sendBsv21 puts the change. If it is unspent and not in the wallet, search
 * for its keyID around the time the transaction was mined (tokenKeySearch).
 * A match proves the wallet holds the key; the token overlay must then report
 * the output valid (or queued) before it is imported. Spent outputs on the way
 * are followed the same way, a few hops deep.
 *
 * A wallet whose storage never recorded any of a token's outputs (a fresh
 * browser, another device did the mint) has nowhere to start. So the frontier
 * is also seeded with outpoints from the indexer (seedOutpoints): the genesis
 * of every token this wallet touched or was asked about, and token outputs
 * found at its own addresses. Seeds are only starting points: they are walked
 * like known outputs but never treated as the wallet's own.
 *
 * Every step is read-only on chain. Results are cached, so a search runs at
 * most once per transaction and window, and nothing is imported twice.
 */

export interface KnownTokenOutput {
  /** txid.vout */
  outpoint: string;
  /** Storage still lists it as spendable. */
  spendable: boolean;
}

export interface TxTokenOutput {
  vout: number;
  tokenId: string;
  amt: string;
  /** hash160 of the P2PKH lock after the inscription, hex; null if not P2PKH. */
  hash160: string | null;
}

export interface TxTiming {
  /** Seconds. Missing while the transaction is unmined. */
  blockTime?: number;
  /** Seconds, time of the block before. */
  prevBlockTime?: number;
}

export interface KeyHit {
  hash160: string;
  keyID: string;
}

export interface TokenRecoveryDeps {
  knownTokenOutputs(): Promise<KnownTokenOutput[]>;
  /**
   * Extra starting outpoints (txid.vout or txid_vout) from the indexer: token
   * genesis outputs and token outputs at the wallet's addresses. Optional.
   */
  seedOutpoints?(opts: { thorough: boolean; tokenIds: string[] }): Promise<string[]>;
  /** Spending txid per outpoint (txid.vout), null when unspent. */
  getSpends(outpoints: string[]): Promise<Map<string, string | null>>;
  getTxTokenOutputs(txid: string): Promise<TxTokenOutput[]>;
  getTxTiming(txid: string): Promise<TxTiming>;
  /** Overlay state per outpoint (txid.vout): valid, queued, spent, unknown. */
  overlayStatus(tokenId: string, outpoints: string[]): Promise<Map<string, string | undefined>>;
  /** Search keyIDs `${prefix}${ms}` for ms in [fromMs, toMs]. */
  searchKeys(prefix: string, targets: Set<string>, fromMs: number, toMs: number): Promise<KeyHit[]>;
  importOutput(args: { txid: string; vout: number; keyID: string; tokenId: string; hash160: string }): Promise<void>;
  /** Drop an output storage lists as spendable that the chain says is spent. */
  dropStale(outpoint: string): Promise<void>;
  cacheGet(key: string): Promise<string | null>;
  cacheSet(key: string, value: string): Promise<void>;
  now(): number;
  log?(msg: string): void;
}

export interface TokenRecoveryOptions {
  /** Repair Sync: search the wider window too, and retry searches cached as not found. */
  thorough?: boolean;
  maxHops?: number;
  /** Tokens to walk from their genesis even if this storage knows none of their outputs. */
  tokenIds?: string[];
}

export interface TokenRecoveryResult {
  imported: { outpoint: string; tokenId: string; amt: string }[];
  stale: string[];
  searched: number;
  pending: string[];
}

const ACCEPT_STATES = new Set(['valid', 'queued']);

/** Window levels in ms around a mined tx: 0 = the block interval, 1 = an hour either side. */
export const searchWindow = (timing: TxTiming, nowMs: number, level: 0 | 1): [number, number] => {
  if (!timing.blockTime) {
    // Unmined: built at most a few hours ago.
    return level === 0 ? [nowMs - 2 * 3600_000, nowMs] : [nowMs - 24 * 3600_000, nowMs];
  }
  const block = timing.blockTime * 1000;
  const prev = (timing.prevBlockTime ?? timing.blockTime - 1200) * 1000;
  // Block timestamps drift from wall clocks; leave margin both sides.
  if (level === 0) return [Math.min(prev, block) - 10 * 60_000, block + 5 * 60_000];
  return [Math.min(prev, block) - 3600_000, block + 3600_000];
};

export const normOutpoint = (o: string): string => o.replace('_', '.');

export const recoverTokenOutputs = async (
  deps: TokenRecoveryDeps,
  opts: TokenRecoveryOptions = {},
): Promise<TokenRecoveryResult> => {
  const maxHops = opts.maxHops ?? 6;
  const result: TokenRecoveryResult = { imported: [], stale: [], searched: 0, pending: [] };
  const log = deps.log ?? (() => {});

  const known = await deps.knownTokenOutputs();
  const knownSet = new Set(known.map((k) => normOutpoint(k.outpoint)));
  const spendableSet = new Set(known.filter((k) => k.spendable).map((k) => normOutpoint(k.outpoint)));

  // A token id is its genesis outpoint (txid_vout).
  const genesis = (opts.tokenIds ?? []).filter((t) => /^[0-9a-f]{64}[._]\d+$/i.test(t)).map(normOutpoint);
  let seeds: string[] = [];
  if (deps.seedOutpoints) {
    try {
      seeds = (await deps.seedOutpoints({ thorough: !!opts.thorough, tokenIds: opts.tokenIds ?? [] })).map(
        normOutpoint,
      );
    } catch (err) {
      log(`seed lookup failed: ${String(err)}`);
    }
  }
  let frontier = [...new Set([...knownSet, ...genesis, ...seeds])];
  const checked = new Set<string>();
  const visitedTx = new Set<string>();

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const batch = frontier.filter((o) => !checked.has(o));
    batch.forEach((o) => checked.add(o));
    frontier = [];
    if (batch.length === 0) break;

    const spends = await deps.getSpends(batch);
    const spenders = new Set<string>();
    for (const o of batch) {
      const spentBy = spends.get(o) ?? null;
      if (!spentBy) continue;
      if (spendableSet.has(o)) {
        // Storage still lists it as spendable, but the chain spent it.
        try {
          await deps.dropStale(o);
          result.stale.push(o);
        } catch (err) {
          log(`could not drop stale ${o}: ${String(err)}`);
        }
      }
      if (!visitedTx.has(spentBy)) spenders.add(spentBy);
    }

    for (const txid of spenders) {
      visitedTx.add(txid);
      const outs = await deps.getTxTokenOutputs(txid);
      const unknownOuts = outs.filter((o) => !knownSet.has(`${txid}.${o.vout}`));
      if (unknownOuts.length === 0) {
        // The wallet recorded this send; its outputs are already seeds.
        continue;
      }
      // Change sits in the last output of each token. Only that one is
      // followed: earlier outputs went to recipients, and walking into their
      // later sends would only cost searches that cannot match.
      const lastByToken = new Map<string, TxTokenOutput>();
      for (const o of outs) lastByToken.set(o.tokenId, o);
      for (const o of lastByToken.values()) {
        if (!knownSet.has(`${txid}.${o.vout}`)) frontier.push(`${txid}.${o.vout}`);
      }
      for (const [tokenId, change] of lastByToken) {
        const outpoint = `${txid}.${change.vout}`;
        if (knownSet.has(outpoint) || !change.hash160) continue;
        const outSpend = (await deps.getSpends([outpoint])).get(outpoint) ?? null;
        if (outSpend) continue; // spent: followed above, nothing to import here

        const keyCache = `tokenRecovery:key:${outpoint}`;
        let keyID = await deps.cacheGet(keyCache);
        if (!keyID) {
          const timing = await deps.getTxTiming(txid);
          const levels: (0 | 1)[] = opts.thorough ? [0, 1] : [0];
          for (const level of levels) {
            const doneKey = `tokenRecovery:none:${outpoint}:${level}`;
            if (!opts.thorough && (await deps.cacheGet(doneKey))) continue;
            const [from, to] = searchWindow(timing, deps.now(), level);
            result.searched++;
            log(`searching ${outpoint} (${tokenId}) level ${level}`);
            const hits = await deps.searchKeys(`${tokenId}-`, new Set([change.hash160]), from, to);
            if (hits.length > 0) {
              keyID = hits[0].keyID;
              await deps.cacheSet(keyCache, keyID);
              break;
            }
            // Only a mined tx's window is final; an unmined one moves with the clock.
            if (timing.blockTime) await deps.cacheSet(doneKey, '1');
          }
        }
        if (!keyID) continue;

        const states = await deps.overlayStatus(tokenId, [outpoint]);
        const state = states.get(outpoint);
        if (!state || !ACCEPT_STATES.has(state)) {
          log(`found key for ${outpoint} but the overlay says ${state ?? 'unknown'}; will retry`);
          result.pending.push(outpoint);
          continue;
        }
        await deps.importOutput({ txid, vout: change.vout, keyID, tokenId, hash160: change.hash160 });
        knownSet.add(outpoint);
        result.imported.push({ outpoint, tokenId, amt: change.amt });
      }
    }
  }
  return result;
};
