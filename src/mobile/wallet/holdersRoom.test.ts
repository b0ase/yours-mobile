import { describe, expect, test } from 'bun:test';
import { holdersRoomKey, MNEE_TOKEN_ID, openHoldersRoom } from './holdersRoom';
import { takeChatRoom } from '../chat/nav';

describe('MNEE / PNEEs holders rooms', () => {
  test('room keys are the coins’ BSV-21 ids', () => {
    expect(holdersRoomKey('mnee')).toBe(`bsv21:${MNEE_TOKEN_ID}`);
    expect(holdersRoomKey('pnee', 'abc_0')).toBe('bsv21:abc_0');
    expect(holdersRoomKey('pnee', '')).toBeNull();
  });
  test('opens the room in Chat when token rooms are on', () => {
    let went = 0;
    openHoldersRoom('mnee', () => went++, true);
    expect(went).toBe(1);
    expect(takeChatRoom()).toBe(`bsv21:${MNEE_TOKEN_ID}`);
  });
  test('store edition: Chat tab only, no room request', () => {
    let went = 0;
    openHoldersRoom('pnee', () => went++, false);
    expect(went).toBe(1);
    expect(takeChatRoom()).toBeNull();
  });
});
