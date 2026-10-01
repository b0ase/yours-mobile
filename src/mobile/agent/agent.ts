/**
 * The b agent (top bar's centre b → /m/agent): bChat's composer agent, reached through
 * bit-sign's POST /api/bitsign/compose { action: 'chat' } with the wallet's silent bit-sign
 * session. bit-sign answers with the platform's model (or the user's own provider key, set in
 * bChat › Settings); the call is not charged, so no payment is involved. Replies are whole
 * turns (no streaming). Pure helpers here; the page is AgentPage.tsx.
 */
export type AgentRole = 'user' | 'assistant';
export type AgentMessage = { role: AgentRole; text: string };

export type AgentReply = {
  text: string;
  /** Things the agent prepared that only bChat can finish (documents, signature requests, mints…). */
  notes: string[];
};

/** Most recent turns sent back each time (the server is stateless; keeps requests bounded). */
export const MAX_TURNS = 40;
export const MAX_INPUT = 4000;

/** The request body for one turn: the transcript (blank turns dropped, last MAX_TURNS). */
export const agentRequest = (messages: AgentMessage[]) => ({
  action: 'chat',
  messages: messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, text: m.text })),
  parties: [],
  draft: null,
});

const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Reads bit-sign's ComposeTurnResult; actions it prepared are surfaced as notes to finish in bChat. */
export const parseAgentReply = (data: unknown): AgentReply => {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const text = typeof d.text === 'string' ? d.text.trim() : '';
  const notes: string[] = [];
  const created = d.created as { fileName?: unknown } | undefined;
  if (created && typeof created === 'object')
    notes.push(`Created ${typeof created.fileName === 'string' ? `“${created.fileName}”` : 'a document'} in bChat.`);
  const pending: [string, string, string][] = [
    ['pendingSignatures', 'signature request', 'signature requests'],
    ['pendingMints', 'token mint', 'token mints'],
    ['pendingAllotments', 'token transfer', 'token transfers'],
    ['pendingRepoRooms', 'repo room', 'repo rooms'],
    ['pendingRooms', 'room', 'rooms'],
    ['pendingInvitations', 'invitation', 'invitations'],
  ];
  for (const [key, one, many] of pending) {
    const n = count(d[key]);
    if (n) notes.push(`${plural(n, one, many)} ready to review in bChat.`);
  }
  return { text: text || (notes.length ? '' : 'No reply.'), notes };
};
