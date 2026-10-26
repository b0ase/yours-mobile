import { describe, expect, it } from 'bun:test';
import { payForCharges } from '../chat/roomSpend';
import { approveListen, checkListenPlan, payPlan, shouldPay, type ListenPlan, type PaidConfig } from './paidListen';

// b-Aware 26 Oct 2026: paid listening signed whatever plan the server sent.
const A = '1BjTE7Az3eUWQn4K56SxHJUwwy6zoHYp5g';
const B = '13WRxSgUYReyawKo2gbRvKHhDEYb29Xd3K';
const EVIL = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const TOKEN = 'aa'.repeat(32) + '_0';

const plan = (charges: ListenPlan['charges']): ListenPlan => ({
  v: 1,
  ticker: 'LOUNGE',
  spaceId: 'sp1',
  payer: 'alice',
  minute: 3,
  body: 'space-listen:sp1:3',
  rule: 'space-listen',
  charges,
  issuedAt: 1,
});
const bsvCfg: PaidConfig = {
  enabled: true,
  amount: 0.01,
  per: 'minute',
  currency: { kind: 'bsv' },
  dest: 'stage',
  hostSharePct: 0,
  freeFirstMinute: true,
};
const approved = plan([
  { unit: 'sats', amount: '300', to: A },
  { unit: 'sats', amount: '200', to: B },
]);

describe('paid listening: (a) payees are the ones the listener approved', () => {
  it('payForCharges refuses a payee that was not approved, before the wallet is touched', async () => {
    let touched = false;
    const ctx = {
      wallet: new Proxy({}, { get: () => ((touched = true), () => Promise.reject(new Error('signed'))) }),
    } as never;
    await expect(
      payForCharges(ctx, {
        ticker: 'LOUNGE',
        handle: 'alice',
        text: 'x',
        charge: {
          rule: 'space-listen',
          charges: [{ unit: 'sats', amount: '500', to: EVIL }],
          unenforced: null,
          exempt: false,
        },
        approvedPayees: [A, B],
      }),
    ).rejects.toThrow('Payment refused');
    expect(touched).toBe(false);
  });

  it('payPlan never signs a plan whose payee changed after approval', async () => {
    const approval = approveListen(bsvCfg, approved, BigInt(100_000));
    let signed = false;
    const deps = {
      payForMessage: async () => ((signed = true), { beef: 'b', txid: 't' }),
      releasePayment: async () => undefined,
    };
    const client = { spacePaid: async () => ({}), spacePaidAction: async () => ({}) };
    const swapped = plan([{ unit: 'sats', amount: '500', to: EVIL }]);
    await expect(payPlan({} as never, client, swapped, 'sig', approval, deps)).rejects.toThrow('Payment refused');
    expect(signed).toBe(false);
    await payPlan({} as never, client, approved, 'sig', approval, deps);
    expect(signed).toBe(true);
  });

  it('issuer plans pay only the issuer address the sheet named', () => {
    const cfg: PaidConfig = { ...bsvCfg, dest: 'issuer', issuerAddress: A };
    const a = approveListen(cfg, plan([{ unit: 'sats', amount: '100', to: A }]), BigInt(1000));
    expect(() => checkListenPlan(plan([{ unit: 'sats', amount: '100', to: B }]), a)).toThrow('Payment refused');
  });
});

describe('paid listening: (b) the session limit is in one unit', () => {
  const approval = () => approveListen(bsvCfg, approved, BigInt(1_000_000));

  it('a token line against a BSV limit is refused, not summed', () => {
    const tokenPlan = plan([{ unit: 'token', tokenId: TOKEN, amount: '1', to: A }]);
    expect(() => checkListenPlan(tokenPlan, approval())).toThrow('Payment refused');
    expect(
      shouldPay({ approval: approval(), plan: tokenPlan, paidThrough: null, now: 0, spent: BigInt(0), busy: false }),
    ).toBe('refuse');
  });

  it('a token plan for a different token is refused', () => {
    const cfg: PaidConfig = { ...bsvCfg, currency: { kind: 'bsv21', tokenId: TOKEN, sym: 'PNEE', dec: 2 } };
    const a = approveListen(cfg, plan([{ unit: 'token', tokenId: TOKEN, amount: '5', to: A }]), BigInt(500));
    const other = plan([{ unit: 'token', tokenId: 'bb'.repeat(32) + '_0', amount: '5', to: A }]);
    expect(() => checkListenPlan(other, a)).toThrow('Payment refused');
  });

  it('refuses a plan with no cap (zero limit) or no floor (empty or zero lines)', () => {
    expect(() => approveListen(bsvCfg, approved, BigInt(0))).toThrow('Payment refused');
    expect(() => checkListenPlan(plan([]), approval())).toThrow('Payment refused');
    expect(() => checkListenPlan(plan([{ unit: 'sats', amount: '0', to: A }]), approval())).toThrow('Payment refused');
    expect(() => checkListenPlan(plan([{ unit: 'sats', amount: '-5', to: A }]), approval())).toThrow('Payment refused');
  });
});
