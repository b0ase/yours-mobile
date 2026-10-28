import { describe, expect, test } from 'bun:test';
import { docToOffer, offerBanner, pendingDocOf, pendingOfferOf, signDocUrl } from './pendingDoc';
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

describe('offer-first room contracts', () => {
  const room = (offer: unknown) => ({ metadata: { pending_doc: { id: ID, offer } } });
  const roles = { b0asex: 'Seller', rboase2020: 'Buyer' };
  const offered = pendingOfferOf(
    room({ status: 'offered', from: '$B0aseX', to: ['rboase2020'], reason: null, roles }),
  )!;

  test('reads metadata.pending_doc.offer, ignores junk', () => {
    expect(offered.from).toBe('b0asex');
    expect(pendingOfferOf(room({ status: 'nope' }))).toBeNull();
    expect(pendingOfferOf({ metadata: { pending_doc: { id: ID } } })).toBeNull();
  });

  test('sender and recipient see different words, with roles', () => {
    const s = offerBanner(offered, 'b0asex');
    const r = offerBanner(offered, 'rboase2020');
    expect(s.title).toBe('Offer sent to $rboase2020 (Buyer)');
    expect(s.line).toBe('Waiting for their signature.');
    expect(s.youAre).toBe('You are the Seller');
    expect(s.button).toBeNull();
    expect(r.title).toBe('Offer from $b0asex (Seller)');
    expect(r.youAre).toBe('You are the Buyer');
    expect(r.button).toBe('Accept, reject or counter');
    expect(JSON.stringify([s, r])).not.toContain('other parties');
  });

  test('draft is labelled, rejected shows the reason', () => {
    const d = pendingOfferOf(room({ status: 'draft', to: [], roles }))!;
    expect(offerBanner(d, 'b0asex').title).toBe('Draft, not an offer');
    expect(offerBanner(d, 'b0asex').button).toBe('Sign & send as offer');
    const x = pendingOfferOf(
      room({ status: 'rejected', from: 'b0asex', to: ['rboase2020'], reason: 'too high', roles }),
    )!;
    expect(offerBanner(x, 'b0asex').line).toBe('Reason: too high');
  });
});
