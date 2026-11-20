/**
 * The business agent account panel (lazy chunk behind BIZ_AGENT_ACCOUNT_ENABLED; not in store builds).
 * The owner turns it on, funds it, sets the daily limit, sees today's spend against it, and has one big Stop.
 */
import { useCallback, useEffect, useState } from 'react';
import { useServiceContext } from '../../../hooks/useServiceContext';
import { useSnackbar } from '../../../hooks/useSnackbar';
import { cachedExchangeRate, fetchExchangeRate } from '../../../utils/wallet';
import { broadcastRaw } from '../../pots/potSend';
import {
  bizAgentBalance,
  bizAgentPay,
  bizAgentSweep,
  bizSpentToday,
  createBizAgent,
  defaultFindBizCoins,
  getBizAgent,
  getBizLog,
  onBizAgentChange,
  setBizCap,
  setBizStopped,
  DEFAULT_DAILY_CAP_USD,
} from './bizAgent';

const GOLD = '#d4af37';
const MUTED = '#8a8576';
const LINE = '#2a2618';
const RED = '#F04438';
const money = (n: number) => `$${n.toFixed(2)}`;

const useBiz = (ticker: string) => {
  const [, bump] = useState(0);
  useEffect(() => onBizAgentChange(() => bump((n) => n + 1)), []);
  return { agent: getBizAgent(ticker), log: getBizLog(ticker) };
};

const rate = async () => cachedExchangeRate() || (await fetchExchangeRate().catch(() => 0));

export default function BizAgentAccount({ ticker }: { ticker: string }) {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const { agent, log } = useBiz(ticker);
  const [cap, setCap] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const wallet = apiContext?.wallet;

  const loadBalance = useCallback(() => {
    if (agent) void bizAgentBalance(agent.address).then(setBalance, () => setBalance(null));
  }, [agent]);
  useEffect(loadBalance, [loadBalance]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy('');
    }
  };

  if (!agent)
    return (
      <div className="text-[13px]" style={{ color: '#e8e2d2' }}>
        <div className="text-white font-semibold">Agent account</div>
        <p className="text-[12px] mt-1" style={{ color: MUTED }}>
          A separate account, made from your own seed, that your business agent pays refunds from. You set a daily limit
          and can stop it at any time. Its keys stay on this device.
        </p>
        <button
          disabled={!wallet || !!busy}
          onClick={() =>
            void run('Creating…', async () => {
              if (!wallet) throw new Error('Unlock the wallet first');
              await createBizAgent(wallet, ticker, DEFAULT_DAILY_CAP_USD);
            })
          }
          className="mt-3 w-full rounded-xl py-2.5 text-sm font-bold disabled:opacity-50"
          style={{ background: GOLD, color: '#1a1300' }}
        >
          {busy || `Turn on (limit $${DEFAULT_DAILY_CAP_USD} a day)`}
        </button>
      </div>
    );

  const spent = bizSpentToday(log);
  const pct = Math.min(100, (spent / agent.dailyCapUsd) * 100);

  return (
    <div className="text-[13px]" style={{ color: '#e8e2d2' }}>
      <button
        onClick={() => setBizStopped(ticker, !agent.stopped)}
        className="w-full rounded-2xl py-4 text-base font-black tracking-wide"
        style={agent.stopped ? { background: '#1f3d2a', color: '#32D583' } : { background: RED, color: '#fff' }}
      >
        {agent.stopped ? 'Stopped. Tap to resume' : 'STOP agent spending'}
      </button>

      <div className="mt-4 flex justify-between text-[12px]" style={{ color: MUTED }}>
        <span>Spent today</span>
        <span>
          <span style={{ color: GOLD }}>{money(spent)}</span> of {money(agent.dailyCapUsd)}
        </span>
      </div>
      <div className="h-2 rounded-full mt-1 overflow-hidden" style={{ background: '#1a1a1a' }}>
        <div className="h-full" style={{ width: `${pct}%`, background: pct >= 100 ? RED : GOLD }} />
      </div>

      <div className="mt-4 flex gap-2">
        <input
          value={cap}
          onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder={`Daily limit ($${agent.dailyCapUsd})`}
          inputMode="decimal"
          className="flex-1 min-w-0 rounded-xl px-3 py-2 text-sm text-white outline-none"
          style={{ background: '#111', border: `1px solid ${LINE}` }}
        />
        <button
          disabled={!(Number(cap) > 0)}
          onClick={() => {
            setBizCap(ticker, Number(cap));
            setCap('');
          }}
          className="rounded-xl px-3 text-sm font-bold disabled:opacity-50"
          style={{ border: `1px solid ${GOLD}`, color: GOLD }}
        >
          Set limit
        </button>
      </div>

      <div className="mt-4 text-[12px]" style={{ color: MUTED }}>
        Balance: {balance == null ? '…' : `${balance.toLocaleString('en-US')} sats`}. Fund it by sending BSV to:
      </div>
      <div className="text-[11px] break-all text-white select-all">{agent.address}</div>
      <button
        disabled={!wallet || !!busy || !balance}
        onClick={() =>
          void run('Returning…', async () => {
            if (!wallet) throw new Error('Unlock the wallet first');
            const r = await bizAgentSweep(ticker, { wallet, findCoins: defaultFindBizCoins });
            addSnackbar(r.sats ? `Returned ${r.sats.toLocaleString('en-US')} sats` : 'Nothing to return', 'success');
            loadBalance();
          })
        }
        className="mt-2 rounded-xl px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
        style={{ border: `1px solid ${LINE}`, color: MUTED }}
      >
        {busy === 'Returning…' ? busy : 'Return all to my wallet'}
      </button>

      <div className="mt-4 text-white font-semibold text-[13px]">Activity</div>
      {!log.length && (
        <div className="text-[12px]" style={{ color: MUTED }}>
          Nothing yet.
        </div>
      )}
      {log.slice(0, 50).map((e, i) => (
        <div
          key={`${e.at}-${i}`}
          className="flex justify-between gap-2 py-1 text-[12px]"
          style={{ borderBottom: `1px solid ${LINE}` }}
        >
          <span className="min-w-0">
            <span style={{ color: e.action === 'refused' || e.action === 'failed' ? RED : '#e8e2d2' }}>{e.detail}</span>
            <span className="block text-[10px]" style={{ color: MUTED }}>
              {new Date(e.at).toLocaleString()}
              {e.txid ? ` · ${e.txid.slice(0, 12)}…` : ''}
            </span>
          </span>
          {e.usd > 0 && <span style={{ color: GOLD }}>{money(e.usd)}</span>}
        </div>
      ))}
    </div>
  );
}

/**
 * Refund from the agent account (owner taps it; the cap and Stop still apply). Shown only when the room has an
 * agent account. `onPaid` records the refund txid with the server.
 */
export function AgentRefundButton({
  ticker,
  resolve,
  sats,
  label,
  disabled,
  onPaid,
}: {
  ticker: string;
  /** Re-checks the order with the server (refundCheck) and returns where the refund goes. */
  resolve: () => Promise<{ address: string; data: string[] }>;
  sats: number;
  label: string;
  disabled?: boolean;
  onPaid: (txid: string) => Promise<void>;
}) {
  const { apiContext } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const { agent } = useBiz(ticker);
  const [busy, setBusy] = useState(false);
  if (!agent) return null;
  const pay = async () => {
    const wallet = apiContext?.wallet;
    if (!wallet) return addSnackbar('Unlock the wallet first', 'error');
    setBusy(true);
    try {
      const { address, data } = await resolve();
      const r = await bizAgentPay(
        { ticker, address, sats, data, detail: label },
        { wallet, findCoins: defaultFindBizCoins, broadcast: broadcastRaw, usdPerBsv: await rate() },
      );
      if (!r.ok) throw new Error(r.reason);
      await onPaid(r.txid);
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={() => void pay()}
      disabled={disabled || busy || agent.stopped}
      className="mt-2 ml-2 rounded-xl px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
      style={{ border: `1px solid ${LINE}`, color: GOLD }}
    >
      {busy ? 'Refunding…' : agent.stopped ? 'Agent stopped' : 'Refund from agent account'}
    </button>
  );
}
