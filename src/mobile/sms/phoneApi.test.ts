import { describe, expect, it } from 'bun:test';
import { ChatApiError } from '../chat/api';
import { PhoneApi, normE164, parseMatches, parsePhone, type Caller } from './phoneApi';

const rec = (reply: unknown | ((p: string) => unknown)) => {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const call: Caller = async (method, path, body) => {
    calls.push({ method, path, body });
    const r = typeof reply === 'function' ? (reply as (p: string) => unknown)(path) : reply;
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, api: new PhoneApi(call) };
};

describe('phoneApi', () => {
  it('normalises numbers like bit-sign', () => {
    expect(normE164('07700 900123')).toBe('+447700900123');
    expect(normE164('+44 (7700) 900-123')).toBe('+447700900123');
    expect(normE164('0044 7700 900123')).toBe('+447700900123');
    expect(normE164('hello')).toBeNull();
  });

  it('503 sms_disabled hides the feature', async () => {
    const { api } = rec(new ChatApiError('sms_disabled', 503));
    expect(await api.available()).toBeNull();
  });

  it('reads my phone', async () => {
    const { api } = rec({ phone: { last4: '0123', masked: '•••• 0123', discoverable: true } });
    expect(await api.available()).toEqual({ phone: { last4: '0123', masked: '•••• 0123', discoverable: true } });
    expect(parsePhone({ phone: null })).toBeNull();
  });

  it('match sends normalised, deduped numbers and keeps only bWalletX paymails', async () => {
    const { api, calls } = rec({
      matches: [
        { e164: '+447700900123', paymail: 'alice@bwalletx.com' },
        { e164: '+1', paymail: 'x@evil.com' },
      ],
    });
    const m = await api.match(['07700 900123', '+447700900123', 'junk']);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/api/bitsign/me/phone/lookup',
      body: { numbers: ['+447700900123'] },
    });
    expect(m).toEqual([{ e164: '+447700900123', paymail: 'alice@bwalletx.com' }]);
    expect(parseMatches({})).toEqual([]);
  });

  it('createDrop body is built field by field', async () => {
    const { api, calls } = rec({ ok: true, code: 'abcdefghijkl' });
    await api.createDrop({
      to: '+447700900123',
      funded_address: '1A',
      funding_txid: 'ab'.repeat(32),
      beef: 'beef',
      amount_sats: 2000,
      wif: 'Kwif',
    });
    expect(Object.keys(calls[0].body!).sort()).toEqual([
      'amount_sats',
      'beef',
      'fragment',
      'funded_address',
      'funding_txid',
      'to',
    ]);
    expect(calls[0].body!.fragment).toBe(`k=Kwif&t=${'ab'.repeat(32)}`);
  });

  it('verify / remove paths', async () => {
    const { api, calls } = rec({ ok: true, phone: { last4: '0123' } });
    expect(await api.verify(' 123456 ')).toMatchObject({ last4: '0123' });
    await api.remove();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/bitsign/me/phone/verify',
      'DELETE /api/bitsign/me/phone',
    ]);
    expect(calls[0].body).toEqual({ code: '123456' });
  });
});
