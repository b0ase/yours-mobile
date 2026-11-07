import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { ProtoWallet, PrivateKey } from '@bsv/sdk';
import {
  fundPaidSession,
  newSessionAction,
  PAID_LISTENING_PAUSED,
  PAID_LISTENING_PAUSED_NOTE,
  PaidListeningPaused,
  routeBudgetRequest,
  type BudgetRequest,
} from './paidListening';
import { openSponsoredSession } from './session';

/** A wallet that records every createAction (the call that would fund a session key). */
const spyWallet = () => {
  const proto = new ProtoWallet(PrivateKey.fromRandom());
  const calls: string[] = [];
  const wallet = {
    createHmac: (a: Parameters<ProtoWallet['createHmac']>[0]) => {
      calls.push('createHmac');
      return proto.createHmac(a);
    },
    getPublicKey: (a: Parameters<ProtoWallet['getPublicKey']>[0]) => {
      calls.push('getPublicKey');
      return proto.getPublicKey(a);
    },
    createAction: async () => {
      calls.push('createAction');
      throw new Error('createAction must not run');
    },
    internalizeAction: async () => {
      calls.push('internalizeAction');
      throw new Error('internalizeAction must not run');
    },
  };
  return { wallet, calls };
};

describe('paid listening paused (owner, 2 Nov 2026)', () => {
  test('the flag is on and the note says why and what still plays', () => {
    expect(PAID_LISTENING_PAUSED).toBe(true);
    expect(PAID_LISTENING_PAUSED_NOTE).toBe(
      'Paid listening is paused while we move to the new pay-as-you-listen model. Tracks 1–6 play free.',
    );
  });

  // Every way the budget sheet used to open: PayToPlay, a tap on a paid track, "continue" after the pot runs out,
  // and the top-up when the budget is used up.
  const requests: [string, BudgetRequest][] = [
    ['pay-to-play track reached', { track: 6, from: 0 }],
    ['tap on a paid track', { track: 7 }],
    ['continue after the sponsor ran out', { track: 3, from: 42 }],
    ['top-up when out', { track: 8, from: 10, topUp: true }],
  ];
  for (const [name, req] of requests) {
    test(`paused: ${name} shows the note, never the sheet`, () => {
      const seen: string[] = [];
      routeBudgetRequest(req, { showPaused: () => seen.push('note'), openSheet: () => seen.push('sheet') });
      expect(seen).toEqual(['note']);
    });
  }

  test('not paused: the sheet opens with the same request (the normal flow, for when it comes back)', () => {
    const opened: BudgetRequest[] = [];
    routeBudgetRequest(
      { track: 7, from: 3, topUp: true },
      { showPaused: () => opened.push({ track: -1 }), openSheet: (r) => opened.push(r) },
      false,
    );
    expect(opened).toEqual([{ track: 7, from: 3, topUp: true }]);
  });

  test('paused: funding a paid session rejects before the wallet is asked (no createAction, no session key)', async () => {
    const { wallet, calls } = spyWallet();
    let opened = 0;
    const open = (async () => {
      opened++;
      throw new Error('openSession must not run');
    }) as unknown as Parameters<typeof fundPaidSession>[3];
    await expect(fundPaidSession(wallet, 1000, true, open)).rejects.toBeInstanceOf(PaidListeningPaused);
    await expect(fundPaidSession(wallet, 1000)).rejects.toBeInstanceOf(PaidListeningPaused);
    expect(opened).toBe(0);
    expect(calls).toEqual([]);
  });

  test('not paused: funding goes to openSession as before', async () => {
    const { wallet } = spyWallet();
    const seen: number[] = [];
    const open = (async (_w: unknown, b: number) => {
      seen.push(b);
      return { id: 'x' };
    }) as unknown as Parameters<typeof fundPaidSession>[3];
    await fundPaidSession(wallet, 1234, false, open);
    expect(seen).toEqual([1234]);
  });

  test('a sponsored track still starts a sponsored session; a paid one shows the note', () => {
    expect(newSessionAction('sponsored')).toBe('sponsored');
    expect(newSessionAction('sponsored', true)).toBe('sponsored');
    expect(newSessionAction('perSecond')).toBe('paused');
    expect(newSessionAction('perSecond', false)).toBe('budget');
  });

  test('sponsored sessions are unaffected: no funding, no createAction', async () => {
    const { wallet, calls } = spyWallet();
    const { id, key } = await openSponsoredSession(wallet);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(key.toPublicKey().toString()).toMatch(/^0[23]/);
    expect(calls).not.toContain('createAction');
  });
});

describe('paid listening paused: StreamAlbum wiring', () => {
  const src = readFileSync(new URL('./StreamAlbum.tsx', import.meta.url), 'utf8');
  /** Whitespace-insensitive: Prettier may wrap these lines. */
  const flat = src.replace(/\s+/g, ' ');

  test('no direct openSession: paid funding only goes through fundPaidSession', () => {
    expect(src).not.toMatch(/\bopenSession\(/);
    expect(src).toContain('fundPaidSession(wallet, budget)');
  });

  test('every budget request goes through the gate', () => {
    // setSheetRaw(x) with a request only inside the gate's openSheet; onFunded routes through it too.
    const raw = src.match(/setSheetRaw\((?!null\))[^)]*\)/g) ?? [];
    expect(raw).toEqual(['setSheetRaw(req)', 'setSheetRaw(req)']);
    expect(src).toContain('routeBudgetRequest(x, {');
    expect(src).toContain('routeBudgetRequest(f, { showPaused, openSheet: setSheetRaw })');
    expect(src).toContain('{sheet && m && !PAID_LISTENING_PAUSED && (');
  });

  test('a paid track tap and the sponsor running out show the note', () => {
    expect(flat).toContain("next === 'paused' ? showPaused()");
    expect(src).toContain('if (PAID_LISTENING_PAUSED) showPaused();');
    expect(src).toContain('{PAID_LISTENING_PAUSED_NOTE}');
  });

  test('sponsored playback path is unchanged (openSponsoredSession, no budget)', () => {
    expect(src).toContain('await openSponsoredSession(wallet)');
    expect(flat).toContain("next === 'sponsored' ? void startSponsored(index)");
  });
});
