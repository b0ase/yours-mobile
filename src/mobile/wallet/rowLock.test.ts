import { describe, expect, it } from 'bun:test';
import { BACK_PNEE_ROUTE } from '../notes/backPnee';
import { BSV_LOCK_ROUTE, lockRouteFor } from './rowLock';

describe('row Lock routes', () => {
  it('BSV opens the Lock BSV screen, never Settings', () => {
    expect(lockRouteFor('bsv', { backPneeLive: false })).toBe('/m/lock');
    expect(lockRouteFor('bsv', { backPneeLive: true })).toBe(BSV_LOCK_ROUTE);
  });
  it('PNEEs open Back PNEEs only where it is live', () => {
    expect(lockRouteFor('pnee', { backPneeLive: true })).toBe(BACK_PNEE_ROUTE);
    expect(lockRouteFor('pnee', { backPneeLive: false })).toBeNull();
  });
});
