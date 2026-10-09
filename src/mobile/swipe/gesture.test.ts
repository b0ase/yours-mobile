import { describe, expect, test } from 'bun:test';
import { ACTION_W, dragOffset, isArmed, lockAxis, resolveRelease } from './gesture';

const L = { count: 3, hasFull: true };
const R = { count: 2, hasFull: true };
const rel = (offset: number, velocity = 0, width = 390) =>
  resolveRelease({ offset, width, velocity, left: L, right: R });

describe('lockAxis', () => {
  test('undecided under 10px', () => expect(lockAxis(6, 7)).toBeNull());
  test('horizontal wins', () => expect(lockAxis(-12, 4)).toBe('x'));
  test('vertical scroll is not hijacked', () => expect(lockAxis(8, 14)).toBe('y'));
});

describe('resolveRelease', () => {
  test('tiny drag closes', () => expect(rel(-20)).toBe('closed'));
  test('half a tray opens it', () => expect(rel(-(3 * ACTION_W) / 2 - 1)).toBe('open-left'));
  test('right tray opens', () => expect(rel(ACTION_W + 5)).toBe('open-right'));
  test('past 60% commits', () => expect(rel(-0.61 * 390)).toBe('commit-left'));
  test('59% does not commit slowly', () => expect(rel(-0.59 * 390)).toBe('open-left'));
  test('slow release past the tray but under 60% opens', () => expect(rel(3 * ACTION_W + 10, 0)).toBe('open-right'));
  test('fast flick past tray commits right', () => expect(rel(2 * ACTION_W + 10, 1.2)).toBe('commit-right'));
  test('flick back closes', () => expect(rel(-150, 0.8)).toBe('closed'));
  test('no full action never commits', () =>
    expect(
      resolveRelease({ offset: -380, width: 390, velocity: -2, left: { count: 2, hasFull: false }, right: R }),
    ).toBe('open-left'));
  test('side with no actions stays closed', () =>
    expect(resolveRelease({ offset: 200, width: 390, velocity: 0, left: L, right: { count: 0, hasFull: false } })).toBe(
      'closed',
    ));
});

describe('dragOffset / isArmed', () => {
  test('no actions on that side: row does not move', () =>
    expect(dragOffset(100, 390, L, { count: 0, hasFull: false })).toBe(0));
  test('tray-only side is damped past the tray', () =>
    expect(dragOffset(-200, 390, { count: 1, hasFull: false }, R)).toBeCloseTo(-(ACTION_W + (200 - ACTION_W) * 0.2)));
  test('armed at 60%', () => {
    expect(isArmed(-240, 390, L)).toBe(true);
    expect(isArmed(-200, 390, L)).toBe(false);
  });
});

describe('keyToAction', () => {
  test('gmail-style keys', async () => {
    const { keyToAction } = await import('./listKeys');
    expect(keyToAction('e')).toBe('archive');
    expect(keyToAction('#')).toBe('delete');
    expect(keyToAction('Delete')).toBe('delete');
    expect(keyToAction('u')).toBe('read');
    expect(keyToAction('j')).toBe('next');
    expect(keyToAction('k')).toBe('prev');
    expect(keyToAction('x')).toBeNull();
  });
});
