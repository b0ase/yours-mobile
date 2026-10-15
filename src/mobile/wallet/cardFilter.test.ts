import { describe, expect, test } from 'bun:test';
import { cardForView, filterForCard, PNEE_ROW_ID, rowMatchesCoin } from './cardFilter';
import { PNEE_TOKEN_ID } from '../notes/pnee';
import { getListCoin, getWalletKind, setWalletKind, setWalletView, subscribeWalletKind } from './walletKind';
import { clearFocusedToken, getFocusedToken, hasFocusHost, registerFocusHost, setFocusedToken } from './cardFocus';

const ALL = ['bsv', 'tokens', 'btickets', 'bshares', 'bcredits', 'mnee', 'pnee', 'topup'];
const STORE = ['bsv', 'tokens', 'mnee', 'pnee', 'topup'];

describe('filterForCard', () => {
  test('each card maps to its list', () => {
    expect(filterForCard('bsv')).toEqual({ kind: 'tokens', coin: null });
    expect(filterForCard('tokens')).toEqual({ kind: 'tokens', coin: null });
    expect(filterForCard('btickets')).toEqual({ kind: 'tickets', coin: null });
    expect(filterForCard('bcredits')).toEqual({ kind: 'credits', coin: null });
    expect(filterForCard('bshares')).toEqual({ kind: 'shares', coin: null });
    expect(filterForCard('mnee')).toEqual({ kind: 'tokens', coin: 'mnee' });
    expect(filterForCard('pnee')).toEqual({ kind: 'tokens', coin: 'pnee' });
    expect(filterForCard('topup')).toEqual({ kind: 'tokens', coin: null });
    expect(filterForCard('tok-abc_0')).toEqual({ kind: 'tokens', coin: null });
  });
});

describe('cardForView', () => {
  test('chips land on the matching card', () => {
    expect(cardForView({ kind: 'tickets', coin: null }, ALL, 'bsv')).toBe(2);
    expect(cardForView({ kind: 'credits', coin: null }, ALL, 'bsv')).toBe(4);
    expect(cardForView({ kind: 'shares', coin: null }, ALL, 'bsv')).toBe(3);
    expect(cardForView({ kind: 'tokens', coin: null }, ALL, 'btickets')).toBe(0);
    expect(cardForView({ kind: 'tokens', coin: null }, ALL, 'mnee')).toBe(0);
    expect(cardForView({ kind: 'tokens', coin: 'pnee' }, ALL, 'bsv')).toBe(6);
  });
  test('stays put when the current card already shows the view', () => {
    expect(cardForView({ kind: 'tokens', coin: null }, ALL, 'bsv')).toBeNull();
    expect(cardForView({ kind: 'tokens', coin: null }, ALL, 'tokens')).toBeNull();
    expect(cardForView({ kind: 'tokens', coin: null }, ALL, 'topup')).toBeNull();
    expect(cardForView({ kind: 'tokens', coin: 'mnee' }, ALL, 'mnee')).toBeNull();
  });
  test('views with no card, or cards not in this build, stay put', () => {
    expect(cardForView({ kind: 'nfts', coin: null }, ALL, 'bsv')).toBeNull();
    expect(cardForView({ kind: 'friends', coin: null }, ALL, 'btickets')).toBeNull();
    expect(cardForView({ kind: 'tickets', coin: null }, STORE, 'bsv')).toBeNull();
    expect(cardForView({ kind: 'credits', coin: null }, STORE, 'bsv')).toBeNull();
    expect(cardForView({ kind: 'shares', coin: null }, STORE, 'bsv')).toBeNull();
  });
});

describe('rowMatchesCoin', () => {
  test('PNEE id matches notes/pnee', () => expect(PNEE_ROW_ID).toBe(PNEE_TOKEN_ID));
  test('no coin keeps every row', () => {
    for (const id of ['bsv', 'mnee', 'pnee', PNEE_ROW_ID, 'abc_0']) expect(rowMatchesCoin(id, null)).toBe(true);
  });
  test('a coin keeps only its own row', () => {
    expect(rowMatchesCoin('mnee', 'mnee')).toBe(true);
    expect(rowMatchesCoin('bsv', 'mnee')).toBe(false);
    expect(rowMatchesCoin(PNEE_ROW_ID, 'mnee')).toBe(false);
    expect(rowMatchesCoin('pnee', 'pnee')).toBe(true);
    expect(rowMatchesCoin(PNEE_ROW_ID, 'pnee')).toBe(true);
    expect(rowMatchesCoin('mnee', 'pnee')).toBe(false);
    expect(rowMatchesCoin('abc_0', 'pnee')).toBe(false);
  });
});

describe('wallet view store', () => {
  test('chips clear the coin; coin only applies to Tokens', () => {
    let n = 0;
    const off = subscribeWalletKind(() => n++);
    setWalletView('tokens', 'mnee');
    expect([getWalletKind(), getListCoin()]).toEqual(['tokens', 'mnee']);
    setWalletKind('tokens');
    expect(getListCoin()).toBeNull();
    setWalletView('tickets', 'pnee');
    expect([getWalletKind(), getListCoin()]).toEqual(['tickets', null]);
    const before = n;
    setWalletKind('tickets');
    expect(n).toBe(before);
    setWalletKind('tokens');
    off();
  });
});

describe('card focus', () => {
  test('a row only populates the card while a carousel is mounted', () => {
    expect(hasFocusHost()).toBe(false);
    const off = registerFocusHost();
    expect(hasFocusHost()).toBe(true);
    setFocusedToken({ id: 'a_0', name: 'A', icon: '', amount: '1 A', onSend: () => {} });
    expect(getFocusedToken()?.id).toBe('a_0');
    clearFocusedToken();
    expect(getFocusedToken()).toBeNull();
    setFocusedToken({ id: 'b_0', name: 'B', icon: '', amount: '1 B', onSend: () => {} });
    off();
    expect(hasFocusHost()).toBe(false);
    expect(getFocusedToken()).toBeNull();
  });
});
