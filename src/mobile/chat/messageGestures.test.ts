import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { HOLD_MS, MOVE_CANCEL_PX, SWIPE_MIN_PX, classifyTouch } from './messageGestures';

describe('message gestures: tap = reactions, hold = reply, swipe left = report/block', () => {
  test('hold matches hold-to-talk (400 ms)', () => {
    expect(HOLD_MS).toBe(400);
  });

  test('a short still touch is a tap', () => {
    expect(classifyTouch(0, 0, 120, false)).toBe('tap');
    expect(classifyTouch(MOVE_CANCEL_PX, -MOVE_CANCEL_PX, HOLD_MS - 1, false)).toBe('tap');
  });

  test('once the hold has fired, lifting the finger does nothing more', () => {
    expect(classifyTouch(0, 0, 900, true)).toBe('none');
    expect(classifyTouch(-200, 0, 900, true)).toBe('none');
  });

  test('a slow still touch that never fired a hold is not a tap', () => {
    expect(classifyTouch(0, 0, HOLD_MS + 50, false)).toBe('none');
  });

  test('a mostly horizontal swipe left past the threshold opens report/block', () => {
    expect(classifyTouch(-SWIPE_MIN_PX, 4, 200, false)).toBe('swipe-left');
    expect(classifyTouch(-120, -20, 250, false)).toBe('swipe-left');
  });

  test('swipe right replies', () => {
    expect(classifyTouch(SWIPE_MIN_PX + 5, 0, 200, false)).toBe('swipe-right');
  });

  test('vertical scrolling wins: no tap, no swipe', () => {
    expect(classifyTouch(0, 80, 200, false)).toBe('none');
    expect(classifyTouch(-70, 45, 200, false)).toBe('none');
    expect(classifyTouch(-40, 0, 200, false)).toBe('none');
  });

  test('a diagonal drag is not a swipe', () => {
    expect(classifyTouch(-60, 31, 200, false)).toBe('none');
  });
});

describe('wiring in the room view', () => {
  const page = readFileSync(new URL('../tabs/ChatPage.tsx', import.meta.url), 'utf8');
  test('tap opens the reactions sheet, hold and swipe right reply, swipe left opens the message menu', () => {
    expect(page).toContain('onTap: () => setActing(it.message)');
    expect(page).toContain('onHold: isPrivateB(it.message) ? null : () => startReply(it.message)');
    expect(page).toContain(
      'onSwipeLeft: onMessageMenu && !isPrivateB(it.message) ? () => onMessageMenu(it.message) : null',
    );
  });
  test('reply focuses the composer straight away', () => {
    expect(page).toMatch(/const startReply = [\s\S]{0,200}composer\.current\?\.focus\(\)/);
  });
  test('the sheet offers Copy text', () => {
    expect(page).toContain('onCopy={');
    expect(readFileSync(new URL('./BubbleExtras.tsx', import.meta.url), 'utf8')).toContain('label="Copy text"');
  });
  test('haptics use the Capacitor plugin on phones', () => {
    expect(readFileSync(new URL('../swipe/haptics.ts', import.meta.url), 'utf8')).toContain(
      "from '@capacitor/haptics'",
    );
  });
});
