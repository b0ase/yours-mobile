import { describe, expect, test } from 'bun:test';
import { parseHistorySetting, parseHistoryVisibility, showHistoryNote, HISTORY_OFF_NOTE } from './history';

describe('room history setting', () => {
  test('defaults to all', () => {
    expect(parseHistoryVisibility(undefined)).toBe('all');
    expect(parseHistoryVisibility('nonsense')).toBe('all');
    expect(parseHistorySetting({}).visibility).toBe('all');
  });
  test('reads since_join and the reader floor', () => {
    const s = parseHistorySetting({
      history_visibility: 'since_join',
      history_hidden_before: '2026-10-01T00:00:00Z',
      can_change: false,
    });
    expect(s).toEqual({ visibility: 'since_join', hiddenBefore: '2026-10-01T00:00:00Z', canChange: false });
  });
  test('note only for a floored reader (owners see everything, so no note)', () => {
    expect(showHistoryNote('2026-10-01T00:00:00Z')).toBe(true);
    expect(showHistoryNote(null)).toBe(false);
  });
  test('copy is honest: hidden in the app, not deleted, and not called private', () => {
    expect(HISTORY_OFF_NOTE).toContain('hidden in the app');
    expect(HISTORY_OFF_NOTE.toLowerCase()).not.toContain('private');
  });
});
