import { describe, expect, test } from 'bun:test';
import { parseMyReports, releaseUrl, stageText } from './myReports';

describe('your reports', () => {
  test('parses the server reply', () => {
    const r = parseMyReports({
      reports: [
        {
          ref: '#F-12',
          created_at: 'a',
          updated_at: 'b',
          category: 'bug',
          area: 'wallet',
          stage: 'fixed',
          summary: 'Load failed',
          fixed_in: '5.2.30',
        },
        {
          ref: '#F-3',
          created_at: 'a',
          category: 'bug',
          area: 'wallet',
          stage: 'weird',
          summary: 'x',
          fixed_in: '5.2.30',
        },
        { ref: 'nope' },
        null,
      ],
    });
    expect(r.length).toBe(2);
    expect(r[0]).toMatchObject({ ref: 'F-12', stage: 'fixed', fixedIn: '5.2.30', updatedAt: 'b' });
    expect(r[1]).toMatchObject({ ref: 'F-3', stage: 'received', fixedIn: null, updatedAt: 'a' });
  });
  test('anything else is an empty list', () => {
    expect(parseMyReports(null)).toEqual([]);
    expect(parseMyReports({ reports: 'x' })).toEqual([]);
  });
  test('labels and release links', () => {
    expect(stageText({ stage: 'fixed', fixedIn: '5.2.31' })).toBe('Fixed in 5.2.31');
    expect(stageText({ stage: 'fixing', fixedIn: null })).toBe('Fixing');
    expect(releaseUrl('5.2.31 (iOS 124)')).toBe('https://bwalletx.com/releases#v5.2.31');
  });
});
