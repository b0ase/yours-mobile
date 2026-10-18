import { describe, expect, test } from 'bun:test';
import { Utils } from '@bsv/sdk';
import { makeSlices, restoreSecret } from './slices';
import { checkBox, restoreState } from './sliceRestore';

const secret = Utils.toArray('apple banana cherry', 'utf8');
const { cards } = makeSlices(secret, 2, 3);
const other = makeSlices(secret, 2, 3).cards;

describe('one box per slice', () => {
  test('each box checks on its own', () => {
    expect(checkBox('').kind).toBe('empty');
    const ok = checkBox(cards[0].text);
    expect(ok.kind).toBe('ok');
    if (ok.kind === 'ok') expect(ok.label).toContain('slice 1 of 3');
    const bad = checkBox('hello');
    expect(bad.kind).toBe('error');
    const t = cards[1].text;
    const damaged = checkBox(t.slice(0, -6) + (t.at(-6) === 'A' ? 'B' : 'A') + t.slice(-5));
    expect(damaged.kind).toBe('error');
  });

  test('restore turns on once enough different slices are valid, and restores', () => {
    expect(restoreState(['', '']).ready).toBe(false);
    expect(restoreState([cards[0].text, '']).ready).toBe(false);
    expect(restoreState([cards[0].text, cards[0].text]).ready).toBe(false);
    const st = restoreState([cards[2].text, cards[0].text]);
    expect(st.ready).toBe(true);
    expect(st.threshold).toBe(2);
    expect(st.total).toBe(3);
    expect(restoreSecret(st.texts)).toEqual(secret);
  });

  test('a bad box or mixed sets block restore', () => {
    expect(restoreState([cards[0].text, cards[1].text, 'junk']).ready).toBe(false);
    const mixed = restoreState([cards[0].text, other[1].text]);
    expect(mixed.ready).toBe(false);
    expect(mixed.problem).toContain('different sets');
  });

  test('several lines pasted into one box still work', () => {
    const st = restoreState([`${cards[0].text}\n${cards[1].text}\n`, '']);
    expect(st.ready).toBe(true);
    expect(restoreSecret(st.texts)).toEqual(secret);
  });

  test('3-of-5 needs three', () => {
    const five = makeSlices(secret, 3, 5).cards;
    expect(restoreState([five[0].text, five[3].text]).ready).toBe(false);
    const st = restoreState([five[0].text, five[3].text, five[4].text]);
    expect(st.threshold).toBe(3);
    expect(st.ready).toBe(true);
  });
});
