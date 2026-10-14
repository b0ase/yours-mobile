import { describe, expect, test } from 'bun:test';
import {
  chosenDests,
  destSummary,
  TIP_MESSAGE_MAX,
  tipDestinations,
  tipMailBody,
  toggleDest,
  validateTipMessage,
  willSendMessage,
} from './tipMessage';

const TX = 'a'.repeat(64);
const ours = (d: string) => d === 'bwalletx.com';

describe('validateTipMessage', () => {
  test('empty and short messages are fine', () => {
    expect(validateTipMessage('')).toBeNull();
    expect(validateTipMessage('  thanks!  ')).toBeNull();
    expect(validateTipMessage('x'.repeat(TIP_MESSAGE_MAX))).toBeNull();
  });
  test('over the limit is refused; surrounding spaces do not count', () => {
    expect(validateTipMessage('x'.repeat(TIP_MESSAGE_MAX + 1))).toContain(String(TIP_MESSAGE_MAX));
    expect(validateTipMessage(`  ${'x'.repeat(TIP_MESSAGE_MAX)}  `)).toBeNull();
  });
  test('counts emoji as one character each', () => {
    expect(validateTipMessage('🔥'.repeat(TIP_MESSAGE_MAX))).toBeNull();
  });
});

describe('tipDestinations', () => {
  test('on-chain post, no paymail: reply only, on', () => {
    const d = tipDestinations({ txid: TX, author: {} }, ours);
    expect(chosenDests(d)).toEqual(['reply']);
    expect(d.bmail.available).toBe(false);
    expect(d.note.available).toBe(false);
  });
  test('bWalletX paymail: reply + bMail both on, no note', () => {
    const d = tipDestinations({ txid: TX, author: { paymail: 'alice@bwalletx.com' } }, ours);
    expect(chosenDests(d)).toEqual(['reply', 'bmail']);
    expect(destSummary(d)).toBe('Under their post · In their bMail');
    expect(d.note.available).toBe(false);
  });
  test('other paymail with a reply available: note offered but off', () => {
    const d = tipDestinations({ txid: TX, author: { paymail: '123@twetch.me' } }, ours);
    expect(d.note).toEqual({ available: true, on: false });
    expect(chosenDests(d)).toEqual(['reply']);
  });
  test('no on-chain id and only another paymail: note is the default', () => {
    const d = tipDestinations({ txid: 'fwetch:x', author: { paymail: 'bob@example.com' } }, ours);
    expect(chosenDests(d)).toEqual(['note']);
  });
  test('nothing available', () => {
    const d = tipDestinations({ txid: 'nope', author: {} }, ours);
    expect(chosenDests(d)).toEqual([]);
    expect(destSummary(d)).toBe('');
    expect(willSendMessage('hi', d)).toBe(false);
  });
  test('toggle flips available destinations only', () => {
    let d = tipDestinations({ txid: TX, author: {} }, ours);
    d = toggleDest(d, 'reply');
    expect(chosenDests(d)).toEqual([]);
    d = toggleDest(d, 'bmail');
    expect(d.bmail.on).toBe(false);
  });
});

describe('willSendMessage / tipMailBody', () => {
  const d = tipDestinations({ txid: TX, author: {} }, ours);
  test('needs text, a valid length and a destination', () => {
    expect(willSendMessage('', d)).toBe(false);
    expect(willSendMessage('   ', d)).toBe(false);
    expect(willSendMessage('x'.repeat(TIP_MESSAGE_MAX + 1), d)).toBe(false);
    expect(willSendMessage('nice post', d)).toBe(true);
  });
  test('mail body carries the message and the post', () => {
    const m = tipMailBody(' great ', '$0.25', TX);
    expect(m.subject).toBe('Tip: $0.25');
    expect(m.body.startsWith('great\n')).toBe(true);
    expect(m.body).toContain(TX);
  });
});
