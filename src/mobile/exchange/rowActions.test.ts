import { describe, expect, test } from 'bun:test';
import {
  BUY_ANCHOR,
  ROW_ACTION_IDS,
  buyRoute,
  chatDecision,
  heldTokenIds,
  infoRoute,
  isMaskedHandle,
  movieActionIds,
  opnsActionIds,
  payTarget,
  peopleActionIds,
  podcastActionIds,
  profileRoute,
  txInfoUrl,
} from './rowActions';
import { lockAxis, resolveRelease, ACTION_W } from '../swipe/gesture';
import { tradeRoute } from './exchangeData';

const A = 'a'.repeat(64) + '_0';
const B = 'b'.repeat(64) + '_1';
const bal = (id: string, confirmed: bigint, pending = 0n) => ({ id, all: { confirmed, pending } });

describe('heldTokenIds', () => {
  test('keeps only positive balances, normalised', () => {
    const s = heldTokenIds([bal(A.toUpperCase().replace('_', '.'), 5n), bal(B, 0n)]);
    expect([...s]).toEqual([A]);
  });
  test('pending counts as held', () => expect(heldTokenIds([bal(B, 0n, 3n)]).has(B)).toBe(true));
  test('junk ids are ignored', () => expect(heldTokenIds([bal('PEPE', 10n)]).size).toBe(0));
});

describe('chatDecision', () => {
  test('holder opens the room directly', () =>
    expect(chatDecision(A, new Set([A]))).toEqual({ kind: 'open', roomKey: `bsv21:${A}` }));
  test('non-holder gets the hold-first hint', () => expect(chatDecision(B, new Set([A])).kind).toBe('hold-first'));
  test('matches on token ID, never ticker: same ticker, other ID is not held', () => {
    // Two "$PEPE" tokens: holding A says nothing about B.
    expect(chatDecision(B, heldTokenIds([bal(A, 1n)])).kind).toBe('hold-first');
    expect(chatDecision('PEPE', new Set(['PEPE'])).kind).toBe('hold-first');
  });
  test('id case and separator do not matter', () =>
    expect(chatDecision(A.toUpperCase().replace('_', '.'), new Set([A])).kind).toBe('open'));
  test('still loading', () => expect(chatDecision(A, null).kind).toBe('loading'));
});

describe('routes and actions', () => {
  test('Buy lands on the Buy panel, Info on the token page', () => {
    expect(buyRoute(A)).toBe(`${tradeRoute(A)}#${BUY_ANCHOR}`);
    expect(infoRoute(A)).toBe(tradeRoute(A));
  });
  test('tray order is Chat, Buy, Info', () => expect([...ROW_ACTION_IDS]).toEqual(['chat', 'buy', 'info']));
});

describe('swipe on token rows', () => {
  const L = { count: 3, hasFull: false };
  const R = { count: 0, hasFull: false };
  test('vertical scroll is not hijacked', () => expect(lockAxis(4, 20)).toBe('y'));
  test('a left swipe locks to x', () => expect(lockAxis(-20, 3)).toBe('x'));
  test('a short left swipe opens the three-button tray', () =>
    expect(resolveRelease({ offset: -ACTION_W * 2, width: 390, velocity: 0, left: L, right: R })).toBe('open-left'));
  test('no full-swipe commit: a long swipe still just opens', () =>
    expect(resolveRelease({ offset: -350, width: 390, velocity: -2, left: L, right: R })).toBe('open-left'));
  test('a tiny drag snaps closed', () =>
    expect(resolveRelease({ offset: -8, width: 390, velocity: 0, left: L, right: R })).not.toBe('open-left'));
});

describe('other Exchange lists', () => {
  test('people: Chat, Pay, Profile; masked handles get Chat only', () => {
    expect(peopleActionIds('kim')).toEqual(['chat', 'pay', 'profile']);
    expect(peopleActionIds('k•••.gmail')).toEqual(['chat']);
    expect(isMaskedHandle('')).toBe(true);
  });
  test('people routes', () => {
    expect(profileRoute('$kim')).toBe('/m/friends/kim');
    expect(payTarget('kim')).toBe('$kim');
  });
  test('txInfoUrl uses the outpoint txid; junk → null', () => {
    expect(txInfoUrl(A)).toBe(`https://whatsonchain.com/tx/${'a'.repeat(64)}`);
    expect(txInfoUrl('nope')).toBeNull();
    expect(txInfoUrl(null)).toBeNull();
  });
  test('opns: Buy only when buyable, Info when the outpoint is real; never an offer', () => {
    expect(opnsActionIds({ canBuy: true, outpoint: A })).toEqual(['buy', 'info']);
    expect(opnsActionIds({ canBuy: false, outpoint: A })).toEqual(['info']);
    expect(opnsActionIds({ canBuy: true, outpoint: 'x' })).toEqual(['buy']);
  });
  test('podcasts: each action needs a target', () => {
    expect(podcastActionIds({ playable: true, canBuy: true, origin: A })).toEqual(['play', 'buy', 'info']);
    expect(podcastActionIds({ playable: false, canBuy: false, origin: null })).toEqual([]);
  });
  test('movies: Chat only when the token ID is held (not the ticker)', () => {
    expect(movieActionIds(A, 2, new Set([A]))).toEqual(['back', 'clip', 'chat']);
    expect(movieActionIds(A, 0, new Set([B]))).toEqual(['back']);
    expect(movieActionIds(A, 1, null)).toEqual(['back', 'clip']);
  });
});
