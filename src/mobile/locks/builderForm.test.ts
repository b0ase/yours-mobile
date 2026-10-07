import { describe, expect, test } from 'bun:test';
import { EMPTY_AMOUNTS, PREVIEW_LABEL, PREVIEW_NOTE, valuesEntered, type BuilderValues } from './builderForm';

const start: BuilderValues = { kind: 'gradual', gmode: 'usd', until: 'count', ...EMPTY_AMOUNTS };

describe('New Lock builder', () => {
  test('starts with every amount empty', () => {
    for (const v of Object.values(EMPTY_AMOUNTS)) expect(v).toBe('');
  });

  test('preview is labelled as a preview, not "Total locked"', () => {
    expect(PREVIEW_LABEL).toBe('This lock will take');
    expect(PREVIEW_LABEL).not.toContain('Total locked');
    expect(PREVIEW_NOTE).toContain('nothing is locked yet');
  });

  test('review/confirm stays disabled on the untouched form in every mode', () => {
    expect(valuesEntered(start)).toBe(false);
    expect(valuesEntered({ ...start, gmode: 'bsv' })).toBe(false);
    expect(valuesEntered({ ...start, gmode: 'percent' })).toBe(false);
    expect(valuesEntered({ ...start, kind: 'once' })).toBe(false);
  });

  test('needs every value for the mode', () => {
    expect(valuesEntered({ ...start, usdPer: '10' })).toBe(false);
    expect(valuesEntered({ ...start, usdPer: '10', count: '30' })).toBe(true);
    expect(valuesEntered({ ...start, usdPer: '10', until: 'end' })).toBe(true);
    expect(valuesEntered({ ...start, gmode: 'bsv', bsvPer: '0.01', count: '5' })).toBe(true);
    expect(valuesEntered({ ...start, gmode: 'percent', amountBsv: '1' })).toBe(false);
    expect(valuesEntered({ ...start, gmode: 'percent', amountBsv: '1', pct: '2' })).toBe(true);
    expect(valuesEntered({ ...start, kind: 'once', amountBsv: '0.5' })).toBe(true);
    expect(valuesEntered({ ...start, usdPer: '0', count: '30' })).toBe(false);
    expect(valuesEntered({ ...start, usdPer: 'abc', count: '30' })).toBe(false);
  });
});

describe('start small', () => {
  test('asks once more only above 0.01 BSV', async () => {
    const { needsSizeCheck, BIG_LOCK_QUESTION, START_SMALL_NOTE } = await import('./builderForm');
    expect(needsSizeCheck(1_000_000)).toBe(false);
    expect(needsSizeCheck(1_000_001)).toBe(true);
    expect(needsSizeCheck(5_000)).toBe(false);
    expect(BIG_LOCK_QUESTION).toContain('more than 0.01 BSV');
    expect(START_SMALL_NOTE).toContain('start small');
  });
});
