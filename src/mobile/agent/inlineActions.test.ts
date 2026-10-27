import { describe, expect, it } from 'bun:test';
import { INLINE_ACTIONS_PROMPT, isSafeTarget, parseInlineActions, safeTarget } from './inlineActions';

describe('Ask b inline buttons (ported from bChatX #471)', () => {
  it('takes buttons out of the text', () => {
    const r = parseInlineActions('You have 2 tickets.\n[[Open tickets|/m/tickets]] [[Room|/m/chat?room=BOASECONNOR]]');
    expect(r.text).toBe('You have 2 tickets.');
    expect(r.actions).toEqual([
      { label: 'Open tickets', href: '/m/tickets' },
      { label: 'Room', href: '/m/chat?room=BOASECONNOR' },
    ]);
  });
  it('refuses an outside link and keeps its label as words', () => {
    const x = parseInlineActions('Go [[Claim prize|https://evil.example/x]] now');
    expect(x.actions).toHaveLength(0);
    expect(x.text).toBe('Go Claim prize now');
  });
  it('refuses tricks', () => {
    for (const h of ['//evil.example', 'javascript:alert(1)', '/\\evil.example', '/m/../x', '/user/account', '/m//x'])
      expect(isSafeTarget(h)).toBe(false);
  });
  it('never opens a spend or sign screen, and drops pre-filled parameters', () => {
    for (const h of ['/m/send', '/m/sweep', '/m/presign', '/m/signature', '/m/swap', '/m/exchange', '/m/mint/token'])
      expect(isSafeTarget(h)).toBe(false);
    expect(safeTarget('/m/market?amount=100000&to=1abc')).toBe('/m/market');
    expect(safeTarget('/m/chat?room=FOO&pay=1')).toBe('/m/chat?room=FOO');
    expect(safeTarget('/m/feed?room=FOO')).toBe('/m/feed');
  });
  it('maps bwalletx:// app links to screens', () =>
    expect(safeTarget('bwalletx://chat?room=X')).toBe('/m/chat?room=X'));
  it('keeps at most four, no duplicates', () => {
    const many = Array.from(
      { length: 6 },
      (_, i) => `[[B${i}|/m/${['feed', 'home', 'apps', 'you', 'nfts', 'names'][i]}]]`,
    );
    expect(parseInlineActions(many.join(' ')).actions).toHaveLength(4);
    expect(parseInlineActions('[[A|/m/feed]] [[B|/m/feed]]').actions).toHaveLength(1);
  });
  it('tells b a button never pays', () => expect(INLINE_ACTIONS_PROMPT).toContain('never sends, pays or signs'));
});
