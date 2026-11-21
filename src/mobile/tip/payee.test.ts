import { describe, expect, mock, test } from 'bun:test';
import { NOT_VERIFIED_NOTE, type Resolved } from '../names/names';
import { PAYEE_CHANGED, payeeChanged, payeeFromResolved, previewPayee, tipName, type TipPayee } from './payee';
import { sendTip } from './send';
import type { TipRoute } from './tip';

/**
 * b-Aware rows 84, 348, 351, 234 (cluster baware:unverified-payee): a tip must show where the money goes, carry the
 * "not verified" state the sheet showed, and refuse at send time when the name now resolves somewhere else.
 */

const K1 = '02' + '11'.repeat(32);
const K2 = '03' + '22'.repeat(32);
const ATTACKER = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const HOST_ADDR = '1KFHE7w8BhaENAswwryaoccDb6qcT6DbYY';

const ours = (over: Partial<Resolved> = {}): Resolved => ({
  input: '$alice',
  target: 'alice@bwalletx.com',
  targetKind: 'paymail',
  via: 'p2p-paymail',
  pubkey: K1,
  nameBinding: 'signed',
  ...over,
});
const external = (over: Partial<Resolved> = {}): Resolved => ({
  input: 'alice@handcash.io',
  target: 'alice@handcash.io',
  targetKind: 'paymail',
  via: 'p2p-paymail',
  pubkey: K2,
  external: 'handcash.io',
  ...over,
});
const basicAddress = (over: Partial<Resolved> = {}): Resolved => ({
  input: 'bob@oldhost.io',
  target: HOST_ADDR,
  targetKind: 'address',
  via: 'paymail-address',
  external: 'oldhost.io',
  ...over,
});

const PM = (to: string): TipRoute => ({ kind: 'paymail', to });

describe('what the tip sheet shows (b)', () => {
  test('a bWalletX name the wallet can check shows as its $handle, verified', () => {
    const p = payeeFromResolved(PM('$alice'), ours());
    expect(p.shown).toBe('$alice');
    expect(p.check).toBe('verified');
    expect(p.notes).not.toContain(NOT_VERIFIED_NOTE);
  });
  test('an outside paymail shows in full with the not-verified note', () => {
    const p = payeeFromResolved(PM('alice@handcash.io'), external());
    expect(p.shown).toBe('alice@handcash.io');
    expect(p.check).toBe('unverified');
    expect(p.notes).toContain(NOT_VERIFIED_NOTE);
    expect(p.detail).toContain('outside');
  });
  test('a host-served address is shown, and marked not verified', () => {
    const p = payeeFromResolved(PM('bob@oldhost.io'), basicAddress());
    expect(p.detail).toContain(HOST_ADDR);
    expect(p.check).toBe('unverified');
    expect(p.notes).toContain(NOT_VERIFIED_NOTE);
  });
  test('a plain address route shows the address itself', () => {
    const p = payeeFromResolved({ kind: 'address', to: ATTACKER });
    expect(p.shown).toBe(ATTACKER);
    expect(p.check).toBe('address');
  });
  test('an identity-key tip shows the key', () => {
    const p = payeeFromResolved({ kind: 'identity', to: K1 });
    expect(p.check).toBe('key');
    expect(p.detail).toContain(K1.slice(0, 6));
  });
  test('a name the resolver refuses never becomes a payee', async () => {
    const out = await previewPayee(PM('$alice'), async () => ours({ nameBinding: 'changed' }));
    expect(out.ok).toBe(false);
  });
});

describe('a $name the payee does not prove (b, row 351)', () => {
  test('"$alice" paying a bare address is labelled not verified', () => {
    const payee = payeeFromResolved({ kind: 'address', to: ATTACKER });
    expect(tipName({ name: '$alice', address: ATTACKER }, payee)).toBe('$alice (not verified)');
  });
  test('"$alice" proven by the resolved name stays as is', () => {
    const payee = payeeFromResolved(PM('$alice'), ours());
    expect(tipName({ name: '$alice', paymail: '$alice' }, payee)).toBe('$alice');
  });
  test('"$alice" resolving to another name is not proven', () => {
    const payee = payeeFromResolved(PM('$mallory'), ours({ input: '$mallory', target: 'mallory@bwalletx.com' }));
    expect(tipName({ name: '$alice', paymail: '$mallory' }, payee)).toBe('$alice (not verified)');
  });
  test('a plain display name is left alone', () => {
    const payee = payeeFromResolved({ kind: 'address', to: ATTACKER });
    expect(tipName({ name: 'Vex Void', address: ATTACKER }, payee)).toBe('Vex Void');
  });
});

describe('send time re-check (d, row 234)', () => {
  test('same answer: no change', () => {
    const shown = payeeFromResolved(PM('$alice'), ours());
    expect(payeeChanged(shown, ours())).toBeNull();
  });
  test('a different key, route or target is a change', () => {
    const shown = payeeFromResolved(PM('$alice'), ours());
    expect(payeeChanged(shown, ours({ pubkey: K2 }))).toBe(PAYEE_CHANGED);
    expect(payeeChanged(shown, ours({ via: 'paymail-address', targetKind: 'address', target: HOST_ADDR }))).toBe(
      PAYEE_CHANGED,
    );
    expect(payeeChanged(shown, ours({ target: 'mallory@bwalletx.com' }))).toBe(PAYEE_CHANGED);
  });
  test('a verified name that is no longer verified is a change', () => {
    const shown = payeeFromResolved(PM('alice@bwalletx.com'), ours());
    expect(payeeChanged(shown, ours({ external: 'bwalletx.com' }))).toBe(PAYEE_CHANGED);
  });
});

type Req = { paymail?: string; address?: string; satoshis: number };
const fakeSend = () =>
  mock(async (_ctx: unknown, input: { requests: Req[]; requireVerified?: boolean }) => ({
    txid: 'ab'.repeat(32),
    input,
  }));
const CTX = {} as never;

describe('sendTip (a, row 348)', () => {
  test('a name the sheet showed as verified is paid with requireVerified', async () => {
    const send = fakeSend();
    const shown = payeeFromResolved(PM('$alice'), ours());
    await sendTip(CTX, PM('$alice'), 1000, '$alice', '', shown, { resolve: async () => ours(), send });
    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0][1];
    expect(input.requireVerified).toBe(true);
    expect(input.requests[0].paymail).toBe('alice@bwalletx.com');
  });
  test('with nothing shown, a paymail tip is strict', async () => {
    const send = fakeSend();
    await sendTip(CTX, PM('alice@handcash.io'), 1000, 'x', '', undefined, { resolve: async () => external(), send });
    expect(send.mock.calls[0][1].requireVerified).toBe(true);
  });
  test('an outside paymail the sheet marked not verified is paid as shown', async () => {
    const send = fakeSend();
    const shown = payeeFromResolved(PM('alice@handcash.io'), external());
    await sendTip(CTX, PM('alice@handcash.io'), 1000, 'x', '', shown, { resolve: async () => external(), send });
    expect(send.mock.calls[0][1].requireVerified).toBeFalsy();
  });
  test('a name that changed since the sheet opened is refused, nothing sent (d)', async () => {
    const send = fakeSend();
    const shown = payeeFromResolved(PM('$alice'), ours());
    await expect(
      sendTip(CTX, PM('$alice'), 1000, '$alice', '', shown, { resolve: async () => ours({ pubkey: K2 }), send }),
    ).rejects.toThrow(PAYEE_CHANGED);
    expect(send).not.toHaveBeenCalled();
  });
  test('a host-served address pays the address the sheet showed', async () => {
    const send = fakeSend();
    const shown = payeeFromResolved(PM('bob@oldhost.io'), basicAddress());
    await sendTip(CTX, PM('bob@oldhost.io'), 1000, 'x', '', shown, {
      resolve: async () => basicAddress({ target: ATTACKER }),
      send,
    });
    expect(send.mock.calls[0][1].requests[0].address).toBe(HOST_ADDR);
  });
  test('an address route pays only the address the sheet showed', async () => {
    const send = fakeSend();
    const shown: TipPayee = payeeFromResolved({ kind: 'address', to: HOST_ADDR });
    await expect(
      sendTip(CTX, { kind: 'address', to: ATTACKER }, 1000, 'x', '', shown, { resolve: async () => ours(), send }),
    ).rejects.toThrow(PAYEE_CHANGED);
    expect(send).not.toHaveBeenCalled();
  });
});
