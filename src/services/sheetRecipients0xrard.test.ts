/**
 * b-Aware 6 Nov 2026, 0xrard #1: two concurrent createActions from one site. The second payment's sheet showed the
 * FIRST action's recipients (the list was kept per site), so the sheet named the merchant while the money went to
 * the attacker. Each sheet must show its own action's outputs, and approving must check them.
 *
 * The fake manager below raises one spending request per createAction the way the toolbox does (each its own
 * request, line items built from that action's own outputs, index.client.mjs computeNetSpend) and pays exactly the
 * outputs of the action whose request was granted.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeLockingScript,
  guardSpendRecipients,
  recipientsForSheet,
  spendApprovalMatches,
  type Recipient,
} from './spendRecipients';

const SITE = 'shop.example';
const script = (byte: string) => `76a914${byte.repeat(20)}88ac`;
const MERCHANT = script('11');
const ATTACKER = script('22');

type SpendRequest = {
  requestID: string;
  type: 'spending';
  originator: string;
  spending: { satoshis: number; lineItems: { type: string; description: string; satoshis: number }[] };
  recipients?: Recipient[];
  recipientsHash?: string;
};
type Out = { lockingScript: string; satoshis: number; outputDescription?: string };

const fakeSite = () => {
  const raised: SpendRequest[] = [];
  const waiters: ((r: SpendRequest) => void)[] = [];
  const answers = new Map<string, (ok: boolean) => void>();
  const paid: { requestID: string; scripts: string[] }[] = [];
  let seq = 0;
  const manager = {
    createAction: async (args: { outputs: Out[] }, originator?: string) => {
      await new Promise((r) => setTimeout(r, 1)); // storage builds the transaction
      const lineItems = [
        ...args.outputs.map((o) => ({
          type: 'output',
          satoshis: o.satoshis,
          description: o.outputDescription || 'No output description provided',
        })),
        { type: 'fee', satoshis: 10, description: 'Network fee' },
      ];
      const request: SpendRequest = {
        requestID: `spend:${originator}:request:${++seq}`,
        type: 'spending',
        originator: originator ?? '',
        spending: { satoshis: lineItems.reduce((s, l) => s + l.satoshis, 0), lineItems },
      };
      const ok = await new Promise<boolean>((resolve) => {
        answers.set(request.requestID, resolve);
        raised.push(request);
        waiters.shift()?.(request);
      });
      if (!ok) throw new Error('Permission denied.');
      paid.push({ requestID: request.requestID, scripts: args.outputs.map((o) => o.lockingScript) });
      return { txid: request.requestID };
    },
  };
  const wallet = guardSpendRecipients(manager, { adminOriginator: 'admin', normalize: (o) => o });
  /** The next spending request to reach the background (or one already raised and not yet taken). */
  let taken = 0;
  const nextRequest = () =>
    taken < raised.length
      ? Promise.resolve(raised[taken++])
      : new Promise<SpendRequest>((r) =>
          waiters.push((req) => {
            taken++;
            r(req);
          }),
        );
  /** What background.ts does when the spending request arrives: attach this request's own outputs. */
  const sheetFor = (req: SpendRequest) => {
    const r = recipientsForSheet(SITE, req);
    if (r && 'recipients' in r) {
      req.recipients = r.recipients;
      req.recipientsHash = r.hash;
    }
    return r;
  };
  const answer = (req: SpendRequest, ok: boolean) => answers.get(req.requestID)!(ok);
  return { wallet, raised, paid, nextRequest, sheetFor, answer };
};

const shownPayees = (r: ReturnType<typeof recipientsForSheet>) =>
  r && 'recipients' in r ? r.recipients.map((x) => x.to) : [];

describe('0xrard #1: concurrent payments from one site each show their own payee', () => {
  test('different amounts: each sheet lists its own outputs, approving A pays only A', async () => {
    const s = fakeSite();
    const a = s.wallet.createAction({ outputs: [{ lockingScript: MERCHANT, satoshis: 1_000 }] }, SITE);
    const b = s.wallet.createAction({ outputs: [{ lockingScript: ATTACKER, satoshis: 50_000 }] }, SITE);
    const first = await s.nextRequest();
    const second = await s.nextRequest();
    const [reqA, reqB] = first.spending.satoshis === 1_010 ? [first, second] : [second, first];

    expect(shownPayees(s.sheetFor(reqA))).toEqual([describeLockingScript(MERCHANT)]);
    // The bug: B's sheet showed A's merchant while B pays the attacker.
    expect(shownPayees(s.sheetFor(reqB))).toEqual([describeLockingScript(ATTACKER)]);

    expect(spendApprovalMatches(reqA)).toBe(true);
    s.answer(reqA, true);
    await a;
    expect(s.paid).toEqual([{ requestID: reqA.requestID, scripts: [MERCHANT] }]);
    s.answer(reqB, false);
    await expect(b).rejects.toThrow();
    expect(s.paid.length).toBe(1);
  });

  test('same amount, different payees: the look-alike waits, then shows its own payee', async () => {
    const s = fakeSite();
    const a = s.wallet.createAction({ outputs: [{ lockingScript: MERCHANT, satoshis: 1_000 }] }, SITE);
    const b = s.wallet.createAction({ outputs: [{ lockingScript: ATTACKER, satoshis: 1_000 }] }, SITE);
    const reqA = await s.nextRequest();
    expect(shownPayees(s.sheetFor(reqA))).toEqual([describeLockingScript(MERCHANT)]);
    // Never two sheets a person could not tell apart: B is not asked while A is open.
    await new Promise((r) => setTimeout(r, 10));
    expect(s.raised.length).toBe(1);
    expect(spendApprovalMatches(reqA)).toBe(true);
    s.answer(reqA, true);
    await a;
    expect(s.paid).toEqual([{ requestID: reqA.requestID, scripts: [MERCHANT] }]);

    const reqB = await s.nextRequest();
    expect(shownPayees(s.sheetFor(reqB))).toEqual([describeLockingScript(ATTACKER)]);
    s.answer(reqB, false);
    await expect(b).rejects.toThrow();
    expect(s.paid.length).toBe(1);
  });

  test('approving refuses a sheet whose list is not its own action outputs', async () => {
    const s = fakeSite();
    const a = s.wallet.createAction({ outputs: [{ lockingScript: MERCHANT, satoshis: 1_000 }] }, SITE);
    const b = s.wallet.createAction({ outputs: [{ lockingScript: ATTACKER, satoshis: 50_000 }] }, SITE);
    const first = await s.nextRequest();
    const second = await s.nextRequest();
    const [reqA, reqB] = first.spending.satoshis === 1_010 ? [first, second] : [second, first];
    s.sheetFor(reqA);
    s.sheetFor(reqB);
    // A's list (and hash) pasted onto B: approving B is refused.
    const forged = { ...reqB, recipients: reqA.recipients, recipientsHash: reqA.recipientsHash };
    expect(spendApprovalMatches(forged)).toBe(false);
    // A list with a different hash, or none bound to the request, is refused too.
    expect(spendApprovalMatches({ ...reqA, recipientsHash: 'x' })).toBe(false);
    expect(spendApprovalMatches({ ...reqA, requestID: 'spend:other:request:99' })).toBe(false);
    expect(spendApprovalMatches(reqA)).toBe(true);
    expect(spendApprovalMatches(reqB)).toBe(true);
    s.answer(reqA, false);
    s.answer(reqB, false);
    await Promise.allSettled([a, b]);
    // After the actions end nothing stays bound: an old answer cannot be replayed.
    expect(spendApprovalMatches(reqA)).toBe(false);
  });

  test('a request matching no running action of the site gets no list', () => {
    const r = recipientsForSheet(SITE, {
      requestID: 'spend:x:request:1',
      type: 'spending',
      originator: SITE,
      spending: { satoshis: 1_010, lineItems: [{ type: 'output', satoshis: 1_000, description: 'x' }] },
    });
    expect(r).toBeNull();
  });
});

describe('background.ts binds the list to the request and checks it on Allow', () => {
  const bg = readFileSync(join(import.meta.dir, '..', 'background.ts'), 'utf8');
  test('the spend sheet takes its own request outputs, never a per-site list', () => {
    expect(bg).not.toContain('takeRecipientsForSheet');
    expect(bg).toContain('recipientsForSheet(permSite, request as BundleRequest)');
    expect(bg).toContain("if (shown && 'refuse' in shown) throw new Error(shown.refuse);");
  });
  test('Allow grants a payment only when its list is still its own action', () => {
    const fn = bg.slice(bg.indexOf('permissionBundler.resolve(response.bundleID'));
    expect(fn.indexOf('spendApprovalMatches')).toBeGreaterThan(0);
    expect(fn.indexOf('spendApprovalMatches')).toBeLessThan(
      fn.indexOf('wallet.grantPermission({ requestID: r.requestID'),
    );
  });
});
