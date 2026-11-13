/**
 * Pairing the bWalletX CLI / MCP with an agent account (SMART-WALLET-SPEC.md, "paired" mode).
 *
 * The CLI uses the same pairing channel as websites (src/pair/protocol.ts) but connects with the origin
 * CLI_ORIGIN. Browsers set the websocket Origin and pages can't change it, so no website can pose as the
 * CLI: only a program on a computer can. A CLI pairing is bound to ONE agent account, with scopes and an
 * expiry (30 days at most). Keys never leave the phone: requests run here, through the same gate the
 * b agent uses (checkAgentAction / runAgentAction), on the paired agent account while it's the one open.
 */
import { listOrdinals, type OneSatContext } from '@1sat/actions';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { checkSize, estimateCost, isMintableType, notifyMinted, validateForm, type Collection } from '../mint/mint';
import { mintMedia } from '../mint/mintMedia';
import {
  checkMintBudget,
  MintLimitError,
  recordMint,
  remaining,
  UPLOAD_CHUNK_BYTES,
  UploadStore,
  type MintLimits,
} from './mintScope';
import {
  allAgentsStopped,
  appendAgentLog,
  checkAgentSpend,
  getAgentAccount,
  getAgentLog,
  isPairableAgent,
} from '../agents/agentAccounts';
import { isPaused, PAUSED_MESSAGE } from '../config/killSwitch';
import { runAgentAction, type AgentActionHooks } from '../agents/agentTrade';
import { serialSpend } from '../agents/spendQueue';
import { getLoadedStrategy, getPaperBook, loadStrategy, parseStrategy } from '../agents/strategy';

export const CLI_ORIGIN = 'https://cli.bwalletx.com';
export type AgentScope = 'read' | 'trade' | 'send' | 'mint';
export const MAX_GRANT_DAYS = 30;

/** `mint` is set exactly when the scopes include 'mint': the limits chosen at pairing and what's used. */
export type AgentGrant = { agentId: string; name: string; scopes: AgentScope[]; expiresAt: number; mint?: MintLimits };

export const makeGrant = (
  agentId: string,
  name: string,
  scopes: AgentScope[],
  days: number,
  now = Date.now(),
  mint?: MintLimits,
): AgentGrant => {
  const all = [...new Set<AgentScope>(['read', ...scopes.filter((s) => s !== 'mint' || mint)])];
  return {
    agentId,
    name,
    scopes: all,
    expiresAt: now + Math.min(Math.max(days, 1), MAX_GRANT_DAYS) * 86_400_000,
    ...(all.includes('mint') && mint && { mint }),
  };
};

/** Mint-only pairings (read + mint) may use any account, agent or not: the budget is set on the phone. */
export const mintOnly = (g: Pick<AgentGrant, 'scopes'>) => g.scopes.every((s) => s === 'read' || s === 'mint');

const NEEDS: Record<string, AgentScope> = {
  info: 'read',
  balance: 'read',
  log: 'read',
  strategy_show: 'read',
  strategy_load: 'trade',
  buy: 'trade',
  send: 'send',
  mint_quote: 'mint',
  mint_upload: 'mint',
  mint: 'mint',
};

export class AgentCallError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Is this call allowed by the grant right now? Pure; throws AgentCallError with a code the CLI shows. */
export const checkGrant = (grant: AgentGrant, action: string, currentId: string | undefined, now = Date.now()) => {
  if (now > grant.expiresAt)
    throw new AgentCallError('EXPIRED', 'This pairing has expired. Run `bwalletx login` again.');
  const need = NEEDS[action];
  if (!need) throw new AgentCallError('UNKNOWN', `Unknown action "${action}"`);
  if (!grant.scopes.includes(need))
    throw new AgentCallError('SCOPE', `This pairing isn't allowed to ${need} (granted: ${grant.scopes.join(', ')}).`);
  if (!(mintOnly(grant) && grant.mint) && !isPairableAgent(grant.agentId))
    throw new AgentCallError('NOT_AGENT', `${grant.name} is no longer an agent account.`);
  if (currentId !== grant.agentId)
    throw new AgentCallError('NOT_OPEN', `bWalletX is open on another account. Switch to ${grant.name} in the app.`);
};

type P = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

export type AgentDeps = {
  ctx: OneSatContext;
  currentId: string | undefined;
  bsvUsd: () => Promise<number>;
  /** sat/kB the wallet signs at (Settings › Custom Fee Rate). */
  feeRate?: () => number;
  /** Persist the grant (mint usage) with the pairing. */
  saveGrant?: (g: AgentGrant) => void;
  /** Swappable for tests. */
  mintMedia?: typeof mintMedia;
  /** The `spending` kill switch (config/killSwitch.ts); swappable for tests. */
  spendingPaused?: () => Promise<boolean>;
  /**
   * Is this pairing still live (not unpaired, lapsed or parked, same account and wallet open)? sessions.ts sets it per
   * request. A spend waits in the queue behind other spends, so it is asked again inside the queued job and right
   * before signing (b-Aware report, 13 Nov 2026). Missing = live (direct callers and tests with no session).
   */
  isLive?: () => boolean;
  /** Swappable for tests: the trade run's own outside calls (agentTrade.ts AgentTradeIo). */
  tradeIo?: AgentActionHooks['io'];
};

const NOT_PAIRED = 'This computer is no longer paired with bWalletX. Run `bwalletx login` again.';

/** Refuse when the pairing was removed (or the account switched) since the request came in. Fails closed. */
const assertLive = (deps: AgentDeps) => {
  let ok: boolean;
  try {
    ok = deps.isLive ? deps.isLive() : true;
  } catch {
    ok = false;
  }
  if (!ok) throw new AgentCallError('UNPAIRED', NOT_PAIRED);
};

/**
 * Refuse a paired-CLI spend (buy, send, mint) while "Stop all agents", the account's own Stop or the `spending`
 * pause is on. Checked before anything is assembled or signed, for agent and mint-only pairings alike.
 */
const assertMaySpend = async (grant: AgentGrant, deps: AgentDeps) => {
  if (allAgentsStopped()) throw new AgentCallError('STOPPED', 'All agents are stopped in bWalletX.');
  if (getAgentAccount(grant.agentId)?.stopped)
    throw new AgentCallError('STOPPED', `${grant.name} is stopped in bWalletX.`);
  const paused = deps.spendingPaused ?? (() => isPaused('spending'));
  if (await paused().catch(() => true)) throw new AgentCallError('PAUSED', PAUSED_MESSAGE);
};

/**
 * First thing inside a queued spend job, and its last look: the pairing is still live, the grant still allows the call
 * (expiry, agent status), and Stop all / Stop / pause are off. Throws AgentCallError.
 */
const assertSpendJob = async (grant: AgentGrant, action: string, deps: AgentDeps) => {
  assertLive(deps);
  checkGrant(grant, action, deps.currentId);
  await assertMaySpend(grant, deps);
  assertLive(deps);
};

const uploads = new UploadStore();
/** One spend (mint, buy, send) at a time per phone, shared with pot payments (agents/spendQueue.ts). */
const serial = serialSpend;

const asCollection = (v: unknown): Collection => {
  const c = (v && typeof v === 'object' ? v : {}) as P;
  if (c.kind === 'new') return { kind: 'new', name: String(c.name ?? '') };
  if (c.kind === 'existing') return { kind: 'existing', id: String(c.id ?? ''), name: String(c.name ?? 'Collection') };
  return { kind: 'none' };
};

/** Run one paired-CLI call on the phone. */
export async function handleAgentCall(
  grant: AgentGrant,
  action: string,
  params: unknown,
  deps: AgentDeps,
): Promise<unknown> {
  checkGrant(grant, action, deps.currentId);
  const p = (params && typeof params === 'object' ? params : {}) as P;
  const id = grant.agentId;
  const acct = getAgentAccount(id);

  switch (action) {
    case 'info': {
      const l = getLoadedStrategy(id);
      return {
        account: grant.name,
        identityAddress: id,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
        stopped: acct?.stopped ?? false,
        dailyCapUsd: acct?.dailyCapUsd ?? null,
        mint: grant.mint
          ? { maxItems: grant.mint.maxItems, maxUsd: grant.mint.maxUsd, ...remainingOf(grant.mint) }
          : null,
        strategy: l ? { name: l.strategy.name, version: l.strategy.version, mode: l.mode } : null,
      };
    }
    case 'balance': {
      const [outs, tokens, rate] = await Promise.all([
        deps.ctx.wallet.listOutputs({ basket: 'default', limit: 10_000 }),
        heldBsv21Balances(deps.ctx).catch(() => []),
        deps.bsvUsd(),
      ]);
      const sats = outs.outputs.reduce((s, o) => s + (o.spendable !== false ? o.satoshis : 0), 0);
      const l = getLoadedStrategy(id);
      return {
        bsv: { sats, usd: rate ? (sats / 1e8) * rate : null },
        tokens: tokens.map((t) => ({ id: t.id, sym: t.sym, amount: String(t.all.confirmed), dec: t.dec })),
        paper: l?.mode === 'paper' ? getPaperBook(id) : null,
      };
    }
    case 'log':
      return getAgentLog(id).slice(0, Math.min(Math.max(num(p.limit) || 50, 1), 200));
    case 'strategy_show':
      return getLoadedStrategy(id);
    case 'strategy_load': {
      // From a computer, strategies load on paper only; going live is a tap in the app.
      const r = parseStrategy(p.strategy);
      if (!r.ok) throw new AgentCallError('INVALID', r.errors.join('; '));
      loadStrategy(id, r.strategy, 'paper');
      return { loaded: r.strategy.name, version: r.strategy.version, mode: 'paper' };
    }
    case 'buy':
    case 'send': {
      const usd = num(p.usd ?? p.maxUsd);
      if (!(usd > 0)) throw new AgentCallError('INVALID', 'usd must be a positive number');
      const block =
        action === 'buy'
          ? { kind: 'buy' as const, token: String(p.tokenId ?? ''), usd }
          : { kind: 'send' as const, token: 'BSV', usd, to: String(p.to ?? '') };
      await assertMaySpend(grant, deps);
      // Serialised like mint: checkAgentAction reads the log and the spend is logged only after it is
      // signed, so two parallel requests could both pass the daily cap (18 Oct 2026 review).
      const rate = await deps.bsvUsd();
      const r = await serial(async () => {
        // The job may have waited behind a slow mint: unpaired, expired or Stopped meanwhile → nothing runs.
        await assertSpendJob(grant, action, deps);
        return runAgentAction(deps.ctx, id, block, rate, {
          // Again after the listing / destination checks, right before signing (agentTrade.ts lastLook).
          beforeSign: async () => {
            try {
              await assertSpendJob(grant, action, deps);
              return null;
            } catch (e) {
              return e instanceof Error ? e.message : 'Refused';
            }
          },
          io: deps.tradeIo,
        });
      });
      if (!r.ok) throw new AgentCallError('REFUSED', r.text);
      return { text: r.text, txid: r.txid ?? null };
    }
    case 'mint_quote': {
      const bytes = num(p.bytes);
      if (!(bytes > 0)) throw new AgentCallError('INVALID', 'bytes must be a positive number');
      const rate = await deps.bsvUsd();
      const est = estimateCost(bytes, deps.feeRate?.() ?? 100, rate, { newCollection: p.newCollection === true });
      return {
        ...est,
        satsPerKb: deps.feeRate?.() ?? 100,
        bsvUsd: rate,
        mint: grant.mint ? remainingOf(grant.mint) : null,
      };
    }
    case 'mint_upload':
      return wrapLimit(() => uploads.put(p as Parameters<UploadStore['put']>[0]));
    case 'mint':
      return serial(async () => {
        await assertSpendJob(grant, action, deps);
        return runMint(grant, p, deps);
      });
  }
  throw new AgentCallError('UNKNOWN', `Unknown action "${action}"`);
}

const remainingOf = (l: MintLimits) => {
  const r = remaining(l);
  return { itemsUsed: l.items, spentUsd: l.spentUsd, itemsLeft: r.items, usdLeft: r.usd };
};

const wrapLimit = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MintLimitError) throw new AgentCallError(e.code, e.message);
    throw e;
  }
};

/**
 * On an agent account a mint is an agent spend too: the account's daily cap and hourly limit apply, refusals are
 * logged, and the spend is logged after broadcast so it counts against them. Mint-only pairings on an ordinary
 * account keep only the pairing's own limits (it has no agent cap).
 */
const assertAgentCap = (grant: AgentGrant, usd: number) => {
  if (!getAgentAccount(grant.agentId)) return;
  const r = checkAgentSpend(grant.agentId, usd);
  if (r.ok) return;
  appendAgentLog(grant.agentId, { at: Date.now(), action: 'refused', detail: `Refused mint: ${r.reason}`, usd: 0 });
  throw new AgentCallError('REFUSED', r.reason);
};

/** `mint`: checks, budget BEFORE signing, the Mint screen's own routine, then the actual spend is recorded. */
async function runMint(grant: AgentGrant, p: P, deps: AgentDeps) {
  await assertMaySpend(grant, deps);
  const contentType = String(p.contentType ?? '');
  if (!isMintableType(contentType))
    throw new AgentCallError(
      'TYPE',
      `Can't mint "${contentType}": photos, video, audio, PDF, ebooks, text or HTML only.`,
    );
  const collection = asCollection(p.collection);
  if (collection.kind === 'existing' && !/^[0-9a-f]{64}_\d+$/.test(collection.id))
    throw new AgentCallError('INVALID', 'Bad collection id (expected <txid>_<vout>).');
  const form = { title: String(p.name ?? ''), description: String(p.description ?? ''), collection };
  const bad = validateForm(form);
  if (bad) throw new AgentCallError('INVALID', bad);

  // Budget check first, on the declared size, so nothing is assembled or signed when it can't fit.
  const g0 = grant.mint;
  const declared = p.uploadId !== undefined ? num(p.bytes) : Math.floor((String(p.base64Content ?? '').length * 3) / 4);
  const rate = await deps.bsvUsd();
  const satsPerKb = deps.feeRate?.() ?? 100;
  const est = estimateCost(declared > 0 ? declared : 1, satsPerKb, rate, { newCollection: collection.kind === 'new' });
  wrapLimit(() => checkMintBudget(g0, est.usd));
  assertAgentCap(grant, est.usd ?? 0);

  let base64Content: string;
  if (p.uploadId !== undefined) base64Content = await wrapLimitAsync(() => uploads.take(p.uploadId));
  else {
    base64Content = String(p.base64Content ?? '');
    if (base64Content.length > (UPLOAD_CHUNK_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64Content))
      throw new AgentCallError('INVALID', 'Send files over 1.5 MB with mint_upload, then mint with the uploadId.');
  }
  const bytes =
    (base64Content.length / 4) * 3 - (base64Content.endsWith('==') ? 2 : base64Content.endsWith('=') ? 1 : 0);
  const size = checkSize(bytes);
  if (!size.ok) throw new AgentCallError('TOO_BIG', size.message);
  // Re-check on the real size (the declared one could have been smaller).
  const cost = estimateCost(bytes, satsPerKb, rate, { newCollection: collection.kind === 'new' });
  wrapLimit(() => checkMintBudget(g0, cost.usd));

  if (collection.kind === 'existing') {
    const { outputs } = await listOrdinals.execute(deps.ctx, { tags: ['subType:collection'], limit: 100, offset: 0 });
    if (!outputs.some((o) => o.outpoint.replace('.', '_') === collection.id))
      throw new AgentCallError('INVALID', "That collection isn't in this wallet.");
  }
  // Last look right before signing: Stop all / Stop / pause may have been turned on, or the computer unpaired,
  // while the file came in.
  await assertSpendJob(grant, 'mint', deps);
  assertAgentCap(grant, cost.usd ?? 0);

  const r = await (deps.mintMedia ?? mintMedia)(deps.ctx, {
    base64Content,
    contentType,
    ...form,
    feeSats: cost.feeSats,
  });
  const spentSats = r.networkSats === null ? cost.totalSats : r.networkSats + cost.feeSats;
  const usd = rate > 0 ? (spentSats / 1e8) * rate : (cost.usd ?? 0);
  // The grant may have been replaced while minting; record on the latest copy.
  const next: AgentGrant = {
    ...grant,
    mint: recordMint(grant.mint!, {
      at: Date.now(),
      name: form.title.trim(),
      txid: r.txid,
      outpoint: r.outpoint,
      usd,
      ...(r.collectionId && { collectionId: r.collectionId }),
    }),
  };
  grant.mint = next.mint;
  deps.saveGrant?.(next);
  if (getAgentAccount(grant.agentId))
    appendAgentLog(grant.agentId, {
      at: Date.now(),
      action: 'mint',
      detail: `Minted ${form.title.trim()} from a paired computer`,
      usd,
      txid: r.txid,
    });
  notifyMinted();
  return {
    txid: r.txid,
    outpoint: r.outpoint,
    origin: r.origin,
    ...(r.collectionId && { collectionId: r.collectionId }),
    sats: spentSats,
    usd,
    estimatedUsd: cost.usd,
    mint: remainingOf(next.mint!),
  };
}

const wrapLimitAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MintLimitError) throw new AgentCallError(e.code, e.message);
    throw e;
  }
};
