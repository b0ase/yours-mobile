import { describe, expect, test } from 'bun:test';
import {
  addable,
  addToDock,
  cleanDock,
  DEFAULT_DOCK,
  defaultDock,
  DOCK_MAX,
  OLD_DEFAULT_DOCK,
  moveInDock,
  normaliseDock,
  removeFromDock,
  serialiseDock,
  splitDock,
  type DockItem,
} from './dockModel';
import { stripFor } from './screens';

const app = (n: number): DockItem => ({ kind: 'app', url: `https://app${n}.example`, name: `App ${n}` });

describe('phone dock model', () => {
  test('default: Wallet · Exchange · (b) · Feed · Chat, Wallet leftmost (the safeguard: Send/Receive is on Wallet)', () => {
    expect(normaliseDock(null, false)).toEqual(defaultDock(false));
    expect(DEFAULT_DOCK[0]).toEqual({ kind: 'screen', id: 'wallet' });
    const { left, right } = splitDock(defaultDock(false));
    expect(left).toEqual([
      { kind: 'screen', id: 'wallet' },
      { kind: 'screen', id: 'exchange' },
    ]);
    expect(right).toEqual([
      { kind: 'screen', id: 'feed' },
      { kind: 'screen', id: 'chat' },
    ]);
  });

  test('store default: Wallet · Apps · (b) · Feed · Chat, no Exchange', () => {
    const d = normaliseDock(null, true);
    expect(d).toEqual([
      { kind: 'screen', id: 'wallet' },
      { kind: 'screen', id: 'apps' },
      { kind: 'screen', id: 'feed' },
      { kind: 'screen', id: 'chat' },
    ]);
    expect(d).not.toContainEqual({ kind: 'screen', id: 'exchange' });
  });

  test('migration: a saved dock equal to the old default becomes the new default', () => {
    const saved = serialiseDock([...OLD_DEFAULT_DOCK]);
    expect(normaliseDock(saved, false)).toEqual(defaultDock(false));
    expect(normaliseDock(saved, true)).toEqual(defaultDock(true));
  });

  test('migration: a customised dock is never touched', () => {
    const reordered = [OLD_DEFAULT_DOCK[1], OLD_DEFAULT_DOCK[0], OLD_DEFAULT_DOCK[2], OLD_DEFAULT_DOCK[3]];
    expect(normaliseDock(serialiseDock(reordered), false)).toEqual(reordered);
    const plusApp = [...OLD_DEFAULT_DOCK, app(1)];
    expect(normaliseDock(serialiseDock(plusApp), false)).toEqual(plusApp);
    const fewer = OLD_DEFAULT_DOCK.slice(0, 3);
    expect(normaliseDock(serialiseDock(fewer), false)).toEqual(fewer);
  });

  test('corrupt or wrong-version JSON falls back to the default', () => {
    expect(normaliseDock('{nope', false)).toEqual([...DEFAULT_DOCK]);
    expect(normaliseDock('{"v":2,"items":[]}', false)).toEqual([...DEFAULT_DOCK]);
    expect(normaliseDock('null', false)).toEqual([...DEFAULT_DOCK]);
  });

  test('an empty saved dock stays empty', () => {
    expect(normaliseDock(serialiseDock([]), false)).toEqual([]);
  });

  test('round-trips through storage', () => {
    const items: DockItem[] = [{ kind: 'screen', id: 'games' }, app(1)];
    expect(normaliseDock(serialiseDock(items), false)).toEqual(items);
  });

  test('unknown and duplicate items are dropped', () => {
    const raw = [
      { kind: 'screen', id: 'wallet' },
      { kind: 'screen', id: 'wallet' },
      { kind: 'screen', id: 'agent' },
      { kind: 'action', id: 'scan' },
      { kind: 'app', url: 'javascript:alert(1)', name: 'x' },
      app(1),
      app(1),
      42,
      null,
    ];
    expect(cleanDock(raw, false)).toEqual([{ kind: 'screen', id: 'wallet' }, app(1)]);
  });

  test('cap: four slots (plus the fixed b); the 5th is refused', () => {
    const many = Array.from({ length: 20 }, (_, i) => app(i));
    // An old saved dock (up to 12) is kept, never trimmed to 4.
    expect(cleanDock(many, false)).toHaveLength(12);
    const full = many.slice(0, DOCK_MAX);
    const r = addToDock(full, app(99), false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('full');
    expect(r.items).toHaveLength(DOCK_MAX);
  });

  test('add, remove, move', () => {
    let items = removeFromDock(defaultDock(false), { kind: 'screen', id: 'chat' });
    const a = addToDock(items, { kind: 'screen', id: 'games' }, false);
    expect(a.ok).toBe(true);
    items = a.items;
    expect(items.at(-1)).toEqual({ kind: 'screen', id: 'games' });
    expect(addToDock(items, { kind: 'screen', id: 'games' }, false).ok).toBe(false);
    items = moveInDock(items, items.length - 1, 0);
    expect(items[0]).toEqual({ kind: 'screen', id: 'games' });
    for (const i of [...items]) items = removeFromDock(items, i);
    expect(items).toEqual([]);
  });

  test('a full default dock refuses a fifth item', () => {
    const r = addToDock(defaultDock(false), { kind: 'screen', id: 'games' }, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('full');
  });

  test('store build: Exchange is dropped from a saved dock and cannot be added', () => {
    const saved = serialiseDock([
      { kind: 'screen', id: 'exchange' },
      { kind: 'screen', id: 'wallet' },
    ]);
    expect(normaliseDock(saved, true)).toEqual([{ kind: 'screen', id: 'wallet' }]);
    expect(normaliseDock(saved, false)).toHaveLength(2);
    const r = addToDock([], { kind: 'screen', id: 'exchange' }, true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('blocked');
  });

  test('add sheet offers only what is not in the dock, from the build strip', () => {
    const choices = addable(defaultDock(true), stripFor(true, false));
    expect(choices).not.toContainEqual({ kind: 'screen', id: 'wallet' });
    expect(choices).not.toContainEqual({ kind: 'screen', id: 'exchange' });
    expect(choices).toContainEqual({ kind: 'screen', id: 'games' });
    expect(addable([], stripFor(false, true))).toContainEqual({ kind: 'action', id: 'sendReceive' });
  });
});
