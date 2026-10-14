import { useCallback, useEffect, useState } from 'react';
import type { AgentMessage } from '../agent/agent';
import { clientInfo } from '../agent/paid';
import { ChatApiError, type BchatClient } from '../chat/api';
import { canAskFromCredits, creditsStopped, emitCreditsChanged, lowBalanceText, parseCreditsInfo } from './credits';
import {
  CreditsLowError,
  creditsTurnBody,
  creditsUsedBefore,
  lowBalanceOf,
  markCreditsUsed,
  newReplyId,
  parseCreditsReply,
} from './agentCredits';

type WithClient = <T>(fn: (c: BchatClient) => Promise<T>) => Promise<T>;

export interface AgentCredits {
  /** Before a message: 'credits' = pay from bCredits, 'low' = b should say "top up" (lowText), 'other' = old path. */
  route: (paidMode: boolean) => Promise<'credits' | 'low' | 'other'>;
  /** One reply paid from bCredits; throws CreditsLowError when the server says the balance is too low. */
  run: (sent: AgentMessage[], system: string) => Promise<string>;
  /** b's words for a low balance, when `e` is that error (else null). */
  lowText: (e?: unknown) => string | null;
  low: boolean;
  setLow: (v: boolean) => void;
}

/**
 * Ask b paid from bCredits (bWalletX only; AgentConversation picks this hook or useNoAgentCredits by the literal
 * BCREDITS_ENABLED flag, so a store build has none of it). The server prices and debits each reply; the wallet only
 * reads the balance, sends a reply id, and tells the card the new balance (bwx:bcredits) so it ticks down.
 */
export function useAgentCredits(withClient: WithClient, ready: boolean): AgentCredits {
  const [low, setLow] = useState(false);

  const read = useCallback(async () => {
    if (!ready) return null;
    try {
      return parseCreditsInfo(await withClient((c) => c.credits()));
    } catch {
      return null;
    }
  }, [withClient, ready]);

  // Read once on open so the first message knows which way to pay.
  useEffect(() => {
    void read();
  }, [read]);

  const route = async (paidMode: boolean) => {
    if (!paidMode) return 'other' as const;
    const c = await read();
    if (!c || !c.enabled || !c.agentTurn || creditsStopped()) return 'other' as const;
    if (canAskFromCredits(c)) return 'credits' as const;
    // Once this device has paid b from bCredits, an empty balance asks for a top-up; it never runs into debt.
    return c.balance <= 0 && creditsUsedBefore() ? ('low' as const) : ('other' as const);
  };

  const run = async (sent: AgentMessage[], system: string) => {
    const replyId = newReplyId();
    try {
      const r = parseCreditsReply(
        await withClient((c) =>
          c.agentCall('POST', '/api/bitsign/agent/turn', creditsTurnBody(replyId, sent, system, clientInfo())),
        ),
      );
      markCreditsUsed();
      emitCreditsChanged(r.balance ?? undefined);
      return r.text;
    } catch (e) {
      const bal = e instanceof ChatApiError ? lowBalanceOf(e.status, e.data) : null;
      if (bal !== null) {
        emitCreditsChanged(bal);
        throw new CreditsLowError(bal);
      }
      throw e;
    }
  };

  const lowText = (e?: unknown) =>
    e === undefined ? lowBalanceText(0) : e instanceof CreditsLowError ? lowBalanceText(e.balance) : null;

  return { route, run, lowText, low, setLow };
}
