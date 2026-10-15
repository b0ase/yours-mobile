import { describe, expect, test } from 'bun:test';
import { ChatApiError } from './api';
import { InvitesApi, createBody, forwardWarning, revokeBody, sweptBody, type Caller } from './invitesApi';
import { addressOf, newInviteKey } from './xInvites';

const recorder = (reply: (path: string) => unknown) => {
  const calls: { method: string; path: string; body?: unknown; auth?: boolean }[] = [];
  const call: Caller = async (method, path, body, auth) => {
    calls.push({ method, path, body, auth });
    const r = reply(path);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, api: new InvitesApi(call) };
};

describe('invites API', () => {
  test('keys are never in any payload', async () => {
    const keys = [newInviteKey(), newInviteKey()];
    // Local records carry the key; the API must copy only the two allowed fields.
    const local = keys.map((k, i) => ({ x_handle: `h${i}`, funded_address: addressOf(k), wif: k.toWif() }));
    const { calls, api } = recorder((p) =>
      p.endsWith('/x-invites')
        ? {
            invites: local.map((l, i) => ({
              code: `c${i}`,
              x_handle: l.x_handle,
              funded_address: l.funded_address,
              url_base: `https://www.bchatx.com/i/x/c${i}`,
            })),
          }
        : { ok: true },
    );
    await api.create('SCAMMERSCARTEL', local, 'ab'.repeat(32), 'beef');
    await api.revoke('SCAMMERSCARTEL', 'c0', 'cd'.repeat(32));
    await api.verify('c1');
    await api.swept('c1', 'ef'.repeat(32));
    const sent = JSON.stringify(calls);
    for (const k of keys) {
      expect(sent).not.toContain(k.toWif());
      expect(sent).not.toContain(k.toHex());
    }
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/api/bitsign/rooms/SCAMMERSCARTEL/x-invites' });
    expect((calls[0].body as { invites: object[] }).invites[0]).toEqual({
      x_handle: 'h0',
      funded_address: local[0].funded_address,
    });
    expect(calls[1].path).toBe('/api/bitsign/rooms/SCAMMERSCARTEL/x-invites/c0/revoke');
    expect(calls[2].path).toBe('/api/bitsign/x-invites/c1/verify');
    expect(calls[3]).toMatchObject({ path: '/api/bitsign/x-invites/c1/swept', body: { txid: 'ef'.repeat(32) } });
  });

  test('body builders copy only known fields', () => {
    const b = createBody([{ x_handle: 'a', funded_address: '1x', wif: 'L1' } as never], 't', 'b');
    expect(Object.keys(b.invites[0]).sort()).toEqual(['funded_address', 'x_handle']);
    expect(sweptBody('t')).toEqual({ txid: 't' });
    expect(revokeBody(null)).toEqual({});
  });

  test('not a host (403) or not deployed (404) hides the entry', async () => {
    for (const status of [403, 404]) {
      const { api } = recorder(() => new ChatApiError('no', status));
      expect(await api.list('SCAMMERSCARTEL')).toBeNull();
    }
    const { api } = recorder(() => ({
      invites: [{ code: 'c', x_handle: '@Bob', status: 'swept', claimed_by: 'bob' }],
    }));
    expect(await api.list('SCAMMERSCARTEL')).toEqual([
      { code: 'c', x_handle: 'Bob', status: 'swept', claimed_by: 'bob', created_at: null },
    ]);
  });

  test('public lookup is unauthenticated', async () => {
    const { calls, api } = recorder(() => ({
      room: { ticker: 'SCAMMERSCARTEL', name: 'Scammers Cartel', icon: null },
      x_handle: 'alice',
      status: 'open',
    }));
    expect((await api.lookup('c'))?.room.ticker).toBe('SCAMMERSCARTEL');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/api/public/x-invites/c', auth: false });
  });
});

describe('server confirmations (15 Oct)', () => {
  test('public lookup carries the gate symbol', async () => {
    const { api } = recorder(() => ({
      room: { ticker: 'SCAMMERSCARTEL', name: null, icon: null, gate_symbol: '$SCAM' },
      x_handle: 'a',
      status: 'open',
    }));
    expect((await api.lookup('c'))?.room.gate_symbol).toBe('SCAM');
  });

  test('verify: 401 signed out; 403 x_mismatch / x_not_linked → sign in with X; other 403 refused', async () => {
    const run = async (e: unknown) => recorder(() => e).api.verify('c');
    expect(await run(new ChatApiError('no', 401))).toEqual({ ok: false, reason: 'signed_out' });
    expect(await run(new ChatApiError('no', 403, { code: 'x_mismatch' }))).toEqual({ ok: false, reason: 'x' });
    expect(await run(new ChatApiError('no', 403, { code: 'x_not_linked' }))).toEqual({ ok: false, reason: 'x' });
    expect(await run(new ChatApiError('Revoked', 403, { code: 'revoked' }))).toEqual({
      ok: false,
      reason: 'refused',
      message: 'Revoked',
    });
    expect(await run({ ok: true })).toEqual({ ok: true });
  });
});

test('claim warning names the gate token', () => {
  expect(forwardWarning('SCAM')).toBe("Whoever opens this link can take the 1 SCAM it holds, so don't forward it.");
  expect(forwardWarning(null)).toContain('the 1 token it holds');
});
