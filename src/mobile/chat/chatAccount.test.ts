import { describe, expect, it } from 'bun:test';
import { resetChatSessionsOnce, SESSION_VERSION_KEY } from './chatAccount';

const fake = (init: Record<string, string>) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    ls: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    } as unknown as Storage,
  };
};

describe('one-time chat session reset', () => {
  it('drops every stored bChat session (all accounts) once, keeps other keys', () => {
    const { m, ls } = fake({
      'bwallet.bchat.session': 'legacy',
      'bwallet.bchat.session:1Gmail': 'b0asex-token',
      'bwallet.bchat.session:1B0asex': 'tok',
      'bwallet.avatar.1Gmail': 'x',
    });
    expect(resetChatSessionsOnce(ls)).toBe(true);
    expect([...m.keys()].sort()).toEqual(['bwallet.avatar.1Gmail', SESSION_VERSION_KEY].sort());
    m.set('bwallet.bchat.session:1Gmail', 'fresh');
    expect(resetChatSessionsOnce(ls)).toBe(false);
    expect(m.get('bwallet.bchat.session:1Gmail')).toBe('fresh');
  });
});
