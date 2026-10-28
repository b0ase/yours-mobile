import { describe, expect, test } from 'bun:test';
import { docToOffer, pendingDocOf, signDocUrl } from './pendingDoc';
import { takeRoomDoc, requestRoomByTicker, takeRoomTicker } from './segmentNav';

const ID = '04ea9a26-6e55-4b19-8c16-ee76b8d7397a';

describe('pending document in a room', () => {
  test('reads metadata.pending_doc', () => {
    expect(pendingDocOf({ metadata: { pending_doc: { id: ID, sent_by: 'bcorpboard', sent_at: 'x' } } })).toEqual({
      id: ID,
      sentBy: 'bcorpboard',
      sentAt: 'x',
    });
    expect(pendingDocOf({ metadata: {} })).toBeNull();
    expect(pendingDocOf({ metadata: { pending_doc: { id: 'bad id/../' } } })).toBeNull();
    expect(pendingDocOf(null)).toBeNull();
  });

  test('sign URL is rebuilt from ticker + id only', () => {
    expect(signDocUrl('$bcorpboard', ID)).toBe(`https://www.bchatx.com/room/BCORPBOARD?doc=${ID}`);
    expect(signDocUrl('BCORPBOARD', 'x?y=1')).toBeNull();
    expect(signDocUrl('a/b', ID)).toBeNull();
  });

  test('the push-named document wins over the pinned one', () => {
    const room = { metadata: { pending_doc: { id: 'old-1' } } };
    expect(docToOffer(room, ID)).toBe(ID);
    expect(docToOffer(room, null)).toBe('old-1');
    expect(docToOffer({ metadata: null }, null)).toBeNull();
  });
});

describe('segmentNav carries the document', () => {
  test('requestRoomByTicker with a doc → takeRoomDoc for that room, once', () => {
    requestRoomByTicker('$bcorpboard', false, ID);
    expect(takeRoomTicker(false)).toBe('BCORPBOARD');
    expect(takeRoomDoc('OTHER')).toBeNull();
    expect(takeRoomDoc('bcorpboard')).toBe(ID);
    expect(takeRoomDoc('BCORPBOARD')).toBeNull();
  });
});
