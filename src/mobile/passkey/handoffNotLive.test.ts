import { describe, expect, test } from 'bun:test';
import { HANDOFF_EXT_ID } from './extHandoff';
import { isHandoffNotLive } from './handoffNotLive';

const link = `?passkey=1&ext=${HANDOFF_EXT_ID}&n=abcdefghijklmnopqrstuv`;

describe('extension passkey link while passkeys are off on the web', () => {
  test('shows the not-yet message for the extension link', () => {
    expect(isHandoffNotLive(false, '/restore', link)).toBe(true);
    expect(isHandoffNotLive(false, '/restore/', link)).toBe(true);
  });
  test('never when passkeys are on (the real hand-off runs)', () => {
    expect(isHandoffNotLive(true, '/restore', link)).toBe(false);
  });
  test('never for other pages or other links', () => {
    expect(isHandoffNotLive(false, '/', link)).toBe(false);
    expect(isHandoffNotLive(false, '/restore', '?passkey=1')).toBe(false);
    expect(isHandoffNotLive(false, '/restore', '?passkey=1&ext=someoneelse&n=abcdefghijklmnopqrstuv')).toBe(false);
  });
});
