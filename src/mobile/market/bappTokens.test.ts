import { describe, expect, test } from 'bun:test';
import { isBappToken, unlaunchedBapps } from './bappTokens';

describe('bApp tokens', () => {
  test('matches by token id only', () => {
    const ids = new Set(['abc_0']);
    expect(isBappToken('abc_0', ids)).toBe(true);
    expect(isBappToken('abc_1', ids)).toBe(false);
  });
  test('lists bApps that have no token yet', () => {
    const apps = [{ name: 'bMail' }, { name: 'bDrive' }];
    expect(unlaunchedBapps(apps, [{ app: 'bmail', ticker: 'BMAIL', tokenId: 'x_0' }])).toEqual([{ name: 'bDrive' }]);
  });
});
