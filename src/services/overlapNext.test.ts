/**
 * Review of a95a1ff0, 2: the first open after the storage-key fix can mark this device's store as its own in the middle
 * of a pull (keepDeviceStoreKey). The pass started without the overlap; its next cursor then gets it, and the toolbox's
 * validateSyncCheckpoint refuses a next cursor older than the page's own ("Invalid sync checkpoint"). The next cursor
 * with the overlap never goes below the cursor the page was asked from.
 */
import { describe, expect, test } from 'bun:test';
import { overlappedNext, PULL_OVERLAP_MS } from './fullPass';

describe('overlappedNext', () => {
  const S = new Date('2026-11-22T12:00:00Z');
  test('a pass that started without the overlap: its next cursor never goes below where the page started', () => {
    const next = new Date(S.getTime() + 60_000);
    expect(overlappedNext(next, S)).toEqual(S);
    // The toolbox's rule (validateSyncCheckpoint): since >= previous.since.
    expect(overlappedNext(next, S)!.getTime()).toBeGreaterThanOrEqual(S.getTime());
  });
  test('a pass that started with it: the overlap as before', () => {
    const start = new Date(S.getTime() - PULL_OVERLAP_MS);
    const next = new Date(S.getTime() + 60 * 60_000);
    expect(overlappedNext(next, start)).toEqual(new Date(next.getTime() - PULL_OVERLAP_MS));
  });
  test('no cursor stays none; a pass from the start keeps the overlap', () => {
    expect(overlappedNext(undefined, S)).toBeUndefined();
    expect(overlappedNext(S, undefined)).toEqual(new Date(S.getTime() - PULL_OVERLAP_MS));
    expect(overlappedNext(S.toISOString(), S.toISOString())).toEqual(S);
  });
});
