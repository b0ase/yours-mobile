/**
 * bMail postage against the REAL wallet-toolbox: the two-device harness (src/testing/twoDeviceSim: two devices on one
 * seed, device sync, a fake chain behind WhatsOnChain / ARC). What is checked here is money: a stamp shows as paid
 * only when the network has it, once, and no device ever shows more than the chain holds because of a letter.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Beef, P2PKH, PrivateKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import { teardownSim, World } from '../../testing/twoDeviceSim/world';
import {
  RECHECK_EVERY_MS,
  RECHECK_TRIES,
  STAMP_HELD,
  STAMP_NO_RECORD,
  STAMP_USED,
  syncMail,
  type MailRelay,
  type RelayMessage,
} from './client';
import { BRC29_PROTOCOL, encodeEnvelope, stampPrefix, type Envelope, type Postage } from './envelope';
import { route } from './route';
import { emptyMail, loadMail, saveMail } from './store';
import { keepGlobals } from '../../testing/stubGlobals';

keepGlobals('localStorage', 'fetch');
// The Store client reads its API base once, when first loaded; every sim file sets the same value (twoDeviceSim.test).
(globalThis as { __PAYMAIL_API__?: string }).__PAYMAIL_API__ ??= 'https://pay.store.test';

const T = 120_000;
let current: World | undefined;
const realWarn = console.warn;
const realLog = console.log;
beforeAll(() => {
  // Every lookup and broadcast bMail makes goes to the current fake chain, never the network.
  globalThis.fetch = ((u: string, i?: RequestInit) =>
    current ? current.chain.fetch(u, i) : Promise.resolve(new Response('', { status: 404 }))) as typeof fetch;
  console.warn = (...a: unknown[]) => current?.log(...a);
  console.log = (...a: unknown[]) => (current ? current.log(...a) : realLog(...a));
});
afterAll(() => {
  console.warn = realWarn;
  console.log = realLog;
  teardownSim();
});
afterEach(async () => {
  await current?.close();
  current = undefined;
});
const world = async (seed: number) => (current = await World.open({ seed }));

const SENDER = PrivateKey.fromRandom().toPublicKey().toString();
let n = 0;
const nextId = () => (++n).toString(16).padStart(32, '0');
const rnd = (len: number) => [...crypto.getRandomValues(new Uint8Array(len))];

/**
 * A stamp of `sats` from SENDER to the wallet, funded by a mined coin. `mined`: in a block, with its proof. Else it is
 * signed and never sent. `forId`: bound to that letter (envelope.ts `bound`).
 */
const stamp = async (
  w: World,
  sats: number,
  o: { mined?: boolean; mempool?: boolean; forId?: string; two?: boolean } = {},
) => {
  const derivationPrefix = o.forId ? stampPrefix(o.forId) : Utils.toBase64(rnd(8));
  const derivationSuffix = Utils.toBase64(rnd(8));
  const priv = w.kd.derivePrivateKey(BRC29_PROTOCOL, `${derivationPrefix} ${derivationSuffix}`, SENDER);
  const k = PrivateKey.fromRandom();
  const parent = new Transaction();
  parent.addInput({
    sourceTXID: Utils.toHex(rnd(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  parent.addOutput({ lockingScript: new P2PKH().lock(k.toAddress()), satoshis: sats + 50 });
  const ptxid = parent.id('hex');
  w.chain.accept(parent);
  w.chain.height++;
  w.chain.txs.get(ptxid)!.block = w.chain.height;
  parent.merklePath = w.chain.merklePath(ptxid);
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
  // A second output to the wallet under its own derivation: a second stamp in the same transaction.
  const second = { derivationPrefix: Utils.toBase64(rnd(8)), derivationSuffix: Utils.toBase64(rnd(8)) };
  if (o.two) {
    const k2 = w.kd.derivePrivateKey(BRC29_PROTOCOL, `${second.derivationPrefix} ${second.derivationSuffix}`, SENDER);
    tx.addOutput({ lockingScript: new P2PKH().lock(k2.toPublicKey().toAddress()), satoshis: 40 });
  }
  await tx.sign();
  const txid = tx.id('hex');
  // The output is the wallet's once the network has the transaction (the chain's own count of what the wallet holds).
  w.chain.owned.set(`${txid}.0`, { sats });
  if (o.two) w.chain.owned.set(`${txid}.1`, { sats: 40 });
  if (o.mempool) w.chain.accept(tx);
  if (o.mined) {
    w.chain.accept(tx);
    w.chain.height++;
    w.chain.txs.get(txid)!.block = w.chain.height;
    tx.merklePath = w.chain.merklePath(txid);
  }
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const postage: Postage = {
    txid,
    sats,
    outputIndex: 0,
    beef: Utils.toHex(beef.toBinaryAtomic(txid)),
    derivationPrefix,
    derivationSuffix,
    ...(o.forId ? { bound: true as const } : {}),
  };
  /** The sender spends the same funding coin elsewhere: a double spend of the stamp. */
  const doubleSpend = async () => {
    const other = new Transaction();
    other.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
    other.addOutput({ lockingScript: new P2PKH().lock(k.toAddress()), satoshis: sats });
    await other.sign();
    return w.chain.accept(other);
  };
  /** The mempool drops the stamp and a miner takes the sender's other spend of the same coin instead. */
  const replace = async () => {
    w.chain.txs.delete(txid);
    for (const [spent, by] of [...w.chain.spentBy]) if (by === txid) w.chain.spentBy.delete(spent);
    const r = await doubleSpend();
    w.chain.mine();
    return r;
  };
  const postage2: Postage = { ...postage, sats: 40, outputIndex: 1, ...second };
  return { postage, postage2, doubleSpend, replace, txid };
};
const me = (w: World) => w.kd.identityKey.toLowerCase();
const letter = (w: World, postage: Postage, id = nextId()): Envelope => ({
  t: 'bmail',
  v: 1,
  id,
  from: SENDER.toLowerCase(),
  to: me(w),
  at: Date.now(),
  sealed: 'c2VhbGVk',
  postage,
});
const fakeRelay = () => {
  const box: RelayMessage[] = [];
  const relay: MailRelay = { list: async () => box.map((m) => ({ ...m })), ack: async () => undefined };
  return {
    relay,
    post: (env: Envelope) =>
      void box.push({ messageId: `relay-${env.id}`, sender: env.from, body: encodeEnvelope(env) }),
  };
};
type Device = World['A'];
const stores = new Map<string, Map<string, string>>();
const sync = async (w: World, d: Device, r: { relay: MailRelay }, now = Date.now()) => {
  const name = `${d.name}-${me(w)}`;
  const mem = stores.get(name) ?? new Map<string, string>();
  stores.set(name, mem);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  };
  await syncMail(d.wallet as unknown as WalletInterface, me(w), r.relay, now);
  return loadMail(me(w)).received;
};
const shown = async (w: World, d: Device) => (await w.view(d)).shown;
const onChain = (w: World) => [...w.chain.unspent('bsv').values()].reduce((x, y) => x + y, 0);
const box = (m: { verifiedSats: number; id: string; from: string; at: number }) =>
  route(m, { isFriend: () => false, priceSats: 1000 });

describe('bMail stamps on the real wallet', () => {
  test(
    'a mined stamp: paid, taken in once; a second fetch and the other device add nothing',
    async () => {
      const w = await world(21);
      const s = await stamp(w, 5000, { mined: true });
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      const a = await sync(w, w.A, r);
      expect(a[0].verifiedSats).toBe(5000);
      expect(a[0].recheck).toBeUndefined();
      expect(await shown(w, w.A)).toBe(5000);
      await sync(w, w.A, r);
      expect(await shown(w, w.A)).toBe(5000);
      // The other device, before any device sync: paid there too; after the devices sync, one coin.
      const b = await sync(w, w.B, r);
      expect(b[0].verifiedSats).toBe(5000);
      await w.settleAndCheck();
      expect(await shown(w, w.A)).toBe(5000);
      expect(await shown(w, w.B)).toBe(5000);
    },
    T,
  );

  test(
    'one stamp, five letters: the first is paid, the other four are unstamped; the money came once',
    async () => {
      const w = await world(22);
      const s = await stamp(w, 5000, { mined: true });
      const r = fakeRelay();
      for (let i = 0; i < 5; i++) r.post(letter(w, s.postage));
      const got = await sync(w, w.A, r);
      expect(got.map((m) => m.verifiedSats)).toEqual([5000, 0, 0, 0, 0]);
      expect(got.slice(1).every((m) => m.verifyNote === STAMP_USED && box(m) === 'requests')).toBe(true);
      expect(await shown(w, w.A)).toBe(5000);
      // The same on the other device, which lists the box in the same order.
      const b = await sync(w, w.B, r);
      expect(b.map((m) => m.verifiedSats)).toEqual([5000, 0, 0, 0, 0]);
    },
    T,
  );

  test(
    'a stamp bound to its letter pays for that letter, and not for another one',
    async () => {
      const w = await world(23);
      const id = nextId();
      const s = await stamp(w, 5000, { mined: true, forId: id });
      const r = fakeRelay();
      r.post(letter(w, s.postage)); // another letter shows it first
      r.post(letter(w, s.postage, id));
      const got = await sync(w, w.A, r);
      expect(got.find((m) => m.id === id)?.verifiedSats).toBe(5000);
      const other = got.find((m) => m.id !== id)!;
      expect(other.verifiedSats).toBe(0);
      expect(other.verifyNote).toBe('This stamp was made for another letter');
      expect(await shown(w, w.A)).toBe(5000);
    },
    T,
  );

  test(
    'a stamp that was signed and never sent: this wallet hands it to the network, then it is paid',
    async () => {
      const w = await world(24);
      const s = await stamp(w, 5000);
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      expect(w.chain.has(s.txid)).toBe(false);
      const got = await sync(w, w.A, r);
      expect(w.chain.has(s.txid)).toBe(true);
      expect(got[0].verifiedSats).toBe(5000);
      expect(await shown(w, w.A)).toBe(5000);
      expect(onChain(w)).toBe(5000);
    },
    T,
  );

  test(
    'never sent and already double-spent: unpaid once a second look agrees, nothing in the wallet',
    async () => {
      const w = await world(25);
      const s = await stamp(w, 5000);
      expect((await s.doubleSpend()).ok).toBe(true);
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      const t0 = Date.now();
      let got = await sync(w, w.A, r, t0);
      expect(got[0].verifiedSats).toBe(0);
      // One refusal is not believed (the lookups said "not there" before and after it): a second look is due.
      expect(got[0].recheck?.doubt).toBeDefined();
      expect(box(got[0])).toBe('requests');
      expect(await shown(w, w.A)).toBe(0);
      expect(await w.statusOf('A', s.txid)).toEqual(await w.statusOf('A', 'f'.repeat(64)));
      got = await sync(w, w.A, r, t0 + RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(0);
      expect(got[0].recheck).toBeUndefined();
      expect(got[0].verifyNote).toContain('refused');
      expect(await shown(w, w.A)).toBe(0);
      expect(onChain(w)).toBe(0);
    },
    T,
  );

  test(
    'never sent, broadcaster down on arrival, double-spent before the re-check: never paid, never a balance',
    async () => {
      const w = await world(26);
      const s = await stamp(w, 5000);
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      w.fault('broadcast', '500', 1);
      const t0 = Date.now();
      let got = await sync(w, w.A, r, t0);
      expect(got[0].verifiedSats).toBe(0);
      expect(got[0].recheck).toMatchObject({ tries: 0, mine: true });
      expect(got[0].verifyNote).toContain('not checked yet');
      expect(await shown(w, w.A)).toBe(0);
      expect((await s.doubleSpend()).ok).toBe(true);
      got = await sync(w, w.A, r, t0 + RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(0);
      expect(got[0].recheck?.doubt).toBeDefined();
      got = await sync(w, w.A, r, t0 + 2 * RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(0);
      expect(got[0].recheck).toBeUndefined();
      expect(box(got[0])).toBe('requests');
      expect(w.chain.has(s.txid)).toBe(false);
      expect(await shown(w, w.A)).toBe(0);
      // The wallet's own sender has nothing of it to send later.
      await w.sendWaiting('A');
      expect(await shown(w, w.A)).toBe(0);
      expect(await w.statusOf('A', s.txid)).toEqual(await w.statusOf('A', 'f'.repeat(64)));
    },
    T,
  );

  test(
    'never sent and the broadcaster gives no answer for hours: not checked, no balance; paid once it answers',
    async () => {
      const w = await world(27);
      const s = await stamp(w, 5000);
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      const t0 = Date.now();
      let got: Awaited<ReturnType<typeof sync>> = [];
      for (let i = 0; i <= RECHECK_TRIES; i++) {
        w.fault('broadcast', '500', 1);
        got = await sync(w, w.A, r, t0 + i * RECHECK_EVERY_MS);
        expect(await shown(w, w.A)).toBe(0);
        expect(got[0].verifiedSats).toBe(0);
      }
      // No answer is not a try: the stamp is still waiting, not given up on.
      expect(got[0].recheck).toMatchObject({ tries: 0 });
      got = await sync(w, w.A, r, t0 + (RECHECK_TRIES + 2) * RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(5000);
      expect(await shown(w, w.A)).toBe(5000);
    },
    T,
  );

  test(
    'the lookups are down on arrival, then back: not checked yet, then paid once',
    async () => {
      const w = await world(28);
      const s = await stamp(w, 5000, { mined: true });
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      w.fault('woc', '500', 4);
      w.fault('arc', '500', 4);
      w.fault('broadcast', '500', 2);
      const t0 = Date.now();
      let got = await sync(w, w.A, r, t0);
      expect(got[0].recheck).toMatchObject({ tries: 0, mine: true });
      expect(await shown(w, w.A)).toBe(0);
      w.chain.clearFaults();
      got = await sync(w, w.A, r, t0 + RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(5000);
      expect(got[0].recheck).toBeUndefined();
      expect(box(got[0])).toBe('inbox');
      expect(await shown(w, w.A)).toBe(5000);
    },
    T,
  );

  test(
    "device A took the stamp and spent it; device B: not paid until it has synced A's record, and never a coin",
    async () => {
      const w = await world(29);
      const s = await stamp(w, 50_000, { mined: true });
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      await sync(w, w.A, r);
      await w.send('A', 20_000); // spends the stamp (A's only coin); the change comes back to A
      const truth = onChain(w);
      expect(await shown(w, w.A)).toBe(truth);
      const t0 = Date.now();
      let b = await sync(w, w.B, r, t0);
      // B's wallet has no record of the stamp yet: spent alone is never paid. B holds no coin for it either.
      expect(b[0].verifiedSats).toBe(0);
      expect(b[0].verifyNote).toBe(STAMP_NO_RECORD);
      expect(await shown(w, w.B)).toBe(0);
      expect(await w.statusOf('B', s.txid)).toEqual(await w.statusOf('B', 'f'.repeat(64)));
      // One ordinary device sync each (A pushes, B pulls and admits what it pulled): the record is on B.
      await w.sync('A');
      await w.sync('B');
      await w.admit(w.B);
      b = await sync(w, w.B, r, t0 + RECHECK_EVERY_MS);
      expect(b[0].verifiedSats).toBe(50_000);
      expect(await shown(w, w.B)).toBe(truth);
      expect(await shown(w, w.A)).toBe(truth);
      await w.settleAndCheck();
    },
    T,
  );

  test(
    'a spent stamp shown again on a new letter pays for nothing: on the device that took it in, and on the other',
    async () => {
      const w = await world(30);
      const s = await stamp(w, 50_000, { mined: true });
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      await sync(w, w.A, r);
      await w.send('A', 20_000);
      const truth = onChain(w);
      // The sender shows the same stamp on a new letter. Device B never stored the first one.
      const r2 = fakeRelay();
      r2.post(letter(w, s.postage));
      const t0 = Date.now();
      let b = await sync(w, w.B, r2, t0);
      expect(b[0].verifiedSats).toBe(0);
      expect(await shown(w, w.B)).toBe(0);
      await w.sync('A');
      await w.sync('B');
      await w.admit(w.B);
      // With the account's record synced: the stamp was taken in for the other letter.
      b = await sync(w, w.B, r2, t0 + RECHECK_EVERY_MS);
      expect(b[0].verifiedSats).toBe(0);
      expect(b[0].verifyNote).toBe(STAMP_USED);
      expect(b[0].recheck).toBeUndefined();
      expect(await shown(w, w.B)).toBe(truth);
      // Device A, which stored the first letter, with its bMail data gone (the record is the wallet's, not the app's).
      stores.delete(`${w.A.name}-${me(w)}`);
      const a = await sync(w, w.A, r2);
      expect(a[0].verifiedSats).toBe(0);
      expect(a[0].verifyNote).toBe(STAMP_USED);
      expect(await shown(w, w.A)).toBe(truth);
    },
    T,
  );

  test(
    'a coin taken in before the record was kept (no labels), still unspent: it pays for no later letter',
    async () => {
      const w = await world(31);
      const s = await stamp(w, 5000, { mined: true });
      // As a released wallet took a stamp in: no labels.
      await (w.A.wallet as unknown as WalletInterface).internalizeAction({
        tx: Utils.toArray(s.postage.beef, 'hex'),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: s.postage.derivationPrefix,
              derivationSuffix: s.postage.derivationSuffix,
              senderIdentityKey: SENDER,
            },
          },
        ],
        description: 'bMail postage received',
      });
      expect(await shown(w, w.A)).toBe(5000);
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      const got = await sync(w, w.A, r);
      expect(got[0].verifiedSats).toBe(0);
      expect(got[0].verifyNote).toBe(STAMP_HELD);
      expect(await shown(w, w.A)).toBe(5000);
    },
    T,
  );

  test(
    'one transaction, two outputs to the wallet, two letters: each output pays for its own letter',
    async () => {
      const w = await world(32);
      const s = await stamp(w, 5000, { mined: true, two: true });
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      r.post(letter(w, s.postage2));
      r.post(letter(w, s.postage2)); // the second output shown again
      const got = await sync(w, w.A, r);
      expect(got.map((m) => m.verifiedSats)).toEqual([5000, 40, 0]);
      expect(got[2].verifyNote).toBe(STAMP_USED);
      expect(await shown(w, w.A)).toBe(5040);
      expect(onChain(w)).toBe(5040);
    },
    T,
  );

  test(
    "paid while in the mempool, then replaced by the sender's other spend: the letter goes back to unpaid",
    async () => {
      const w = await world(33);
      const s = await stamp(w, 5000, { mempool: true });
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      const t0 = Date.now();
      let got = await sync(w, w.A, r, t0);
      expect(got[0].verifiedSats).toBe(5000);
      expect(got[0].settling).toBeDefined();
      expect((await s.replace()).ok).toBe(true);
      got = await sync(w, w.A, r, t0 + RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(5000); // one look is not believed
      got = await sync(w, w.A, r, t0 + 2 * RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(0);
      expect(box(got[0])).toBe('requests');
      got = await sync(w, w.A, r, t0 + 3 * RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(0);
      expect(got[0].recheck).toBeUndefined();
      expect(got[0].verifyNote).toContain('refused');
      expect(onChain(w)).toBe(0);
    },
    T,
  );

  test(
    'in the mempool, then mined: paid throughout, and no longer watched',
    async () => {
      const w = await world(34);
      const s = await stamp(w, 5000, { mempool: true });
      const r = fakeRelay();
      r.post(letter(w, s.postage));
      const t0 = Date.now();
      let got = await sync(w, w.A, r, t0);
      expect(got[0].settling).toBeDefined();
      w.chain.mine();
      got = await sync(w, w.A, r, t0 + RECHECK_EVERY_MS);
      expect(got[0].verifiedSats).toBe(5000);
      expect(got[0].settling).toBeUndefined();
      expect(await shown(w, w.A)).toBe(5000);
    },
    T,
  );

  test(
    'upgrade: a letter an older version stored as paid gets its record on this device, and the other device reads it paid',
    async () => {
      const w = await world(35);
      const s = await stamp(w, 50_000, { mined: true });
      const env = letter(w, s.postage);
      // As a released wallet took the stamp in: no labels. Its letter is stored as paid, with no record.
      await (w.A.wallet as unknown as WalletInterface).internalizeAction({
        tx: Utils.toArray(s.postage.beef, 'hex'),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: s.postage.derivationPrefix,
              derivationSuffix: s.postage.derivationSuffix,
              senderIdentityKey: SENDER,
            },
          },
        ],
        description: 'bMail postage received',
      });
      const mem = new Map<string, string>();
      stores.set(`${w.A.name}-${me(w)}`, mem);
      saveMail(
        me(w),
        { ...emptyMail(), received: [{ id: env.id, from: env.from, at: env.at, verifiedSats: 50_000, env }] },
        { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) },
      );
      await w.send('A', 20_000); // and the coin was spent since
      const truth = onChain(w);
      const r = fakeRelay();
      r.post(env);
      const a = await sync(w, w.A, r);
      expect(a[0].stampRecorded).toBe(true);
      expect(await shown(w, w.A)).toBe(truth);
      await w.sync('A');
      await w.sync('B');
      await w.admit(w.B);
      const b = await sync(w, w.B, r);
      expect(b[0].verifiedSats).toBe(50_000);
      expect(await shown(w, w.B)).toBe(truth);
      await w.settleAndCheck();
    },
    T,
  );
});
