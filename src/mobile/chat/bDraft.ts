/**
 * "b drafts in partner chats" (bit-sign PR #298): ask b to draft a partnership agreement or
 * summarise the terms in a partnership (non-token) room. Pure helpers + the two calls; the card
 * and sheet live in BDraftCard.tsx.
 *
 * POST /api/bitsign/rooms/{ticker}/b-draft {kind, instructions?} posts b's message into the room.
 * An agreement is an `agent_proposal` every member accepts through the returned accept path
 * (rooms/{ticker}/proposal); a terms summary (`b_draft`) is read-only.
 */
import { ChatApiError, type BchatClient } from './api';
import type { ChatMessage, ChatRoom } from './messages';
import { isDirectRoom } from './messages';

export type BDraftKind = 'agreement' | 'terms_summary';

export const B_DRAFT_LABEL = 'Draft by b, not legal advice; review before signing';

export interface BDraftAccept {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface BDraftResult {
  kind: BDraftKind;
  label: string;
  title: string;
  draft: string;
  body: string;
  messageId: string | null;
  acceptable: boolean;
  accept: BDraftAccept | null;
}

export const MAX_INSTRUCTIONS = 1000;

/** Partnership rooms only: not token-gated, not a 1:1 DM. */
export const canAskBDraft = (room: Pick<ChatRoom, 'name' | 'metadata'>, isTokenRoom: boolean): boolean =>
  !isTokenRoom && !(room.metadata && (room.metadata as Record<string, unknown>).tokenGate) && !isDirectRoom(room);

export interface BDraftInfo {
  kind: BDraftKind;
  /** An agreement proposal members can accept. */
  acceptable: boolean;
  status: string | null;
  accepts: string[];
  proposedBy: string | null;
  requestedBy: string | null;
  label: string;
  title: string | null;
}

/** b's draft message (agent_proposal with b_draft, or b_draft), else null. */
export const bDraftInfo = (m: Pick<ChatMessage, 'event_type' | 'event_payload'>): BDraftInfo | null => {
  const p = (m.event_payload || {}) as Record<string, unknown>;
  const d = p.b_draft as Record<string, unknown> | undefined;
  if (!d || (m.event_type !== 'agent_proposal' && m.event_type !== 'b_draft')) return null;
  const kind: BDraftKind = d.kind === 'agreement' ? 'agreement' : 'terms_summary';
  const proposal = p.proposal as Record<string, unknown> | undefined;
  return {
    kind,
    acceptable: m.event_type === 'agent_proposal',
    status: typeof p.status === 'string' ? p.status : null,
    accepts: Array.isArray(p.accepts) ? p.accepts.filter((x): x is string => typeof x === 'string') : [],
    proposedBy: typeof p.proposed_by === 'string' ? p.proposed_by : null,
    requestedBy: typeof d.requested_by === 'string' ? d.requested_by : null,
    label: typeof d.label === 'string' && d.label ? d.label : B_DRAFT_LABEL,
    title: proposal && typeof proposal.title === 'string' ? proposal.title : null,
  };
};

export type DraftSegment = { text: string; placeholder: boolean };

/** Split text so [TO BE AGREED] placeholders can be highlighted. */
export const splitPlaceholders = (text: string): DraftSegment[] => {
  const out: DraftSegment[] = [];
  const re = /\[TO BE AGREED[^\]]*\]/gi;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), placeholder: false });
    out.push({ text: m[0], placeholder: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), placeholder: false });
  return out;
};

export const countPlaceholders = (text: string): number => splitPlaceholders(text).filter((s) => s.placeholder).length;

/** Plain words for every refusal the two routes give. */
export const bDraftErrorText = (e: unknown): string => {
  const status = e instanceof ChatApiError ? e.status : -1;
  const msg = e instanceof Error ? e.message : '';
  switch (status) {
    case 0:
      return "Couldn't reach b. Check your connection and try again.";
    case 401:
      return 'Sign in to chat again, then ask b.';
    case 403:
      return 'Only members of this room can ask b to draft or accept.';
    case 404:
      return 'b drafting is not available for this room yet.';
    case 409:
      return /proposal is/i.test(msg)
        ? `This draft can no longer be accepted (${msg.replace(/^This proposal is /i, '')}).`
        : 'b only drafts in partnership rooms, not token rooms.';
    case 400:
      return msg
        ? `b couldn't use that: ${msg}`
        : "b couldn't use that request. Shorten the instructions and try again.";
    case 429:
      return 'b is drafting a lot right now. Wait a minute and try again.';
    case 502:
    case 503:
    case 504:
      return "b couldn't finish the draft. Try again in a moment.";
    default:
      return 'Something went wrong asking b. Try again.';
  }
};

const path = (ticker: string) => `/api/bitsign/rooms/${encodeURIComponent(ticker)}`;

export const requestBDraft = async (
  client: Pick<BchatClient, 'request'>,
  ticker: string,
  kind: BDraftKind,
  instructions?: string,
): Promise<BDraftResult> => {
  const body: Record<string, unknown> = { kind };
  const ins = instructions?.trim().slice(0, MAX_INSTRUCTIONS);
  if (ins) body.instructions = ins;
  return (await client.request('POST', `${path(ticker)}/b-draft`, body)) as BDraftResult;
};

export interface AcceptResult {
  ok?: boolean;
  status?: string;
  accepts?: string[];
}

/** Accept b's agreement proposal through the existing rooms/{ticker}/proposal route. */
export const acceptBDraft = async (
  client: Pick<BchatClient, 'request'>,
  ticker: string,
  messageId: string,
): Promise<AcceptResult> =>
  (await client.request('POST', `${path(ticker)}/proposal`, { messageId, decision: 'accept' })) as AcceptResult;
