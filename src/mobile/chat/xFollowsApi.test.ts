import { describe, expect, it } from 'bun:test';
import { ChatApiError } from './api';
import {
  absoluteUrl,
  filterUnmatched,
  parseUnmatched,
  blockedReason,
  estimateLines,
  explainError,
  FOLLOWS_PATH,
  IMPORT_PATH,
  ESTIMATE_PATH,
  parseEstimate,
  parseResult,
  XFollowsApi,
} from './xFollowsApi';
import { addMatch, inviteNote, openReauth } from '../wallet/XFollowsImport';
import { hasInvitePrefill, requestInvitePrefill, takeInvitePrefill } from './xInvites';

const est = {
  accounts: 850,
  estimated_usd: 8.5,
  usd_per_account: 0.01,
  max_per_import: 1000,
  capped: false,
  allowed: true,
  reason: 'ok',
  following_count: 850,
  cooldown_until: null,
  has_scope: false,
  reauth_url: '/api/auth/twitter?scope=follows&next=%2F',
};

describe('X follows import client', () => {
  it('parses the estimate and resolves the reauth link against bit-sign', () => {
    const e = parseEstimate(est);
    expect(e.accounts).toBe(850);
    expect(e.hasScope).toBe(false);
    expect(e.reauthUrl).toBe('https://www.bitcoinchat.online/api/auth/twitter?scope=follows&next=%2F');
    expect(absoluteUrl('javascript:alert(1)')).toBeNull();
    expect(absoluteUrl('http://evil.example/x')).toBeNull();
  });

  it('says accounts, cost, cap and cooldown in plain words', () => {
    const lines = estimateLines(
      parseEstimate({ ...est, following_count: 4200, accounts: 1000, estimated_usd: 10, capped: true }),
    );
    expect(lines).toContain('You follow 4,200 accounts on X.');
    expect(lines.join(' ')).toContain('look up 1,000 of them. X charges about $10.00');
    expect(lines).toContain('One import covers up to 1,000 accounts.');
    expect(lines).toContain('You can import once every 30 days.');
    const cool = parseEstimate({
      ...est,
      allowed: false,
      accounts: 0,
      reason: 'cooldown',
      cooldown_until: '2026-11-15T00:00:00Z',
    });
    expect(blockedReason(cool)).toContain('Next one on');
    expect(blockedReason(parseEstimate({ ...est, allowed: false, reason: 'monthly_cap_reached' }))).toContain(
      'full for this month',
    );
    expect(blockedReason(parseEstimate(est))).toBeNull();
  });

  it('cleans matches: bare lowercase handles, no duplicates, no junk', () => {
    const r = parseResult({
      imported: 10,
      matched: [
        { handle: '$Mike', x_username: '@mike_x' },
        { handle: 'mike', x_username: 'dupe' },
        { handle: 'bad handle!', x_username: 'x' },
        null,
      ],
      capped: false,
      last_import_at: '2026-10-16T00:00:00Z',
    });
    expect(r.matched).toEqual([{ handle: 'mike', xUsername: 'mike_x' }]);
    expect(parseResult(null)).toEqual({ imported: 0, matched: [], unmatched: [], capped: false, lastImportAt: null });
  });

  it('turns every refusal into a plain message', () => {
    const err = (status: number, data: unknown = null) => explainError(new ChatApiError('x', status, data));
    expect(err(404, { code: 'disabled' }).kind).toBe('disabled');
    expect(err(401).kind).toBe('signed_out');
    expect(err(409, { code: 'no_x' }).kind).toBe('no_x');
    const scope = err(409, { code: 'scope_missing', reauth_url: 'https://www.bitcoinchat.online/api/auth/twitter' });
    expect(scope).toEqual({
      kind: 'scope',
      message: 'Allow X to share who you follow, then come back and try again.',
      reauthUrl: 'https://www.bitcoinchat.online/api/auth/twitter',
    });
    expect(err(429, { code: 'cooldown', cooldown_until: '2026-11-15T00:00:00Z' }).kind).toBe('cooldown');
    expect(err(429, { code: 'monthly_cap_reached' }).kind).toBe('cap');
    expect(err(429, { code: 'monthly_cap_disabled' }).kind).toBe('cap');
    expect(err(402)).toEqual({ kind: 'payment', message: 'Paying for the import is coming soon.' });
    expect(err(502).kind).toBe('x_down');
  });

  it('calls the four routes', async () => {
    const calls: string[] = [];
    const api = new XFollowsApi(async (m, p) => {
      calls.push(`${m} ${p}`);
      return m === 'GET' && p === ESTIMATE_PATH ? est : { imported: 1, matched: [{ handle: 'a', x_username: 'a' }] };
    });
    expect((await api.estimate()).accounts).toBe(850);
    expect((await api.runImport()).matched.length).toBe(1);
    await api.result();
    await api.remove();
    expect(calls).toEqual([
      `GET ${ESTIMATE_PATH}`,
      `POST ${IMPORT_PATH}`,
      `GET ${FOLLOWS_PATH}`,
      `DELETE ${FOLLOWS_PATH}`,
    ]);
  });

  it('opens the X page in the system browser on the phone, a new tab on the web', () => {
    const opened: string[] = [];
    openReauth('https://x', true, (u, t) => opened.push(`${u} ${t}`));
    openReauth('https://x', false, (u, t) => opened.push(`${u} ${t}`));
    expect(opened).toEqual(['https://x _system', 'https://x _blank']);
  });

  it('adds a match as a friend through its bWalletX paymail', async () => {
    const added: unknown[] = [];
    const paymail = await addMatch(
      { handle: 'mike', xUsername: 'mike_x' },
      async (n) => `${n}@bwalletx.com`,
      async (raw) => ({ key: '02ab', label: raw }),
      async (p) => void added.push(p),
    );
    expect(paymail).toBe('mike@bwalletx.com');
    expect(added).toEqual([{ key: '02ab', name: 'mike@bwalletx.com' }]);
    await expect(addMatch({ handle: 'nobody', xUsername: '' }, async () => null)).rejects.toThrow(
      'no bWalletX paymail',
    );
  });

  it('parses the people not on bChatX and searches them', () => {
    const u = parseUnmatched([
      { x_username: '@Alice', x_id: '1' },
      { x_username: 'alice', x_id: '1' },
      { x_username: 'bad name', x_id: '2' },
      { x_username: 'bob_99', x_id: '3' },
    ]);
    expect(u).toEqual([
      { xUsername: 'Alice', xId: '1' },
      { xUsername: 'bob_99', xId: '3' },
    ]);
    expect(parseUnmatched(Array.from({ length: 1200 }, (_, i) => ({ x_username: `u${i}` }))).length).toBe(1000);
    expect(filterUnmatched(u, '@ALI').map((x) => x.xUsername)).toEqual(['Alice']);
    expect(filterUnmatched(u, '  ').length).toBe(2);
    expect(parseResult({ unmatched: [{ x_username: 'z', x_id: '9' }] }).unmatched).toEqual([
      { xUsername: 'z', xId: '9' },
    ]);
  });

  it('hands the chosen @handles to your room Invites, one batch at a time', () => {
    requestInvitePrefill(Array.from({ length: 60 }, (_, i) => `u${i}`));
    expect(hasInvitePrefill()).toBe(true);
    const first = takeInvitePrefill();
    expect(first.length).toBe(50);
    expect(first[0]).toBe('u0');
    expect(takeInvitePrefill().length).toBe(10);
    expect(hasInvitePrefill()).toBe(false);
    expect(takeInvitePrefill()).toEqual([]);
    expect(inviteNote(3)).toContain('show the cost and ask you once');
    expect(inviteNote(60)).toContain('first 50');
  });
});
