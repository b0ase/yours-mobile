/**
 * Pairing the bWalletX CLI / MCP with an agent account (SMART-WALLET-SPEC.md, "paired" mode).
 *
 * The CLI uses the same pairing channel as websites (src/pair/protocol.ts) but connects with the origin
 * CLI_ORIGIN. Browsers set the websocket Origin and pages can't change it, so no website can pose as the
 * CLI: only a program on a computer can. A CLI pairing is bound to ONE agent account, with scopes and an
 * expiry (30 days at most). Keys never leave the phone: requests run here, through the same gate the
 * b agent uses (checkAgentAction / runAgentAction), on the paired agent account while it's the one open.
 */
import { getBsv21Balances, type OneSatContext } from '@1sat/actions';
import { getAgentAccount, getAgentLog, isAgentAccount } from '../agents/agentAccounts';
import { runAgentAction } from '../agents/agentTrade';
import { getLoadedStrategy, getPaperBook, loadStrategy, parseStrategy } from '../agents/strategy';

export const CLI_ORIGIN = 'https://cli.bwalletx.com';
export type AgentScope = 'read' | 'trade' | 'send';
export const MAX_GRANT_DAYS = 30;

export type AgentGrant = { agentId: string; name: string; scopes: AgentScope[]; expiresAt: number };

export const makeGrant = (agentId: string, name: string, scopes: AgentScope[], days: number, now = Date.now()): AgentGrant => ({
  agentId,
  name,
  scopes: [...new Set<AgentScope>(['read', ...scopes])],
  expiresAt: now + Math.min(Math.max(days, 1), MAX_GRANT_DAYS) * 86_400_000,
});

const NEEDS: Record<string, AgentScope> = {
  info: 'read',
  balance: 'read',
  log: 'read',
  strategy_show: 'read',
  strategy_load: 'trade',
  buy: 'trade',
  send: 'send',
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
  if (now > grant.expiresAt) throw new AgentCallError('EXPIRED', 'This pairing has expired. Run `bwalletx login` again.');
  const need = NEEDS[action];
  if (!need) throw new AgentCallError('UNKNOWN', `Unknown action "${action}"`);
  if (!grant.scopes.includes(need)) throw new AgentCallError('SCOPE', `This pairing isn't allowed to ${need} (granted: ${grant.scopes.join(', ')}).`);
  if (!isAgentAccount(grant.agentId)) throw new AgentCallError('NOT_AGENT', `${grant.name} is no longer an agent account.`);
  if (currentId !== grant.agentId)
    throw new AgentCallError('NOT_OPEN', `bWalletX is open on another account. Switch to ${grant.name} in the app.`);
};

type P = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));

/** Run one paired-CLI call on the phone. */
export async function handleAgentCall(
  grant: AgentGrant,
  action: string,
  params: unknown,
  deps: { ctx: OneSatContext; currentId: string | undefined; bsvUsd: () => Promise<number> },
): Promise<unknown> {
  checkGrant(grant, action, deps.currentId);
  const p = (params && typeof params === 'object' ? params : {}) as P;
  const id = grant.agentId;
  const acct = getAgentAccount(id)!;

  switch (action) {
    case 'info': {
      const l = getLoadedStrategy(id);
      return {
        account: grant.name,
        identityAddress: id,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
        stopped: acct.stopped,
        dailyCapUsd: acct.dailyCapUsd,
        strategy: l ? { name: l.strategy.name, version: l.strategy.version, mode: l.mode } : null,
      };
    }
    case 'balance': {
      const [outs, tokens, rate] = await Promise.all([
        deps.ctx.wallet.listOutputs({ basket: 'default', limit: 10_000 }),
        getBsv21Balances.execute(deps.ctx, {}).catch(() => []),
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
      const r = await runAgentAction(deps.ctx, id, block, await deps.bsvUsd());
      if (!r.ok) throw new AgentCallError('REFUSED', r.text);
      return { text: r.text, txid: r.txid ?? null };
    }
  }
  throw new AgentCallError('UNKNOWN', `Unknown action "${action}"`);
}
