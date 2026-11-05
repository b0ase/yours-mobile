/**
 * Owner's iPhone, 17/19 Oct 2026 (b_feedback 9, 15, 16): sends failed with WERR_REVIEW_ACTIONS / UTXO_SPENT because
 * coins spent from another device (same seed) were still spendable in this device's storage. Reproduced here with a
 * simulated wallet that behaves like the toolbox: createAction reserves (locks) inputs, a refused broadcast fails the
 * action and makes its inputs spendable again, then throws WERR_REVIEW_ACTIONS carrying the tx as AtomicBEEF.
 */
import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk';
import { DeviceNotActiveError } from './deviceActive';
import { healInvalidSend, withHealMessage } from './invalidSendHeal';
import {
  createWithSpentRetry,
  provenNotSent,
  reasonNamesSpender,
  rejectedTxid,
  retryEligible,
  SPENT_ELSEWHERE_MESSAGE,
} from './spentRetry';
import {
  classifySendError,
  DOUBLE_SPEND_PENDING_MESSAGE,
  SPENT_ELSEWHERE_SHORT_MESSAGE,
  OWN_COIN_OTHER_PAYMENT_MESSAGE,
  OWN_PAYMENTS_UNCHECKED_MESSAGE,
  ownPaymentOutMessage,
  REFUSED_MAYBE_SENT_MESSAGE,
  REFUSED_NOT_SENT_MESSAGE,
} from '../utils/sendErrors';

const key = PrivateKey.fromRandom();
const lock = new P2PKH().lock(key.toAddress());
const OTHER_DEVICE_TX = 'e'.repeat(64);

/** A funding tx with `n` 1000-sat outputs; returns it and its outpoints. */
function funding(n: number) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: '0'.repeat(64), sourceOutputIndex: 0, unlockingScript: lock, sequence: 0xffffffff });
  for (let i = 0; i < n; i++) tx.addOutput({ lockingScript: lock, satoshis: 1000 });
  return tx;
}

type Coin = { spendable: boolean; locked: boolean };

/** A toolbox-like wallet over in-memory storage and a fake network. */
function simWallet(
  nCoins: number,
  spentElsewhere: number[],
  refusal: 'invalidTx' | 'doubleSpend' | ((coin: number) => 'invalidTx' | 'doubleSpend') = 'invalidTx',
) {
  const src = funding(nCoins);
  const srcId = src.id('hex');
  const coins = new Map<string, Coin>();
  for (let i = 0; i < nCoins; i++) coins.set(`${srcId}_${i}`, { spendable: true, locked: false });
  const chainSpent = new Map<string, string>(spentElsewhere.map((i) => [`${srcId}_${i}`, OTHER_DEVICE_TX]));
  const accepted: { txid: string; inputs: string[]; sats: number }[] = [];
  const refusals = new Map<string, string>();
  const known = new Set<string>();
  let calls = 0;

  const create = async (sats: number) => {
    calls++;
    const pick = [...coins.entries()].find(([, c]) => c.spendable && !c.locked);
    if (!pick) throw Object.assign(new Error('Insufficient funds'), { name: 'WERR_INSUFFICIENT_FUNDS' });
    const [op, coin] = pick;
    coin.locked = true;
    coin.spendable = false;
    const tx = new Transaction();
    tx.addInput({
      sourceTransaction: src,
      sourceOutputIndex: Number(op.split('_')[1]),
      unlockingScript: lock,
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: lock, satoshis: sats });
    const txid = tx.id('hex');
    const spender = chainSpent.get(op);
    if (spender) {
      // Toolbox: tx failed → inputs restored spendable (lock released), then WERR_REVIEW_ACTIONS.
      coin.locked = false;
      coin.spendable = true;
      refusals.set(
        txid,
        `UTXO_SPENT (70): [ProcessTransaction][${txid}] UTXO_SPENT (70): ${op.replace('_', ':')} utxo already spent by tx ${spender}[0]`,
      );
      throw Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
        name: 'WERR_REVIEW_ACTIONS',
        txid,
        tx: tx.toAtomicBEEF(true),
        reviewActionResults: [
          { txid, status: typeof refusal === 'function' ? refusal(Number(op.split('_')[1])) : refusal },
        ],
      });
    }
    coin.locked = false;
    chainSpent.set(op, txid);
    known.add(txid);
    accepted.push({ txid, inputs: [op], sats });
    return { txid };
  };

  const heal = (e: unknown) =>
    healInvalidSend(
      e,
      async (op) => chainSpent.get(op) ?? null,
      {
        markSpent: async (txid, vout) => {
          const c = coins.get(`${txid}_${vout}`);
          if (!c || !c.spendable) return 0;
          c.spendable = false;
          return 1;
        },
      },
      { reason: refusals.get(rejectedTxid(e) ?? '') },
    );

  const balance = () => [...coins.values()].filter((c) => c.spendable).length * 1000;
  return { srcId, coins, accepted, refusals, known, heal, create, balance, calls: () => calls };
}

const deps = (w: ReturnType<typeof simWallet>, over: Partial<Parameters<typeof createWithSpentRetry>[0]> = {}) => ({
  create: () => w.create(500),
  heal: w.heal,
  reason: (txid: string) => w.refusals.get(txid),
  // The other device's payment is not one this wallet holds, and (for a double spend) it is mined.
  ownTxids: async () => new Set<string>(),
  spendMined: async () => true,
  eligible: true,
  ...over,
});

describe('UTXO_SPENT: coin spent on another device', () => {
  test('reproduction: without the retry, the send fails and the dead coin was still counted as balance', async () => {
    const w = simWallet(3, [0]);
    expect(w.balance()).toBe(3000); // storage counts the coin spent elsewhere
    const r = await createWithSpentRetry(deps(w, { eligible: false }));
    expect(r.ok).toBe(false);
    expect(w.accepted).toHaveLength(0);
  });

  test('the input is marked spent, locks are released, and the balance is corrected', async () => {
    const w = simWallet(3, [0]);
    const r = await createWithSpentRetry(deps(w, { eligible: false }));
    expect(r.heal?.released).toBe(1);
    expect(w.coins.get(`${w.srcId}_0`)).toEqual({ spendable: false, locked: false });
    for (const i of [1, 2]) expect(w.coins.get(`${w.srcId}_${i}`)).toEqual({ spendable: true, locked: false });
    expect(w.balance()).toBe(2000);
  });

  test('DOUBLE_SPEND_ATTEMPTED with the competing spend MINED: healed and retried once', async () => {
    const w = simWallet(3, [0], 'doubleSpend');
    const asked: string[][] = [];
    const r = await createWithSpentRetry(deps(w, { spendMined: async (op, by) => (asked.push([op, by]), true) }));
    expect(asked).toEqual([[`${w.srcId}_0`, OTHER_DEVICE_TX]]);
    expect(r.ok).toBe(true);
    expect(r.retried).toBe(true);
    expect(r.heal?.released).toBe(1);
    expect(w.accepted).toHaveLength(1);
    expect(w.accepted[0].inputs).toEqual([`${w.srcId}_1`]);
    expect(w.balance()).toBe(1000); // coin 0 cleared, coin 1 spent by the retry
  });

  test('DOUBLE_SPEND_ATTEMPTED with the competing spend NOT mined (review 17, F2): healed, never retried', async () => {
    for (const spendMined of [async () => false, async () => null, async () => Promise.reject(new Error('woc down'))]) {
      const w = simWallet(3, [0], 'doubleSpend');
      const r = await createWithSpentRetry(deps(w, { spendMined }));
      expect(r.ok).toBe(false);
      expect(r.retried).toBe(false);
      expect(r.heal?.released).toBe(1); // the balance is still corrected
      expect(w.accepted).toHaveLength(0);
      expect(r.ok ? undefined : r.notice).toBe(DOUBLE_SPEND_PENDING_MESSAGE);
    }
  });

  test("the spent coin's spender is a payment THIS wallet holds (review 17, F1): never retried, the person is told", async () => {
    const w = simWallet(3, [0]);
    const r = await createWithSpentRetry(deps(w, { ownTxids: async (t) => new Set(t) }));
    expect(r.ok).toBe(false);
    expect(r.retried).toBe(false);
    expect(w.accepted).toHaveLength(0);
    expect(r.heal?.released).toBe(1);
    // Not known to have paid this payee (17b L1): "a coin went to another payment of this wallet", no "won't pay twice".
    expect(r.ok ? undefined : r.notice).toBe(OWN_COIN_OTHER_PAYMENT_MESSAGE);
    // It paid this payee: then it is named, with its txid (the background strips it for sites).
    const same = simWallet(3, [0]);
    const t = await createWithSpentRetry(
      deps(same, { ownTxids: async (x) => new Set(x), samePayee: async (txid) => txid === OTHER_DEVICE_TX }),
    );
    expect(t.ok ? undefined : t.notice).toBe(ownPaymentOutMessage(OTHER_DEVICE_TX));
    // Not even a non-eligible caller (a site) is told to "try again".
    const site = simWallet(3, [0]);
    const s = await createWithSpentRetry(deps(site, { eligible: false, ownTxids: async (x) => new Set(x) }));
    expect(s.ok ? undefined : s.notice).toBe(OWN_COIN_OTHER_PAYMENT_MESSAGE);
  });

  test('17b H1: every double spend not proven dead says "may still go through", in every branch', async () => {
    // A site (not eligible), the toolbox having cleared the coin itself (released 0), and the retry's own refusal.
    const site = simWallet(3, [0], 'doubleSpend');
    const a = await createWithSpentRetry(deps(site, { eligible: false, spendMined: async () => false }));
    const own = simWallet(3, [0], 'doubleSpend');
    const b = await createWithSpentRetry(
      deps(own, { heal: async () => ({ checked: 1, released: 0, spenders: {} }), spendMined: async () => false }),
    );
    const two = simWallet(3, [0, 1], (coin) => (coin === 0 ? 'invalidTx' : 'doubleSpend'));
    const c = await createWithSpentRetry(deps(two, { spendMined: async () => false }));
    expect(c.retried).toBe(true);
    for (const r of [a, b, c]) {
      expect(r.ok).toBe(false);
      expect(r.ok ? undefined : r.notice).toBe(DOUBLE_SPEND_PENDING_MESSAGE);
    }
    expect(site.accepted.length + own.accepted.length + two.accepted.length).toBe(0);
  });

  test('17c: "not sent" only with hard proof; a refusal without it says "can\'t confirm" and is never retried', async () => {
    // No spender named, and no input known spent by another tx: the refused tx may have gone out.
    for (const heal of [
      async () => ({ checked: 1, released: 0 }),
      async () => ({ checked: 1, released: 1, inputs: ['ab'.repeat(32) + '_0'], spenders: {}, cleared: [] }),
    ]) {
      const w = simWallet(3, [0]);
      const r = await createWithSpentRetry(deps(w, { reason: () => 'REJECTED', heal }));
      expect(r.retried).toBe(false);
      expect(r.ok ? undefined : r.notice).toBe(REFUSED_MAYBE_SENT_MESSAGE);
    }
    // The broadcaster named a DIFFERENT spender (17c M4: whatever WhatsOnChain says): proof.
    const named = simWallet(3, [0]);
    const r = await createWithSpentRetry(
      deps(named, {
        heal: async () => ({ checked: 1, released: 0 }),
        reason: () => `UTXO_SPENT spent by tx ${'f'.repeat(64)}`,
      }),
    );
    expect(r.ok ? undefined : r.notice).toBe(REFUSED_NOT_SENT_MESSAGE);
    // Every input known spent by another tx, no reason at all: proof too.
    expect(
      provenNotSent('a'.repeat(64), undefined, {
        checked: 1,
        released: 1,
        inputs: ['b'.repeat(64) + '_0'],
        spenders: { ['b'.repeat(64) + '_0']: 'c'.repeat(64) },
      }),
    ).toBe(true);
    expect(provenNotSent('a'.repeat(64), undefined, { checked: 1, released: 0, inputs: [], spenders: {} })).toBe(false);
  });

  test('storage can\'t say whose the spender is: no retry (fail closed), and never "try again" (17d L3)', async () => {
    for (const ownTxids of [async () => null, async () => Promise.reject(new Error('locked'))]) {
      const w = simWallet(3, [0]);
      const r = await createWithSpentRetry(deps(w, { ownTxids }));
      expect(r.retried).toBe(false);
      expect(w.accepted).toHaveLength(0);
      // Before: SPENT_ELSEWHERE_MESSAGE ("spent from another device… try again", moneyMoved 'no').
      expect(r.ok ? undefined : r.notice).toBe(OWN_PAYMENTS_UNCHECKED_MESSAGE);
      expect(classifySendError(OWN_PAYMENTS_UNCHECKED_MESSAGE).moneyMoved).toBe('unknown');
    }
  });

  test('retries once with a different input and sends exactly once', async () => {
    const w = simWallet(3, [0]);
    const r = await createWithSpentRetry(deps(w));
    expect(r.ok).toBe(true);
    expect(r.retried).toBe(true);
    expect(w.calls()).toBe(2);
    expect(w.accepted).toHaveLength(1);
    expect(w.accepted[0].inputs).toEqual([`${w.srcId}_1`]);
    expect(w.accepted[0].sats).toBe(500); // same amount as approved
  });

  test('only one retry: a second dead coin gives the plain message, not the toolbox text', async () => {
    const w = simWallet(3, [0, 1]);
    const r = await createWithSpentRetry(deps(w));
    expect(r.ok).toBe(false);
    expect(r.retried).toBe(true);
    expect(w.calls()).toBe(2);
    expect(w.accepted).toHaveLength(0);
    expect(r.heal?.released).toBe(2); // both dead coins cleared
    expect(w.balance()).toBe(1000);
    const shown = withHealMessage('Undelayed createAction … UTXO_SPENT (70) …', r.ok ? null : r.heal);
    expect(shown).toBe(SPENT_ELSEWHERE_MESSAGE);
    // The next tap sends with the last live coin.
    const again = await createWithSpentRetry(deps(w));
    expect(again.ok && !again.retried).toBe(true);
    expect(w.accepted[0].inputs).toEqual([`${w.srcId}_2`]);
  });

  test('never retries when the broadcaster names the refused tx itself as the spender (it went out)', async () => {
    const w = simWallet(3, [0]);
    const r = await createWithSpentRetry(
      deps(w, { reason: (txid) => `UTXO_SPENT (70): x:0 utxo already spent by tx ${txid}[0]` }),
    );
    expect(r.retried).toBe(false);
    expect(w.calls()).toBe(1);
    expect(r.ok ? undefined : r.notice).toBe(REFUSED_MAYBE_SENT_MESSAGE);
  });

  test('17c L4: the retry fails without a refusal: "can\'t confirm" unless it failed before signing', async () => {
    const run = async (second: Error) => {
      const w = simWallet(3, [0]);
      let n = 0;
      return createWithSpentRetry(
        deps(w, { create: async () => (n++ === 0 ? w.create(500) : Promise.reject(second)) }),
      );
    };
    const svc = await run(Object.assign(new Error('broadcast service error'), { name: 'WERR_REVIEW_ACTIONS' }));
    expect(svc.ok ? undefined : svc.notice).toBe(REFUSED_MAYBE_SENT_MESSAGE);
    const short = await run(Object.assign(new Error('Insufficient funds'), { name: 'WERR_INSUFFICIENT_FUNDS' }));
    expect(short.ok ? undefined : short.notice).toBe(SPENT_ELSEWHERE_SHORT_MESSAGE);
    // Refused before anything was built because this device's store wasn't active yet: its own "Nothing was sent".
    const notActive = await run(new DeviceNotActiveError());
    expect(notActive.ok ? undefined : notActive.notice).toBeUndefined();
    expect(classifySendError(notActive.ok ? undefined : notActive.error)).toMatchObject({ moneyMoved: 'no' });
    // The toolbox's raw refusal after a heal (a step that may follow signing) keeps "can't confirm".
    const raw = await run(
      Object.assign(
        new Error(
          "WalletStorageManager is not accessing user's active storage or there are conflicting active stores configured.",
        ),
        { name: 'WERR_NOT_ACTIVE' },
      ),
    );
    expect(raw.ok ? undefined : raw.notice).toBe(REFUSED_MAYBE_SENT_MESSAGE);
  });

  test('never retries when nothing could be cleared (would pick the same coin)', async () => {
    const w = simWallet(3, [0]);
    const r = await createWithSpentRetry(deps(w, { heal: async () => ({ checked: 1, released: 0 }) }));
    expect(r.retried).toBe(false);
    expect(w.calls()).toBe(1);
  });

  test('other failures pass through untouched, no heal, no retry', async () => {
    let healed = 0;
    const err = new Error('Insufficient funds');
    const r = await createWithSpentRetry({
      create: async () => Promise.reject(err),
      heal: async () => (healed++, null),
      ownTxids: async () => new Set<string>(),
      spendMined: async () => null,
      eligible: true,
    });
    expect(r).toEqual({ ok: false, error: err, retried: false, heal: null });
    expect(healed).toBe(0);
  });
});

describe('retryEligible: only the wallet’s own fixed-amount send', () => {
  const base = { isAdmin: true, continuing: false, delayed: false, sendAll: false, args: {} };
  test('admin plain send is eligible', () => expect(retryEligible(base)).toBe(true));
  test('dApps, chains, delayed, send-all, explicit inputs, noSend, unsigned are not', () => {
    expect(retryEligible({ ...base, isAdmin: false })).toBe(false);
    expect(retryEligible({ ...base, continuing: true })).toBe(false);
    expect(retryEligible({ ...base, delayed: true })).toBe(false);
    expect(retryEligible({ ...base, sendAll: true })).toBe(false);
    expect(retryEligible({ ...base, args: { inputs: [{}] } })).toBe(false);
    expect(retryEligible({ ...base, args: { inputBEEF: [1] } })).toBe(false);
    expect(retryEligible({ ...base, args: { options: { noSend: true } } })).toBe(false);
    expect(retryEligible({ ...base, args: { options: { signAndProcess: false } } })).toBe(false);
    expect(retryEligible({ ...base, args: { options: { acceptDelayedBroadcast: true } } })).toBe(false);
  });
});

describe('helpers', () => {
  test('rejectedTxid / reasonNamesSpender', () => {
    const t = 'A'.repeat(64);
    expect(rejectedTxid({ reviewActionResults: [{ txid: t, status: 'invalidTx' }] })).toBe(t.toLowerCase());
    expect(rejectedTxid({ reviewActionResults: [{ txid: 'x', status: 'invalidTx' }] })).toBeUndefined();
    expect(reasonNamesSpender(`already spent by tx ${'a'.repeat(64)}[0]`, 'a'.repeat(64))).toBe(true);
    expect(reasonNamesSpender(`already spent by tx ${'b'.repeat(64)}[0]`, 'a'.repeat(64))).toBe(false);
  });
});
