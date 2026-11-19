import { describe, expect, test } from 'bun:test';
import { createReleaseMarks, markReleases, releasedBy, type ReleaseRecord } from './releaseMarks';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

describe('task 54 round 3: release marks (this device only, never synced)', () => {
  test('kept across a reopen through the kv; a fresh device has none', async () => {
    let kept: ReleaseRecord | null = null;
    const kv = { load: async () => kept, save: async (r: ReleaseRecord) => void (kept = r) };
    const m = createReleaseMarks(kv);
    await m.release([A]);
    await m.arm(B);
    const again = createReleaseMarks(kv);
    await again.hydrate();
    expect([again.released(A), again.armed(B), again.released(B)]).toEqual([true, true, false]);
    expect(createReleaseMarks().released(A)).toBe(false);
  });

  test('releasedBy: sendWith always; noSendChange only for an action that goes out', () => {
    expect(releasedBy({ options: { sendWith: [A], noSendChange: [`${B}.1`] } })).toEqual([A, B]);
    expect(releasedBy({ options: { noSend: true, sendWith: [], noSendChange: [`${B}.1`] } })).toEqual([]);
    expect(releasedBy(undefined)).toEqual([]);
  });

  test('markReleases: a payment that goes out is released, a noSend one is not, sendWith releases before the call', async () => {
    const m = createReleaseMarks();
    const seen: boolean[] = [];
    const wallet = {
      createAction: async (args: { options?: { noSend?: boolean; sendWith?: string[] } }) => {
        seen.push(m.released(A));
        return { txid: args.options?.noSend ? B : C };
      },
      signAction: async () => ({ txid: A.replace(/a/g, 'd') }),
    };
    markReleases(wallet, m);
    await wallet.createAction({ options: { noSend: true } });
    expect(m.released(B)).toBe(false); // withheld: held here until released
    await wallet.createAction({ options: { sendWith: [A] } });
    expect(seen).toEqual([false, true]); // released before the broadcast inside the call
    expect(m.released(C)).toBe(true); // a payment that goes out
    await wallet.signAction();
    expect(m.released('d'.repeat(64))).toBe(false); // signAction can't tell a noSend: never released by it
  });
});
