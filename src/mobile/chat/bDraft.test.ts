import { describe, expect, test } from 'bun:test';
import { ChatApiError } from './api';
import {
  acceptBDraft,
  bDraftErrorText,
  bDraftInfo,
  canAskBDraft,
  countPlaceholders,
  requestBDraft,
  splitPlaceholders,
} from './bDraft';

const fake = (reply: unknown) => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  return {
    calls,
    request: async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
      calls.push({ method, path, body });
      return reply;
    },
  };
};

describe('b drafts', () => {
  test('only partnership rooms', () => {
    expect(canAskBDraft({ name: 'Acme partners', metadata: null }, false)).toBe(true);
    expect(canAskBDraft({ name: 'X', metadata: null }, true)).toBe(false);
    expect(canAskBDraft({ name: 'X', metadata: { tokenGate: { key: 'k' } } }, false)).toBe(false);
    expect(canAskBDraft({ name: 'alice ↔ bob', metadata: null }, false)).toBe(false);
  });

  test('reads agreement proposals and summaries', () => {
    const a = bDraftInfo({
      event_type: 'agent_proposal',
      event_payload: {
        b_draft: { kind: 'agreement', requested_by: 'alice' },
        status: 'open',
        accepts: ['bob'],
        proposed_by: 'b',
      },
    })!;
    expect(a.kind).toBe('agreement');
    expect(a.acceptable).toBe(true);
    expect(a.accepts).toEqual(['bob']);
    expect(a.label).toContain('not legal advice');
    const s = bDraftInfo({ event_type: 'b_draft', event_payload: { b_draft: { kind: 'terms_summary' } } })!;
    expect(s.acceptable).toBe(false);
    expect(bDraftInfo({ event_type: 'agent_proposal', event_payload: { status: 'open' } })).toBeNull();
    expect(bDraftInfo({ event_type: null, event_payload: null })).toBeNull();
  });

  test('highlights placeholders', () => {
    const t = 'Split: [TO BE AGREED]. Term: [TO BE AGREED: years] end';
    const segs = splitPlaceholders(t);
    expect(segs.filter((x) => x.placeholder).map((x) => x.text)).toEqual(['[TO BE AGREED]', '[TO BE AGREED: years]']);
    expect(segs.map((x) => x.text).join('')).toBe(t);
    expect(countPlaceholders('none')).toBe(0);
  });

  test('calls the routes', async () => {
    const c = fake({ kind: 'agreement' });
    await requestBDraft(c, 'ACME', 'agreement', '  add vesting  ');
    expect(c.calls[0]).toEqual({
      method: 'POST',
      path: '/api/bitsign/rooms/ACME/b-draft',
      body: { kind: 'agreement', instructions: 'add vesting' },
    });
    await requestBDraft(c, 'ACME', 'terms_summary', '   ');
    expect(c.calls[1].body).toEqual({ kind: 'terms_summary' });
    await acceptBDraft(c, 'ACME', 'm1');
    expect(c.calls[2]).toEqual({
      method: 'POST',
      path: '/api/bitsign/rooms/ACME/proposal',
      body: { messageId: 'm1', decision: 'accept' },
    });
  });

  test('plain-word errors', () => {
    expect(bDraftErrorText(new ChatApiError('x', 429))).toContain('Wait a minute');
    expect(bDraftErrorText(new ChatApiError('x', 409))).toContain('partnership rooms');
    expect(bDraftErrorText(new ChatApiError('This proposal is adopted', 409))).toContain('adopted');
    expect(bDraftErrorText(new ChatApiError('x', 403))).toContain('members');
    expect(bDraftErrorText(new ChatApiError('x', 502))).toContain('Try again');
    expect(bDraftErrorText(new Error('boom'))).toContain('Try again');
  });
});
