import { useState } from 'react';
import { Bot } from 'lucide-react';
import { isBWalletX } from '../storeBuild';
import { isAgentCreatePending, setAgentCreate } from './agentCreate';

/** Add account (not first-time setup), bWalletX only: "Agent account" switch (docs/SMART-WALLET-SPEC.md §1). */
export const AgentAccountToggle = () => {
  const [on, setOn] = useState(isAgentCreatePending);
  if (!isBWalletX()) return null;
  return (
    <button
      type="button"
      onClick={() => {
        setAgentCreate(!on);
        setOn(!on);
      }}
      className="w-[85%] flex items-start gap-3 rounded-xl p-3 my-2 border text-left cursor-pointer"
      style={{ background: on ? '#7A5AF81A' : '#17191E', borderColor: on ? '#7A5AF8' : '#2b2f36' }}
    >
      <Bot size={18} color={on ? '#BDB4FE' : '#98A2B3'} className="mt-0.5 shrink-0" />
      <span className="flex-1">
        <span className="block text-sm font-bold text-white">Agent account {on ? '· on' : ''}</span>
        <span className="block text-xs" style={{ color: '#98A2B3' }}>
          Your AI agents may use this account without asking each time. Its balance is their budget; your other
          accounts are never touched.
        </span>
      </span>
    </button>
  );
};
