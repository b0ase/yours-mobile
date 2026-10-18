import { describe, expect, test } from 'bun:test';
import { eventIcs, filterCalendar, isLiveNow, mergeCalendar, parseEvent } from './calendar';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const at = (h: number) => new Date(NOW + h * 3600_000).toISOString();
const TX = 'a'.repeat(64);

describe('bCal calendar', () => {
  test('parses and drops bad rows', () => {
    expect(parseEvent({ id: 'x', title: 't', room: '$bradio', startsAt: at(1) })?.room).toBe('BRADIO');
    expect(parseEvent({ id: '../x', title: 't', room: 'A', startsAt: at(1) })).toBeNull();
    expect(parseEvent({ id: 'x', title: '', room: 'A', startsAt: at(1) })).toBeNull();
    expect(parseEvent({ id: 'x', title: 't', room: 'A', startsAt: 'soon' })).toBeNull();
    expect(parseEvent({ id: 'x', title: 't', room: 'A', startsAt: at(1), chainTxid: 'nope' })?.chainTxid).toBeNull();
  });

  test('merges public + yours by id, yours wins, keeps the chain txid, drops ended, sorts', () => {
    const pub = {
      items: [
        { id: 'b', title: 'B', room: 'X', startsAt: at(5), chainTxid: TX },
        { id: 'a', title: 'A', room: 'X', startsAt: at(1) },
        { id: 'old', title: 'Old', room: 'X', startsAt: at(-3), durationMin: 60 },
      ],
    };
    const yours = { items: [{ id: 'b', title: 'B', room: 'X', startsAt: at(5), mine: true }] };
    const all = mergeCalendar(pub, yours, NOW);
    expect(all.map((e) => e.id)).toEqual(['a', 'b']);
    expect(all[1].mine && all[1].following).toBe(true);
    expect(all[1].chainTxid).toBe(TX);
    expect(filterCalendar(all, 'mine').map((e) => e.id)).toEqual(['b']);
    expect(filterCalendar(all, 'following').map((e) => e.id)).toEqual(['b']);
    expect(filterCalendar(all, 'all')).toHaveLength(2);
  });

  test('a missing feed is an empty calendar', () => {
    expect(mergeCalendar(null, undefined, NOW)).toEqual([]);
  });

  test('live now', () => {
    const e = parseEvent({ id: 'x', title: 't', room: 'A', startsAt: at(-0.5), durationMin: 60 })!;
    expect(isLiveNow(e, NOW)).toBe(true);
  });

  test('.ics shares its UID with bcalx.com and links the chain record', () => {
    const e = parseEvent({ id: 'abc', title: 'Open, mic', room: 'A', startsAt: at(1), chainTxid: TX })!;
    const ics = eventIcs(e, 'https://www.bchatx.com/s/a', NOW);
    expect(ics).toContain('UID:abc@bcalx.com');
    expect(ics).toContain('SUMMARY:Open\\, mic');
    expect(ics).toContain(`whatsonchain.com/tx/${TX}`);
    expect(ics).toContain('DTSTART:20261020T130000Z');
  });
});
