import { describe, expect, test } from 'bun:test';
import { isLounge, loungeCardInfo } from './loungeInfo';

describe('Lounge yellow card (owner, 10 Oct 2026)', () => {
  test('recognises the Lounge however the ticker is written', () => {
    expect(isLounge('LOUNGE')).toBe(true);
    expect(isLounge('$lounge')).toBe(true);
    expect(isLounge('ABC')).toBe(false);
    expect(isLounge(null)).toBe(false);
  });
  test('unread badge, capped at 99+', () => {
    expect(loungeCardInfo({ unread: 0, listening: null, preview: 'hi', member: true }).badge).toBeNull();
    expect(loungeCardInfo({ unread: 7, listening: null, preview: 'hi', member: true }).badge).toBe('7');
    expect(loungeCardInfo({ unread: 140, listening: null, preview: 'hi', member: true }).badge).toBe('99+');
  });
  test('live pill only while the Space is live', () => {
    expect(loungeCardInfo({ unread: 0, listening: null, preview: '', member: true }).live).toBeNull();
    expect(loungeCardInfo({ unread: 0, listening: 0, preview: '', member: true }).live).toBe('Live · 0 listening');
    expect(loungeCardInfo({ unread: 0, listening: 12, preview: '', member: true }).live).toBe('Live · 12 listening');
  });
  test('preview, empty fallback, and a non-member invitation', () => {
    expect(loungeCardInfo({ unread: 0, listening: null, preview: 'alice: gm', member: true }).line).toBe('alice: gm');
    expect(loungeCardInfo({ unread: 0, listening: null, preview: ' ', member: true }).line).toMatch(/Say hello/);
    expect(loungeCardInfo({ unread: 0, listening: null, preview: 'x', member: false }).line).toMatch(/join the chat/);
  });
});
