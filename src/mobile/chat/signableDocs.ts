/**
 * Which documents in a room's loaded messages can be signed, and where each one's "Review & sign" button goes.
 * PURE: signableDocs.test.ts imports it directly.
 *
 * bit-sign posts a `contract_prepared` event for every signable document (room-actions.ts, room-signable.ts,
 * prepare-doc), carrying `documentId` and, for an uploaded file, `from_upload` (its file name). When a party signs,
 * prepare-doc "send" posts another `contract_prepared` for the same id with `sent_by` = the signer. `contract_sealed`
 * carries no id: it seals the document the room had pinned, which is the newest one prepared before it.
 *
 * Nothing here signs or seals; the button only opens bChatX's page for that document (pendingDoc.signDocUrl).
 */
import type { ChatMessage } from './messages';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const norm = (h: unknown) => (typeof h === 'string' ? h.trim().replace(/^[$@]/, '').toLowerCase() : '');

export type DocState = 'sign' | 'signed' | 'sealed';
export type SignableDoc = { id: string; fileName: string | null; state: DocState };

export type SignableDocs = {
  /** Every signable document, by id. */
  byId: Map<string, SignableDoc>;
  /** The document made from an uploaded file, by that file's name (the newest wins). */
  byFile: Map<string, SignableDoc>;
};

export const signableDocs = (messages: readonly ChatMessage[], me: string): SignableDocs => {
  const byId = new Map<string, SignableDoc>();
  const byFile = new Map<string, SignableDoc>();
  const mine = norm(me);
  let latest: SignableDoc | null = null;
  const ordered = [...messages].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const m of ordered) {
    if (m.kind !== 'event') continue;
    const p = (m.event_payload ?? {}) as { documentId?: unknown; from_upload?: unknown; sent_by?: unknown };
    if (m.event_type === 'contract_sealed') {
      if (latest) latest.state = 'sealed';
      continue;
    }
    if (m.event_type !== 'contract_prepared' || typeof p.documentId !== 'string' || !ID_RE.test(p.documentId)) continue;
    let doc = byId.get(p.documentId);
    if (!doc) {
      doc = { id: p.documentId, fileName: null, state: 'sign' };
      byId.set(doc.id, doc);
    }
    if (typeof p.from_upload === 'string' && p.from_upload) {
      doc.fileName = p.from_upload;
      byFile.set(p.from_upload, doc);
    }
    if (doc.state === 'sign' && mine && norm(p.sent_by) === mine) doc.state = 'signed';
    latest = doc;
  }
  return { byId, byFile };
};

/** The signable document a chat message stands for: a file card by its name, or the prepared-document note. */
export const docForMessage = (docs: SignableDocs, m: ChatMessage, cardFileNames: ReadonlySet<string>) => {
  if (m.kind === 'media') {
    const f = (m.event_payload as { filename?: unknown } | null)?.filename;
    return typeof f === 'string' ? (docs.byFile.get(f) ?? null) : null;
  }
  if (m.kind !== 'event' || m.event_type !== 'contract_prepared') return null;
  const p = (m.event_payload ?? {}) as { documentId?: unknown };
  const doc = typeof p.documentId === 'string' ? docs.byId.get(p.documentId) : undefined;
  // The file's own card already carries the button; the note only gets one when there is no card to put it on.
  if (!doc || (doc.fileName && cardFileNames.has(doc.fileName))) return null;
  return doc;
};

/** File names of the attachment cards in the loaded messages. */
export const cardFileNames = (messages: readonly ChatMessage[]): Set<string> => {
  const s = new Set<string>();
  for (const m of messages) {
    const f = m.kind === 'media' ? (m.event_payload as { filename?: unknown } | null)?.filename : null;
    if (typeof f === 'string') s.add(f);
  }
  return s;
};

export const docButtonLabel = (state: DocState) =>
  state === 'sign' ? 'Review & sign' : state === 'signed' ? 'Signed · Open' : 'Sealed · Open';
