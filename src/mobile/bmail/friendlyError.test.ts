import { describe, expect, it, spyOn } from 'bun:test';
import { BMAIL_OFFLINE, friendlyMailError, isRawMailError } from './friendlyError';

describe('bMail friendly errors', () => {
  spyOn(console, 'warn').mockImplementation(() => undefined);
  it('hides the raw host error', () => {
    expect(friendlyMailError(new Error('failed to retrieve messages from any host'))).toBe(BMAIL_OFFLINE);
    expect(isRawMailError('TypeError: Failed to fetch')).toBe(true);
    expect(isRawMailError('HTTP 502')).toBe(true);
  });
  it('keeps app-written messages, except for the whole-inbox refresh', () => {
    expect(friendlyMailError(new Error('Not enough BSV to pay the postage'))).toBe('Not enough BSV to pay the postage');
    expect(friendlyMailError(new Error('Not enough BSV'), { whole: true })).toBe(BMAIL_OFFLINE);
  });
});
