import { describe, expect, it } from 'bun:test';
import { profileUrlOf, studioRoomParam } from './broadcast';

describe('Space broadcast links', () => {
  it('opens bTV: AIVJ studio for this Space', () => {
    expect(studioRoomParam('$vexvoid')).toBe('VEXVOID');
  });
  it('links the host profile where the live Space plays', () => {
    expect(profileUrlOf('VexVoid')).toBe('https://www.bchatx.com/u/vexvoid');
    expect(profileUrlOf('$vexvoid')).toBe('https://www.bchatx.com/u/vexvoid');
    expect(profileUrlOf('vexvoid.screen')).toBe('https://www.bchatx.com/u/vexvoid');
  });
});
