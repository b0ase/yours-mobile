import { useState } from 'react';
import { Terminal } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { isAgentAccount } from '../agents/agentAccounts';
import { makeGrant, type AgentGrant, type AgentScope } from './agentPairing';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const PANEL = '#17191E';

/**
 * Confirm a bWalletX CLI / MCP pairing: it's bound to the agent account open right now, with the scopes
 * and lifetime chosen here. Keys stay on the phone; the computer sends requests, the phone checks and signs.
 */
export const CliPairConfirm = ({ code, onCancel, onConnect }: { code: string; onCancel: () => void; onConnect: (g: AgentGrant) => void }) => {
  const { chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses.identityAddress;
  const agent = isAgentAccount(id);
  const [trade, setTrade] = useState(true);
  const [send, setSend] = useState(false);
  const [days, setDays] = useState(7);

  const toggle = (on: boolean, set: (v: boolean) => void, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => set(!on)}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left border-0"
      style={{ background: PANEL }}
    >
      <span className="grid h-5 w-5 place-items-center rounded text-xs font-bold" style={{ background: on ? GOLD : '#2b2f36', color: '#000' }}>
        {on ? '✓' : ''}
      </span>
      <span className="flex-1">
        <span className="block text-sm font-semibold text-white">{label}</span>
        <span className="block text-xs" style={{ color: MUTED }}>
          {hint}
        </span>
      </span>
    </button>
  );

  return (
    <div className="mt-6 flex flex-col items-center text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl" style={{ background: 'rgba(245,184,0,0.12)' }}>
        <Terminal size={28} color={GOLD} />
      </span>
      <p className="mt-4 text-xl font-bold text-white">Pair the bWalletX CLI</p>
      <p className="mt-1 text-sm" style={{ color: MUTED }}>
        A program on a computer (CLI or an AI agent through MCP)
      </p>
      <p className="mt-5 text-sm" style={{ color: MUTED }}>
        Check the terminal shows the same code:
      </p>
      <p className="mt-2 font-mono text-4xl font-bold tracking-[0.3em]" style={{ color: GOLD }}>
        {code}
      </p>
      {!agent ? (
        <>
          <p className="mt-6 text-sm" style={{ color: '#FDA29B' }}>
            The CLI can only use an agent account. Switch to one (or make one in Settings › Agents), then run{' '}
            <span className="font-mono">bwalletx login</span> again.
          </p>
          <button onClick={onCancel} className="mt-6 w-full rounded-xl py-3 font-semibold text-white" style={{ background: PANEL }}>
            Close
          </button>
        </>
      ) : (
        <>
          <p className="mt-6 text-sm text-white">
            For <b>{account?.name || 'this agent account'}</b> only. Its balance is the budget; your other accounts are never touched.
          </p>
          <div className="mt-4 flex w-full flex-col gap-2">
            {toggle(true, () => {}, 'See balances, prices and activity', 'Always on')}
            {toggle(trade, setTrade, 'Buy tokens and load strategies', 'Within the account’s limits and its strategy’s rules')}
            {toggle(send, setSend, 'Send BSV', 'To anyone, unless a strategy limits who')}
          </div>
          <div className="mt-4 flex w-full items-center gap-2 text-sm" style={{ color: MUTED }}>
            Lasts
            {[1, 7, 30].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                className="rounded-full px-3 py-1 text-sm font-semibold border-0"
                style={{ background: days === d ? GOLD : PANEL, color: days === d ? '#000' : MUTED }}
              >
                {d === 1 ? '1 day' : `${d} days`}
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs" style={{ color: MUTED }}>
            Your keys stay on this phone: the computer asks, bWalletX checks and signs. Keep bWalletX open on this account
            while it works. Disconnect any time in Settings › Paired websites.
          </p>
          <div className="mt-6 flex w-full gap-3">
            <button onClick={onCancel} className="flex-1 rounded-xl py-3 font-semibold text-white" style={{ background: PANEL }}>
              Cancel
            </button>
            <button
              onClick={() => onConnect(makeGrant(id!, account?.name || 'Agent account', [...(trade ? ['trade' as AgentScope] : []), ...(send ? ['send' as AgentScope] : [])], days))}
              className="flex-1 rounded-xl py-3 font-bold"
              style={{ background: GOLD, color: '#000' }}
            >
              Pair
            </button>
          </div>
        </>
      )}
    </div>
  );
};
