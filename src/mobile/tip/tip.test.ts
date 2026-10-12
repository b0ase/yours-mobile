import { describe, expect, test } from 'bun:test';
import { QUEUED_MESSAGE } from '../../services/repeatGuard';
import { runTip, STILL_SENDING } from './flow';
import {
  TIP_EVENT,
  TIP_LOG_KEY,
  TIP_MIN_SATS,
  TipLock,
  fiatToTipSats,
  isSelf,
  nftCreator,
  normName,
  parseFiatInput,
  presetLabel,
  presetSats,
  readTipLog,
  recordTip,
  tipAmountError,
  tipRoute,
  type TipRecord,
} from './tip';

const USD = { currency: 'USD' as const, usdPerUnit: 1 };
const GBP = { currency: 'GBP' as const, usdPerUnit: 1.25 };
const KEY = '02' + 'ab'.repeat(32);
const ME = {
  identityKey: KEY,
  address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
  names: ['b0asex', 'b0asex@bwalletx.com'],
};

describe('tip amount conversion', () => {
  test('presets in display currency convert to sats at the BSV price', () => {
    // $50/BSV: $1 = 2,000,000 sats; £1 at 1.25 USD/GBP = $1.25 = 2,500,000 sats.
    expect(fiatToTipSats(1, USD, 50)).toBe(2_000_000);
    expect(fiatToTipSats(1, GBP, 50)).toBe(2_500_000);
    expect(fiatToTipSats(0.1, GBP, 50)).toBe(250_000);
    expect(presetSats(GBP, 50)).toEqual([250_000, 1_250_000, 2_500_000, 12_500_000]);
  });
  test('never under dust; unknown price falls back to sats presets', () => {
    expect(fiatToTipSats(0.0000001, USD, 50)).toBe(TIP_MIN_SATS);
    expect(fiatToTipSats(1, USD, 0)).toBeNull();
    expect(presetSats(USD, 0)).toEqual([2_000, 10_000, 20_000, 100_000]);
  });
  test('labels', () => {
    expect([0.1, 0.5, 1, 5].map((p) => presetLabel(p, GBP))).toEqual(['10p', '50p', '£1', '£5']);
    expect([0.1, 1].map((p) => presetLabel(p, USD))).toEqual(['10¢', '$1']);
  });
  test('typed amounts and limits', () => {
    expect(parseFiatInput('£2.50')).toBe(2.5);
    expect(parseFiatInput('1.234')).toBeNull();
    expect(parseFiatInput('0')).toBeNull();
    expect(tipAmountError(null)).toBeTruthy();
    expect(tipAmountError(100)).toBeTruthy();
    expect(tipAmountError(1_000)).toBeNull();
    expect(tipAmountError(200_000_000)).toBeTruthy();
  });
});

describe("can't tip yourself", () => {
  test('same key, address or $handle is self', () => {
    expect(isSelf({ name: 'x', identityKey: KEY.toUpperCase().replace('0X', '0x') }, ME)).toBe(true);
    expect(isSelf({ name: 'x', address: ME.address }, ME)).toBe(true);
    expect(isSelf({ name: '$B0aseX', paymail: '$b0asex' }, ME)).toBe(true);
    expect(isSelf({ name: 'x', paymail: 'b0asex@bwalletx.com' }, ME)).toBe(true);
  });
  test('others are not; a plain display name never matches', () => {
    expect(isSelf({ name: '$vexvoid', paymail: '$vexvoid' }, ME)).toBe(false);
    expect(isSelf({ name: 'b0asex', address: '1111111111111111111114oLvT2' }, ME)).toBe(false);
    expect(normName('$VexVoid')).toBe('vexvoid');
  });
});

describe('route', () => {
  test('identity key first, then paymail, then address', () => {
    expect(tipRoute({ name: 'a', identityKey: KEY, paymail: '$a' })).toEqual({ kind: 'identity', to: KEY });
    expect(tipRoute({ name: 'a', paymail: '$a', address: ME.address })).toEqual({ kind: 'paymail', to: '$a' });
    expect(tipRoute({ name: 'a', address: ME.address })).toEqual({ kind: 'address', to: ME.address });
    expect(tipRoute({ name: 'a', identityKey: 'nope' })).toBeNull();
  });
  test('nft creator only from tags, never the holder', () => {
    expect(nftCreator(['creator:$vexvoid'])).toEqual({ name: '$vexvoid', paymail: '$vexvoid' });
    expect(nftCreator([`creatorKey:${KEY}`])?.identityKey).toBe(KEY);
    expect(nftCreator(['name:Thing'])).toBeNull();
    expect(nftCreator(undefined)).toBeNull();
  });
});

describe('sheet flow (runTip)', () => {
  const route = { kind: 'paymail' as const, to: '$vexvoid' };
  const base = { route, name: '$vexvoid', label: '£1', context: { kind: 'artist' as const, artist: 'vexvoid' } };

  test('sends once, records, toasts "Sent £1 to $vexvoid"', async () => {
    const recs: TipRecord[] = [];
    let calls = 0;
    const out = await runTip({
      ...base,
      sats: 2_500,
      lock: new TipLock(),
      now: () => 7,
      record: (r) => void recs.push(r),
      send: async () => {
        calls++;
        return { txid: 'a'.repeat(64), pending: false };
      },
    });
    expect(out).toEqual({ ok: true, toast: 'Sent £1 to $vexvoid', kind: 'success', txid: 'a'.repeat(64) });
    expect(calls).toBe(1);
    expect(recs[0]).toMatchObject({ v: 1, at: 7, sats: 2_500, to: '$vexvoid', route: 'paymail' });
  });

  test('a second Send while the first is going out is refused; failures are not retried', async () => {
    const lock = new TipLock();
    let release!: () => void;
    let calls = 0;
    const send = () => {
      calls++;
      return new Promise<{ txid: string; pending: boolean }>((res) => {
        release = () => res({ txid: 'b'.repeat(64), pending: false });
      });
    };
    const first = runTip({ ...base, sats: 2_500, lock, record: () => {}, send });
    const second = await runTip({ ...base, sats: 2_500, lock, record: () => {}, send });
    expect(second).toEqual({ ok: false, error: STILL_SENDING });
    release();
    expect((await first).ok).toBe(true);
    const failed = await runTip({
      ...base,
      sats: 2_500,
      lock,
      record: () => {},
      send: async () => {
        calls++;
        throw new Error('Insufficient funds');
      },
    });
    expect(failed).toEqual({ ok: false, error: 'Insufficient funds' });
    expect(calls).toBe(2);
  });

  test('queued (slow network) says do not pay again', async () => {
    const out = await runTip({
      ...base,
      sats: 2_500,
      lock: new TipLock(),
      record: () => {},
      send: async () => ({ txid: 'c'.repeat(64), pending: true }),
    });
    expect(out).toMatchObject({ ok: true, kind: 'info', toast: QUEUED_MESSAGE });
  });

  test('bad amount never calls send', async () => {
    let called = false;
    const out = await runTip({
      ...base,
      sats: 10,
      send: async () => {
        called = true;
        return { txid: '', pending: false };
      },
    });
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('record', () => {
  test('log is capped and an event goes out', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const events: string[] = [];
    const target = { dispatchEvent: (e: Event) => (events.push(e.type), true) };
    const rec: TipRecord = {
      v: 1,
      at: 1,
      txid: 'd',
      sats: 1000,
      to: '$x',
      route: 'paymail',
      context: { kind: 'person' },
    };
    for (let i = 0; i < 205; i++) recordTip({ ...rec, at: i }, store, target);
    expect(readTipLog(store).length).toBe(200);
    expect(readTipLog(store)[0].at).toBe(204);
    expect(mem.has(TIP_LOG_KEY)).toBe(true);
    expect(events.length).toBe(205);
    expect(events[0]).toBe(TIP_EVENT);
  });
});
