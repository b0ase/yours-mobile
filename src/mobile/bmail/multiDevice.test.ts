import { beforeEach, describe, expect, test } from 'bun:test';
import { Beef, P2PKH, PrivateKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { MessageBoxClient } from '@bsv/message-box-client';
import {
  RECHECK_EVERY_MS,
  RECHECK_MAX,
  RECHECK_PER_SENDER,
  RECHECK_TRIES,
  ACK_MAX,
  STAMP_USED,
  TAKE_MAX,
  peekMail,
  relayOf,
  syncMail,
  type MailRelay,
  type RelayMessage,
  type StampNet,
} from './client';
import { tscToMerklePath } from './delivery';
import { encodeEnvelope, stampPrefix, type Envelope, type Postage } from './envelope';
import { route, shownSats } from './route';
import {
  BIN_MS,
  RECEIVED_MAX,
  RELAY_CONFIRM_MS,
  RELAY_KEEP_MS,
  RELAY_SEEN_MAX,
  isQuarantined,
  loadMail,
  loadRelaySeen,
  loadStamps,
  purgeBin,
  saveMail,
  relayKey,
  saveRelaySeen,
  setFlags,
  updateMail,
  type Received,
  type RelaySeen,
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

/**
 * The network, as far as stamps go: which transactions it has, which it refuses, which outputs are spent, and whether
 * it answers at all. Every stamp() is on the network unless made with `sent: false`.
 */
const chain = {
  has: new Set<string>(),
  refuses: new Set<string>(),
  spent: new Map<string, string>(),
  down: false,
  calls: { seen: 0, broadcast: 0, spender: 0 },
};
const net: StampNet = {
  seen: async (txid) => {
    chain.calls.seen++;
    return !chain.down && chain.has.has(txid);
  },
  broadcast: async (beefHex) => {
    chain.calls.broadcast++;
    if (chain.down) return 'unclear';
    const txid = Transaction.fromAtomicBEEF(Utils.toArray(beefHex, 'hex')).id('hex');
    if (chain.refuses.has(txid)) return 'refused';
    chain.has.add(txid);
    return 'seen';
  },
  spender: async (outpoint) => {
    chain.calls.spender++;
    if (chain.down) throw new Error('woc 500');
    return chain.spent.get(outpoint) ?? null;
  },
};

/** A stamp of `sats` to the account: a signed payment with a mined parent, as Atomic BEEF. */
const stamp = async (sats: number, o: { sent?: boolean } = {}): Promise<Postage> => {
  const k = PrivateKey.fromRandom();
  const parent = new Transaction();
  parent.addOutput({ lockingScript: new P2PKH().lock(k.toAddress()), satoshis: sats + 100 });
  parent.merklePath = tscToMerklePath(parent.id('hex'), 0, [], 900_000);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
  tx.addOutput({ lockingScript: new P2PKH().lock(STAMP.toPublicKey().toHash()), satoshis: sats });
  await tx.sign();
  if (o.sent !== false) chain.has.add(tx.id('hex'));
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

const txidOf = (beefHex: string) => Transaction.fromAtomicBEEF(Utils.toArray(beefHex, 'hex')).id('hex');

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
    post: (env: Envelope, o: Partial<RelayMessage> & { front?: boolean } = {}) => {
      const { front, ...rest } = o;
      const m = { messageId: `relay-${env.id}`, sender: env.from, body: encodeEnvelope(env), ...rest };
      if (front) box.unshift(m);
      else box.push(m);
      return m.messageId;
    },
  };
};

/** The account's wallet storage, as far as postage goes: the stamps taken in (shared once the devices have synced). */
type Coins = Set<string>;
type Repeat = 'merge' | 'busy';

/**
 * A device: its own localStorage and its own wallet. `repeat` is what the wallet does when the stamp is already in
 * its storage: 'merge' (the toolbox: accepted, counted once), 'busy' (the toolbox's "undergoing active changes" once,
 * then a merge).
 */
const device = (coins: Coins = new Set(), repeat: Repeat = 'merge') => {
  const mem = new Map<string, string>();
  const calls = { derive: 0, internalize: 0, decrypt: 0 };
  let full = false;
  let down = false;
  let busy = repeat === 'busy';
  // The time of the newest block this wallet knows (null: it cannot tell). sync() keeps it at the refresh's `now`.
  let chainAt: number | null = T0;
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
      if (down) throw new Error('Failed to fetch');
      const txid = Transaction.fromAtomicBEEF(a.tx).id('hex');
      if (coins.has(txid)) {
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
    getHeight: async () => ({ height: 900_000 }),
    getHeaderForHeight: async () => {
      if (chainAt === null) throw new Error('Failed to fetch');
      const time = new Utils.Writer().writeUInt32LE(Math.floor(chainAt / 1000)).toArray();
      return { header: Utils.toHex([...new Array<number>(68).fill(0), ...time, ...new Array<number>(8).fill(0)]) };
    },
  } as unknown as WalletInterface;
  return {
    wallet,
    calls,
    coins,
    ls,
    setChain: (at: number | null) => void (chainAt = at),
    setFull: (v: boolean) => void (full = v),
    setDown: (v: boolean) => void (down = v),
  };
};
type Device = ReturnType<typeof device>;

const onDevice = (d: Device) => void ((globalThis as { localStorage?: unknown }).localStorage = d.ls);
/** One refresh at `now` by the device's clock; `chainAt`: the newest block's time (the true time unless given). */
const sync = (d: Device, r: MailRelay, now = T0, chainAt: number | null = now) => {
  onDevice(d);
  d.setChain(chainAt);
  return syncMail(d.wallet, ME, r, now, net);
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
  chain.has.clear();
  chain.refuses.clear();
  chain.spent.clear();
  chain.down = false;
  chain.calls = { seen: 0, broadcast: 0, spender: 0 };
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
    for (const repeat of ['merge', 'busy'] as const) {
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

  test('30 days after it arrived, seen so twice a day apart, the letter is cleared once and stays stored', async () => {
    const r = fakeRelay();
    const env = letter();
    const rid = r.post(env);
    const [a, b] = [device(), device()];
    await sync(a, r.relay);
    await sync(b, r.relay, T0 + 10 * DAY);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS - 1);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS - 1);
    expect(r.acks).toEqual([]);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS);
    expect(r.acks).toEqual([[rid]]);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + 2 * DAY);
    await sync(b, r.relay, T0 + RELAY_KEEP_MS + 2 * DAY);
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
    expect(r.acks).toEqual([]);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS);
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
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS);
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
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS);
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
    expect([...loadRelaySeen(ME).keys()]).toEqual(junk.map(relayKey));
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS);
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

  test('the ledger: small fixed-size keys whatever the relay id is, longest-known kept over its cap', async () => {
    const a = device();
    onDevice(a);
    const many: RelaySeen = new Map();
    for (let i = 0; i < RELAY_SEEN_MAX + 50; i++) many.set(relayKey(`m${i}`), { first: T0 + i * 60_000, due: 0 });
    saveRelaySeen(ME, many);
    const back = loadRelaySeen(ME);
    expect(back.size).toBe(RELAY_SEEN_MAX);
    expect(back.get(relayKey('m0'))).toEqual({ first: T0, due: 0 });
    expect(back.has(relayKey(`m${RELAY_SEEN_MAX + 49}`))).toBe(false);
    expect(relayKey('x'.repeat(256)).length).toBe(16);
    a.ls.setItem(`bw-bmail-relay:${ME}`, '{"not":"a list"}');
    expect(loadRelaySeen(ME).size).toBe(0);
    // Relay ids are the sender's choice: odd ones are taken once like any other.
    const r = fakeRelay();
    r.post(letter(), { messageId: '__proto__' });
    r.post(letter(), { messageId: 'constructor' });
    await sync(a, r.relay);
    await sync(a, r.relay, T0 + DAY);
    expect(mail(a).length).toBe(2);
    expect(loadRelaySeen(ME).size).toBe(2);
  });
});

describe('bMail postage that could not be checked on arrival', () => {
  const box = (d: Device) => route(mail(d)[0], { isFriend: () => false, priceSats: 100 });

  test('chain lookup down, then up: kept as unchecked, then paid once with the right amount, in the Inbox', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    const coins: Coins = new Set();
    const [a, b] = [device(coins), device(coins)];
    a.setDown(true);
    await sync(a, r.relay);
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(mail(a)[0].recheck).toEqual({ first: T0, last: T0, tries: 1 });
    expect(mail(a)[0].verifyNote).toContain('not checked yet');
    expect(box(a)).toBe('requests');
    a.setDown(false);
    // Not before its time: the relay still lists the letter, the ledger skips it, and nothing is tried.
    await sync(a, r.relay, T0 + RECHECK_EVERY_MS - 1);
    expect(a.calls.internalize).toBe(1);
    await sync(a, r.relay, T0 + RECHECK_EVERY_MS);
    expect(mail(a).length).toBe(1);
    expect(mail(a)[0].verifiedSats).toBe(700);
    expect(mail(a)[0].recheck).toBeUndefined();
    expect(mail(a)[0].verifyNote).toBeUndefined();
    expect(box(a)).toBe('inbox');
    expect(a.calls.internalize).toBe(2);
    await sync(a, r.relay, T0 + DAY);
    expect(a.calls.internalize).toBe(2);
    // The other device takes the same stamp: still one coin, paid on both.
    await sync(b, r.relay, T0 + DAY);
    expect(mail(b)[0].verifiedSats).toBe(700);
    expect(coins.size).toBe(1);
  });

  test('a stamp that is definitely not good is settled unpaid at once and never checked again', async () => {
    const r = fakeRelay();
    const good = await stamp(700);
    r.post(letter({ postage: { ...good, sats: 900 } }));
    r.post(letter({ postage: { ...good, txid: 'f'.repeat(64) } }));
    r.post(letter({ postage: { ...good, beef: '00' } }));
    r.post(letter({ postage: await stamp(500) }));
    const a = device();
    (a.wallet as unknown as { internalizeAction: unknown }).internalizeAction = async () => {
      a.calls.internalize++;
      throw new Error('target transaction of internalizeAction has invalid status failed.');
    };
    await sync(a, r.relay);
    const calls = { ...a.calls };
    for (let i = 1; i <= 5; i++) await sync(a, r.relay, T0 + i * DAY);
    expect(a.calls).toEqual(calls);
    expect(mail(a).length).toBe(4);
    for (const m of mail(a)) {
      expect(m.verifiedSats).toBe(0);
      expect(m.recheck).toBeUndefined();
      expect(m.verifyNote).toBeTruthy();
    }
  });

  test('no storm: one try per letter per 10 minutes, and unpaid for good after 30 days', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    const a = device();
    a.setDown(true);
    await sync(a, r.relay);
    for (let t = 60_000; t <= 60 * 60_000; t += 60_000) await sync(a, r.relay, T0 + t);
    expect(a.calls.internalize).toBe(1 + 6);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    const calls = a.calls.internalize;
    expect(mail(a)[0].recheck).toBeUndefined();
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(mail(a)[0].verifyNote).toBe('Postage could not be checked');
    a.setDown(false);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + DAY);
    expect(a.calls.internalize).toBe(calls);
  });

  test('20 letters a refresh, 5 of one sender, senders in turn: one sender cannot hold up another', async () => {
    const r = fakeRelay();
    const senders = Array.from({ length: RECHECK_MAX + 5 }, () => PrivateKey.fromRandom().toPublicKey().toString());
    for (const from of senders) r.post(letter({ from, postage: await stamp(100) }));
    const b = device();
    b.setDown(true);
    await sync(b, r.relay);
    expect(b.calls.internalize).toBe(RECHECK_MAX);
    await sync(b, r.relay, T0 + 1000);
    expect(b.calls.internalize).toBe(RECHECK_MAX + 5);
    b.setDown(false);
    await sync(b, r.relay, T0 + DAY);
    await sync(b, r.relay, T0 + 2 * DAY);
    expect(mail(b).every((m) => m.verifiedSats === 100 && !m.recheck)).toBe(true);
    expect(b.coins.size).toBe(RECHECK_MAX + 5);

    // 400 letters from one sender whose stamps the network never answers for, then one honest letter.
    const flood = fakeRelay();
    const c = device();
    const bad = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const p = await stamp(100, { sent: false });
      bad.add(p.txid);
      flood.post(letter({ from: EVE, postage: p }));
    }
    const slow: StampNet = {
      ...net,
      broadcast: async (beef) => (bad.has(txidOf(beef)) ? 'unclear' : net.broadcast(beef)),
    };
    onDevice(c);
    await syncMail(c.wallet, ME, flood.relay, T0, slow);
    const honest = letter({ postage: await stamp(700) });
    flood.post(honest);
    onDevice(c);
    await syncMail(c.wallet, ME, flood.relay, T0 + 30_000, slow);
    const got = mail(c).find((m) => m.id === honest.id);
    expect(got?.verifiedSats).toBe(700);
    expect(got?.recheck).toBeUndefined();
    // The flood is worked off 5 letters a refresh (two refreshes so far), 12 tries each at most, then unpaid for good.
    expect(c.calls.internalize).toBe(1);
    expect(mail(c).filter((m) => m.from === EVE && (m.recheck?.tries ?? 0) > 0).length).toBe(2 * RECHECK_PER_SENDER);
  });

  test('a wallet that cannot derive the key yet (locked) leaves the stamp unchecked, not bad', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    const a = device();
    const w = a.wallet as unknown as { getPublicKey: (x: { identityKey?: boolean }) => Promise<unknown> };
    const real = w.getPublicKey;
    w.getPublicKey = async (x) => {
      if (x.identityKey) return real(x);
      throw new Error('Wallet is locked');
    };
    await sync(a, r.relay);
    expect(mail(a)[0].recheck).toBeDefined();
    w.getPublicKey = real;
    await sync(a, r.relay, T0 + RECHECK_EVERY_MS);
    expect(mail(a)[0].verifiedSats).toBe(700);
    expect(a.calls.internalize).toBe(1);
  });

  test('a stamp is given up after 12 tries', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    const a = device();
    chain.down = true;
    for (let i = 0; i < RECHECK_TRIES - 1; i++) await sync(a, r.relay, T0 + i * RECHECK_EVERY_MS);
    expect(mail(a)[0].recheck?.tries).toBe(RECHECK_TRIES - 1);
    await sync(a, r.relay, T0 + RECHECK_TRIES * RECHECK_EVERY_MS);
    expect(mail(a)[0].recheck).toBeUndefined();
    expect(mail(a)[0].verifiedSats).toBe(0);
    chain.down = false;
    await sync(a, r.relay, T0 + DAY);
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(a.calls.internalize).toBe(0);
  });

  test('"must be valid AtomicBEEF": headers that disagree settle it at once; no headers, it is tried again', async () => {
    const refuse = (d: Device, header?: string) => {
      const w = d.wallet as unknown as Record<string, unknown>;
      w.internalizeAction = async () => {
        d.calls.internalize++;
        throw new Error('The tx parameter must be valid AtomicBEEF');
      };
      w.getHeaderForHeight = async () => {
        if (!header) throw new Error('Failed to fetch');
        return { header };
      };
      w.getHeight = async () => ({ height: 900_001 });
    };
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    // The wallet knows block 900,000 and its merkle root is not the proof's: a forged proof.
    const a = device();
    refuse(a, '00'.repeat(80));
    await sync(a, r.relay);
    expect(mail(a)[0].recheck).toBeUndefined();
    expect(mail(a)[0].verifyNote).toBe('Postage proof is not valid');
    for (let d = 1; d <= 3; d++) await sync(a, r.relay, T0 + d * DAY);
    expect(a.calls.internalize).toBe(1);
    // The wallet cannot read headers either (its chain lookup is down): unknown, tried again, bounded.
    const b = device();
    refuse(b);
    await sync(b, r.relay);
    expect(mail(b)[0].recheck?.tries).toBe(1);
    for (let d = 1; d <= 29; d++) await sync(b, r.relay, T0 + d * DAY);
    expect(mail(b)[0].recheck).toBeUndefined();
    expect(mail(b)[0].verifiedSats).toBe(0);
    expect(b.calls.internalize).toBe(RECHECK_TRIES);
  });
});

describe('bMail: what counts as a paid stamp', () => {
  test('one stamp, five letters: the first is paid, the rest are unstamped, and the wallet is asked once', async () => {
    const r = fakeRelay();
    const one = await stamp(700);
    const ids = Array.from({ length: 5 }, () => r.post(letter({ postage: one })));
    const a = device();
    await sync(a, r.relay);
    const got = mail(a);
    expect(got.map((m) => m.verifiedSats)).toEqual([700, 0, 0, 0, 0]);
    expect(got[0].relayId).toBe(ids[0]);
    expect(got.slice(1).every((m) => m.verifyNote === STAMP_USED && !m.recheck)).toBe(true);
    expect(got.filter((m) => route(m, { isFriend: () => false, priceSats: 500 }) === 'inbox').length).toBe(1);
    expect(a.calls.internalize).toBe(1);
    expect(a.coins.size).toBe(1);
  });

  test('one stamp, forty letters: all but the first are settled unstamped in the same refresh', async () => {
    const r = fakeRelay();
    const one = await stamp(700);
    for (let i = 0; i < 40; i++) r.post(letter({ postage: one }));
    const a = device();
    await sync(a, r.relay);
    expect(mail(a).filter((m) => m.verifiedSats === 700).length).toBe(1);
    expect(mail(a).filter((m) => m.verifyNote === STAMP_USED && !m.recheck).length).toBe(39);
    expect(a.calls.internalize).toBe(1);
  });

  test("a copy of someone's stamp on another sender's letter does not take the stamp from their letter", async () => {
    const r = fakeRelay();
    const one = await stamp(700);
    // The stamp's transaction is public once sent: Eve shows it on her own letters, listed before Alice's.
    const copies = [letter({ from: EVE, postage: one }), letter({ from: EVE, postage: one })];
    const real = letter({ postage: one });
    for (const e of [copies[0], real, copies[1]]) r.post(e);
    const a = device();
    // As a real wallet: the key a stamp must pay is derived from its sender, so Eve's letters do not match it.
    const w = a.wallet as unknown as { getPublicKey: (x: { counterparty?: string }) => Promise<unknown> };
    const derive = w.getPublicKey;
    w.getPublicKey = async (x) =>
      x.counterparty === EVE ? { publicKey: PrivateKey.fromRandom().toPublicKey().toString() } : derive(x);
    await sync(a, r.relay);
    const by = (id: string) => mail(a).find((m) => m.id === id);
    expect(by(real.id)?.verifiedSats).toBe(700);
    for (const c of copies) {
      expect(by(c.id)?.verifiedSats).toBe(0);
      expect(by(c.id)?.recheck).toBeUndefined();
    }
    expect(by(copies[0].id)?.verifyNote).toBe('Postage is not paid to you');
    expect(a.coins.size).toBe(1);
  });

  test('a stamp that is not checked yet reserves nothing: the letter found paid first keeps it', async () => {
    const r = fakeRelay();
    const one = await stamp(700);
    const first = letter({ postage: one });
    r.post(first);
    const a = device();
    chain.down = true;
    await sync(a, r.relay);
    const second = letter({ postage: one });
    r.post(second);
    await sync(a, r.relay, T0 + 60_000);
    expect(mail(a).every((m) => m.recheck && m.verifiedSats === 0)).toBe(true);
    chain.down = false;
    await sync(a, r.relay, T0 + 2 * RECHECK_EVERY_MS);
    expect(
      mail(a)
        .map((m) => m.verifiedSats)
        .sort(),
    ).toEqual([0, 700]);
    expect(mail(a).filter((m) => m.verifyNote === STAMP_USED && !m.recheck).length).toBe(1);
    expect(a.calls.internalize).toBe(1);
  });

  test('the notifier counts one stamp once: not for a second letter, nor after it paid for a stored one', async () => {
    const r = fakeRelay();
    const one = await stamp(700);
    for (let i = 0; i < 3; i++) r.post(letter({ postage: one }));
    const a = device();
    onDevice(a);
    const peekSats = async () =>
      (await peekMail(a.wallet, ME, { seen: loadRelaySeen(ME), stamps: loadStamps(ME) }, r.relay)).map((p) => p.sats);
    expect(await peekSats()).toEqual([700, 0, 0]);
    await sync(a, r.relay);
    r.post(letter({ postage: one }));
    onDevice(a);
    expect(await peekSats()).toEqual([0]);
  });

  test('the record of used stamps outlives the relay ledger and the mail store', async () => {
    const r = fakeRelay();
    const one = await stamp(700);
    r.post(letter({ postage: one }));
    const a = device();
    await sync(a, r.relay);
    expect(mail(a)[0].verifiedSats).toBe(700);
    // The letter leaves the store and the relay; the ledger empties with it.
    saveMail(ME, { ...loadMail(ME), received: [] });
    await r.relay.ack(r.ids());
    await sync(a, r.relay, T0 + DAY);
    expect(loadRelaySeen(ME).size).toBe(0);
    r.post(letter({ postage: one }));
    await sync(a, r.relay, T0 + 2 * DAY);
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(mail(a)[0].verifyNote).toBe(STAMP_USED);
    expect(a.calls.internalize).toBe(1);
  });

  test('a letter stored by an earlier version keeps its stamp: a later letter cannot reuse it', async () => {
    const r = fakeRelay();
    const one = await stamp(700);
    const old = letter({ postage: one });
    const a = device();
    onDevice(a);
    saveMail(ME, { ...loadMail(ME), received: [{ id: old.id, from: ALICE, at: T0, verifiedSats: 700, env: old }] });
    r.post(letter({ postage: one }));
    await sync(a, r.relay);
    expect(mail(a)[0].verifyNote).toBe(STAMP_USED);
    expect(a.calls.internalize).toBe(0);
  });

  test('a bound stamp pays for its own letter only; an unbound one (older wallets) still pays', async () => {
    const r = fakeRelay();
    const own = letter();
    const bound = { ...(await stamp(700)), derivationPrefix: stampPrefix(own.id), bound: true as const };
    const other = letter({ postage: bound });
    r.post(other);
    r.post({ ...own, postage: bound });
    const plain = letter({ postage: await stamp(300) });
    r.post(plain);
    const a = device();
    await sync(a, r.relay);
    const by = (id: string) => mail(a).find((m) => m.id === id);
    expect(by(other.id)?.verifiedSats).toBe(0);
    expect(by(other.id)?.verifyNote).toBe('This stamp was made for another letter');
    expect(by(own.id)?.verifiedSats).toBe(700);
    expect(by(plain.id)?.verifiedSats).toBe(300);
  });

  test('never sent: this wallet hands it to the network first; refused means unpaid and nothing taken in', async () => {
    const r = fakeRelay();
    const [fine, spentElsewhere] = [await stamp(700, { sent: false }), await stamp(900, { sent: false })];
    chain.refuses.add(spentElsewhere.txid);
    r.post(letter({ postage: spentElsewhere }));
    r.post(letter({ postage: fine }));
    const a = device();
    await sync(a, r.relay);
    expect(mail(a).map((m) => m.verifiedSats)).toEqual([0, 700]);
    expect(mail(a)[0].verifyNote).toContain('refused');
    expect(mail(a)[0].recheck).toBeUndefined();
    expect(chain.calls.broadcast).toBe(2);
    expect([...a.coins]).toEqual([fine.txid]);
    await sync(a, r.relay, T0 + DAY);
    expect(chain.calls.broadcast).toBe(2);
    expect(a.calls.internalize).toBe(1);
  });

  test('a BEEF that leaves out the coins the stamp spends is unpaid at once: no network, no wallet', async () => {
    const r = fakeRelay();
    const whole = await stamp(700);
    const tx = Transaction.fromAtomicBEEF(Utils.toArray(whole.beef, 'hex'));
    const bare = new Beef();
    bare.mergeRawTx(tx.toBinary());
    r.post(letter({ postage: { ...whole, beef: Utils.toHex(bare.toBinaryAtomic(whole.txid)) } }));
    const a = device();
    await sync(a, r.relay);
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(mail(a)[0].recheck).toBeUndefined();
    expect(mail(a)[0].verifyNote).toBe('Postage proof is incomplete');
    expect(chain.calls).toEqual({ seen: 0, broadcast: 0, spender: 0 });
    expect(a.calls.internalize).toBe(0);
  });

  test('the network cannot be asked: nothing is taken in, the letter waits unchecked, then is paid', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    const a = device();
    chain.down = true;
    await sync(a, r.relay);
    expect(a.calls.internalize).toBe(0);
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(mail(a)[0].recheck?.tries).toBe(1);
    chain.down = false;
    await sync(a, r.relay, T0 + RECHECK_EVERY_MS);
    expect(mail(a)[0].verifiedSats).toBe(700);
    expect(a.calls.internalize).toBe(1);
  });

  test('already spent by another device of the account: a paid letter, and no coin added on this device', async () => {
    const r = fakeRelay();
    const p = await stamp(700);
    chain.spent.set(`${p.txid}_0`, 'ab'.repeat(32));
    r.post(letter({ postage: p }));
    const b = device();
    await sync(b, r.relay);
    expect(mail(b)[0].verifiedSats).toBe(700);
    expect(mail(b)[0].verifyNote).toBeUndefined();
    expect(b.calls.internalize).toBe(0);
    expect(b.coins.size).toBe(0);
  });

  test('no wallet error text reads as paid: "Key already exists" leaves the stamp unchecked', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    const a = device();
    (a.wallet as unknown as { internalizeAction: unknown }).internalizeAction = async () => {
      throw new Error('Key already exists in the object store');
    };
    await sync(a, r.relay);
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(mail(a)[0].recheck?.tries).toBe(1);
  });
});

describe('bMail: flood, clock and load', () => {
  test('a clock that was behind when the letter was first seen, then corrected: the other device still gets it', async () => {
    const r = fakeRelay();
    r.post(letter());
    const [a, b] = [device(), device()];
    await sync(a, r.relay, T0 - 40 * DAY); // the phone started with a stale clock
    await sync(a, r.relay, T0); // corrected a minute later
    expect(r.acks).toEqual([]);
    await sync(b, r.relay, T0 + 1000);
    expect(mail(b).length).toBe(1);
  });

  test("with the relay's own time for the letter, a stale first sight does not age it at all", async () => {
    const r = fakeRelay();
    const rid = r.post(letter(), { created_at: new Date(T0).toISOString() });
    const a = device();
    await sync(a, r.relay, T0 - 40 * DAY);
    await sync(a, r.relay, T0);
    await sync(a, r.relay, T0 + 2 * DAY);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS - 1);
    expect(r.acks).toEqual([]);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS);
    expect(r.acks).toEqual([[rid]]);
  });

  test("the relay's time can only keep a letter longer: an old or unreadable one changes nothing", async () => {
    const r = fakeRelay();
    r.post(letter(), { created_at: new Date(T0 - 300 * DAY).toISOString() });
    r.post(letter(), { created_at: 'not a time' });
    r.post(letter(), { created_at: new Date(T0 + 900 * DAY).toISOString() });
    const a = device();
    await sync(a, r.relay);
    await sync(a, r.relay, T0 + DAY);
    await sync(a, r.relay, T0 + 3 * DAY);
    expect(r.acks).toEqual([]);
    // A time far ahead of this device's clock is not believed: 30 days from first sight, as without it.
    await sync(a, r.relay, T0 + RELAY_KEEP_MS);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS);
    expect(r.acks.flat().length).toBe(3);
  });

  test('a clock 31 days ahead for one refresh clears nothing; the mark it left is dropped', async () => {
    const r = fakeRelay();
    for (let i = 0; i < 3; i++) r.post(letter());
    const [a, b] = [device(), device()];
    await sync(a, r.relay, T0);
    await sync(a, r.relay, T0 + 31 * DAY); // wrong clock, one refresh
    await sync(a, r.relay, T0 + 60_000);
    await sync(a, r.relay, T0 + 2 * DAY);
    expect(r.acks).toEqual([]);
    expect(r.ids().length).toBe(3);
    await sync(b, r.relay, T0 + 2 * DAY);
    expect(mail(b).length).toBe(3);
  });

  test('a clock that goes 31 days ahead and stays there clears nothing: the newest block says otherwise', async () => {
    const r = fakeRelay();
    for (let i = 0; i < 3; i++) r.post(letter());
    const [a, b] = [device(), device()];
    await sync(a, r.relay, T0);
    // The device's clock is wrong for days; the chain's time is the true one.
    for (let d = 0; d <= 3; d++) await sync(a, r.relay, T0 + (31 + d) * DAY, T0 + d * DAY);
    expect(r.acks).toEqual([]);
    await sync(b, r.relay, T0 + 3 * DAY);
    expect(mail(b).length).toBe(3);
  });

  test('a wallet that cannot tell the time of the newest block clears nothing by age; erased mail still goes', async () => {
    const r = fakeRelay();
    const [aged, binned] = [letter(), letter()];
    r.post(aged);
    const rid = r.post(binned);
    const a = device();
    await sync(a, r.relay, T0);
    updateMail(ME, (s) => setFlags(s, [binned.id], { deleted: true }, T0).next);
    updateMail(ME, (s) => purgeBin(s, T0 + BIN_MS));
    await sync(a, r.relay, T0 + RELAY_KEEP_MS, null);
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS, null);
    expect(r.acks).toEqual([[rid]]);
    // The wallet's headers are back: the aged letter goes.
    await sync(a, r.relay, T0 + RELAY_KEEP_MS + RELAY_CONFIRM_MS + 60_000);
    expect(r.acks.length).toBe(2);
    expect(r.ids()).toEqual([]);
  });

  test("a store full of the user's own mail still takes a stranger's new letter, and drops its oldest", async () => {
    const a = device();
    onDevice(a);
    const own: Received[] = Array.from({ length: RECEIVED_MAX }, () => {
      const env = letter();
      return { id: env.id, from: ALICE, at: T0, verifiedSats: 0, read: true, env };
    });
    saveMail(ME, { ...loadMail(ME), received: own });
    const r = fakeRelay();
    const fresh = letter({ from: EVE });
    r.post(fresh);
    await sync(a, r.relay);
    expect(mail(a).length).toBe(RECEIVED_MAX);
    expect(mail(a)[0].id).toBe(fresh.id);
    expect(mail(a).some((m) => m.id === own[RECEIVED_MAX - 1].id)).toBe(false);
    expect(mail(a).some((m) => m.id === own[0].id)).toBe(true);
    // And it is this device's from then on: not taken again, not new to the notifier.
    await sync(a, r.relay, T0 + DAY);
    expect(mail(a)[0].id).toBe(fresh.id);
    expect(await peek(a, r.relay)).toEqual([]);
  });

  test('a flood of 4,000 letters: no churn, a real new letter is taken, a binned letter stays binned', async () => {
    const r = fakeRelay();
    const a = device();
    // Mail the user already has and deals with: read, from a contact.
    const kept = letter({ from: EVE });
    r.post(kept);
    await sync(a, r.relay, T0 - DAY);
    updateMail(ME, (s) => ({ ...setFlags(s, [kept.id], { read: true }).next, contacts: [EVE] }));
    for (let i = 0; i < 4000; i++) r.post(letter());
    const taken: number[] = [];
    let last = new Set(mail(a).map((m) => m.id));
    let t = T0;
    for (let k = 0; k < 24; k++) {
      await sync(a, r.relay, (t += 60_000));
      const now = new Set(mail(a).map((m) => m.id));
      taken.push([...now].filter((id) => !last.has(id)).length);
      last = now;
    }
    // 200 a refresh until the whole flood has been seen once, then nothing: no letter is taken a second time.
    expect(taken.slice(0, 20).every((x) => x === TAKE_MAX)).toBe(true);
    expect(taken.slice(20)).toEqual([0, 0, 0, 0]);
    expect(mail(a).length).toBe(RECEIVED_MAX);
    expect(loadRelaySeen(ME).size).toBe(4001);
    expect(mail(a).some((m) => m.id === kept.id)).toBe(true);
    expect(await peek(a, r.relay)).toEqual([]);
    // Mid-flood: 4,000 more, then a real letter at each end of the listing. Both are in the very next fetch.
    for (let i = 0; i < 4000; i++) r.post(letter());
    const [newest, oldest] = [letter({ from: EVE }), letter({ from: EVE })];
    r.post(newest);
    r.post(oldest, { front: true });
    await sync(a, r.relay, (t += 60_000));
    expect(mail(a).filter((m) => m.id === newest.id || m.id === oldest.id).length).toBe(2);
    // The user reads one and bins it; the flood goes on being taken in; it stays binned and is never new again.
    updateMail(ME, (s) => setFlags(s, [newest.id], { deleted: true, read: true }, t).next);
    for (let k = 0; k < 6; k++) {
      await sync(a, r.relay, (t += 60_000));
      expect(mail(a).find((m) => m.id === newest.id)?.deleted).toBe(true);
      expect((await peek(a, r.relay)).includes(newest.id)).toBe(false);
    }
    expect(mail(a).some((m) => m.id === kept.id)).toBe(true);
  }, 120_000);

  test("a full store drops flood mail first, then the Bin, and the user's own mail last", async () => {
    const r = fakeRelay();
    const a = device();
    const [read, paid, binned] = [letter(), letter({ postage: await stamp(500) }), letter()];
    for (const e of [read, paid, binned]) r.post(e);
    await sync(a, r.relay, T0 - DAY);
    updateMail(ME, (s) => setFlags(s, [read.id], { read: true }).next);
    updateMail(ME, (s) => setFlags(s, [binned.id], { deleted: true }, T0 - DAY).next);
    for (let i = 0; i < RECEIVED_MAX + 100; i++) r.post(letter({ from: EVE }));
    for (let k = 0; k < 7; k++) await sync(a, r.relay, T0 + k * 60_000);
    const ids = new Set(mail(a).map((m) => m.id));
    expect(ids.size).toBe(RECEIVED_MAX);
    expect([read.id, paid.id, binned.id].every((id) => ids.has(id))).toBe(true);
    // Nothing that was dropped is taken again.
    const before = [...ids];
    await sync(a, r.relay, T0 + DAY);
    expect(mail(a).map((m) => m.id)).toEqual(before);
  });

  test('senders the user deals with come first, then stamped letters, and senders take turns', async () => {
    const r = fakeRelay();
    const a = device();
    onDevice(a);
    updateMail(ME, (s) => ({ ...s, contacts: [EVE] }));
    for (let i = 0; i < 2 * TAKE_MAX; i++) r.post(letter());
    const friend = letter({ from: EVE });
    const stamped = letter({ from: PrivateKey.fromRandom().toPublicKey().toString(), postage: await stamp(500) });
    const stranger = letter({ from: PrivateKey.fromRandom().toPublicKey().toString() });
    r.post(friend, { front: true });
    r.post(stamped);
    r.post(stranger);
    await sync(a, r.relay);
    const got = mail(a).map((m) => m.id);
    expect(got.length).toBe(TAKE_MAX);
    // The contact, then the stamped letter; the stranger shares the next turn with the flood's sender.
    expect(got.slice(0, 2)).toEqual([friend.id, stamped.id]);
    expect(got.slice(2, 4)).toContain(stranger.id);
  });

  test('another account: a refresh started for one account stores, takes in and clears nothing for another', async () => {
    const r = fakeRelay();
    r.post(letter({ postage: await stamp(700) }));
    const a = device();
    const OTHER = PrivateKey.fromRandom().toPublicKey().toString();
    const w = a.wallet as unknown as { getPublicKey: (x: { identityKey?: boolean }) => Promise<{ publicKey: string }> };
    const real = w.getPublicKey;
    // The account changes while the relay is being listed.
    let who = ME;
    w.getPublicKey = async (x) => (x.identityKey ? { publicKey: who } : real(x));
    const switching: MailRelay = { ...r.relay, list: async () => ((who = OTHER), r.relay.list()) };
    await sync(a, switching);
    expect(mail(a)).toEqual([]);
    expect(loadRelaySeen(ME).size).toBe(0);
    expect(a.calls.internalize).toBe(0);
    // And while a stamp is being checked: the answer is not written, and nothing is cleared.
    who = ME;
    const during: StampNet = { ...net, seen: async (txid) => ((who = OTHER), net.seen(txid)) };
    onDevice(a);
    await syncMail(a.wallet, ME, r.relay, T0, during);
    expect(mail(a)[0].verifiedSats).toBe(0);
    expect(mail(a)[0].recheck?.tries).toBe(0);
    expect(r.acks).toEqual([]);
    // A refresh for an account the wallet is not on does nothing at all.
    await sync(a, r.relay, T0 + DAY);
    expect(mail(a)[0].recheck?.tries).toBe(0);
  });
});

describe('bMail over the real message box client (@bsv/message-box-client, its network stubbed)', () => {
  const SERVER = PrivateKey.fromRandom().toPublicKey().toString();
  const client = (messages: unknown[]) => {
    const calls = { decrypt: 0, internalize: 0, lists: 0, acks: [] as string[][] };
    const wallet = {
      getPublicKey: async () => ({ publicKey: ME }),
      decrypt: async () => {
        calls.decrypt++;
        throw new Error('no');
      },
      internalizeAction: async () => {
        calls.internalize++;
        throw new Error('no');
      },
    } as unknown as WalletInterface;
    const c = new MessageBoxClient({ walletClient: wallet, host: 'https://box.test' });
    (c as unknown as { authFetch: unknown }).authFetch = {
      fetch: async (url: string, cfg: { body?: string }) => {
        const body = JSON.parse(String(cfg.body)) as { messageIds?: string[]; offset?: number };
        let answer: unknown = { status: 'success' };
        if (url.endsWith('/listMessages')) {
          calls.lists++;
          // Two pages, as a server with a page size answers.
          const half = Math.ceil(messages.length / 2);
          answer = body.offset
            ? { status: 'success', messages: messages.slice(half) }
            : {
                status: 'success',
                messages: messages.slice(0, half),
                hasMore: messages.length > half,
                nextOffset: half,
              };
        } else if (url.endsWith('/acknowledgeMessage')) calls.acks.push(body.messageIds ?? []);
        return new Response(JSON.stringify(answer), { headers: { 'x-bsv-auth-identity-key': SERVER } });
      },
    };
    return { relay: relayOf(wallet, c, 'https://box.test'), calls, wallet };
  };

  test('listing reads every page and neither decrypts nor takes in anything; letters arrive whole', async () => {
    const env = letter();
    const wrapped = letter();
    const { relay, calls, wallet } = client([
      { messageId: 'plain', sender: ALICE, body: encodeEnvelope(env), created_at: new Date(T0).toISOString() },
      { messageId: 'wrapped', sender: ALICE, body: JSON.stringify({ message: encodeEnvelope(wrapped) }) },
      {
        messageId: 'secret',
        sender: ALICE,
        body: JSON.stringify({ message: JSON.stringify({ encryptedMessage: 'AAAA' }) }),
      },
      {
        messageId: 'pay',
        sender: ALICE,
        body: JSON.stringify({
          message: 'x',
          payment: {
            tx: [1, 2, 3],
            outputs: [
              {
                outputIndex: 0,
                protocol: 'wallet payment',
                paymentRemittance: { derivationPrefix: 'a', derivationSuffix: 'b', senderIdentityKey: ALICE },
              },
            ],
          },
        }),
      },
    ]);
    for (let i = 0; i < 3; i++) expect((await relay.list()).length).toBe(4);
    expect(calls).toMatchObject({ decrypt: 0, internalize: 0, lists: 6 });
    const a = device();
    onDevice(a);
    await syncMail(wallet, ME, relay, T0, net);
    expect(mail(a).map((m) => m.id)).toEqual([env.id, wrapped.id]);
    expect(loadRelaySeen(ME).size).toBe(4);
    expect(calls).toMatchObject({ decrypt: 0, internalize: 0 });
  });

  test('clearing: ids the client would refuse are left out, the rest go, 1,000 at most a time', async () => {
    const { relay, calls } = client([]);
    await relay.ack(['good-1', ' lead', 'x'.repeat(257), 'a\nb', '', 'good-2', 'good-1']);
    expect(calls.acks).toEqual([['good-1', 'good-2']]);
    await relay.ack([' only bad ']);
    expect(calls.acks.length).toBe(1);
    await relay.ack(Array.from({ length: ACK_MAX + 500 }, (_, i) => `m${i}`));
    expect(calls.acks[1].length).toBe(ACK_MAX);
    expect(calls.acks.length).toBe(2);
  });

  test('a batch the relay refuses is tried again in halves, so one bad message does not hold up the rest', async () => {
    const sent: string[][] = [];
    const cleared: string[] = [];
    const fake = {
      acknowledgeMessage: async ({ messageIds }: { messageIds: string[] }) => {
        sent.push(messageIds);
        if (messageIds.includes('m5')) throw new Error('HTTP 400');
        cleared.push(...messageIds);
      },
    } as unknown as MessageBoxClient;
    const ids = Array.from({ length: 16 }, (_, i) => `m${i}`);
    await relayOf({} as WalletInterface, fake, 'https://box.test').ack(ids);
    expect(cleared.sort()).toEqual(ids.filter((x) => x !== 'm5').sort());
    expect(sent.length).toBeLessThanOrEqual(24);
  });
});
