import { describe, expect, test } from 'bun:test';
import {
  applyParticipantsReply,
  mayModerate,
  OPEN_STAGE_FULL,
  parseSpaceState,
  stageButtonLabel,
  takeStageNote,
} from './model';

/** Lounge open stage + appointed moderators (owner, 11 Oct 2026). */
describe('open stage', () => {
  const reply = {
    space: { id: 's1', host_handle: 'bwalletx', status: 'live', transport: 'sfu' },
    participants: [{ handle: 'testy', role: 'listener' }],
    open_stage: true,
    stage_cap: 16,
    may_moderate: false,
    may_appoint: true,
    moderators: ['alice', 'bob', 3],
  };

  test('parses open stage, cap and moderation facts', () => {
    const s = parseSpaceState(reply, '$testy');
    expect(s.openStage).toBe(true);
    expect(s.stageCap).toBe(16);
    expect(s.mayModerate).toBe(false);
    expect(s.mayAppoint).toBe(true);
    expect(s.moderators).toEqual(['alice', 'bob']);
  });

  test('older server: no open-stage facts → closed stage, no powers', () => {
    const s = parseSpaceState({ space: reply.space, participants: [] }, 'testy');
    expect(s.openStage).toBe(false);
    expect(s.mayModerate).toBe(false);
    expect(s.mayAppoint).toBe(false);
    expect(s.moderators).toBeUndefined();
  });

  test('a participants reply keeps the open-stage facts', () => {
    const s = parseSpaceState(reply, 'testy');
    const next = applyParticipantsReply(s, { participants: [{ handle: 'testy', role: 'speaker' }] }, 'testy');
    expect(next?.openStage).toBe(true);
    expect(next?.me?.role).toBe('speaker');
  });

  test('button reads "Join the stage" on an open stage', () => {
    expect(stageButtonLabel({ openStage: true, raised: false })).toBe('Join the stage');
    expect(stageButtonLabel({ openStage: true, raised: true })).toBe('Waiting for a seat');
    expect(stageButtonLabel({ openStage: false, raised: false })).toBe('✋ Request to speak');
    expect(stageButtonLabel({ openStage: false, raised: true })).toBe('✋ Hand raised');
  });

  test('take_stage outcomes become plain notes', () => {
    expect(takeStageNote('speaker')).toContain("You're on stage");
    expect(takeStageNote('queued')).toBe(OPEN_STAGE_FULL);
    expect(takeStageNote('queued', 'Too many stage joins. Try again in a few minutes.')).toContain('Too many');
    expect(takeStageNote('ask')).toBeNull();
  });

  test('an appointed moderator gets the moderator menu', () => {
    expect(mayModerate({ isHost: false, roomBoss: false })).toBe(false);
    const s = parseSpaceState({ ...reply, may_moderate: true }, 'testy');
    expect(mayModerate({ isHost: false, roomBoss: !!s.mayModerate })).toBe(true);
  });
});
