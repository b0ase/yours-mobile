import { describe, expect, test } from 'bun:test';
import {
  BASE_DELAY_MS,
  MAX_DELAY_MS,
  PERMANENT_DELAY_MS,
  backoffDelay,
  createInternalizeBackoff,
  isPermanentInternalizeError,
} from './internalizeBackoff';

const FAILED = new Error('The tx parameter must be target transaction of internalizeAction has invalid status failed.');

describe('internalize back-off', () => {
  test('a failed-status refusal is permanent', () => {
    expect(isPermanentInternalizeError(FAILED)).toBe(true);
    expect(isPermanentInternalizeError(new Error('network down'))).toBe(false);
    expect(backoffDelay(1, FAILED)).toBe(PERMANENT_DELAY_MS);
  });

  test('other errors back off exponentially up to a cap', () => {
    expect(backoffDelay(1)).toBe(BASE_DELAY_MS);
    expect(backoffDelay(3)).toBe(BASE_DELAY_MS * 4);
    expect(backoffDelay(50)).toBe(MAX_DELAY_MS);
  });

  test('a txid is skipped until its delay passes, and clear() makes it due again', () => {
    let now = 1000;
    const b = createInternalizeBackoff(() => now);
    const tx = 'a'.repeat(64);
    expect(b.due(tx)).toBe(true);
    b.fail(tx, FAILED);
    expect(b.due(tx)).toBe(false);
    now += PERMANENT_DELAY_MS - 1;
    expect(b.due(tx)).toBe(false);
    b.clear(tx);
    expect(b.due(tx)).toBe(true);
    b.fail(tx, new Error('timeout'));
    now += BASE_DELAY_MS;
    expect(b.due(tx)).toBe(true);
  });
});
