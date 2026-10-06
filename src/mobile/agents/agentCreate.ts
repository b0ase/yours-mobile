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

/** Account menu › Add agent account: Add account opens with the Agent switch already on (owner, 6 Oct 2026). */
export const startAgentCreate = () => writeFlag(true);

/** The Agent account switch on Add account. */
export const setAgentCreate = (on: boolean) => writeFlag(on);

/** True while Add account is creating an agent account (hides X / Google sign-in there). */
export const isAgentCreatePending = () => readFlag();
