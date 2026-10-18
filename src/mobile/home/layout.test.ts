import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LAYOUT,
  WIDE_DEFAULT_LAYOUT,
  migrateWide,
  addModule,
  normalise,
  parseLayout,
  removeModule,
  serialise,
  shiftModule,
  visibleLayout,
} from './layout';

describe('home layout', () => {
  test('defaults: card, Ask b, store showcase', () => {
    expect(DEFAULT_LAYOUT).toEqual(['card', 'askB', 'showcase']);
    expect(parseLayout(null)).toEqual(['card', 'askB', 'showcase']);
  });

  test('migration: an existing user with nothing saved gets the defaults; garbage too', () => {
    expect(parseLayout(undefined)).toEqual([...DEFAULT_LAYOUT]);
    expect(parseLayout('{not json')).toEqual([...DEFAULT_LAYOUT]);
    expect(parseLayout('42')).toEqual([...DEFAULT_LAYOUT]);
  });

  test('migration: a v0 bare array is read, unknown ids dropped, card first', () => {
    expect(parseLayout(JSON.stringify(['history', 'card', 'nope', 'history']))).toEqual(['card', 'history']);
  });

  test('round trip through v1', () => {
    const ids = ['card', 'history', 'askB'] as const;
    expect(JSON.parse(serialise(ids))).toEqual({ v: 1, ids: [...ids] });
    expect(parseLayout(serialise(ids))).toEqual([...ids]);
  });

  test('add appends once', () => {
    expect(addModule(['card', 'askB'], 'history')).toEqual(['card', 'askB', 'history']);
    expect(addModule(['card', 'askB'], 'askB')).toEqual(['card', 'askB']);
    expect(addModule(['askB'], 'card')).toEqual(['card', 'askB']);
  });

  test('remove, including the card', () => {
    expect(removeModule(['card', 'askB', 'showcase'], 'askB')).toEqual(['card', 'showcase']);
    expect(removeModule(['card', 'askB'], 'card')).toEqual(['askB']);
  });

  test('reorder: up and down, clamped, never above the card', () => {
    const ids = ['card', 'askB', 'showcase', 'history'] as const;
    expect(shiftModule(ids, 'history', -1)).toEqual(['card', 'askB', 'history', 'showcase']);
    expect(shiftModule(ids, 'askB', 1)).toEqual(['card', 'showcase', 'askB', 'history']);
    expect(shiftModule(ids, 'askB', -1)).toEqual([...ids]);
    expect(shiftModule(ids, 'history', 5)).toEqual([...ids]);
    expect(shiftModule(ids, 'card', 1)).toEqual([...ids]);
    expect(shiftModule(['askB', 'history'], 'history', -1)).toEqual(['history', 'askB']);
  });

  test('visible layout hides what a build does not allow, keeping order', () => {
    expect(visibleLayout(['card', 'showcase', 'history'], (id) => id !== 'showcase')).toEqual(['card', 'history']);
  });

  test('Desktop opens with the card alone (side pane has price, History, Holdings); a saved layout wins', () => {
    expect(WIDE_DEFAULT_LAYOUT).toEqual(['card']);
    expect(parseLayout(null, WIDE_DEFAULT_LAYOUT)).toEqual([...WIDE_DEFAULT_LAYOUT]);
    expect(parseLayout(serialise(['card', 'history']), WIDE_DEFAULT_LAYOUT)).toEqual(['card', 'history']);
  });

  test('normalise dedupes', () => {
    expect(normalise(['askB', 'askB', 'card'])).toEqual(['card', 'askB']);
  });
});

describe('Desktop classic home (19 Oct 2026)', () => {
  test('untouched old Desktop defaults move to the card alone', () => {
    expect(migrateWide(['card', 'askB', 'holdings', 'showcase'])).toEqual(['card']);
    expect(migrateWide(['card', 'askB', 'showcase'])).toEqual(['card']);
  });
  test('a layout the user arranged is kept', () => {
    expect(migrateWide(['card', 'showcase', 'askB'])).toEqual(['card', 'showcase', 'askB']);
    expect(migrateWide(['card', 'pots'])).toEqual(['card', 'pots']);
  });
});
