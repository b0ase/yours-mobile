import { describe, expect, test } from 'bun:test';
import {
  DUPLICATE_WARNING,
  MARK_ATTR,
  SEEN_KEY,
  duplicateWarningOnce,
  markAndDetect,
  mergeMark,
} from './duplicateExtension';

const memStore = () => {
  const m: Record<string, unknown> = {};
  return {
    m,
    get: async (k: string) => ({ [k]: m[k] }),
    set: async (v: Record<string, unknown>) => void Object.assign(m, v),
  };
};
const fakeDoc = () => {
  const attrs: Record<string, string> = {};
  return {
    documentElement: {
      getAttribute: (k: string) => attrs[k] ?? null,
      setAttribute: (k: string, v: string) => void (attrs[k] = v),
    },
    attrs,
  } as unknown as Document & { attrs: Record<string, string> };
};

describe('duplicate extension detection', () => {
  test('mergeMark', () => {
    expect(mergeMark(null, 'a')).toEqual({ next: 'a', others: [] });
    expect(mergeMark('b', 'a')).toEqual({ next: 'b a', others: ['b'] });
    expect(mergeMark('a b', 'a').others).toEqual(['b']);
  });
  test('both extensions see each other (second check catches a later script)', async () => {
    const doc = fakeDoc();
    const sa = memStore();
    const sb = memStore();
    let laterA: () => void = () => undefined;
    markAndDetect(doc, 'A', sa, (f) => (laterA = f));
    markAndDetect(doc, 'B', sb, () => undefined);
    laterA();
    await Promise.resolve();
    expect((doc as unknown as { attrs: Record<string, string> }).attrs[MARK_ATTR]).toBe('A B');
    expect((sa.m[SEEN_KEY] as { ids: string[] }).ids).toEqual(['B']);
    expect((sb.m[SEEN_KEY] as { ids: string[] }).ids).toEqual(['A']);
  });
  test('alone: nothing recorded, no warning', async () => {
    const s = memStore();
    markAndDetect(fakeDoc(), 'A', s, (f) => f());
    expect(await duplicateWarningOnce(s)).toBeNull();
  });
  test('warns once per detection', async () => {
    const s = memStore();
    s.m[SEEN_KEY] = { ids: ['B'], at: Date.now() - 10 };
    expect(await duplicateWarningOnce(s)).toBe(DUPLICATE_WARNING);
    expect(await duplicateWarningOnce(s)).toBeNull();
  });
});
