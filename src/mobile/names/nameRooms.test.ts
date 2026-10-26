import { describe, expect, test } from 'bun:test';
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as { window?: unknown }).window ??= globalThis;
(globalThis as { Event?: unknown }).Event ??= class {};
import { ensureNameRoom, getNameRooms, orderNameRooms, withNameRoom } from './nameRooms';

describe('one free room per name, primary first', () => {
  test('orders the primary first', () => {
    const rooms = [
      { alias: 'b0ase', ticker: 'B0ASE' },
      { alias: 'rboase2020', ticker: 'RBOASE', primary: true },
    ];
    expect(orderNameRooms(rooms).map((r) => r.alias)).toEqual(['rboase2020', 'b0ase']);
    expect(orderNameRooms(rooms, 'b0ase').map((r) => r.alias)).toEqual(['b0ase', 'rboase2020']);
  });
  test('a new primary takes the flag from the old one', () => {
    const r = withNameRoom([{ alias: 'a', ticker: 'A', primary: true }], { alias: 'b', ticker: 'B', primary: true });
    expect(r.filter((x) => x.primary).map((x) => x.alias)).toEqual(['b']);
  });
  test('creates through the free open-room call once, invite-only, then reuses it', async () => {
    const calls: unknown[] = [];
    const client = {
      createOpenRoom: async (b: { name: string; visibility: string }) => {
        calls.push(b);
        return { ticker: 'RB', name: b.name, invite_code: null };
      },
    };
    const id = `t${Date.now()}`;
    const first = await ensureNameRoom(client, id, 'rboase2020', true);
    const again = await ensureNameRoom(client, id, 'rboase2020', true);
    expect(first.ticker).toBe('RB');
    expect(again.ticker).toBe('RB');
    expect(calls).toEqual([{ name: '$rboase2020', description: "rboase2020's room", visibility: 'invite' }]);
    expect(getNameRooms(id).length).toBe(1);
  });
});
