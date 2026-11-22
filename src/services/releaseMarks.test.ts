import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Script, Transaction } from '@bsv/sdk';
import {
  createReleaseMarks,
  markReleases,
  NOT_YOURS,
  releasedBy,
  signedForCall,
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

  /** A payment as a createAction asks for it, and the transaction this device's signer built for it. */
  const payment = (sats: number) => {
    const lockingScript = new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex();
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: 'e'.repeat(64),
      sourceOutputIndex: sats % 7,
      unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: Script.fromHex(lockingScript), satoshis: sats });
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 777 }); // change
    return {
      txid: tx.id('hex'),
      raw: tx.toBinary(),
      args: { description: 'a payment', outputs: [{ lockingScript, satoshis: sats, outputDescription: 'payment' }] },
    };
  };

  test('round 5 (3): a send that reached storage and then threw (results require review) keeps its marks', async () => {
    const m = createReleaseMarks();
    const P = payment(1_000);
    const w = {
      createAction: async () => {
        m.noteSigned(P.txid, { rawTx: P.raw }); // this device's signer handed P to storage (watchSigned)
        throw reviewError(P.txid, { sendWithResults: [{ txid: A, status: 'failed' }] });
      },
    };
    markReleases(w, m, { admin: ADMIN });
    await expect(w.createAction({ ...P.args, options: { sendWith: [A] } } as never)).rejects.toThrow('require review');
    // The payment it built is this device's own (queued here), and the release it made stands.
    expect([m.released(P.txid), m.owner(P.txid), m.released(A)]).toEqual([true, '', true]);
    // A noSend one that reached storage is held here.
    const Q = payment(2_000);
    const w2 = {
      createAction: async () => {
        m.noteSigned(Q.txid, { rawTx: Q.raw });
        throw reviewError(Q.txid);
      },
    };
    markReleases(w2, m, { admin: ADMIN });
    await expect(w2.createAction({ ...Q.args, options: { noSend: true } } as never)).rejects.toThrow('require review');
    expect([m.heldHere(Q.txid), m.released(Q.txid)]).toEqual([true, false]);
  });

  test("round 6 (c): a remote store's review error naming W changes nothing about W, and the site still can't send it", async () => {
    const m = createReleaseMarks();
    await m.hold(B, ''); // W: the wallet's own withheld payment
    const P = payment(1_000);
    const sends: unknown[] = [];
    const w = {
      createAction: async (args: { options?: { sendWith?: string[] } }) => {
        if (args.options?.sendWith) {
          sends.push(args);
          return { txid: C };
        }
        m.noteSigned(P.txid, { rawTx: P.raw }); // what this call really signed
        throw reviewError(B); // the remote store's envelope names W instead
      },
    };
    markReleases(w, m, { admin: ADMIN });
    await expect(w.createAction(P.args as never, 'evil.site' as never)).rejects.toThrow('require review');
    expect([m.owner(B), m.heldHere(B), m.released(B), m.known(P.txid)]).toEqual(['', true, false, false]);
    await expect(
      w.createAction({ description: 'x', options: { sendWith: [B] } } as never, 'evil.site' as never),
    ).rejects.toThrow(NOT_YOURS);
    expect(sends).toEqual([]);
  });

  test('round 6 (c): only a WERR_REVIEW_ACTIONS naming a transaction this call signed for itself, with no record yet', async () => {
    for (const why of ['another name', 'nothing signed in the call', 'signed, but not with this call’s outputs']) {
      const m = createReleaseMarks();
      const P = payment(1_000);
      const other = payment(3_000);
      const w = {
        createAction: async () => {
          if (why !== 'nothing signed in the call') m.noteSigned(P.txid, { rawTx: P.raw });
          throw why === 'another name' ? Object.assign(new Error('boom'), { txid: P.txid }) : reviewError(P.txid);
        },
      };
      markReleases(w, m, { admin: ADMIN });
      const args = why === 'signed, but not with this call’s outputs' ? other.args : P.args;
      await expect(w.createAction(args as never, 'a.site' as never)).rejects.toThrow();
      expect([why, m.known(P.txid)]).toEqual([why, false]);
    }
  });

  test("round 6 follow-up: a site's call that errors naming the wallet's concurrently signed T changes nothing about T", async () => {
    const m = createReleaseMarks();
    const T = payment(5_000); // the wallet's own withheld payment, signed while the site's call is running
    const S = payment(1_000); // what the site asked for (its call signs nothing itself)
    let signT!: () => void;
    const tSigned = new Promise<void>((r) => (signT = r));
    const w = {
      createAction: async (args: { description?: string }) => {
        if (args.description === 'wallet') {
          m.noteSigned(T.txid, { rawTx: T.raw });
          signT();
          return { txid: T.txid };
        }
        await tSigned; // the hostile store answers the site's call once T is signed
        throw reviewError(T.txid);
      },
    };
    markReleases(w, m, { admin: ADMIN });
    const site = w.createAction({ ...S.args, description: 'site' } as never, 'evil.site' as never);
    const wallet = w.createAction(
      { ...T.args, description: 'wallet', options: { noSend: true } } as never,
      ADMIN as never,
    );
    await expect(site).rejects.toThrow('require review');
    await wallet;
    // T is the wallet's own, held: the site's error recorded nothing for it.
    expect([m.owner(T.txid), m.heldHere(T.txid), m.released(T.txid)]).toEqual([ADMIN, true, false]);
    await expect(
      w.createAction({ description: 'x', options: { sendWith: [T.txid] } } as never, 'evil.site' as never),
    ).rejects.toThrow(NOT_YOURS);
  });

  test("round 6 follow-up: a signAction's review error counts only for the transaction storage got under this call's reference", async () => {
    for (const ref of ['ref-1', 'ref-other']) {
      const m = createReleaseMarks();
      const P = payment(1_000);
      const w = {
        // Two-step, as every site's action through the permissions manager: noSend, signed later by signAction.
        createAction: async () => ({ signableTransaction: { reference: 'ref-1' } }),
        signAction: async () => {
          m.noteSigned(P.txid, { rawTx: P.raw, reference: ref }); // storage got P under `ref`
          throw reviewError(P.txid);
        },
      };
      markReleases(w, m, { admin: ADMIN });
      await w.createAction({ ...P.args, options: { noSend: true, signAndProcess: false } } as never, 'a.site' as never);
      await expect(w.signAction({ reference: 'ref-1' } as never, 'a.site' as never)).rejects.toThrow('require review');
      expect([ref, m.heldHere(P.txid), m.owner(P.txid)]).toEqual(
        ref === 'ref-1' ? [ref, true, 'a.site'] : [ref, false, undefined],
      );
    }
    expect(signedForCall('signAction', { reference: 'r' }, { txid: A })).toBe(false);
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
    expect([m.signedSince(n).map((x) => x.txid), seen.length]).toEqual([[t.id('hex')], 3]);
  });
});
