import { describe, expect, test } from 'bun:test';
import { backStackSize, handleBack, pushBackCloser } from './backStack';

describe('backStack', () => {
  test('empty stack returns false', () => {
    expect(handleBack()).toBe(false);
  });

  test('pops the most recent closer first (LIFO)', () => {
    const calls: string[] = [];
    const a = pushBackCloser(() => calls.push('a'));
    pushBackCloser(() => calls.push('b'));
    expect(handleBack()).toBe(true);
    expect(calls).toEqual(['b']);
    expect(handleBack()).toBe(true);
    expect(calls).toEqual(['b', 'a']);
    expect(handleBack()).toBe(false);
    a(); // unregistering after pop is a no-op
    expect(backStackSize()).toBe(0);
  });

  test('unregister removes a middle entry without affecting others', () => {
    const calls: string[] = [];
    pushBackCloser(() => calls.push('a'));
    const b = pushBackCloser(() => calls.push('b'));
    pushBackCloser(() => calls.push('c'));
    b();
    b();
    handleBack();
    handleBack();
    expect(calls).toEqual(['c', 'a']);
    expect(handleBack()).toBe(false);
  });
});
