import { describe, expect, it } from 'bun:test';
import { ChatApiError } from './api';
import {
  INDEXING_FAST_MS,
  INDEXING_FAST_WINDOW_MS,
  INDEXING_SLOW_MS,
  indexingMessage,
  indexingRetryDelay,
  isNotYetIndexed,
  isOwnTokenKey,
} from './roomIndexing';

describe('isNotYetIndexed', () => {
  it('treats an unknown token (404) as still indexing', () => {
    expect(isNotYetIndexed(new ChatApiError('That is not a BSV-21 token.', 404))).toBe(true);
  });
  it('treats an indexer that did not answer (502) as still indexing', () => {
    expect(
      isNotYetIndexed(new ChatApiError('Could not verify that holding: the 1Sat indexer did not answer.', 502)),
    ).toBe(true);
    expect(isNotYetIndexed(new ChatApiError('Bad gateway', 502))).toBe(false);
  });
  it('treats a plain 403 as indexing only for your own token', () => {
    const e = new ChatApiError('Hold at least 1 $X to open its room', 403, { error: 'x' });
    expect(isNotYetIndexed(e, { ownToken: true })).toBe(true);
    expect(isNotYetIndexed(e)).toBe(false);
  });
  it('keeps a structured gate refusal as a refusal', () => {
    const e = new ChatApiError('no', 403, { token_gated: true });
    expect(isNotYetIndexed(e, { ownToken: true })).toBe(false);
  });
  it('leaves genuine errors alone', () => {
    expect(isNotYetIndexed(new ChatApiError('boom', 500))).toBe(false);
    expect(isNotYetIndexed(new ChatApiError('auth', 401))).toBe(false);
    expect(isNotYetIndexed(new Error('network'))).toBe(false);
  });
});

describe('indexing retry', () => {
  it('retries every 5s for 3 minutes, then slowly', () => {
    expect(indexingRetryDelay(0)).toBe(INDEXING_FAST_MS);
    expect(indexingRetryDelay(INDEXING_FAST_WINDOW_MS - 1)).toBe(INDEXING_FAST_MS);
    expect(indexingRetryDelay(INDEXING_FAST_WINDOW_MS)).toBe(INDEXING_SLOW_MS);
  });
  it('changes the message after the fast window', () => {
    expect(indexingMessage(0)).toBe('Indexing your token… your room opens shortly');
    expect(indexingMessage(INDEXING_FAST_WINDOW_MS)).toMatch(/^Still indexing/);
  });
});

describe('isOwnTokenKey', () => {
  it('matches by normalised id', () => {
    const own = [{ tokenId: 'abc_0' }];
    expect(isOwnTokenKey('bsv21:abc_0', own)).toBe(true);
    expect(isOwnTokenKey('bsv21:abc.0', own)).toBe(true);
    expect(isOwnTokenKey('bsv21:def_0', own)).toBe(false);
  });
});
