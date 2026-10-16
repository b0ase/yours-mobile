import { describe, expect, test } from 'bun:test';
import { maxOverlayFee, tokenSendProblem, withTokenSendGuard } from './tokenFee';

const FEE = 'feescript';
const tokenOut = { lockingScript: 'tok', satoshis: 1 };

describe('BSV-21 send fee', () => {
  test('max fee: one charge per recipient output plus change', () => {
    expect(maxOverlayFee('1Fee', 10, 2)).toEqual({ address: '1Fee', sats: 30 });
    expect(maxOverlayFee('', 10, 2)).toBeNull();
    expect(maxOverlayFee('1Fee', 0, 2)).toBeNull();
  });

  test('token outputs, a note and the confirmed fee pass', () => {
    const outs = [
      tokenOut,
      tokenOut,
      { lockingScript: 'op_return', satoshis: 0 },
      { lockingScript: FEE, satoshis: 20 },
    ];
    expect(tokenSendProblem(outs, { feeScript: FEE, maxSats: 30 })).toBeNull();
  });

  test('an unconfirmed payee, a second fee or a higher fee is refused', () => {
    expect(
      tokenSendProblem([tokenOut, { lockingScript: 'other', satoshis: 20 }], { feeScript: FEE, maxSats: 30 }),
    ).toMatch(/did not confirm/);
    expect(tokenSendProblem([{ lockingScript: FEE, satoshis: 5 }], null)).toMatch(/did not confirm/);
    const twice = [
      { lockingScript: FEE, satoshis: 5 },
      { lockingScript: FEE, satoshis: 5 },
    ];
    expect(tokenSendProblem(twice, { feeScript: FEE, maxSats: 30 })).toMatch(/did not confirm/);
    expect(tokenSendProblem([{ lockingScript: FEE, satoshis: 31 }], { feeScript: FEE, maxSats: 30 })).toMatch(
      /went up/,
    );
  });

  test('the guard blocks createAction before it reaches the wallet', async () => {
    let called = 0;
    const w = withTokenSendGuard({ createAction: async () => ++called, other: () => 'ok' }, null);
    expect(w.other()).toBe('ok');
    await w.createAction({ outputs: [tokenOut] } as never);
    expect(called).toBe(1);
    expect(() => w.createAction({ outputs: [{ lockingScript: 'x', satoshis: 99 }] } as never)).toThrow();
    expect(called).toBe(1);
  });
});
