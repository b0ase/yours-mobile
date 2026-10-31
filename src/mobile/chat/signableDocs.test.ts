import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './messages';
import { cardFileNames, docButtonLabel, docForMessage, signableDocs } from './signableDocs';

const A = '04ea9a26-6e55-4b19-8c16-ee76b8d7397a';
const B = '9b1c2d3e-0000-4b19-8c16-ee76b8d7397b';
let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 31, 12, 0, n++)).toISOString();
const card = (filename: string): ChatMessage => ({
  id: `m${n}`,
  author_handle: 'alice',
  kind: 'media',
  body: filename,
  event_payload: { media_id: `x${n}`, filename, mime: 'text/html', byte_size: 5000 },
  created_at: at(),
});
const prepared = (documentId: string, extra: Record<string, unknown> = {}): ChatMessage => ({
  id: `e${n}`,
  author_handle: null,
  kind: 'event',
  event_type: 'contract_prepared',
  body: 'is already a signable instrument',
  event_payload: { documentId, ...extra },
  created_at: at(),
});
const sealed = (documentId?: string): ChatMessage => ({
  id: `s${n}`,
  author_handle: null,
  kind: 'event',
  event_type: 'contract_sealed',
  body: 'sealed',
  event_payload: documentId ? { by: 'bob', documentId } : { by: 'bob' },
  created_at: at(),
});

describe('signable documents in a room', () => {
  test('two uploaded documents each get their own button on their own card', () => {
    const msgs = [
      card('Preemption_Offer_s561.html'),
      prepared(A, { from_upload: 'Preemption_Offer_s561.html' }),
      card('Board_Minute.html'),
      prepared(B, { from_upload: 'Board_Minute.html' }),
    ];
    const docs = signableDocs(msgs, 'alice');
    const files = cardFileNames(msgs);
    expect(docForMessage(docs, msgs[0], files)?.id).toBe(A);
    expect(docForMessage(docs, msgs[2], files)?.id).toBe(B);
    // The notes under cards don't repeat the button.
    expect(docForMessage(docs, msgs[1], files)).toBeNull();
    expect(docForMessage(docs, msgs[3], files)).toBeNull();
    expect(docs.byId.get(A)?.state).toBe('sign');
    expect(docButtonLabel('sign')).toBe('Review & sign');
  });

  test('a document with no file card (drafted by the room) gets the button on its note', () => {
    const msgs = [prepared(A, { by: 'drafts' })];
    expect(docForMessage(signableDocs(msgs, 'alice'), msgs[0], cardFileNames(msgs))?.id).toBe(A);
  });

  test('a plain file with no signable document gets no button', () => {
    const msgs = [card('photo-notes.pdf')];
    expect(docForMessage(signableDocs(msgs, 'alice'), msgs[0], cardFileNames(msgs))).toBeNull();
  });

  test('signed by me shows Signed; signed by someone else still asks me to sign', () => {
    const msgs = [
      card('a.html'),
      prepared(A, { from_upload: 'a.html' }),
      prepared(A, { sent_by: 'alice' }),
      card('b.html'),
      prepared(B, { from_upload: 'b.html' }),
      prepared(B, { sent_by: 'bob' }),
    ];
    const docs = signableDocs(msgs, '$Alice');
    expect(docs.byId.get(A)?.state).toBe('signed');
    expect(docs.byId.get(B)?.state).toBe('sign');
    expect(docButtonLabel('signed')).toBe('Signed · Open');
  });

  test('a seal naming a document marks that document sealed', () => {
    const msgs = [prepared(A, { from_upload: 'a.html' }), prepared(B, { from_upload: 'b.html' }), sealed(A)];
    const docs = signableDocs(msgs, 'alice');
    expect(docs.byId.get(A)?.state).toBe('sealed');
    expect(docs.byId.get(B)?.state).toBe('sign');
  });

  test('a seal naming no document marks nothing sealed (never guess on a contract)', () => {
    const msgs = [prepared(A, { from_upload: 'a.html' }), prepared(B, { from_upload: 'b.html' }), sealed()];
    const docs = signableDocs(msgs, 'alice');
    expect(docs.byId.get(A)?.state).toBe('sign');
    expect(docs.byId.get(B)?.state).toBe('sign');
  });

  test('ignores malformed ids and other events', () => {
    const bad = prepared('bad id/../');
    const other: ChatMessage = { ...prepared(A), event_type: 'member_joined' };
    expect(signableDocs([bad, other], 'alice').byId.size).toBe(0);
  });
});
