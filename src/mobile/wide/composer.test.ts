import { describe, expect, it } from 'bun:test';
import { hasOwnComposer } from './composer';

describe('hasOwnComposer', () => {
  it('covers chat rooms, DMs, bMail and Ask b', () => {
    for (const p of ['/m/chat', '/m/chat/room/abc', '/m/bmail', '/m/bmail/compose', '/m/ask-b'])
      expect(hasOwnComposer(p)).toBe(true);
  });
  it('leaves other pages (and look-alike prefixes) with the floating bar', () => {
    for (const p of ['/m/feed', '/m/bmailer', '/m/chatter', '/m/spaces', '/bsv-wallet'])
      expect(hasOwnComposer(p)).toBe(false);
  });
});
