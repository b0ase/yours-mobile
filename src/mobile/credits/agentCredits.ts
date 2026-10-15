/**
 * Ask b paid from bCredits. The server prices and debits each reply itself (bit-sign priceReply:
 * ceil(cost × 1.35 ÷ credit price), app 'b', action 'reply', idempotency key = the reply id), so the wallet never
 * says how much to take. Contract (bit-sign must serve it; until GET /credits says `agentTurn: true` the wallet
 * keeps the pay-per-message path):
 *
 *   POST /api/bitsign/agent/turn { pay: 'bcredits', replyId, messages, system, client }
 *     200 { text, credits: { charged, balance } }
 *     402 { code: 'insufficient_credits', balance }   (nothing charged; b never runs into debt)
 *
 * A retry with the same replyId is never charged twice (the server's idempotency key).
 */
import type { AgentMessage } from '../agent/agent';

export type CreditsReply = { text: string; charged: number; balance: number | null };

export class CreditsLowError extends Error {
  constructor(readonly balance: number) {
    super('Not enough bCredits');
  }
}

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const nonNeg = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

export const newReplyId = () =>
  `b-reply-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

export const parseCreditsReply = (data: unknown): CreditsReply => {
  const d = obj(data);
  const c = obj(d.credits);
  const text = typeof d.text === 'string' && d.text.trim() ? d.text.trim() : 'No reply.';
  return { text, charged: nonNeg(c.charged) ?? 0, balance: nonNeg(c.balance) };
};

/** True when a failed call was the server saying the balance is too low (402 / insufficient_credits). */
export const lowBalanceOf = (status: number, data: unknown): number | null => {
  const d = obj(data);
  if (status !== 402 && d.code !== 'insufficient_credits') return null;
  return nonNeg(d.balance) ?? 0;
};

export const creditsTurnBody = (replyId: string, messages: AgentMessage[], system: string, client: unknown) => ({
  pay: 'bcredits',
  replyId,
  messages,
  system,
  client,
});

/** Records that this device has paid b from bCredits, so an empty balance later reads as "top up", not "pay". */
const USED_KEY = 'bwallet.credits.usedForB';
export const markCreditsUsed = () => {
  try {
    localStorage.setItem(USED_KEY, '1');
  } catch {
    /* storage unavailable */
  }
};
export const creditsUsedBefore = () => {
  try {
    return localStorage.getItem(USED_KEY) === '1';
  } catch {
    return false;
  }
};
