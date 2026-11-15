import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { P2PKH, PrivateKey, Transaction, Utils, type WalletInterface } from '@bsv/sdk';
import * as bmailClient from '../bmail/client';
import type { StampNet } from '../bmail/client';
import { tscToMerklePath } from '../bmail/delivery';
import { encodeEnvelope, type Envelope } from '../bmail/envelope';
import { loadMail } from '../bmail/store';
import { keepGlobals } from '../../testing/stubGlobals';

// bun runs every test file in one process: put back the globals this file swaps so they can't leak into the next.
keepGlobals('localStorage');

// The message box and the wallet's BEEF check are mocked: these tests cover the door's own rules.
type Msg = { messageId: string; sender: string; body: string };
let inbox: Msg[] = [];
let sent: { recipient: string; messageBox: string; body: string }[] = [];
let acked: string[] = [];
let paidSats = 20_000;
let internalized = 0;
let listed: { messageBox?: string; acceptPayments?: boolean }[] = [];
/** The door's own rules are tested with the BEEF check mocked; the money tests below run the real verifyPostage. */
let realCheck = false;
// Keep the real exports: bun module mocks are process-wide, and a partial mock left behind breaks later files that
// import other names from it.
const realMessageBox = { ...(await import('@bsv/message-box-client')) };
mock.module('@bsv/message-box-client', () => ({
  ...realMessageBox,
  MessageBoxClient: class {
    async listMessages(a: { messageBox?: string; acceptPayments?: boolean }) {
      listed.push(a);
      return inbox.filter((m) => !acked.includes(m.messageId));
    }
    async acknowledgeMessage({ messageIds }: { messageIds: string[] }) {
      acked.push(...messageIds);
    }
    async sendMessage(m: { recipient: string; messageBox: string; body: string }) {
      sent.push(m);
    }
  },
}));
// A copy taken before mocking (the mock patches the module namespace in place).
const realClient = { ...bmailClient };
mock.module('../bmail/client', () => ({
  // Keep the real exports (bun module mocks leak across test files; bMail's own tests need sendMail).
  ...realClient,
  bmailHost: () => 'https://box.test',
  verifyPostage: async (...a: Parameters<typeof bmailClient.verifyPostage>) => {
    if (realCheck) return realClient.verifyPostage(...a);
    if (!(a[2] ?? true)) return { sats: paidSats };
    internalized++;
    return { sats: paidSats, fresh: true };
  },
}));
// Put both modules back when this file is done: bMail's own tests fetch through the real verifyPostage.
afterAll(() => {
  mock.module('@bsv/message-box-client', () => realMessageBox);
  mock.module('../bmail/client', () => realClient);
});

const door = await import('./door');
const { checkDoorRequest, parseDoorRequest, runDoor, doorPriceUsd, minAcceptSats, needsHandCheck, loadLedger } = door;

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const K = (c: string) => `02${c.repeat(64)}`;
const HOST = K('b');
const PAYER = K('a');
const NOW = 1_760_000_000_000;
const req = (o: Record<string, unknown> = {}) => ({
  t: 'spacedoor',
  v: 1,
  id: 'ab'.repeat(16),
  from: PAYER,
  to: HOST,
  ticker: 'PENNY1',
  ordAddress: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
  usd: 0.01,
  at: NOW,
  payment: {
    txid: 'c'.repeat(64),
    sats: 20_000,
    outputIndex: 0,
    beef: 'beef',
    derivationPrefix: 'p',
    derivationSuffix: 's',
  },
  ...o,
});
const msg = (id: string, body: unknown, sender = PAYER): Msg => ({ messageId: id, sender, body: JSON.stringify(body) });
const run = (sendTicket = async () => 'd'.repeat(64)) =>
  runDoor({} as never, { hostKey: HOST, ticker: 'PENNY1', priceSats: 20_000, sendTicket, now: () => NOW });

beforeEach(() => {
  inbox = [];
  sent = [];
  acked = [];
  paidSats = 20_000;
  internalized = 0;
  listed = [];
  realCheck = false;
  store.clear();
});

describe('door request parsing', () => {
  test('accepts a good request and normalises the ticker', () => {
    expect(parseDoorRequest(JSON.stringify(req({ ticker: 'penny1' })))?.ticker).toBe('PENNY1');
  });
  test('rejects a bad address, self-payment, or missing payment', () => {
    expect(parseDoorRequest(req({ ordAddress: 'nope' }))).toBeNull();
    expect(parseDoorRequest(req({ to: PAYER }))).toBeNull();
    expect(parseDoorRequest(req({ payment: null }))).toBeNull();
  });
});

describe('door checks', () => {
  const ctx = { sender: PAYER, hostKey: HOST, ticker: 'PENNY1', priceSats: 20_000, ledger: {}, now: NOW };
  const r = () => parseDoorRequest(req())!;
  test('ok', () => expect(checkDoorRequest(r(), ctx).ok).toBe(true));
  test('sender must be the payer the relay authenticated', () =>
    expect(checkDoorRequest(r(), { ...ctx, sender: K('e') }).ok).toBe(false));
  test('a txid already used is refused', () => {
    const c = checkDoorRequest(r(), {
      ...ctx,
      ledger: { ['c'.repeat(64)]: { status: 'sent', ticker: 'PENNY1', payer: PAYER, at: NOW } },
    });
    expect(c.ok).toBe(false);
  });
  test('underpaid is refused; small rate drift is fine', () => {
    expect(checkDoorRequest(r(), { ...ctx, priceSats: 30_000 }).ok).toBe(false);
    expect(checkDoorRequest(r(), { ...ctx, priceSats: 24_000 }).ok).toBe(true);
  });
  test('stale request refused; no rate yet means retry later', () => {
    expect(checkDoorRequest(r(), { ...ctx, now: NOW + 7 * 3600_000 }).ok).toBe(false);
    const c = checkDoorRequest(r(), { ...ctx, priceSats: null });
    expect(c.ok === false && c.retry).toBe(true);
  });
  test('price defaults to one cent', () => {
    expect(doorPriceUsd(null)).toBe(0.01);
    expect(doorPriceUsd(0.05)).toBe(0.05);
    expect(minAcceptSats(20_000)).toBe(16_000);
  });
});

describe('runDoor', () => {
  test('one admission per txid, even when the same payment is sent twice', async () => {
    inbox = [msg('m1', req()), msg('m2', req({ id: 'cd'.repeat(16) }))];
    const tickets: string[] = [];
    const r = await run(async () => {
      tickets.push('x');
      return 'd'.repeat(64);
    });
    expect(r.admitted).toBe(1);
    expect(tickets.length).toBe(1);
    expect(internalized).toBe(1);
    expect(acked.sort()).toEqual(['m1', 'm2']);
    // Both get an ok reply (the repeat is told it is already in).
    const replies = sent.filter((s) => s.messageBox === 'spacedoor_reply').map((s) => JSON.parse(s.body));
    expect(replies.every((x) => x.ok)).toBe(true);
    // A later pass with the same payment again sends nothing.
    inbox.push(msg('m3', req({ id: 'ef'.repeat(16) })));
    const again = await run();
    expect(again.admitted).toBe(0);
  });

  test('a payment smaller than claimed is refused and not taken', async () => {
    paidSats = 100;
    inbox = [msg('m1', req())];
    const r = await run();
    expect(r.admitted).toBe(0);
    expect(r.refused).toBe(1);
    expect(internalized).toBe(0);
  });

  test('a forged sender is refused without touching money', async () => {
    inbox = [msg('m1', req(), K('e'))];
    const r = await run();
    expect(r.admitted).toBe(0);
    expect(internalized).toBe(0);
  });

  test('a failed ticket send is never retried automatically', async () => {
    inbox = [msg('m1', req())];
    const r = await run(async () => {
      throw new Error('broadcast failed');
    });
    expect(r.check).toBe(1);
    expect(needsHandCheck(loadLedger(HOST), 'PENNY1').length).toBe(1);
    inbox.push(msg('m2', req({ id: 'cd'.repeat(16) })));
    let calls = 0;
    await run(async () => {
      calls++;
      return 'd'.repeat(64);
    });
    expect(calls).toBe(0);
  });

  test('requests for another room stay in the box', async () => {
    inbox = [msg('m1', req({ ticker: 'OTHER' }))];
    await run();
    expect(acked).toEqual([]);
  });
});

describe('runDoor: the payment, the network and the account record (the real postage check)', () => {
  /** The key the host's wallet derives for the payment. */
  const PAID = PrivateKey.fromRandom();
  const payment = async (sats = 20_000) => {
    const k = PrivateKey.fromRandom();
    const parent = new Transaction();
    parent.addOutput({ lockingScript: new P2PKH().lock(k.toAddress()), satoshis: sats + 100 });
    parent.merklePath = tscToMerklePath(parent.id('hex'), 0, [], 900_000);
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
    tx.addOutput({ lockingScript: new P2PKH().lock(PAID.toPublicKey().toHash()), satoshis: sats });
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
  /** The network: which transactions it has, which it refuses when handed them, what is spent, whether it answers. */
  const network = (o: { has?: string[]; refuses?: string[]; down?: boolean } = {}) => {
    const has = new Set(o.has ?? []);
    const state = { down: !!o.down, broadcasts: 0, spent: new Set<string>(), gate: null as Promise<void> | null };
    const net: StampNet = {
      seen: async (txid) => {
        if (state.gate) await state.gate;
        return state.down ? 'unclear' : has.has(txid) ? 'seen' : 'missing';
      },
      broadcast: async (beefHex) => {
        state.broadcasts++;
        if (state.down) return 'unclear';
        const txid = Transaction.fromAtomicBEEF(Utils.toArray(beefHex, 'hex')).id('hex');
        if (o.refuses?.includes(txid)) return 'refused';
        has.add(txid);
        return 'seen';
      },
      spender: async (outpoint) => {
        if (state.down) throw new Error('woc 500');
        return state.spent.has(outpoint) ? 'f'.repeat(64) : null;
      },
    };
    return { net, state };
  };
  /**
   * The host's account: the payments its wallet took in and the labels it keeps on each (the record of what a
   * payment paid for). Two host devices given the same account have synced.
   */
  type Account = Map<string, Set<string>>;
  const host = (account: Account = new Map(), spent: Set<string> = new Set()) => {
    const mem = new Map<string, string>();
    let locked = 0;
    const wallet = {
      getPublicKey: async (a: { identityKey?: boolean }) => {
        if (!a.identityKey && locked-- > 0) throw new Error('Wallet is locked');
        return { publicKey: a.identityKey ? HOST : PAID.toPublicKey().toString() };
      },
      internalizeAction: async (a: { tx: number[]; labels?: string[] }) => {
        const txid = Transaction.fromAtomicBEEF(a.tx).id('hex');
        const isMerge = account.has(txid);
        const labels = account.get(txid) ?? new Set<string>();
        for (const l of a.labels ?? []) labels.add(l.trim().toLowerCase());
        account.set(txid, labels);
        return { accepted: true, isMerge, satoshis: isMerge ? 0 : 1 };
      },
      listActions: async (a: { labels: string[] }) => ({
        actions: [...account]
          .filter(([, labels]) => a.labels.some((l) => labels.has(l)))
          .map(([txid, labels]) => ({ txid, status: 'completed', labels: [...labels] })),
      }),
      listOutputs: async () => {
        const outputs = [...account.keys()].filter((t) => !spent.has(`${t}_0`)).map((t) => ({ outpoint: `${t}.0` }));
        return { totalOutputs: outputs.length, outputs };
      },
    } as unknown as WalletInterface;
    const use = () =>
      void ((globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => void mem.set(k, v),
        removeItem: (k: string) => void mem.delete(k),
      });
    return { wallet, account, use, lock: (n: number) => void (locked = n) };
  };
  type Host = ReturnType<typeof host>;
  let tickets: string[] = [];
  const open = (h: Host, net: StampNet, now = NOW) => {
    h.use();
    return runDoor(h.wallet, {
      hostKey: HOST,
      ticker: 'PENNY1',
      priceSats: 20_000,
      now: () => now,
      net,
      sendTicket: async ({ payer }) => {
        tickets.push(payer);
        return 'd'.repeat(64);
      },
    });
  };
  const replies = () => sent.filter((x) => x.messageBox === 'spacedoor_reply').map((x) => JSON.parse(x.body));
  let ids = 0;
  const ask = (p: unknown, at = NOW, from = PAYER) =>
    req({ id: (++ids).toString(16).padStart(32, '0'), payment: p, at, from });
  beforeEach(() => {
    realCheck = true;
    tickets = [];
  });
  afterAll(() => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  test('a payment the network has: taken in under a record for this request, one ticket', async () => {
    const p = await payment();
    const r1 = ask(p);
    inbox = [msg('m1', r1)];
    const h = host();
    const { net } = network({ has: [p.txid] });
    expect((await open(h, net)).admitted).toBe(1);
    expect(tickets.length).toBe(1);
    expect([...(h.account.get(p.txid) ?? [])]).toEqual([`bmail stamp ${p.txid}.0`, `bmail paid door ${r1.id}`]);
    expect(replies()).toMatchObject([{ ok: true }]);
    expect(acked).toEqual(['m1']);
  });

  test('never sent and refused by the network: no ticket, nothing taken in; refused once a second look agrees', async () => {
    const p = await payment();
    inbox = [msg('m1', ask(p))];
    const h = host();
    const { net, state } = network({ refuses: [p.txid] });
    expect(await open(h, net)).toMatchObject({ admitted: 0, refused: 0 });
    expect(acked).toEqual([]);
    // Not looked at again before its time.
    await open(h, net, NOW + door.DOOR_CONFIRM_MS - 1);
    expect(state.broadcasts).toBe(1);
    expect(await open(h, net, NOW + door.DOOR_CONFIRM_MS)).toMatchObject({ admitted: 0, refused: 1 });
    expect(state.broadcasts).toBe(2);
    expect(tickets).toEqual([]);
    expect(h.account.size).toBe(0);
    expect(replies()).toMatchObject([{ ok: false }]);
    expect(acked).toEqual(['m1']);
  });

  test('no answer from the network: nothing taken, sent or recorded; once it has the payment, one ticket', async () => {
    const p = await payment();
    inbox = [msg('m1', ask(p))];
    const h = host();
    const { net, state } = network({ down: true });
    expect(await open(h, net)).toMatchObject({ admitted: 0, refused: 0 });
    expect(h.account.size).toBe(0);
    expect(loadLedger(HOST)).toEqual({});
    expect(acked).toEqual([]);
    state.down = false;
    expect((await open(h, net)).admitted).toBe(1);
    expect(tickets.length).toBe(1);
    expect(acked).toEqual(['m1']);
  });

  test("yesterday's payment, asked again at the host's other device: no second ticket, synced or not", async () => {
    const p = await payment();
    const phone = host();
    const { net, state } = network({ has: [p.txid] });
    inbox = [msg('m1', ask(p))];
    expect((await open(phone, net)).admitted).toBe(1);
    state.spent.add(`${p.txid}_0`); // the host spends the coin
    const later = NOW + 86_400_000;
    // The desktop has synced the wallet (the same account record), and none of the phone's app data.
    const desktop = host(phone.account, state.spent);
    inbox.push(msg('m2', ask(p, later)));
    expect(await open(desktop, net, later)).toMatchObject({ admitted: 0, refused: 1 });
    // A device that has not synced has no record of a spent payment: it waits, and never sends a ticket for it.
    const stale = host(new Map(), state.spent);
    inbox.push(msg('m3', ask(p, later)));
    expect(await open(stale, net, later)).toMatchObject({ admitted: 0, refused: 0 });
    expect(acked).toEqual(['m1', 'm2']);
    expect(tickets.length).toBe(1);
  });

  test('the very same request sent again to the other device: paid, but the ticket is left for the host to check', async () => {
    const p = await payment();
    const again = ask(p);
    const phone = host();
    const { net } = network({ has: [p.txid] });
    inbox = [msg('m1', again)];
    expect((await open(phone, net)).admitted).toBe(1);
    const desktop = host(phone.account);
    inbox.push(msg('m2', again));
    const r = await open(desktop, net);
    expect(r).toMatchObject({ admitted: 0, check: 1 });
    expect(tickets.length).toBe(1);
    desktop.use();
    expect(needsHandCheck(loadLedger(HOST), 'PENNY1').length).toBe(1);
  });

  test('a payment that paid for a bMail letter buys no ticket, spent or not; nor one already in the wallet', async () => {
    const [stampOfALetter, spentStamp, held] = [await payment(), await payment(), await payment()];
    const { net, state } = network({ has: [stampOfALetter.txid, spentStamp.txid, held.txid] });
    state.spent.add(`${spentStamp.txid}_0`);
    const h = host(new Map(), state.spent);
    for (const p of [stampOfALetter, spentStamp])
      h.account.set(p.txid, new Set([`bmail stamp ${p.txid}.0`, bmailClient.usedLabel(`letter ${'ab'.repeat(16)}`)]));
    h.account.set(held.txid, new Set());
    inbox = [msg('m1', ask(stampOfALetter)), msg('m2', ask(spentStamp)), msg('m3', ask(held))];
    expect(await open(h, net)).toMatchObject({ admitted: 0, refused: 3 });
    expect(tickets).toEqual([]);
  });

  test('the same payment as a door request and a bMail stamp, checked at the same moment: the ticket, no paid letter', async () => {
    const p = await payment();
    const h = host();
    const { net, state } = network({ has: [p.txid] });
    inbox = [msg('m1', ask(p))];
    const env = {
      t: 'bmail',
      v: 1,
      id: 'ab'.repeat(16),
      from: PAYER,
      to: HOST,
      at: NOW,
      sealed: 'c2VhbGVk',
      postage: p,
    };
    const relay = {
      list: async () => [{ messageId: 'r1', sender: PAYER, body: encodeEnvelope(env as Envelope) }],
      ack: async () => undefined,
    };
    let release!: () => void;
    state.gate = new Promise<void>((ok) => (release = ok));
    const atDoor = open(h, net);
    const mail = realClient.syncMail(h.wallet, HOST, relay, NOW, net);
    await new Promise((ok) => setTimeout(ok, 20));
    state.gate = null;
    release();
    const [r] = await Promise.all([atDoor, mail]);
    h.use();
    const letter = loadMail(HOST).received[0];
    expect(r.admitted).toBe(1);
    expect(letter.verifiedSats).toBe(0);
    expect(letter.verifyNote).toBe(bmailClient.STAMP_USED);
  });

  test('a wallet that is locked for a moment refuses nothing and records nothing: the request is paid next pass', async () => {
    const p = await payment();
    inbox = [msg('m1', ask(p))];
    const h = host();
    const { net } = network({ has: [p.txid] });
    h.lock(1);
    expect(await open(h, net)).toMatchObject({ admitted: 0, refused: 0 });
    expect(loadLedger(HOST)).toEqual({});
    expect(acked).toEqual([]);
    expect(sent).toEqual([]);
    expect((await open(h, net)).admitted).toBe(1);
    expect(tickets.length).toBe(1);
  });

  test("a junk request that names someone's payment does not use that payment up", async () => {
    const p = await payment();
    const h = host();
    const { net } = network({ has: [p.txid] });
    const EVE = K('e');
    // Eve knows the txid (it is on chain) and sends a request with a made-up proof before the payer's is read.
    inbox = [msg('e1', ask({ ...p, beef: '00' }, NOW, EVE), EVE), msg('good', ask(p))];
    const r = await open(h, net);
    expect(r).toMatchObject({ admitted: 1, refused: 1 });
    expect(tickets).toEqual([PAYER]);
  });

  test('the door boxes are listed with message-box payments off', async () => {
    realCheck = false;
    await run();
    await door.readDoorReply({} as never, 'ab'.repeat(16));
    expect(listed.map((x) => [x.messageBox, x.acceptPayments])).toEqual([
      ['spacedoor', false],
      ['spacedoor_reply', false],
    ]);
  });
});
