/**
 * b agent wallet tools in agent accounts (SMART-WALLET-SPEC.md §4). The chat models are text-only, so the
 * agent asks for an action with a fenced block in its reply:
 *
 *   ```bwalletx
 *   {"kind":"buy","token":"<BSV-21 id>","usd":2}
 *   ```
 *
 * The app reads the block, and every request goes through checkAgentAction (account Stop / daily cap +
 * the loaded strategy's rules) before anything is signed. Only the current account, and only when it is
 * an agent account, can be acted on: its keys are the only ones unlocked. Paper mode fills on the paper
 * book; live mode buys the cheapest listing or sends BSV.
 */
import { MARKET_ENABLED } from '../storeBuild';
import { buyBsv21, type OneSatContext } from '@1sat/actions';
import { sendBsv } from '../../utils/guardedSendBsv';
import { assertOrdLockV2 } from '../market/ordlockVersion';
import { appendAgentLog, checkAgentSpend, getAgentAccount } from './agentAccounts';
import { serialSpend } from './spendQueue';
import { checkAgentAction, getLoadedStrategy, getPaperBook, type ActionRequest, type StrategyAction } from './strategy';
import { describeRules, inactiveRuleNotices, paperRuleGaps } from './describeRules';
import { heldBsv21Balances } from '../airdrops/heldBalances';
import { parseRoom, roomMarket as indexerRoomMarket, roomMeta as indexerRoomMeta, type Listing } from '../market/indexer';
import { MODULE_FINISHES, purchaseContext, walletOutpoint } from '../market/walletOutpoint';
import { marketFeeOptions } from '../market/fee';
import { checkedPurchaseContext as realCheckedPurchaseContext } from '../p2p/checkedPurchase';

export type AgentActionBlock = { kind: StrategyAction; token: string; usd: number; to?: string; amount?: number };

const FENCE = /```bwalletx\s*\n([\s\S]*?)```/g;

/** Pull action blocks out of a reply; returns the reply text without them plus the parsed requests. */
export const parseActions = (reply: string): { text: string; actions: AgentActionBlock[]; bad: number } => {
  const actions: AgentActionBlock[] = [];
  let bad = 0;
  const text = reply
    .replace(FENCE, (_, body: string) => {
      try {
        const o = JSON.parse(body.trim()) as Record<string, unknown>;
        const kind = o.kind as StrategyAction;
        const usd = Number(o.usd ?? 0);
        if (
          !['buy', 'sell', 'send', 'list'].includes(kind) ||
          typeof o.token !== 'string' ||
          !o.token.trim() ||
          !(usd >= 0)
        )
          throw 0;
        actions.push({
          kind,
          token: o.token.trim(),
          usd,
          ...(typeof o.to === 'string' && { to: o.to.trim() }),
          ...(Number(o.amount) > 0 && { amount: Number(o.amount) }),
        });
      } catch {
        bad++;
      }
      return '';
    })
    .trim();
  return { text, actions: actions.slice(0, 3), bad };
};

/** The cheapest buyable listing of a token whose whole price fits the budget. Pure over its inputs. */
export const pickListing = (listings: Listing[], maxUsd: number, bsvUsd: number): Listing | null =>
  listings
    .filter((l) => l.buyable && (l.priceSats / 1e8) * bsvUsd <= maxUsd + 1e-9)
    .sort((a, b) => a.priceSats - b.priceSats)[0] ?? null;

/** A listing's own per-token price in USD, or undefined when unknown (a buyBelowUsd rule then refuses). */
export const listingPriceUsd = (l: Pick<Listing, 'perTokenSats'>, bsvUsd: number): number | undefined =>
  l.perTokenSats !== undefined && Number.isFinite(l.perTokenSats) && l.perTokenSats > 0
    ? (l.perTokenSats / 1e8) * bsvUsd
    : undefined;

/** Extra system-prompt text for an agent account: its strategy and how to ask for actions. Empty otherwise. */
export const agentAccountPrompt = (id: string | undefined, name: string) => {
  if (!id || !getAgentAccount(id)) return '';
  const l = getLoadedStrategy(id);
  const inactive = l ? inactiveRuleNotices(l.strategy.rules) : [];
  const paperGaps = l?.mode === 'paper' ? paperRuleGaps(l.strategy.rules) : [];
  const strategy = l
    ? `Loaded strategy: "${l.strategy.name}" v${l.strategy.version}, ${l.mode === 'paper' ? 'PAPER mode (pretend money, nothing is signed)' : 'LIVE (real money)'}.
Goals: ${l.strategy.goals}
Rules the wallet enforces (you cannot change them): ${describeRules(l.strategy.rules).join('; ')}.${
        inactive.length
          ? ` NOT enforced, so never tell the user these protect them, and tell them so if it matters: ${inactive.join(' ')}`
          : ''
      }${paperGaps.length ? ` ${paperGaps.join(' ')}` : ''}${
        l.mode === 'paper' ? ` Paper cash: $${getPaperBook(id).cashUsd.toFixed(2)}.` : ''
      }`
    : 'No strategy is loaded, so the user is driving: only act when they ask you to in this chat.';
  return `

AGENT ACCOUNT MODE (this overrides "you cannot do anything" above)
The current account "${name}" is an agent account: its balance is a budget the user gave you. ${strategy}
To act, put one fenced block per action at the end of your reply, exactly:
\`\`\`bwalletx
{"kind":"buy","token":"<BSV-21 token id, txid_vout>","usd":<most dollars to spend>}
\`\`\`
Kinds: "buy" (cheapest listing within usd), "send" (BSV worth usd to "to": an address or paymail). Selling and listing from chat are not available yet.
The wallet checks every action before signing and may refuse it; the result is shown to the user and logged. Never claim an action happened: say what you asked for. At most 3 actions per reply.`;
};

/**
 * Tokens of the loaded live strategy's coins this account holds (whole tokens, after decimals), for
 * stop.holdTokens. Undefined when there is no such stop or the balances can't be read: the gate then refuses.
 */
export const strategyHolding = async (ctx: OneSatContext, id: string): Promise<number | undefined> => {
  const loaded = getLoadedStrategy(id);
  if (!loaded || loaded.mode === 'paper' || !loaded.strategy.rules.stop?.holdTokens) return undefined;
  const norm = (t: string) => t.replace(/^\$/, '').toLowerCase();
  const want = new Set(loaded.strategy.rules.tokens.map(norm));
  try {
    const balances = await heldBsv21Balances(ctx);
    return balances
      .filter((b) => want.has(norm(b.id)) || (b.sym !== undefined && want.has(norm(b.sym))))
      .reduce((s, b) => {
        const dec = Number.isInteger(b.dec) && b.dec >= 0 && b.dec <= 18 ? b.dec : 0;
        const n = Number(BigInt(b.amt)) / 10 ** dec;
        return Number.isFinite(n) ? s + n : s;
      }, 0);
  } catch {
    return undefined;
  }
};

export type ActionResult = { ok: boolean; text: string; txid?: string };

/** What runAgentAction talks to outside this file; every field is swappable for tests. */
export type AgentTradeIo = {
  roomMarket: typeof indexerRoomMarket;
  roomMeta: typeof indexerRoomMeta;
  assertOrdLockV2: typeof assertOrdLockV2;
  checkedPurchaseContext: typeof realCheckedPurchaseContext;
  buy: typeof buyBsv21.execute;
  send: typeof sendBsv.execute;
};
const realIo: AgentTradeIo = {
  roomMarket: indexerRoomMarket,
  roomMeta: indexerRoomMeta,
  assertOrdLockV2,
  checkedPurchaseContext: realCheckedPurchaseContext,
  buy: (ctx, input) => buyBsv21.execute(ctx, input),
  send: (ctx, input) => sendBsv.execute(ctx, input),
};

export type AgentActionHooks = {
  /**
   * The caller's own last look, run with the account's (lastLook below) after every listing / destination check and
   * again inside the wallet's createAction, right before anything is signed. Return a reason to refuse, or null.
   * Paired computers use it for "still paired" and the spending pause (pair/agentPairing.ts).
   */
  beforeSign?: () => Promise<string | null> | string | null;
  io?: Partial<AgentTradeIo>;
};

type WalletLike = { createAction: (args: never, originator?: string) => Promise<unknown> };

/** Thrown from a gated createAction: the last look refused, nothing was signed. */
class SpendRefused extends Error {}

/**
 * A context whose wallet runs `look` before every createAction and refuses (throws, nothing signed) when it returns a
 * reason. createAction is where the wallet signs, so awaits inside buyBsv21 / sendBsv (a paymail's destination is
 * fetched inside sendBsv) all happen before this check, the way bizAgent.ts re-runs its gate right before tx.sign().
 */
export const gatedContext = <C extends { wallet: W }, W extends WalletLike>(
  ctx: C,
  look: () => Promise<string | null>,
): C => {
  const wallet = new Proxy(ctx.wallet, {
    get(target, prop, receiver) {
      if (prop === 'createAction')
        return async (args: never, originator?: string) => {
          const why = await look();
          if (why) throw new SpendRefused(why);
          return target.createAction(args, originator);
        };
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { wallet });
};

/** Quote, gate and run one action on the current (agent) account. */
export const runAgentAction = async (
  ctx: OneSatContext,
  id: string,
  a: AgentActionBlock,
  bsvUsd: number,
  hooks: AgentActionHooks = {},
): Promise<ActionResult> => {
  if (!getAgentAccount(id)) return { ok: false, text: 'This isn’t an agent account, so b can’t act on it.' };
  if (!(bsvUsd > 0)) return { ok: false, text: 'No BSV price right now; try again shortly.' };
  if (a.kind === 'sell' || a.kind === 'list') return { ok: false, text: 'Selling from chat isn’t available yet.' };
  // Buying tokens is exchange functionality: bWalletX only (MARKET_ENABLED, App Review 3.1.5(iii)).
  if (!MARKET_ENABLED && a.kind !== 'send') return { ok: false, text: 'This edition can only send BSV.' };
  const io: AgentTradeIo = { ...realIo, ...hooks.io };

  /**
   * b-Aware report (13 Nov 2026): a Stop pressed (or a pairing removed) after checkAgentAction passed but while the
   * listing or destination was being checked must still win. Re-run the account gate (Stop all, the account's Stop,
   * hourly limit, daily cap), refuse a strategy switched to paper meanwhile, then the caller's own look. Fails closed:
   * a look that throws refuses. The first refusal is logged once.
   */
  let refusal: string | null = null;
  const lastLook = async (kind: string, usd: number): Promise<string | null> => {
    if (refusal) return refusal;
    let why: string | null;
    try {
      const s = checkAgentSpend(id, usd);
      why = !s.ok
        ? s.reason
        : getLoadedStrategy(id)?.mode === 'paper'
          ? 'The strategy was switched to paper mode'
          : ((await hooks.beforeSign?.()) ?? null);
    } catch (e) {
      why = e instanceof Error && e.message ? e.message : 'The last check before signing failed';
    }
    if (why) {
      refusal = why;
      appendAgentLog(id, { at: Date.now(), action: 'refused', detail: `Refused ${kind} ${a.token}: ${why}`, usd: 0 });
    }
    return why;
  };
  const refused = () => ({ ok: false, text: `Refused: ${refusal}` });
  /** Run the signing call; a refusal from the gated createAction comes back as a refused result. */
  const signing = async <R extends { txid?: string; error?: unknown }>(run: () => Promise<R>): Promise<R | null> => {
    try {
      const res = await run();
      // Money moved (txid, no error) is always reported and logged, even if a look refused afterwards.
      if (refusal && (!res.txid || res.error)) return null;
      return res;
    } catch (e) {
      if (e instanceof SpendRefused || refusal) return null;
      throw e;
    }
  };

  // stop.holdTokens in live mode: how many of the strategy's tokens this account holds now.
  const holding = await strategyHolding(ctx, id);

  if (a.kind === 'send') {
    if (!a.to) return { ok: false, text: 'Send needs a recipient.' };
    const req: ActionRequest = { kind: 'send', token: a.token, usd: a.usd, to: a.to };
    const g = checkAgentAction(id, req, { holding });
    if (!g.ok) return { ok: false, text: `Refused: ${g.reason}` };
    if (g.paper) return { ok: true, text: `Paper send of $${a.usd.toFixed(2)} to ${a.to}` };
    const sats = Math.round((a.usd / bsvUsd) * 1e8);
    const to = a.to.includes('@') ? { paymail: a.to } : { address: a.to };
    if (await lastLook('send', a.usd)) return refused();
    // A paymail's destination is fetched and checked inside send; the gated createAction looks again after that.
    const res = await signing(() =>
      io.send(gatedContext(ctx, () => lastLook('send', a.usd)), {
        requests: [{ ...to, satoshis: sats }],
        requireVerified: true,
      } as Parameters<typeof sendBsv.execute>[1]),
    );
    if (!res) return refused();
    if (!res.txid || res.error) return { ok: false, text: `Send failed: ${String(res.error ?? 'unknown error')}` };
    appendAgentLog(id, {
      at: Date.now(),
      action: 'send',
      detail: `Sent $${a.usd.toFixed(2)} to ${a.to}`,
      usd: a.usd,
      txid: res.txid,
      rule: getLoadedStrategy(id)?.strategy.name,
    });
    return { ok: true, text: `Sent $${a.usd.toFixed(2)} to ${a.to}`, txid: res.txid };
  }

  // buy
  const ref = parseRoom('bsv21', a.token);
  if (!ref) return { ok: false, text: `${a.token} isn’t a BSV-21 token id.` };
  const [market, meta] = await Promise.all([io.roomMarket(ref, 40), io.roomMeta('bsv21', a.token).catch(() => null)]);
  const ticker = meta?.title?.replace(/^\$/, '');
  const pick = pickListing(market.listings, a.usd, bsvUsd);
  if (!pick) return { ok: false, text: `No listing of that token fits $${a.usd.toFixed(2)}.` };
  const usd = (pick.priceSats / 1e8) * bsvUsd;
  // The picked listing's own per-token price, never the market floor (b-Aware report, 24 Oct 2026).
  const priceUsd = listingPriceUsd(pick, bsvUsd);
  const amount = priceUsd ? usd / priceUsd : undefined;
  const g = checkAgentAction(id, { kind: 'buy', token: a.token, ticker, usd, priceUsd, amount }, { holding });
  if (!g.ok) return { ok: false, text: `Refused: ${g.reason}` };
  if (g.paper) return { ok: true, text: `Paper buy: ${pick.label} for $${usd.toFixed(2)}` };
  const outpoint = walletOutpoint(pick.outpoint);
  try {
    await io.assertOrdLockV2(outpoint);
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : 'Listing check failed' };
  }
  // The cap above was checked against pick.priceSats, so that is the only price the wallet may sign.
  let checked: OneSatContext;
  try {
    checked = await io.checkedPurchaseContext(ctx, {
      tokenId: a.token,
      outpoint,
      amount: BigInt(pick.amount ?? '0'),
      priceSats: pick.priceSats,
    });
  } catch (e) {
    return { ok: false, text: e instanceof Error ? e.message : 'Listing check failed' };
  }
  if (await lastLook('buy', usd)) return refused();
  const res = await signing(() =>
    io.buy(gatedContext(purchaseContext(checked, outpoint), () => lastLook('buy', usd)), {
      tokenId: a.token,
      outpoint,
      amount: pick.amount ?? '0',
      ...marketFeeOptions(),
      ...MODULE_FINISHES,
    }),
  );
  if (!res) return refused();
  if (!res.txid || res.error) return { ok: false, text: `Buy failed: ${String(res.error ?? 'unknown error')}` };
  appendAgentLog(id, {
    at: Date.now(),
    action: 'buy',
    detail: `Bought ${pick.label}`,
    usd,
    txid: res.txid,
    rule: getLoadedStrategy(id)?.strategy.name,
  });
  return { ok: true, text: `Bought ${pick.label} for $${usd.toFixed(2)}`, txid: res.txid };
};

/**
 * runAgentAction inside serialSpend: the cap check, the sign and the log append run one spend at a time, shared with
 * paired agents and pot payments (spendQueue.ts). b agent chat must use this (b-Aware 25 Oct 2026). Don't call it
 * from inside another serialSpend job: the queue would wait on itself.
 */
export const runAgentActionSerial = (...args: Parameters<typeof runAgentAction>): Promise<ActionResult> =>
  serialSpend(() => runAgentAction(...args));
