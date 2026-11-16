import { describe, expect, test } from 'bun:test';
import { storeSignLink } from './pendingDoc';

const room = (metadata: unknown, ticker = 'DRAFTS') => ({ ticker, metadata }) as never;

describe('store build: where to sign a room document', () => {
  test('a room with a pending document links to its bChatX page', () => {
    expect(storeSignLink(room({ pending_doc: { id: '8fad8c87-e1aa-446e-bef5-e5f26eb5372c' } }))).toBe(
      'https://www.bchatx.com/room/DRAFTS?doc=8fad8c87-e1aa-446e-bef5-e5f26eb5372c',
    );
  });
  test('no pending document, no notice', () => {
    expect(storeSignLink(room({}))).toBeNull();
    expect(storeSignLink(room(null))).toBeNull();
  });
  test('a bad id or ticker is never turned into a link', () => {
    expect(storeSignLink(room({ pending_doc: { id: 'x/../../evil' } }))).toBeNull();
    expect(storeSignLink(room({ pending_doc: { id: 'abc' } }, 'bad ticker!'))).toBeNull();
  });
});
