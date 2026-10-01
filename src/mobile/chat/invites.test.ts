import { describe, expect, test } from 'bun:test';
import { inviteLine, inviteState } from './invites';

const key = `bsv21:${'a'.repeat(64)}_0`;
const alice = { name: 'alice', by: 'alice' };
const none = { ignored: new Set<string>(), accepted: new Set<string>() };

describe('unsolicited invites', () => {
  test("someone's personal room you were sent a token for → invite", () => {
    expect(inviteState({ key, status: 'join' }, alice, 'bob', none)).toBe('invite');
    expect(inviteLine(alice)).toBe('$alice invited you');
  });
  test('Ignore hides it (local), without spending', () => {
    expect(inviteState({ key, status: 'join' }, alice, 'bob', { ...none, ignored: new Set([key]) })).toBe('hidden');
  });
  test('Join (accepted) shows it as a normal room', () => {
    expect(inviteState({ key, status: 'join' }, alice, 'bob', { ...none, accepted: new Set([key]) })).toBe('normal');
  });
  test('already a member, your own room, or not a personal room → normal', () => {
    expect(inviteState({ key, status: 'member' }, alice, 'bob', none)).toBe('normal');
    expect(inviteState({ key, status: 'join' }, alice, '$Alice', none)).toBe('normal');
    expect(inviteState({ key, status: 'join' }, null, 'bob', none)).toBe('normal');
    expect(inviteState({ key, status: 'start' }, alice, 'bob', none)).toBe('normal');
  });
});
