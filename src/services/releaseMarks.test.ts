import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import {
  createReleaseMarks,
  markReleases,
  NOT_YOURS,
  releasedBy,
  watchSigned,
  type ReleaseRecord,
} from './releaseMarks';

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

  /** The toolbox's error after the action reached storage, as its class builds it (name WERR_REVIEW_ACTIONS). */
  const reviewError = (txid: string, extra: object = {}) =>
    Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
      name: 'WERR_REVIEW_ACTIONS',
      txid,
      ...extra,
    });

  test('round 5 (3): a send that reached storage and then threw (results require review) keeps its marks', async () => {
    const m = createReleaseMarks();
    const w = {
      createAction: async () => {
        m.noteSigned(C); // this device's signer handed C to storage (watchSigned)
        throw reviewError(C, { sendWithResults: [{ txid: A, status: 'failed' }] });
      },
    };
    markReleases(w, m, { admin: ADMIN });
    await expect(w.createAction({ options: { sendWith: [A] } } as never)).rejects.toThrow('require review');
    // The payment it built is this device's own (queued here), and the release it made stands.
    expect([m.released(C), m.owner(C), m.released(A)]).toEqual([true, '', true]);
    // A noSend one that reached storage is held here.
    const w2 = {
      createAction: async () => {
        m.noteSigned(D);
        throw reviewError(D);
      },
    };
    markReleases(w2, m, { admin: ADMIN });
    await expect(w2.createAction({ options: { noSend: true } } as never)).rejects.toThrow('require review');
    expect([m.heldHere(D), m.released(D)]).toEqual([true, false]);
  });

  test("round 6 (c): a remote store's review error naming W changes nothing about W, and the site still can't send it", async () => {
    const m = createReleaseMarks();
    await m.hold(B, ''); // W: the wallet's own withheld payment
    const sends: unknown[] = [];
    const w = {
      createAction: async (args: { options?: { sendWith?: string[] } }) => {
        if (args.options?.sendWith) {
          sends.push(args);
          return { txid: C };
        }
        m.noteSigned(C); // what this call really signed
        throw reviewError(B); // the remote store's envelope names W instead
      },
    };
    markReleases(w, m, { admin: ADMIN });
    await expect(w.createAction({ description: 'x' } as never, 'evil.site' as never)).rejects.toThrow('require review');
    expect([m.owner(B), m.heldHere(B), m.released(B), m.known(C)]).toEqual(['', true, false, false]);
    await expect(
      w.createAction({ description: 'x', options: { sendWith: [B] } } as never, 'evil.site' as never),
    ).rejects.toThrow(NOT_YOURS);
    expect(sends).toEqual([]);
  });

  test('round 6 (c): only a WERR_REVIEW_ACTIONS naming the one transaction this call signed, with no record yet', async () => {
    const cases: [string, () => void, Error][] = [
      ['another name', () => undefined, Object.assign(new Error('boom'), { txid: C })],
      ['nothing signed in the call', () => undefined, reviewError(C)],
      ['two signed in the call', () => undefined, reviewError(C)],
    ];
    for (const [why, , err] of cases) {
      const m = createReleaseMarks();
      const w = {
        createAction: async () => {
          if (why === 'another name') m.noteSigned(C);
          if (why === 'two signed in the call') {
            m.noteSigned(C);
            m.noteSigned(D);
          }
          throw err;
        },
      };
      markReleases(w, m, { admin: ADMIN });
      await expect(w.createAction({} as never, 'a.site' as never)).rejects.toThrow();
      expect([why, m.known(C)]).toEqual([why, false]);
    }
  });

  test('round 6 (c): a recorded maker is never replaced, on any path', async () => {
    const m = createReleaseMarks();
    await m.hold(A, 'site.a');
    await m.setOwner(A, 'evil.site');
    await m.hold(A, 'evil.site');
    await m.setOwner(B, 'site.b');
    await m.setOwner(B, 'evil.site');
    expect([m.owner(A), m.owner(B)]).toEqual(['site.a', 'site.b']);
  });

  test("round 6 (c): watchSigned notes each new transaction this device's signer hands to storage (bytes checked)", async () => {
    const m = createReleaseMarks();
    const t = new Transaction();
    t.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1 });
    const seen: unknown[] = [];
    const storage = { processAction: async (a: unknown) => void seen.push(a) };
    expect(watchSigned(storage, m)).toBe(true);
    const n = m.signedSeq();
    await storage.processAction({ isNewTx: true, txid: t.id('hex'), rawTx: t.toBinary() });
    await storage.processAction({ isNewTx: true, txid: A, rawTx: t.toBinary() }); // bytes of another tx: not noted
    await storage.processAction({ isNewTx: false, txid: t.id('hex'), rawTx: t.toBinary() });
    expect([m.signedSince(n), seen.length]).toEqual([[t.id('hex')], 3]);
  });
});
