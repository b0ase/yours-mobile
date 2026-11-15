import { beforeEach, describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { peekMail, syncMail, type MailRelay, type RelayMessage } from './client';
import { tscToMerklePath } from './delivery';
import { encodeEnvelope, type Envelope, type Postage } from './envelope';
import { shownSats } from './route';
import {
  BIN_MS,
  RELAY_KEEP_MS,
  RELAY_SEEN_MAX,
  isQuarantined,
  loadMail,
  loadRelaySeen,
  purgeBin,
  saveMail,
  saveRelaySeen,
  setFlags,
  updateMail,
} from './store';
import { diffSeen } from '../notify/notify';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;
const ME = PrivateKey.fromRandom().toPublicKey().toString();
const ALICE = PrivateKey.fromRandom().toPublicKey().toString();
const EVE = PrivateKey.fromRandom().toPublicKey().toString();
/** The BRC-29 key every fake wallet derives for a stamp (one account: every device derives the same key). */
const STAMP = PrivateKey.fromRandom();

/** A stamp of `sats` to the account: a signed payment with a mined parent, as Atomic BEEF. */
const stamp = async (sats: number): Promise<Postage> => {
  const k = PrivateKey.fromRandom();
  const parent = new Transaction();
  parent.addOutput({ lockingScript: new P2PKH().lock(k.toAddress()), satoshis: sats + 100 });
  parent.merklePath = tscToMerklePath(parent.id('hex'), 0, [], 900_000);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
  tx.addOutput({ lockingScript: new P2PKH().lock(STAMP.toPublicKey().toHash()), satoshis: sats });
  await tx.sign();
  return {
    txid: tx.id('hex'),
    sats,
    outputIndex: 0,
    beef: Utils.toHex(tx.toAtomicBEEF()),
    derivationPrefix: 'p',
    derivationSuffix: 's',
  };
};

let n = 0;
const letter = (o: Partial<Envelope> = {}): Envelope => ({
  t: 'bmail',
  v: 1,
  id: (++n).toString(16).padStart(32, '0'),
  from: ALICE,
  to: ME,
  at: T0,
  sealed: 'c2VhbGVk',
  ...o,
});

/** One relay for every device: lists what has not been acknowledged; records each acknowledge call. */
const fakeRelay = () => {
  let box: RelayMessage[] = [];
  const acks: string[][] = [];
  const relay: MailRelay = {
    list: async () => box.map((m) => ({ ...m })),
    ack: async (ids) => {
      if (!ids.length) return;
      acks.push(ids);
      box = box.filter((m) => !ids.includes(m.messageId));
    },
  };
  return {
    relay,
    acks,
    ids: () => box.map((m) => m.messageId),
    post: (env: Envelope, o: Partial<RelayMessage> = {}) => {
      const m = { messageId: `relay-${env.id}`, sender: env.from, body: encodeEnvelope(env), ...o };
      box.push(m);
      return m.messageId;
    },
  };
};

/** The account's wallet storage, as far as postage goes: the stamps taken in (shared once the devices have synced). */
type Coins = Set<string>;
type Repeat = 'merge' | 'already' | 'busy';

/**
 * A device: its own localStorage and its own wallet. `repeat` is what the wallet does when the stamp is already in
 * its storage: 'merge' (the toolbox: accepted, counted once), 'already' (a wallet that throws instead), 'busy' (the
 * toolbox's "undergoing active changes" once, then a merge).
 */
const device = (coins: Coins = new Set(), repeat: Repeat = 'merge') => {
  const mem = new Map<string, string>();
  const calls = { derive: 0, internalize: 0, decrypt: 0 };
  let full = false;
  let busy = repeat === 'busy';
  const ls = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (full && k.startsWith('bw-bmail:')) throw new Error('QuotaExceededError');
      mem.set(k, v);
    },
  };
  const wallet = {
    getPublicKey: async (a: { identityKey?: boolean }) => {
      if (a.identityKey) return { publicKey: ME };
      calls.derive++;
      return { publicKey: STAMP.toPublicKey().toString() };
    },
    internalizeAction: async (a: { tx: number[] }) => {
      calls.internalize++;
      const txid = Transaction.fromAtomicBEEF(a.tx).id('hex');
      if (coins.has(txid)) {
        if (repeat === 'already') throw new Error('Transaction already exists in storage');
        if (busy) {
          busy = false;
          throw new Error(
            'The tx parameter must be target transaction of internalizeAction is undergoing active changes.',
          );
        }
      }
      coins.add(txid);
      return { accepted: true };
    },
    decrypt: async () => {
      calls.decrypt++;
      return { plaintext: [] };
    },
  } as unknown as WalletInterface;
  return { wallet, calls, coins, ls, setFull: (v: boolean) => void (full = v) };
};
type Device = ReturnType<typeof device>;

const onDevice = (d: Device) => void ((globalThis as { localStorage?: unknown }).localStorage = d.ls);
const sync = (d: Device, r: MailRelay, now = T0) => {
  onDevice(d);
  return syncMail(d.wallet, ME, r, now);
};
const mail = (d: Device) => {
  onDevice(d);
  return loadMail(ME).received;
};
/** The notifier's bMail peek, as notify/engine.ts makes it: the ids of mail not yet on this device. */
const peek = async (d: Device, r: MailRelay) => {
  onDevice(d);
  const known = new Set(loadMail(ME).received.map((x) => x.id));
  return (await peekMail(d.wallet, ME, { known, seen: loadRelaySeen(ME) }, r)).map((p) => p.env.id);
};

beforeEach(() => {
  n = 0;
});

describe('bMail on several devices', () => {
  test('both devices get the same letter; neither clears it from the relay on fetch', async () => {
    const r = fakeRelay();
    const env = letter();
    const rid = r.post(env);
    const [a, b] = [device(), device()];
    await sync(a, r.relay);
    await sync(b, r.relay);
    expect(mail(a).map((x) => x.id)).toEqual([env.id]);
    expect(mail(b).map((x) => x.id)).toEqual([env.id]);
    expect(mail(b)[0].relayId).toBe(rid);
    expect(r.acks).toEqual([]);
    expect(r.ids()).toEqual([rid]);
  });

  test('a second fetch on the same device: no duplicate, no second postage check, nothing decrypted', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(500) }));
    const a = device();
    await sync(a, r.relay);
    expect(a.calls).toEqual({ derive: 1, internalize: 1, decrypt: 0 });
    await sync(a, r.relay, T0 + DAY);
    await sync(a, r.relay, T0 + 2 * DAY);
    expect(mail(a).length).toBe(1);
    expect(a.calls).toEqual({ derive: 1, internalize: 1, decrypt: 0 });
    expect(r.acks).toEqual([]);
  });

  test('notifier: new to a device that has not stored it, once; never again once stored', async () => {
    const r = fakeRelay();
    const env = letter({ postage: await stamp(500) });
    r.post(env);
    const [a, b] = [device(), device()];
    await sync(a, r.relay);
    // Device A has it: nothing to notify there, and the stamp is not even checked again.
    const derived = a.calls.derive;
    expect(await peek(a, r.relay)).toEqual([]);
    expect(a.calls.derive).toBe(derived);
    // Device B has not: it is new there, although A stored it. The notifier's seen ids keep it to one notice.
    const first = diffSeen([], await peek(b, r.relay), true);
    expect(first.fresh).toEqual([env.id]);
    expect(diffSeen(first.seen, await peek(b, r.relay), true).fresh).toEqual([]);
    expect(b.calls.internalize).toBe(0);
    await sync(b, r.relay);
    expect(await peek(b, r.relay)).toEqual([]);
    expect(mail(b)[0].read).toBeUndefined();
  });

  test('a paid letter fetched second still shows as paid, the right amount, once', async () => {
    for (const repeat of ['merge', 'already', 'busy'] as const) {
      const r = fakeRelay();
      r.post(letter({ postage: await stamp(700) }));
      // Synced devices: B's wallet storage already holds the stamp A took in.
      const coins: Coins = new Set();
      const [a, b] = [device(coins), device(coins, repeat)];
      await sync(a, r.relay);
      await sync(b, r.relay);
      const got = mail(b);
      expect(got.length).toBe(1);
      expect(got[0].verifiedSats).toBe(700);
      expect(shownSats(got[0])).toBe(700);
      expect(got[0].verifyNote).toBeUndefined();
      expect(mail(a)[0].verifiedSats).toBe(700);
      expect(coins.size).toBe(1);
      expect(b.calls.internalize).toBe(repeat === 'busy' ? 2 : 1);
      await sync(b, r.relay, T0 + DAY);
      expect(b.calls.internalize).toBe(repeat === 'busy' ? 2 : 1);
    }
  });

  test('a payment the wallet refuses is still shown unpaid', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    const a = device();
    (a.wallet as unknown as { internalizeAction: unknown }).internalizeAction = async () => {
      throw new Error('target transaction of internalizeAction has invalid status failed.');
    };
    await sync(a, r.relay);
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(mail(a)[0].verifyNote).toContain('Postage not accepted');
  });

  test('30 days after a device first saw it, the letter is cleared from the relay once and stays stored', async () => {
    const r = fakeRelay();
    const env = letter();
    const rid = r.post(env);
    const [a, b] = [device(), device()];
    await sync(a, r.relay);
    await sync(b, r.relay, T0 + 10 * DAY);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS - 1);
    expect(r.acks).toEqual([]);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    expect(r.acks).toEqual([[rid]]);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + DAY);
    await sync(b, r.relay, T0 + RELAY_KEEP_MS + DAY);
    expect(r.acks).toEqual([[rid]]);
    expect(mail(a).map((x) => x.id)).toEqual([env.id]);
    expect(mail(b).map((x) => x.id)).toEqual([env.id]);
    // The ledger holds only what the relay still lists.
    onDevice(a);
    expect(loadRelaySeen(ME).size).toBe(0);
  });

  test('a letter erased from the Bin is cleared from the relay; one still in the Bin is not', async () => {
    const r = fakeRelay();
    const [gone, binned] = [letter(), letter()];
    const rid = r.post(gone);
    r.post(binned);
    const a = device();
    await sync(a, r.relay);
    // Back-dated so the 30 days on the relay (first seen at T0) are not what clears it.
    updateMail(ME, (s) => setFlags(s, [gone.id], { deleted: true }, T0 - BIN_MS).next);
    updateMail(ME, (s) => setFlags(s, [binned.id], { deleted: true }, T0).next);
    saveMail(ME, purgeBin(loadMail(ME), T0 + DAY));
    await sync(a, r.relay, T0 + DAY);
    expect(r.acks).toEqual([[rid]]);
    expect(r.ids()).toEqual([`relay-${binned.id}`]);
    // The tombstone stays, so nothing brings it back.
    expect(mail(a).find((x) => x.id === gone.id)?.erased).toBe(true);
    expect(mail(a).length).toBe(2);
  });

  test("the sender's `at`, far in the past or the future, changes neither when it is cleared nor how often", async () => {
    const r = fakeRelay();
    const [past, future] = [letter({ at: 0 }), letter({ at: T0 + 400 * 365 * DAY })];
    r.post(past);
    r.post(future);
    const a = device();
    await sync(a, r.relay);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS - 1);
    expect(r.acks).toEqual([]);
    // Shown no later than the moment it arrived here.
    expect(mail(a).find((x) => x.id === future.id)?.at).toBe(T0);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    expect(r.acks).toEqual([[`relay-${past.id}`, `relay-${future.id}`]]);
    expect(r.ids()).toEqual([]);
    expect(mail(a).length).toBe(2);
  });

  test('a clock that was ahead when the letter was first seen cannot keep it on the relay', async () => {
    const r = fakeRelay();
    const rid = r.post(letter());
    const a = device();
    await sync(a, r.relay, T0 + 900 * DAY);
    await sync(a, r.relay, T0);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    expect(r.acks).toEqual([[rid]]);
  });

  test("a blocked sender's letter goes to Quarantine once and is not processed again", async () => {
    const r = fakeRelay();
    const env = letter({ from: EVE, postage: await stamp(300) });
    const rid = r.post(env);
    const a = device();
    onDevice(a);
    updateMail(ME, (s) => ({ ...s, blocked: [EVE] }));
    await sync(a, r.relay);
    const calls = { ...a.calls };
    await sync(a, r.relay, T0 + DAY);
    await sync(a, r.relay, T0 + 2 * DAY);
    expect(a.calls).toEqual(calls);
    expect(mail(a).length).toBe(1);
    expect(isQuarantined(mail(a)[0], [EVE])).toBe(true);
    expect(r.acks).toEqual([]);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    expect(r.acks).toEqual([[rid]]);
  });

  test('refused messages are not stored, not cleared at once, and go after 30 days', async () => {
    const r = fakeRelay();
    const junk = [
      r.post(letter(), { body: 'not bmail' }),
      r.post(letter({ to: ALICE })),
      r.post(letter({ postage: await stamp(300) }), { sender: EVE }),
      r.post(letter({ v: 2 as unknown as 1 })),
    ];
    const a = device();
    await sync(a, r.relay);
    await sync(a, r.relay, T0 + DAY);
    expect(mail(a)).toEqual([]);
    expect(a.calls).toEqual({ derive: 0, internalize: 0, decrypt: 0 });
    expect(r.acks).toEqual([]);
    onDevice(a);
    expect([...loadRelaySeen(ME).keys()]).toEqual(junk);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    expect(r.acks).toEqual([junk]);
  });

  test('the same letter under two relay ids is stored and paid once', async () => {
    const r = fakeRelay();
    const env = letter({ postage: await stamp(300) });
    r.post(env);
    r.post(env, { messageId: 'again' });
    const a = device();
    await sync(a, r.relay);
    r.post(env, { messageId: 'and-again' });
    await sync(a, r.relay, T0 + DAY);
    expect(mail(a).length).toBe(1);
    expect(a.calls.internalize).toBe(1);
    expect(r.acks).toEqual([]);
  });

  test('a letter this device dealt with but no longer stores (over the store cap) is not taken or notified again', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(300) }));
    const a = device();
    await sync(a, r.relay);
    const calls = { ...a.calls };
    saveMail(ME, { ...loadMail(ME), received: [] });
    await sync(a, r.relay, T0 + DAY);
    expect(await peek(a, r.relay)).toEqual([]);
    expect(mail(a)).toEqual([]);
    expect(a.calls).toEqual(calls);
  });

  test('a letter that could not be stored (storage full) is taken again on the next fetch', async () => {
    const r = fakeRelay();
    const env = letter();
    r.post(env);
    const a = device();
    a.setFull(true);
    await sync(a, r.relay);
    expect(mail(a)).toEqual([]);
    a.setFull(false);
    await sync(a, r.relay, T0 + DAY);
    expect(mail(a).map((x) => x.id)).toEqual([env.id]);
  });

  test('the ledger is bounded, keeps the longest-known ids, and takes any relay id', () => {
    const a = device();
    onDevice(a);
    const many = new Map<string, number>();
    for (let i = 0; i < RELAY_SEEN_MAX + 50; i++) many.set(`m${i}`, T0 + i);
    many.set('__proto__', T0 - 2);
    many.set('constructor', T0 - 1);
    saveRelaySeen(ME, many);
    const back = loadRelaySeen(ME);
    expect(back.size).toBe(RELAY_SEEN_MAX);
    expect(back.get('__proto__')).toBe(T0 - 2);
    expect(back.get('constructor')).toBe(T0 - 1);
    expect(back.has('m0')).toBe(true);
    expect(back.has(`m${RELAY_SEEN_MAX + 49}`)).toBe(false);
    a.ls.setItem(`bw-bmail-relay:${ME}`, '{"not":"a list"}');
    expect(loadRelaySeen(ME).size).toBe(0);
  });
});
