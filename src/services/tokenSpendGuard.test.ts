import { describe, expect, test } from 'bun:test';
import { EMPTY_UNLOCK_MESSAGE } from '../utils/bsv21SendErrors';
import { EmptyUnlockError, guardTokenSpend, type KeyCheckFn } from './tokenSpendGuard';
import { hasTrackingId, withTrackingId } from './tokenSendHeal';
import { tokenOutputTags } from '../mobile/market/launchpad/tokens';

// F-3, 16 Oct 2026, 5.2.25.
const F3 =
  'inputs[0].unlockScript parameter must be valid. Script evaluation error: OP_DUP requires at least one item to be on the stack. PC: 8';

const recorder = () => {
  const calls: [string | undefined, boolean][] = [];
  const check: KeyCheckFn = async (id, fresh) => {
    calls.push([id, fresh]);
  };
  return { calls, check };
};

describe('guardTokenSpend', () => {
  test('checks the tokens being spent before the spend runs', async () => {
    const { calls, check } = recorder();
    const order: string[] = [];
    const r = await guardTokenSpend(
      async (id, fresh) => {
        order.push('check');
        await check(id, fresh);
      },
      ['t1', 't1', 't2'],
      async () => {
        order.push('spend');
        return 'ok';
      },
    );
    expect(r).toBe('ok');
    expect(calls).toEqual([
      ['t1', false],
      ['t2', false],
    ]);
    expect(order).toEqual(['check', 'check', 'spend']);
  });

  test('a thrown empty unlock: every token checked fresh, then exactly one retry', async () => {
    const { calls, check } = recorder();
    let n = 0;
    const r = await guardTokenSpend(check, 't1', async () => {
      if (n++ === 0) throw new Error(F3);
      return 'sent';
    });
    expect(r).toBe('sent');
    expect(n).toBe(2);
    expect(calls).toEqual([
      ['t1', false],
      [undefined, true],
    ]);
  });

  test('a returned empty unlock (sendBsv21 { error }) is retried once', async () => {
    const { check } = recorder();
    let n = 0;
    const r = await guardTokenSpend(check, 't1', async () => (n++ === 0 ? { error: F3 } : { txid: 'abc' }), {
      failure: (x: { error?: string }) => x.error,
      log: () => {},
    });
    expect(r).toEqual({ txid: 'abc' });
  });

  test('a second empty unlock stops: thrown -> EmptyUnlockError, returned -> the result', async () => {
    const { check } = recorder();
    let n = 0;
    await expect(
      guardTokenSpend(
        check,
        't1',
        async () => {
          n++;
          throw new Error(F3);
        },
        { log: () => {} },
      ),
    ).rejects.toBeInstanceOf(EmptyUnlockError);
    expect(n).toBe(2);
    expect(new EmptyUnlockError().message).toBe(EMPTY_UNLOCK_MESSAGE);
    const r = await guardTokenSpend(check, 't1', async () => ({ error: F3 }), {
      failure: (x) => x.error,
      log: () => {},
    });
    expect(r.error).toBe(F3);
  });

  test('other errors pass straight through, no retry', async () => {
    const { calls, check } = recorder();
    let n = 0;
    await expect(
      guardTokenSpend(check, 't1', async () => {
        n++;
        throw new Error('insufficient-valid-tokens');
      }),
    ).rejects.toThrow('insufficient-valid-tokens');
    expect(n).toBe(1);
    expect(calls.length).toBe(1);
  });

  test('a failing check never blocks the spend', async () => {
    const r = await guardTokenSpend(
      async () => {
        throw new Error('offline');
      },
      't1',
      async () => 1,
    );
    expect(r).toBe(1);
  });
});

describe('token records always carry an id: tag (the writer fix)', () => {
  test('tokenOutputTags: filter tag + a tracking tag, unique per output', () => {
    const a = tokenOutputTags('t_0');
    const b = tokenOutputTags('t_0');
    expect(a[0]).toBe('bsv21:t_0');
    expect(hasTrackingId(a)).toBe(true);
    expect(a[1]).toMatch(/^id:[0-9a-f]{16}_0$/);
    expect(a[1]).not.toBe(b[1]);
  });

  test('withTrackingId adds one only when missing', () => {
    expect(withTrackingId(['bsv21:x'], () => 'id:z_0')).toEqual(['bsv21:x', 'id:z_0']);
    expect(withTrackingId(['bsv21:x', 'id:y_1'], () => 'id:z_0')).toEqual(['bsv21:x', 'id:y_1']);
    expect(withTrackingId(undefined, () => 'id:z_0')).toEqual(['id:z_0']);
  });
});
