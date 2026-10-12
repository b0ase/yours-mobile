import { describe, expect, test } from 'bun:test';
import { OVERLAY_ISSUES, bsv21ErrorMessage } from './bsv21SendErrors';

describe('BSV-21 send error messages', () => {
  test('a token details lookup failure is "could not reach", never "unknown token"', () => {
    expect(OVERLAY_ISSUES['token-not-found']).toBe('unreachable');
    expect(bsv21ErrorMessage('token-not-found', 'TERANODE')).toBe(
      "Couldn't reach the token indexer. Nothing was sent. Try again.",
    );
  });

  test('overlay-validation-failed has its own message', () => {
    expect(bsv21ErrorMessage('overlay-validation-failed', 'TERANODE')).toContain(
      "Couldn't check your TERANODE with the token indexer",
    );
  });

  test('the other overlay issues keep their prompts; unknown errors fall through', () => {
    expect(OVERLAY_ISSUES['token-not-active']).toBe('not-active');
    expect(OVERLAY_ISSUES['tokens-queued']).toBe('queued');
    expect(OVERLAY_ISSUES['insufficient-valid-tokens']).toBe('not-valid');
    expect(bsv21ErrorMessage('funding-amount-changed', 'X')).toContain('changed its price');
    expect(bsv21ErrorMessage('something-else', 'X')).toBeUndefined();
  });
});
