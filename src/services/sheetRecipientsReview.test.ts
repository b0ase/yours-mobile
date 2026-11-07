/**
 * Review of fix/sheet-recipients (0xrard, 6 Nov 2026), proof tests turned into repo tests:
 *  - HIGH 1: runs were keyed with @1sat normalizeOriginator, which keeps a port, while the toolbox's requests carry
 *    the hostname only. "shop.example" and "shop.example:8443" ran side by side and the attacker's sheet named the
 *    merchant.
 *  - HIGH 2: the P2PKH pattern was anchored only at the end, so "<attacker P2PKH> 6a <merchant P2PKH>" was shown as
 *    the merchant.
 *  - MED 4: module-routed sheets showed no payees; a paying sheet must always list them.
 *  - LOW: a bound request is re-checked; a hung run releases.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeOriginator } from '@1sat/wallet';
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client';
import {
  describeLockingScript,
  guardSpendRecipients,
  noteModuleOutputs,
  recipientsForSheet,
  releaseSpendRuns,
  spendApprovalMatches,
  type Recipient,
} from './spendRecipients';
import { permissionSite } from './permissionSite';

const script = (byte: string) => `76a914${byte.repeat(20)}88ac`;
const MERCHANT = script('11');
const ATTACKER = script('22');
const MERCHANT_ADDR = describeLockingScript(MERCHANT);
const ATTACKER_ADDR = describeLockingScript(ATTACKER);

type Req = {
  requestID: string;
  type: 'spending';
  originator: string;
  spending: { satoshis: number; lineItems?: { type: string; description: string; satoshis: number }[] };
  reason?: string;
  recipients?: Recipient[];
  recipientsHash?: string;
  paid: string;
};
type Out = { lockingScript: string; satoshis: number };

/** The toolbox's own originator form (index.client.mjs normalizeOriginator): hostname only. */
const toolboxSite = (o: string) => new URL(`https://${o}`).hostname;

const fakeSite = (opts: { preflight?: boolean } = {}) => {
  const raised: Req[] = [];
  const answers = new Map<string, (ok: boolean) => void>();
  let seq = 0;
  const raise = (req: Req) =>
    new Promise<boolean>((resolve) => {
      answers.set(req.requestID, resolve);
      raised.push(req);
    });
  const manager = {
    createAction: async (args: { outputs: Out[] }, originator?: string) => {
      await new Promise((r) => setTimeout(r, 1));
      const site = toolboxSite(originator!);
      if (opts.preflight) {
        // BRC-177 nosend preflight: no line items, the sum of the site's outputs (index.client.mjs 42711).
        const pre: Req = {
          requestID: `spend:${site}:request:${++seq}`,
          type: 'spending',
          originator: site,
          spending: {
            satoshis: Math.max(
              1,
              args.outputs.reduce((s, o) => s + o.satoshis, 0),
            ),
          },
          reason: 'BRC-177 protected action prefunding',
          paid: args.outputs[0].lockingScript,
        };
        if (!(await raise(pre))) throw new Error('Permission denied.');
      }
      const lineItems = [
        ...args.outputs.map((o) => ({ type: 'output', satoshis: o.satoshis, description: 'x' })),
        { type: 'fee', satoshis: 10, description: 'Network fee' },
      ];
      const req: Req = {
        requestID: `spend:${site}:request:${++seq}`,
        type: 'spending',
        originator: site,
        spending: { satoshis: lineItems.reduce((s, l) => s + l.satoshis, 0), lineItems },
        paid: args.outputs[0].lockingScript,
      };
      if (!(await raise(req))) throw new Error('Permission denied.');
      return { paid: req.paid };
    },
  };
  // As initWallet.ts wires it.
  const wallet = guardSpendRecipients(manager, { adminOriginator: 'admin', normalize: normalizeOriginator });
  /** background.ts: mintSite is normalizeOriginator(request.originator). */
  const sheetFor = (req: Req) => {
    const r = recipientsForSheet(normalizeOriginator(req.originator), req);
    if (r && 'recipients' in r) {
      req.recipients = r.recipients;
      req.recipientsHash = r.hash;
    }
    return r;
  };
  const settle = () => new Promise((r) => setTimeout(r, 15));
  const answer = (req: Req, ok: boolean) => answers.get(req.requestID)?.(ok);
  return { wallet, raised, sheetFor, settle, answer };
};
const payees = (r: ReturnType<typeof recipientsForSheet>) =>
  r && 'recipients' in r ? r.recipients.map((x) => x.to) : [];

describe('HIGH 1: a port is not a different site', () => {
  test("permissionSite is exactly the toolbox's form: hostname only, no port", () => {
    expect(permissionSite('shop.example:8443')).toBe('shop.example');
    expect(permissionSite('https://Shop.Example:8443/x')).toBe('shop.example');
    const toolbox = (o: string) =>
      (
        WalletPermissionsManager.prototype as unknown as { normalizeOriginator: (o: string) => string }
      ).normalizeOriginator(o);
    for (const o of [
      'shop.example:8443',
      'HTTP://A.b:80',
      'http://[::1]:3000',
      ' x ',
      '',
      'chrome-extension://abc',
      '%%',
    ])
      expect(permissionSite(o)).toBe(toolbox(o));
  });

  test('shop.example and shop.example:8443 never share a sheet list (look-alike waits)', async () => {
    const s = fakeSite();
    const a = s.wallet.createAction({ outputs: [{ lockingScript: MERCHANT, satoshis: 1_000 }] }, 'shop.example');
    const b = s.wallet.createAction({ outputs: [{ lockingScript: ATTACKER, satoshis: 1_000 }] }, 'shop.example:8443');
    await s.settle();
    expect(s.raised.length).toBe(1); // serialised: the same site to the toolbox
    const reqA = s.raised[0];
    expect(payees(s.sheetFor(reqA))).toEqual([MERCHANT_ADDR]);
    s.answer(reqA, true);
    await a;
    await s.settle();
    const reqB = s.raised[1];
    expect(reqB.paid).toBe(ATTACKER);
    expect(payees(s.sheetFor(reqB))).toEqual([ATTACKER_ADDR]);
    expect(spendApprovalMatches(reqB)).toBe(true);
    s.answer(reqB, false);
    await expect(b).rejects.toThrow();
  });
});

describe('HIGH 2: an address is named only for a script that pays exactly it', () => {
  const pkh = '11'.repeat(20);
  test('exact P2PKH, and a parsed 1Sat envelope over an exact P2PKH', () => {
    expect(describeLockingScript(MERCHANT)).toBe(MERCHANT_ADDR);
    const ord = `0063036f726451${'0a'}${'61'.repeat(10)}00${'04'}${'aabbccdd'}68`;
    expect(describeLockingScript(`${ord}76a914${pkh}88ac`)).toBe(`${MERCHANT_ADDR} (token or ordinal)`);
  });
  test('anything else is a custom script, never the address at its end', () => {
    expect(describeLockingScript(`${ATTACKER}6a${MERCHANT}`)).toBe('a custom script');
    expect(describeLockingScript(`516a${MERCHANT}`)).toBe('a custom script');
    expect(describeLockingScript(`${ATTACKER}${MERCHANT}`)).toBe('a custom script');
    // An envelope with an executable opcode in it, or code between the envelope and the lock.
    expect(describeLockingScript(`0063036f72647568${MERCHANT}`)).toBe('a custom script');
    expect(describeLockingScript(`0063036f72646875${MERCHANT}`)).toBe('a custom script');
    // Not an envelope at all: OP_1 OP_IF runs.
    expect(describeLockingScript(`5163036f726468${MERCHANT}`)).toBe('a custom script');
    expect(describeLockingScript('006a0568656c6c6f')).toBe('data (OP_RETURN)');
  });
});

describe('MED 4: a module-routed payment lists its payees', () => {
  test('BRC-177 nosend: the preflight and the payment both list the site outputs', async () => {
    const s = fakeSite({ preflight: true });
    const args = { outputs: [{ lockingScript: MERCHANT, satoshis: 700 }], labels: ['p nosend expiry 1'] };
    const a = s.wallet.createAction(args, 'nosend.example');
    await s.settle();
    const pre = s.raised[0];
    expect(pre.spending.lineItems).toBeUndefined();
    expect(payees(s.sheetFor(pre))).toEqual([MERCHANT_ADDR]);
    expect(spendApprovalMatches(pre)).toBe(true);
    s.answer(pre, true);
    await s.settle();
    const full = s.raised[1];
    expect(payees(s.sheetFor(full))).toEqual([MERCHANT_ADDR]);
    s.answer(full, true);
    await a;
  });

  test('an asset module: the sheet lists the outputs the module sends', async () => {
    const raised: Req[] = [];
    let answerIt: (ok: boolean) => void = () => undefined;
    const manager = {
      createAction: async (_args: unknown, originator?: string) => {
        // pModuleSpendGate: the module rewrote the outputs; the gate notes them before its spend check.
        const sent = [
          { lockingScript: ATTACKER, satoshis: 5_000 },
          { lockingScript: MERCHANT, satoshis: 1 },
        ];
        noteModuleOutputs(originator, sent);
        const lineItems = sent.map((o) => ({ type: 'output', satoshis: o.satoshis, description: 'x' }));
        raised.push({
          requestID: 'spend:asset.example:request:1',
          type: 'spending',
          originator: 'asset.example',
          spending: { satoshis: 5_011, lineItems },
          paid: ATTACKER,
        });
        if (!(await new Promise<boolean>((r) => (answerIt = r)))) throw new Error('denied');
        return {};
      },
    };
    const w = guardSpendRecipients(manager, { adminOriginator: 'admin', normalize: normalizeOriginator });
    const a = w.createAction(
      { outputs: [{ lockingScript: MERCHANT, satoshis: 1, basket: 'p ordlock buy' }] },
      'asset.example:444',
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(payees(recipientsForSheet('asset.example', raised[0]))).toEqual([ATTACKER_ADDR, MERCHANT_ADDR]);
    answerIt(false);
    await expect(a).rejects.toThrow();
  });
});

describe('LOW: a bound request is re-checked, and a hung run releases', () => {
  test('a request already bound must still match its run', async () => {
    const s = fakeSite();
    const a = s.wallet.createAction({ outputs: [{ lockingScript: MERCHANT, satoshis: 1_000 }] }, 'bound.example');
    await s.settle();
    const req = s.raised[0];
    expect(payees(s.sheetFor(req))).toEqual([MERCHANT_ADDR]);
    const changed = {
      ...req,
      spending: { ...req.spending, lineItems: [{ type: 'output', satoshis: 9, description: 'x' }] },
    };
    expect(recipientsForSheet('bound.example', changed)).toBeNull();
    s.answer(req, false);
    await expect(a).rejects.toThrow();
  });

  test('releaseSpendRuns (wallet teardown) frees the site; nothing is misnamed while the released action may ask', async () => {
    const s = fakeSite();
    const quiet = () => undefined;
    const a = s.wallet.createAction({ outputs: [{ lockingScript: MERCHANT, satoshis: 1_000 }] }, 'hung.example');
    const b = s.wallet.createAction({ outputs: [{ lockingScript: ATTACKER, satoshis: 1_000 }] }, 'hung.example');
    a.catch(quiet);
    b.catch(quiet);
    await s.settle();
    expect(s.raised.length).toBe(1);
    releaseSpendRuns();
    await s.settle();
    expect(s.raised.length).toBe(2); // the look-alike is no longer held
    // While the released action may still be going, neither request can be told apart: both are refused.
    const [reqA, reqB] = s.raised;
    expect(recipientsForSheet('hung.example', reqA)).toMatchObject({ refuse: expect.any(String) });
    expect(recipientsForSheet('hung.example', reqB)).toMatchObject({ refuse: expect.any(String) });
    // The released action ends: B's own sheet shows B's payee.
    s.answer(reqA, false);
    await s.settle();
    expect(payees(s.sheetFor(reqB))).toEqual([ATTACKER_ADDR]);
    expect(recipientsForSheet('hung.example', reqA)).toBeNull();
    s.answer(reqB, false);
  });
});

describe('LOW: a run that never ends stops holding its site after a time', () => {
  test('after holdMs a look-alike goes ahead; while the hung one may still ask, neither is misnamed', async () => {
    const raised: Req[] = [];
    let seq = 0;
    const manager = {
      createAction: async (args: { outputs: Out[] }) => {
        const lineItems = args.outputs.map((o) => ({ type: 'output', satoshis: o.satoshis, description: 'x' }));
        raised.push({
          requestID: `spend:slow.example:request:${++seq}`,
          type: 'spending',
          originator: 'slow.example',
          spending: { satoshis: 1_000, lineItems },
          paid: args.outputs[0].lockingScript,
        });
        return new Promise(() => undefined); // hangs
      },
    };
    const w = guardSpendRecipients(manager, { adminOriginator: 'admin', normalize: normalizeOriginator, holdMs: 30 });
    void w.createAction({ outputs: [{ lockingScript: MERCHANT, satoshis: 1_000 }] }, 'slow.example');
    void w.createAction({ outputs: [{ lockingScript: ATTACKER, satoshis: 1_000 }] }, 'slow.example');
    await new Promise((r) => setTimeout(r, 10));
    expect(raised.length).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(raised.length).toBe(2); // held no longer than holdMs
    // The hung action never ends, so no sheet can say which of the two pays where: refused, never misnamed.
    expect(recipientsForSheet('slow.example', raised[0])).toMatchObject({ refuse: expect.any(String) });
    expect(recipientsForSheet('slow.example', raised[1])).toMatchObject({ refuse: expect.any(String) });
    releaseSpendRuns();
  });
});
