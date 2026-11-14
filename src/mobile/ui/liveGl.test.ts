import { describe, expect, test } from 'bun:test';
import { loseAllGl } from './liveGl';

describe('liveGl: an account switch drops live WebGL contexts before reloading', () => {
  test('every registered context is lost and forgotten; an already-lost one does not stop the rest', () => {
    const lost: string[] = [];
    const ctx = (name: string, throws = false) =>
      ({
        getExtension: () => ({
          loseContext: () => {
            if (throws) throw new Error('already lost');
            lost.push(name);
          },
        }),
      }) as unknown as WebGLRenderingContext;
    const set = new Set([ctx('a'), ctx('b', true), ctx('c')]);
    loseAllGl(set);
    expect(lost).toEqual(['a', 'c']);
    expect(set.size).toBe(0);
  });
});
