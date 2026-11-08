// Reviewer repro (audit M5 follow-up): drives the REAL OfferCard Pay flow in BsharesPage.tsx (and the real
// PayConfirmSheet) through a tiny renderer (hooks stubbed, useState kept per mount), the real BsharesApi over a fake
// Http, and a fake wallet. Never broadcasts.
// The 'no double pay' tests fail on origin/bwallet (each tap paid again via /paid). The two that were test.failing on
// fix/sec-bshares-claim (payment record written only after createAction; not_configured treated as final) pass now.
// Harness changes since the review (8 Nov 2026): the Pay button is found by data-testid, since it is relabelled
// "Check payment" / "Try the claim again" while a record exists; Pay opens a confirm sheet whose Pay the person taps
// (a "may have gone out" sheet is left on its default, Cancel); the fake quote's memo_script is the real encoding of
// its memo, which checkQuote now requires; the fake wallet lists the actions it made.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as React from 'react';

// ── storage (persists across "app restarts" inside one test) ────────────────────────────────────────────────────
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

// ── hooks stubbed so components can be called as plain functions; useState keeps its value per mount ──────────
const slots: unknown[] = [];
let cursor = 0;
mock.module('react', () => ({
  ...React,
  default: React,
  useState: <T>(i: T | (() => T)) => {
    const k = cursor++;
    if (!(k in slots)) slots[k] = typeof i === 'function' ? (i as () => T)() : i;
    return [
      slots[k],
      (v: unknown) => {
        slots[k] = typeof v === 'function' ? (v as (p: unknown) => unknown)(slots[k]) : v;
      },
    ];
  },
  useEffect: () => undefined,
  useRef: <T>(v: T) => ({ current: v }),
}));
mock.module('react-router-dom', () => ({ useNavigate: () => () => undefined }));
const snacks: string[] = [];
mock.module('../../hooks/useSnackbar', () => ({ useSnackbar: () => ({ addSnackbar: (m: string) => snacks.push(m) }) }));
mock.module('../../components/TopNav', () => ({ TopNav: () => null }));
mock.module('./CompanySetup', () => ({ CompanySetup: () => null, CreateCompany: () => null }));

// ── wallet ──────────────────────────────────────────────────────────────────────────────────────────────────────
const T = '5221' + '00'.repeat(10) + 'ae';
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
const memoScript = (memo: string) => `006a${Buffer.byteLength(memo).toString(16).padStart(2, '0')}${hex(memo)}`;
type Args = {
  outputs: { lockingScript: string; satoshis: number }[];
  labels?: string[];
  options?: Record<string, unknown>;
};
type Listed = { txid: string; status: string; outputs: { lockingScript: string }[] };
let created = 0;
const walletActions: Listed[] = [];
const createArgs: Args[] = [];
const nextTxid = () => `${String(++created).padStart(2, '0')}`.padEnd(64, 'a');
/** The wallet records the action (as the toolbox does) and answers with its txid. */
const payOk = async (a: Args) => {
  const txid = nextTxid();
  walletActions.push({ txid, status: 'unproven', outputs: a.outputs.map((o) => ({ lockingScript: o.lockingScript })) });
  return { txid };
};
let createImpl: (a: Args) => Promise<{ txid: string; tx?: number[] }> = payOk;
let listImpl: () => Promise<{ totalActions: number; actions: Listed[] }> = async () => ({
  totalActions: walletActions.length,
  actions: walletActions,
});
const wallet = {
  getPublicKey: async () => ({ publicKey: '02' + '11'.repeat(32) }),
  createAction: (a: Args) => (createArgs.push(a), createImpl(a)),
  listActions: () => listImpl(),
};
mock.module('../../hooks/useServiceContext', () => ({
  useServiceContext: () => ({ apiContext: { wallet, services: undefined } }),
}));

// ── bit-sign over a fake Http ───────────────────────────────────────────────────────────────────────────────────
type Res = { status: number; data: unknown };
const calls: { path: string; body: unknown }[] = [];
let claimReplies: (Res | Error)[] = [];
let quoteReplies: Res[] = [];
let quotes = 0;
const http = async (req: { url: string; body?: unknown }): Promise<Res> => {
  const path = new URL(req.url).pathname.replace('/api/bitsign/bshares', '');
  calls.push({ path, body: req.body });
  if (path.endsWith('/quote')) {
    const r = quoteReplies.shift();
    if (r) return r;
    const memo = `bitsign-bshares n${++quotes}`;
    return {
      status: 200,
      data: {
        quote_id: `q${quotes}`,
        expires_at: '',
        outputs: [{ lockingScript: T, satoshis: 1000 }],
        memo,
        memo_script: memoScript(memo),
        terms_text: 'Issuer terms: ordinary shares, no rights to dividends until declared.',
        offer: { treasury: { m: 2, n: 3 } },
      },
    };
  }
  if (path.endsWith('/claim')) {
    const r = claimReplies.shift() ?? { status: 200, data: { ok: true } };
    if (r instanceof Error) throw r;
    return r;
  }
  if (path.endsWith('/paid')) return { status: 409, data: { error: 'Waiting for one confirmation.' } };
  return { status: 404, data: { error: 'nope' } };
};

const offer = {
  id: 'o1',
  ticker: 'CO',
  sats: 1000,
  shares: 10,
  status: 'accepted',
  investorHandle: 'alice',
  pricePence: 100,
  gbpPerBsvPence: 1000,
  rateDate: '2026-11-01',
  lockMonths: 12,
  expiresAt: '2026-12-01T00:00:00Z',
  events: [],
};
const me = {
  role: 'member',
  holdings: [],
  offers: [offer],
  company: { name: 'Co', ticker: 'CO', sharesInIssue: 0, treasury: { lockingScriptHex: T, m: 2, n: 3 } },
};

let api: unknown;
mock.module('./useBshares', () => ({
  useBshares: () => ({ api, me, loading: false, reload: () => undefined }),
  useCompanies: () => ({ companies: [], reload: () => undefined }),
}));

// ── render: call every function component in order; collect buttons by data-testid and all text ─────────────────
type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
type View = { buttons: Map<string, () => unknown>; text: string };
async function render(): Promise<View> {
  const { BsharesPage } = await import('./BsharesPage');
  cursor = 0;
  const buttons = new Map<string, () => unknown>();
  const text: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') return void text.push(String(node));
    if (Array.isArray(node)) return node.forEach(walk);
    const el = node as El;
    if (typeof el.type === 'function') return walk((el.type as (p: unknown) => unknown)(el.props));
    const id = el.props?.['data-testid'];
    if (el.type === 'button' && typeof id === 'string' && !el.props.disabled)
      buttons.set(id, el.props.onClick as () => unknown);
    walk(el.props?.children);
  };
  walk(BsharesPage());
  return { buttons, text: text.join(' ') };
}

/**
 * One tap on the offer's Pay / Check payment / Try the claim again button in a freshly mounted page (a new mount = the
 * app was relaunched; storage survives). If that opens the confirm sheet for a payment, the person taps Pay in it; a
 * "may have gone out" sheet is left on its default (Cancel). False when there is no button to tap.
 */
async function tapPay(): Promise<boolean> {
  slots.length = 0;
  const main = (await render()).buttons.get('bshares-pay');
  if (!main) return false;
  await main();
  const pay = (await render()).buttons.get('bshares-sheet-pay');
  if (pay) await pay();
  return true;
}

const claims = () =>
  calls
    .filter((c) => c.path.endsWith('/claim'))
    .map((c) => c.body as { txid: string; quote_id: string; rawtx?: string });

beforeEach(async () => {
  const { BsharesApi } = await import('./api');
  api = new BsharesApi(http as never, { token: 't' } as never, 'CO', 'https://x.test');
  store.clear();
  snacks.length = 0;
  calls.length = 0;
  claimReplies = [];
  quoteReplies = [];
  quotes = 0;
  created = 0;
  walletActions.length = 0;
  createArgs.length = 0;
  createImpl = payOk;
  listImpl = async () => ({ totalActions: walletActions.length, actions: walletActions });
});

const notConfirmed: Res = {
  status: 409,
  data: { error: 'Waiting for one confirmation.', code: 'not_confirmed', retryable: true, payment_pending: true },
};
const MAYBE = "We can't confirm whether this went out. Check History before sending again.";

describe('bShares Pay: a retry claims, never pays twice (audit M5)', () => {
  test('claim not confirmed yet: the next tap re-claims the same payment', async () => {
    claimReplies = [notConfirmed, { status: 200, data: { ok: true } }];
    await tapPay();
    await tapPay();
    expect(created).toBe(1);
    expect(quotes).toBe(1);
    expect(claims().length).toBe(2);
    expect(claims()[1]).toMatchObject({ txid: claims()[0].txid, quote_id: claims()[0].quote_id });
    expect(store.size).toBe(0); // pending cleared once claimed
  });

  test('claim answer lost (network error): the next tap re-claims, no second payment', async () => {
    claimReplies = [new Error('Network request failed'), { status: 200, data: { ok: true, already_claimed: true } }];
    await tapPay();
    await tapPay();
    expect(created).toBe(1);
    expect(claims().map((c) => c.txid)).toEqual([claims()[0].txid, claims()[0].txid]);
  });

  test('app relaunched while waiting for a block: claims, does not pay', async () => {
    claimReplies = [notConfirmed, notConfirmed, { status: 200, data: { ok: true } }];
    await tapPay();
    await tapPay(); // new mount each time
    await tapPay();
    expect(created).toBe(1);
    expect(claims().length).toBe(3);
  });

  test('claim refused for good (no_memo): never pays again, shows the txid for a refund', async () => {
    claimReplies = [{ status: 402, data: { error: 'missing memo', code: 'no_memo', retryable: false } }];
    await tapPay();
    expect(await tapPay()).toBe(false); // no Pay button any more
    expect(created).toBe(1);
    expect(claims().length).toBe(1);
    expect(snacks.at(-1)).toContain('a'.repeat(40));
    expect(snacks.at(-1)).toContain("Don't pay again");
    slots.length = 0;
    expect((await render()).text).toContain('a'.repeat(40));
  });

  // Was GAP 1: the pending record was written only AFTER createAction returned.
  test('createAction says "can\'t confirm" after the payment went out: the next tap must not pay again', async () => {
    createImpl = async () => {
      created++;
      throw new Error(MAYBE);
    };
    await tapPay();
    createImpl = payOk;
    await tapPay();
    expect(created).toBe(1);
  });

  // Was GAP 2: not_configured (BSHARES_INVEST_ENABLED off for a deploy) deleted the quote_id for good.
  test('not_configured (server switched off for a moment) keeps the claim retryable', async () => {
    claimReplies = [{ status: 503, data: { error: 'One-tap investing is not open.', code: 'not_configured' } }];
    await tapPay();
    await tapPay();
    expect(claims().length).toBe(2);
    expect(created).toBe(1);
  });
});

describe('bShares Pay: the record comes first (review #1)', () => {
  test('the record is on the device before the wallet is asked to pay', async () => {
    let seen: string | null = null;
    createImpl = async (a) => {
      seen = store.get('bshares-claim:o1') ?? null;
      return payOk(a);
    };
    await tapPay();
    expect(JSON.parse(seen!)).toMatchObject({
      quote_id: 'q1',
      memo: 'bitsign-bshares n1',
      memo_script: memoScript('bitsign-bshares n1'),
    });
    expect(JSON.parse(seen!).startedAt).toBeGreaterThan(0);
    expect(JSON.parse(seen!).txid).toBeUndefined();
  });

  test('app killed inside createAction, payment in the wallet: the next tap finds it by its memo and claims it', async () => {
    createImpl = async (a) => {
      await payOk(a); // the wallet broadcast and recorded it…
      throw new Error('message port closed before a response was received'); // …then the app died
    };
    const list = listImpl;
    listImpl = async () => {
      throw new Error('wallet still starting'); // and nothing could be looked up before it went
    };
    await tapPay();
    expect(claims().length).toBe(0);
    expect(JSON.parse(store.get('bshares-claim:o1')!).txid).toBeUndefined();
    createImpl = payOk;
    listImpl = list;
    await tapPay(); // relaunched
    expect(created).toBe(1);
    expect(claims().map((c) => c.txid)).toEqual([walletActions[0].txid]);
    expect(store.size).toBe(0);
  });

  test('"can\'t confirm" but the wallet has it: claimed at once with that txid', async () => {
    createImpl = async (a) => {
      await payOk(a);
      throw new Error(MAYBE);
    };
    await tapPay();
    expect(created).toBe(1);
    expect(claims().map((c) => c.txid)).toEqual([walletActions[0].txid]);
    expect(store.size).toBe(0);
  });

  test('StorageMaybeSentError is "maybe sent", never "failed, pay again"', async () => {
    const { StorageMaybeSentError } = await import('../../services/storageFailover');
    createImpl = async () => {
      created++;
      throw new StorageMaybeSentError(new Error('remote storage hung'));
    };
    await tapPay();
    expect(snacks.at(-1)).toContain("Don't pay again");
    slots.length = 0;
    const v = await render();
    expect(v.text).toContain('Check payment');
    expect(v.text).not.toMatch(/\bPay\b(?! again)/);
  });

  test('nothing found: the sheet warns first, Cancel is the default, and only "Pay again anyway" pays', async () => {
    createImpl = async () => {
      created++;
      throw new Error(MAYBE);
    };
    await tapPay();
    createImpl = payOk;
    slots.length = 0;
    await (await render()).buttons.get('bshares-pay')!();
    const v = await render();
    expect(v.text).toContain('An earlier payment may have gone out. Check your history before paying again.');
    expect(v.buttons.has('bshares-sheet-pay')).toBe(false);
    expect(v.buttons.has('bshares-sheet-cancel')).toBe(true);
    await v.buttons.get('bshares-sheet-cancel')!();
    expect(created).toBe(1);
    await (await render()).buttons.get('bshares-pay')!();
    await (await render()).buttons.get('bshares-sheet-pay-anyway')!();
    expect(created).toBe(2); // the person chose to
    expect(claims().length).toBe(1);
  });

  test("the wallet list can't be read: still asks before paying again", async () => {
    createImpl = async () => {
      created++;
      throw new Error(MAYBE);
    };
    await tapPay();
    listImpl = async () => {
      throw new Error('storage closed');
    };
    await tapPay();
    expect(created).toBe(1);
    slots.length = 0;
    await (await render()).buttons.get('bshares-pay')!();
    expect((await render()).text).toContain('Check your history before paying again');
  });

  test('proven not sent (the person declined in the wallet): forgotten, Pay is offered again', async () => {
    createImpl = async () => {
      throw new Error('User denied the request');
    };
    await tapPay();
    expect(store.size).toBe(0);
    createImpl = payOk;
    await tapPay();
    expect(created).toBe(1);
    expect(claims().length).toBe(1);
  });
});

describe('bShares Pay: broadcast now, rawtx with the claim (review #2)', () => {
  test('acceptDelayedBroadcast: false; the claim carries the signed tx; a re-claim sends it again', async () => {
    createImpl = async (a) => ({ ...(await payOk(a)), tx: [1, 2, 3, 255] });
    claimReplies = [notConfirmed];
    await tapPay();
    expect(createArgs[0].options).toMatchObject({ acceptDelayedBroadcast: false, randomizeOutputs: false });
    expect(createArgs[0].labels).toContain('bshares');
    expect(createArgs[0].outputs[1]).toMatchObject({ lockingScript: memoScript('bitsign-bshares n1'), satoshis: 0 });
    expect(claims()[0].rawtx).toBe('010203ff');
    await tapPay();
    expect(claims()[1].rawtx).toBe('010203ff');
  });
});

describe('bShares Pay: confirm before signing (review #3)', () => {
  test('Pay opens the sheet: amount, treasury m-of-n, the issuer terms; Cancel pays nothing', async () => {
    slots.length = 0;
    await (await render()).buttons.get('bshares-pay')!();
    const v = await render();
    expect(v.text).toContain('1,000 sats');
    expect(v.text).toContain('Co');
    expect(v.text).toContain('treasury');
    expect(v.text).toContain('(2-of-3)');
    expect(v.text).toContain('Issuer terms: ordinary shares');
    expect(v.buttons.has('bshares-sheet-cancel')).toBe(true);
    await v.buttons.get('bshares-sheet-cancel')!();
    expect(created).toBe(0);
    expect(store.size).toBe(0);
    expect((await render()).buttons.has('bshares-sheet-pay')).toBe(false);
  });

  test('a quote whose memo_script does not encode its memo is refused before the sheet', async () => {
    quoteReplies = [
      {
        status: 200,
        data: {
          quote_id: 'qx',
          expires_at: '',
          outputs: [{ lockingScript: T, satoshis: 1000 }],
          memo: 'bitsign-bshares x',
          memo_script: '006a11' + 'aa'.repeat(17),
        },
      },
    ];
    await tapPay();
    expect(created).toBe(0);
    expect(snacks.at(-1)).toContain('memo');
  });
});

describe('bShares Pay: claims that may clear up stay claimable (review #4)', () => {
  for (const code of ['kyc_required', 'offer_changed', 'quote_invalid', 'offer_closed'])
    test(`${code}: txid shown, "Try the claim again" re-claims and never pays`, async () => {
      claimReplies = [{ status: 409, data: { error: `refused: ${code}`, code, retryable: false } }];
      await tapPay();
      slots.length = 0;
      const v = await render();
      expect(v.text).toContain('Try the claim again');
      expect(v.text).toContain('01' + 'a'.repeat(62));
      expect(JSON.parse(store.get('bshares-claim-failed:o1')!)).toMatchObject({ quote_id: 'q1', code });
      await tapPay();
      expect(created).toBe(1);
      expect(claims().length).toBe(2);
      expect(claims()[1]).toMatchObject({ quote_id: 'q1', txid: '01' + 'a'.repeat(62) });
      expect(store.size).toBe(0);
    });

  test("the server's retryable flag wins over the built-in list", async () => {
    claimReplies = [{ status: 409, data: { error: 'Something new.', code: 'new_wait_code', retryable: true } }];
    await tapPay();
    await tapPay();
    expect(created).toBe(1);
    expect(claims().length).toBe(2);
  });

  test('refund_due (late or extra payment, bit-sign 409): final, says so with the txid, never pays', async () => {
    claimReplies = [
      {
        status: 409,
        data: {
          error: "Your payment 01aa was recorded, but the offer closed. Don't pay again: the directors will refund it.",
          code: 'refund_due',
          retryable: false,
          refund_due: true,
          payment_txid: '01' + 'a'.repeat(62),
          reason: 'the offer closed',
          offer: { ...offer, status: 'refund_due' },
        },
      },
    ];
    await tapPay();
    expect(snacks.at(-1)).toContain('Your payment was recorded; the directors will refund it');
    expect(snacks.at(-1)).toContain('01' + 'a'.repeat(62));
    expect(store.size).toBe(0);
    expect(created).toBe(1);
  });

  test('a claim answered with a refund_due offer (replay, already_claimed) reads the same', async () => {
    claimReplies = [{ status: 200, data: { ok: true, already_claimed: true, status: 'refund_due' } }];
    await tapPay();
    expect(snacks.at(-1)).toContain('Your payment was recorded; the directors will refund it');
    expect(store.size).toBe(0);
  });
});

describe('bShares Pay: across devices (review #6)', () => {
  test('no record here: the second-device note; a record: "Check payment" with the txid', async () => {
    slots.length = 0;
    let v = await render();
    expect(v.text).toContain("If you already paid on another device, don't pay again: check there first.");
    expect(v.text).toContain('Pay');
    claimReplies = [notConfirmed];
    await tapPay();
    slots.length = 0;
    v = await render();
    expect(v.text).toContain('Check payment');
    expect(v.text).toContain('01' + 'a'.repeat(62));
    expect(v.text).not.toContain('If you already paid on another device');
  });

  test('quote says payment_pending (paid on another device): "Check payment" claims that txid, never pays', async () => {
    const other = 'bb'.repeat(32);
    quoteReplies = [
      {
        status: 409,
        data: {
          error: `A payment for this offer (${other}) is waiting for its confirmation. Don't pay again: check the payment.`,
          code: 'payment_pending',
          txid: other,
          quote_id: 'q-other',
          claim: 'offers/o1/claim',
        },
      },
    ];
    await tapPay();
    expect(created).toBe(0);
    expect(snacks.at(-1)).toContain("Don't pay again");
    slots.length = 0;
    const v = await render();
    expect(v.text).toContain('Check payment');
    expect(v.text).toContain(other);
    await tapPay();
    expect(created).toBe(0);
    expect(claims()).toEqual([expect.objectContaining({ quote_id: 'q-other', txid: other })]);
    expect(store.size).toBe(0);
  });
});
