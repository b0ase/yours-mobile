import { describe, expect, test } from 'bun:test';
import { nextSession, parseSchedule, slotIcs, whenLabel, zonedToUtc } from './schedule';

const TZ = 'Europe/London';
const slot = parseSchedule({
  tz: TZ,
  slots: [{ id: 'qa', title: 'Q&A', blurb: 'x', room: 'lounge', weekday: 1, start: '19:00', durationMin: 60 }],
}).slots[0];

describe('schedule', () => {
  test('parses and drops bad rows', () => {
    const s = parseSchedule({
      slots: [{ id: 'a' }, { id: 'b', title: 't', room: '../x', weekday: 1, start: '19:00' }],
    });
    expect(s.tz).toBe(TZ);
    expect(s.slots).toHaveLength(0);
    expect(slot.room).toBe('LOUNGE');
    expect(slot.host).toBeNull();
  });
  test('London wall time across BST and GMT', () => {
    expect(new Date(zonedToUtc(TZ, 2026, 9, 12, 19, 0)).toISOString()).toBe('2026-10-12T18:00:00.000Z');
    expect(new Date(zonedToUtc(TZ, 2026, 10, 2, 19, 0)).toISOString()).toBe('2026-11-02T19:00:00.000Z');
  });
  test('next session, live now, and labels', () => {
    const mon5pm = Date.parse('2026-10-12T16:00:00Z'); // Monday 17:00 London
    const s = nextSession(slot, TZ, mon5pm);
    expect(new Date(s.start).toISOString()).toBe('2026-10-12T18:00:00.000Z');
    expect(whenLabel(s, mon5pm)).toBe('Starts in 2h');
    expect(whenLabel(s, s.start + 60_000)).toBe('Live now');
    const after = nextSession(slot, TZ, s.end + 1);
    expect(new Date(after.start).toISOString()).toBe('2026-10-19T18:00:00.000Z');
  });
  test('ics is weekly with TZID', () => {
    const ics = slotIcs(slot, TZ, Date.parse('2026-10-12T16:00:00Z'), 'https://bchatx.com/s/lounge');
    expect(ics).toContain('DTSTART;TZID=Europe/London:20261012T190000');
    expect(ics).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO');
    expect(ics).toContain('DURATION:PT1H');
  });
});
