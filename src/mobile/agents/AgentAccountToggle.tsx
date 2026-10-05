import { useState } from 'react';
import { Bot } from 'lucide-react';
import { isBWalletX } from '../storeBuild';
import { markAgentAccount } from './agentAccounts';

/** Settings › Agents › New agent account sets this; Add account's toggle reads and writes it. */
const FLAG = 'bwallet.createAgent';
const readFlag = () => {
  try {
    return localStorage.getItem(FLAG) === '1';
  } catch {
    return false;
  }
};
const writeFlag = (on: boolean) => {
  try {
    if (on) localStorage.setItem(FLAG, '1');
    else localStorage.removeItem(FLAG);
  } catch {
    /* storage unavailable */
  }
};

/** After Add account creates the keys: mark it as an agent account if the toggle was on, then clear it. */
export const consumeAgentCreate = (identityAddress: string) => {
  if (!readFlag()) return;
  writeFlag(false);
  markAgentAccount(identityAddress);
};

/** Add account (not first-time setup), bWalletX only: "Agent account" switch (docs/SMART-WALLET-SPEC.md §1). */
export const AgentAccountToggle = () => {
  const [on, setOn] = useState(readFlag);
  if (!isBWalletX()) return null;
  return (
    <button
      type="button"
      onClick={() => {
        writeFlag(!on);
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

/** Account menu › Add agent account: Add account opens with the Agent switch already on (owner, 6 Oct 2026). */
export const startAgentCreate = () => writeFlag(true);

/** True while Add account is creating an agent account (hides X / Google sign-in there). */
export const isAgentCreatePending = () => readFlag();
