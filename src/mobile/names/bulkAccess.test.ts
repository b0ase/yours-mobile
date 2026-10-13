import { describe, expect, test } from 'bun:test';
import { paymailAllowsBulkMint } from './bulkAccess';

describe('bulk minter access (owner, 14 Oct 2026: hidden except agents and the owner)', () => {
  test('the owner handle, with or without $ and our domain', () => {
    expect(paymailAllowsBulkMint('b0asex', ['b0asex'])).toBe(true);
    expect(paymailAllowsBulkMint('$B0aseX', ['b0asex'])).toBe(true);
  });
  test('anyone else, or the right name at another domain', () => {
    expect(paymailAllowsBulkMint('kim', ['b0asex'])).toBe(false);
    expect(paymailAllowsBulkMint('b0asex@handcash.io', ['b0asex'])).toBe(false);
    expect(paymailAllowsBulkMint('', ['b0asex'])).toBe(false);
  });
});
