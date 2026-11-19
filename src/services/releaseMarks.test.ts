import { describe, expect, test } from 'bun:test';
import { createReleaseMarks, markReleases, NOT_YOURS, releasedBy, type ReleaseRecord } from './releaseMarks';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);
const ADMIN = 'wallet.admin';

describe('release marks (this device only, never synced): task 54 review, rounds 3 and 4', () => {
  test('kept across a reopen through the kv; a fresh device has none', async () => {
    let kept: ReleaseRecord | null = null;
    const kv = { load: async () => kept, save: async (r: ReleaseRecord) => void (kept = r) };
    const m = createReleaseMarks(kv);
    await m.release([A]);
    await m.hold(B, 'site.b');
    const again = createReleaseMarks(kv);
    await again.hydrate();
    expect([again.released(A), again.heldHere(B), again.owner(B), again.released(B)]).toEqual([
      true,
      true,
      'site.b',
      false,
    ]);
    expect(createReleaseMarks().released(A)).toBe(false);
  });

  test('releasedBy: sendWith always; noSendChange only for an action that goes out', () => {
    expect(releasedBy({ options: { sendWith: [A], noSendChange: [`${B}.1`] } })).toEqual([A, B]);
    expect(releasedBy({ options: { noSend: true, sendWith: [], noSendChange: [`${B}.1`] } })).toEqual([]);
    expect(releasedBy(undefined)).toEqual([]);
  });

  test('item 3: a release is in flight while its call runs and kept only when the call succeeds', async () => {
    const m = createReleaseMarks();
    const seen: boolean[] = [];
    await expect(
      m.inFlight([A], async () => {
        seen.push(m.released(A));
        throw new Error('broadcast failed');
      }),
    ).rejects.toThrow('broadcast failed');
    expect([seen[0], m.released(A)]).toEqual([true, false]);
    await m.inFlight([A], async () => undefined);
    expect(m.released(A)).toBe(true);
  });

  const wallet = (m: ReturnType<typeof createReleaseMarks>, next: { txid?: string; reference?: string }[]) => {
    const calls: string[] = [];
    const w = {
      createAction: async (args: { options?: { sendWith?: string[] } }) => {
        calls.push(`create:${(args.options?.sendWith ?? []).join(',')}`);
        const n = next.shift() ?? {};
        return n.reference ? { signableTransaction: { reference: n.reference } } : { txid: n.txid };
      },
      signAction: async () => {
        calls.push('sign');
        return { txid: next.shift()?.txid };
      },
    };
    markReleases(w, m, { admin: ADMIN });
    return { w, calls };
  };

  test('a noSend payment is held (one-step, and two-step as every site makes it); one that goes out is released', async () => {
    const m = createReleaseMarks();
    const { w } = wallet(m, [{ txid: A }, { reference: 'r1' }, { txid: B }, { txid: C }]);
    await w.createAction({ options: { noSend: true } } as never, ADMIN as never);
    await w.createAction({ options: { noSend: true, signAndProcess: false } } as never, 'site.a' as never);
    await w.signAction({ reference: 'r1', options: { noSend: true } } as never, 'site.a' as never);
    await w.createAction({} as never, 'site.a' as never);
    expect([m.heldHere(A), m.heldHere(B), m.owner(B), m.released(C), m.owner(C)]).toEqual([
      true,
      true,
      'site.a',
      true,
      'site.a',
    ]);
  });

  test("item 2: a site can't name in sendWith / noSendChange a payment the wallet or another site made; its own it can", async () => {
    const m = createReleaseMarks();
    await m.hold(A, ''); // the wallet's own noSend payment
    await m.hold(B, 'site.b');
    await m.hold(C, 'site.a');
    const { w, calls } = wallet(m, [{ txid: D }, { txid: D }]);
    for (const named of [A, B])
      await expect(
        w.createAction({ description: 'x', options: { sendWith: [named] } } as never, 'site.a' as never),
      ).rejects.toThrow(NOT_YOURS);
    await expect(w.createAction({ options: { noSendChange: [`${B}.0`] } } as never, 'site.a' as never)).rejects.toThrow(
      NOT_YOURS,
    );
    expect([calls, m.released(A), m.released(B)]).toEqual([[], false, false]);
    await w.createAction({ description: 'x', options: { sendWith: [C] } } as never, 'site.a' as never);
    expect(m.released(C)).toBe(true);
    // The wallet itself (its admin originator, or a call with none) may name any.
    await w.createAction({ options: { sendWith: [A] } } as never, ADMIN as never);
    expect(m.released(A)).toBe(true);
  });
});
