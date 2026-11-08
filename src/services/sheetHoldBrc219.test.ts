/**
 * BRC-219 review (8 Nov 2026), Medium 4 and 5, through the real payment code (spendRecipients.ts guard and
 * permissionBundle.ts sheet model):
 *  - the ghost hold: a payment sheet left open past SPEND_RUN_HOLD_MS used to lose its run; a look-alike payment then
 *    went ahead and the open sheet's own Allow was refused. The hold now lasts as long as the sheet.
 *  - the variant Retry: a second payment with the same outputs gets its own sheet only after the first is answered,
 *    and that sheet says the site asked for this same payment before, so paying twice is never a blind tap.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeOriginator } from '@1sat/wallet';
import { guardSpendRecipients, recipientsForSheet, releaseSpendRuns, spendApprovalMatches } from './spendRecipients';
import { PermissionBundler, buildSheetModel, sheetDecisions, type BundleRequest } from './permissionBundle';

const script = (byte: string) => `76a914${byte.repeat(20)}88ac`;
const MERCHANT = script('11');
const OTHER = script('22');
type Out = { lockingScript: string; satoshis: number };
type Req = BundleRequest & { requestID: string };

const site = (holdMs: number) => {
  const raised: Req[] = [];
  const answers = new Map<string, (ok: boolean) => void>();
  const paid: string[] = [];
  let seq = 0;
  const manager = {
    createAction: async (args: { outputs: Out[] }, originator?: string) => {
      const lineItems = args.outputs.map((o) => ({ type: 'output', satoshis: o.satoshis, description: 'x' }));
      const req: Req = {
        requestID: `spend:${++seq}`,
        type: 'spending',
        originator: originator ?? '',
        spending: { satoshis: 1_000, lineItems },
      };
      const ok = await new Promise<boolean>((r) => {
        answers.set(req.requestID, r);
        raised.push(req);
      });
      if (!ok) throw new Error('Permission denied.');
      paid.push(args.outputs[0].lockingScript);
      return { txid: req.requestID };
    },
  };
  const w = guardSpendRecipients(manager, { adminOriginator: 'admin', normalize: normalizeOriginator, holdMs });
  return { w, raised, paid, answer: (r: Req, ok: boolean) => answers.get(r.requestID)!(ok) };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ghost hold: the run lasts as long as its sheet, not a clock', () => {
  test('a sheet open past holdMs keeps its run: a look-alike waits, and the open sheet still pays when allowed', async () => {
    const s = site(30);
    const a = s.w.createAction({ outputs: [{ lockingScript: MERCHANT, satoshis: 1_000 }] }, 'held.example');
    await sleep(5);
    const reqA = s.raised[0];
    const shown = recipientsForSheet('held.example', reqA); // the background binds A's sheet to A's run
    expect(shown && 'recipients' in shown).toBe(true);
    if (shown && 'recipients' in shown) {
      reqA.recipients = shown.recipients;
      reqA.recipientsHash = shown.hash;
    }
    await sleep(60); // the person reads the sheet for longer than holdMs
    const b = s.w.createAction({ outputs: [{ lockingScript: OTHER, satoshis: 1_000 }] }, 'held.example');
    await sleep(60);
    expect(s.raised).toHaveLength(1); // B waits for A's sheet: it cannot be confused with it
    expect(spendApprovalMatches(reqA)).toBe(true); // A's Allow is still honoured
    s.answer(reqA, true);
    await a;
    await sleep(5);
    expect(s.raised).toHaveLength(2); // A answered: now B gets its own sheet
    const reqB = s.raised[1];
    const shownB = recipientsForSheet('held.example', reqB);
    expect(shownB && 'recipients' in shownB ? shownB.recipients.map((x) => x.satoshis) : []).toEqual([1_000]);
    s.answer(reqB, false);
    await expect(b).rejects.toThrow();
    expect(s.paid).toEqual([MERCHANT]);
    releaseSpendRuns();
  });
});

describe('variant Retry: one payment sheet at a time per site, and the repeat says so', () => {
  test('B (same outputs, fresh reference) cannot ride A\'s Allow; its own sheet carries "asked again"', () => {
    const shown: string[] = [];
    const bundler = new PermissionBundler<Req>({ onReady: (b) => shown.push(b.id), windowMs: 0 });
    const pay = (id: string, extra: Partial<Req> = {}): Req => ({
      requestID: id,
      type: 'spending',
      originator: 'game.example',
      spending: { satoshis: 2_010, lineItems: [{ type: 'output', satoshis: 2_000, description: 'NPG Arena' }] },
      recipientsHash: 'h-npg',
      ...extra,
    });
    const first = bundler.add(pay('A'))!;
    bundler.flush(first.id);
    // A is on screen; the game's variant Retry arrives: it joins only as an unticked "New" line.
    bundler.add(pay('B', { askedAgain: { secondsAgo: 20 } }));
    const model = buildSheetModel(first);
    expect(model.payment?.requestID).toBe('A');
    const decisions = sheetDecisions(model, true, {}, true);
    expect(decisions).toEqual({ A: true }); // Allow pays A only; B is carried to its own sheet
    const newLine = model.lines.find((l) => l.requestID === 'B');
    expect(newLine?.checked).toBe(false);
    expect(newLine?.detail).toContain('This site asked for this same payment 20 s ago');
    // B's own sheet later: the warning is on the payment itself, above Allow.
    const own = buildSheetModel({ originator: 'game.example', items: [pay('B', { askedAgain: { secondsAgo: 25 } })] });
    expect(own.payment?.askedAgain).toEqual({ secondsAgo: 25 });
  });
});
