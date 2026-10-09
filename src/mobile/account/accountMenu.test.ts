import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearChatSessionFor,
  getPinned,
  getRecent,
  inlineAccounts,
  markAccountUsed,
  matchesQuery,
  orderAccounts,
  RECENT_LIMIT,
  splitAccounts,
  togglePinned,
  type MenuAccount,
} from './accountMenu';

const fake = (init: Record<string, string> = {}) => {
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

const acct = (id: string, name: string, handle = '', paymail = ''): MenuAccount => ({ id, name, handle, paymail });
const list = [
  acct('1', 'Zed', '$ZED', 'zed@bwalletx.com'),
  acct('2', 'alice', '$ALICE', 'alice.x@bwalletx.com'),
  acct('3', 'Bob', '', 'bobby@bwalletx.com'),
  acct('4', 'carol', '$CAROL'),
  acct('5', 'Dave'),
];
const ids = (xs: MenuAccount[]) => xs.map((x) => x.id);

describe('account search', () => {
  it('filters by name, handle or paymail, case-insensitive, $ ignored', () => {
    expect(matchesQuery(list[1], 'ALI')).toBe(true);
    expect(matchesQuery(list[1], '$alice')).toBe(true);
    expect(matchesQuery(list[2], 'bobby@')).toBe(true);
    expect(matchesQuery(list[3], 'zz')).toBe(false);
    expect(ids(orderAccounts(list, { query: 'bwalletx.com' }).rest)).toEqual(['2', '3', '1']);
    expect(ids(orderAccounts(list, { query: '   ' }).rest)).toHaveLength(5);
  });

  it('a search also filters recent and pinned', () => {
    const s = orderAccounts(list, { query: 'dave', recent: { '2': 5 }, pinned: ['1'] });
    expect([...s.pinned, ...s.recent, ...s.rest].map((a) => a.id)).toEqual(['5']);
  });
});

describe('recent ordering', () => {
  it('recent first (newest first), then the rest A–Z', () => {
    const s = orderAccounts(list, { recent: { '5': 100, '1': 300 } });
    expect(ids(s.recent)).toEqual(['1', '5']);
    expect(ids(s.rest)).toEqual(['2', '3', '4']);
  });

  it('pinned go above recent and are not repeated', () => {
    const s = orderAccounts(list, { recent: { '5': 100, '1': 300 }, pinned: ['1', '3'] });
    expect(ids(s.pinned)).toEqual(['3', '1']);
    expect(ids(s.recent)).toEqual(['5']);
    expect(ids(s.rest)).toEqual(['2', '4']);
  });

  it('caps the recent section', () => {
    const many = Array.from({ length: 12 }, (_, i) => acct(`a${i}`, `n${i}`));
    const recent = Object.fromEntries(many.map((a, i) => [a.id, i]));
    const s = orderAccounts(many, { recent });
    expect(s.recent).toHaveLength(RECENT_LIMIT);
    expect(s.recent[0].id).toBe('a11');
    expect(s.recent.length + s.rest.length).toBe(12);
  });

  it('stores last-used and pins', () => {
    const { ls } = fake();
    markAccountUsed('1', 10, ls);
    markAccountUsed('2', 20, ls);
    markAccountUsed('1', 30, ls);
    expect(getRecent(ls)).toEqual({ '1': 30, '2': 20 });
    expect(togglePinned('2', ls)).toEqual(['2']);
    expect(togglePinned('2', ls)).toEqual([]);
    expect(getPinned(ls)).toEqual([]);
  });
});

describe('agents excluded from the account switcher', () => {
  it('splits agent accounts out', () => {
    const agents = new Set(['2', '4']);
    const { people, agents: a } = splitAccounts(list, (id) => agents.has(id));
    expect(ids(people)).toEqual(['1', '3', '5']);
    expect(ids(a)).toEqual(['2', '4']);
  });
});

describe('sign out', () => {
  it('clears only the current account chat session', () => {
    const { m, ls } = fake({
      'bwallet.bchat.session:1A': 'a',
      'bwallet.bchat.session:1B': 'b',
      'bwallet.bchat.sessionVersion': '2',
    });
    clearChatSessionFor('1A', ls);
    expect([...m.keys()].sort()).toEqual(['bwallet.bchat.session:1B', 'bwallet.bchat.sessionVersion']);
  });

  it('the drawer confirms, signs out of chat, then locks', () => {
    const src = readFileSync(join(import.meta.dir, '../tabs/TopNav.tsx'), 'utf8');
    expect(src).toContain('signOut(current)');
    expect(src).not.toContain("'Lock wallet'");
    const menu = readFileSync(join(import.meta.dir, 'accountMenu.ts'), 'utf8');
    const fn = menu.slice(menu.indexOf('export const signOutAndLock'));
    expect(fn.indexOf('saveSession(null)')).toBeLessThan(fn.indexOf('lockWallet()'));
    expect(readFileSync(join(import.meta.dir, 'useMenuAccounts.ts'), 'utf8')).toContain('signOutAndLock(');
  });
});

describe('drawer inline accounts', () => {
  it('shows all of up to 4 accounts, no All accounts row', () => {
    expect(inlineAccounts(list.slice(0, 4), '3')).toEqual({ shown: list.slice(0, 4), more: false });
  });

  it('with more: current plus the 3 most recent, then the All accounts row', () => {
    const r = inlineAccounts(list, '5', { '1': 10, '2': 30, '3': 20, '5': 40 });
    expect(ids(r.shown)).toEqual(['5', '2', '3', '1']);
    expect(r.more).toBe(true);
  });

  it('fills A-Z when there is little history', () => {
    expect(ids(inlineAccounts(list, '1', {}).shown)).toEqual(['1', '2', '3', '4']);
  });
});

describe('sign out keeps the keys (D8)', () => {
  const memStore = (init: Record<string, string>) => {
    const m = new Map(Object.entries(init));
    return {
      m,
      s: {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
        clear: () => m.clear(),
        key: (i: number) => [...m.keys()][i] ?? null,
        get length() {
          return m.size;
        },
      } as Storage,
    };
  };

  it('signs this account out of chat and locks; the encrypted keys stay', async () => {
    const { signOutAndLock } = await import('./accountMenu');
    const keys = 'secure:chrome.storage.local:accounts';
    const { m, s } = memStore({
      [keys]: JSON.stringify({ A: { encryptedKeys: 'ciphertext' } }),
      'secure:chrome.storage.local:selectedAccount': '"A"',
      'bwallet.bchat.session:A': 'chat',
      'bwallet.bchat.session:B': 'other',
    });
    let locked = false;
    let session: unknown = 'x';
    await signOutAndLock('A', { saveSession: (v) => (session = v), lockWallet: async () => void (locked = true), store: s });
    expect(locked).toBe(true);
    expect(session).toBeNull();
    expect(m.get(keys)).toContain('ciphertext');
    expect(m.has('secure:chrome.storage.local:selectedAccount')).toBe(true);
    expect(m.has('bwallet.bchat.session:B')).toBe(true);
    expect(m.has('bwallet.bchat.session:A')).toBe(false);
    expect(true).toBe(true);
  });

  it('no Sign out path clears wallet storage (Settings, drawer)', () => {
    const settings = readFileSync(join(import.meta.dir, '../../pages/Settings.tsx'), 'utf8');
    const body = settings.slice(settings.indexOf('const signOut = async'), settings.indexOf('const handleCancel'));
    expect(body).toContain('signOutAndLock');
    expect(body).not.toMatch(/\.clear\(|SIGNED_OUT|deleteDatabase|wipeLocalWallet/);
    const hook = readFileSync(join(import.meta.dir, 'useMenuAccounts.ts'), 'utf8');
    expect(hook).not.toMatch(/\.clear\(|SIGNED_OUT|wipeLocalWallet|removeAccount/);
  });
});
