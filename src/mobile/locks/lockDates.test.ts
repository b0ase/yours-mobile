import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  BLOCK_MS,
  HEIGHT_MAX_AGE_MS,
  buildGradual,
  buildOnce,
  confirmOpensText,
  heightForDate,
  heightFresh,
  marginBlocks,
  opensText,
} from './schedule';

const NOW = new Date('2026-10-18T09:00:00Z');
const H = 930_000;
const fmt = (d: Date) => d.toISOString().slice(0, 10);

describe('safety margin', () => {
  test('blocks + ceil(3·√blocks) + 6', () => {
    expect(marginBlocks(144)).toBe(36 + 6);
    expect(heightForDate(new Date(NOW.getTime() + 86_400_000), NOW, H)).toBe(H + 144 + 42);
    expect(heightForDate(new Date(NOW.getTime() + 60_000), NOW, H)).toBe(H + 1 + 9);
    expect(heightForDate(NOW, NOW, H)).toBe(H + 1);
  });
  test('the height is never reached before the date at 10 min/block plus the margin', () => {
    for (const mins of [1, 9, 10, 11, 59, 60, 1440, 1441, 10_080, 43_829, 525_960, 5_256_000]) {
      const date = new Date(NOW.getTime() + mins * 60_000);
      const blocks = Math.ceil((mins * 60_000) / BLOCK_MS);
      const h = heightForDate(date, NOW, H);
      expect(h - H).toBe(blocks + marginBlocks(blocks));
      // At exactly 10-minute blocks the lock opens no earlier than the date…
      expect(NOW.getTime() + (h - H) * BLOCK_MS).toBeGreaterThanOrEqual(date.getTime());
      // …and survives blocks running 3σ fast over the span.
      const fast = (h - H) * BLOCK_MS - 3 * Math.sqrt(blocks) * BLOCK_MS;
      expect(NOW.getTime() + fast).toBeGreaterThanOrEqual(date.getTime());
    }
  });
  test('shown dates are never earlier than the chosen date', () => {
    const at = new Date(NOW.getTime() + 30 * 86_400_000);
    expect(buildOnce(100_000, at, NOW, H).pieces[0].date.getTime()).toBeGreaterThanOrEqual(at.getTime());
    const g = buildGradual({ start: at, frequency: 'daily', count: 5, perPayoutSats: 10_000 }, NOW, H);
    g.pieces.forEach((p, i) => expect(p.date.getTime()).toBeGreaterThanOrEqual(at.getTime() + i * 86_400_000));
  });
});

describe('stale height', () => {
  test('a height older than 10 minutes is not fresh', () => {
    const t = NOW.getTime();
    expect(heightFresh(t, t + HEIGHT_MAX_AGE_MS)).toBe(true);
    expect(heightFresh(t, t + HEIGHT_MAX_AGE_MS + 1)).toBe(false);
    expect(heightFresh(0, t)).toBe(false);
  });
  test('rebuilding on the new tip keeps the lock a full day away', () => {
    // Read the tip at H, then 36 blocks (6 h) pass. The screen pairs `now` with when the height was read.
    const readAt = NOW;
    const later = new Date(NOW.getTime() + 6 * 3_600_000);
    const at = new Date(later.getTime() + 86_400_000);
    // The old bug: a fresh clock on the old height leaves the lock 6 hours short of the true tip.
    const bug = buildOnce(100_000, at, later, H).pieces[0].height - (H + 36);
    expect(bug).toBeLessThan(144 + marginBlocks(144));
    // The old height with its own read time, and the rebuilt one on the new tip, both give the full day.
    const paired = buildOnce(100_000, at, readAt, H).pieces[0].height;
    const rebuilt = buildOnce(100_000, at, later, H + 36).pieces[0].height;
    expect(rebuilt - (H + 36)).toBe(144 + marginBlocks(144));
    expect(paired).toBeGreaterThanOrEqual(rebuilt);
  });
});

describe('confirm text', () => {
  const d1 = new Date('2027-01-01T12:00:00Z');
  const d2 = new Date('2027-06-01T12:00:00Z');
  test('once-off', () => {
    expect(confirmOpensText([{ height: 983_000, date: d1 }], fmt)).toBe('Opens at block 983000 (≈ 2027-01-01).');
  });
  test('schedule: first and last block', () => {
    expect(
      confirmOpensText(
        [
          { height: 983_000, date: d1 },
          { height: 990_000, date: d1 },
          { height: 1_004_000, date: d2 },
        ],
        fmt,
      ),
    ).toBe('First payout opens at block 983000 (≈ 2027-01-01); last at block 1004000 (≈ 2027-06-01).');
  });
  test('opens wording', () => {
    expect(opensText(d1, fmt)).toBe('Opens on or after ≈ 2027-01-01, usually a little later (blocks vary)');
    expect(confirmOpensText([], fmt)).toBe('');
  });
});

/** Local date fields around UTC±13, DST changes and the year boundary (each case in its own TZ process). */
describe('local dates', () => {
  const run = (tz: string, iso: string) => {
    const code = `import { localDay, tomorrowLocal, fromLocalDay } from './src/mobile/locks/schedule.ts';
      const n = new Date('${iso}');
      console.log(JSON.stringify([localDay(n), tomorrowLocal(n), fromLocalDay(localDay(n)).getHours(), new Date(n.getTime()).toISOString().slice(0,10)]));`;
    const r = spawnSync('bun', ['-e', code], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    return JSON.parse(r.stdout.trim()) as [string, string, number, string];
  };
  test('UTC+13 morning: today is the local day, not the UTC day', () => {
    const [today, tomorrow, hour, utc] = run('Pacific/Auckland', '2026-10-18T20:00:00Z'); // 09:00 19 Oct NZDT
    expect([today, tomorrow, hour, utc]).toEqual(['2026-10-19', '2026-10-20', 12, '2026-10-18']);
  });
  test('UTC-11 evening', () => {
    const [today, tomorrow] = run('Pacific/Pago_Pago', '2026-10-19T09:00:00Z'); // 22:00 18 Oct
    expect([today, tomorrow]).toEqual(['2026-10-18', '2026-10-19']);
  });
  test('UTC+14 and the year boundary', () => {
    const [today, tomorrow] = run('Pacific/Kiritimati', '2026-12-31T10:30:00Z'); // 00:30 1 Jan 2027
    expect([today, tomorrow]).toEqual(['2027-01-01', '2027-01-02']);
  });
  test('DST change days keep midday and the next calendar day', () => {
    expect(run('Europe/London', '2026-10-24T23:30:00Z').slice(0, 3)).toEqual(['2026-10-25', '2026-10-26', 12]);
    expect(run('America/New_York', '2027-03-14T05:30:00Z').slice(0, 3)).toEqual(['2027-03-14', '2027-03-15', 12]);
  });
});
