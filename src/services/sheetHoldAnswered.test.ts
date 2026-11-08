/**
 * BRC-219 re-review (8 Nov 2026), through the real payment-run guard (spendRecipients.ts):
 *  - an approved payment whose build or broadcast hangs no longer holds its site: a look-alike payment gets its own
 *    sheet instead of waiting with nothing on screen (no clock on a sheet: the hold ends when the sheet is answered);
 *  - a payment waiting behind a look-alike stops when its caller goes, and never asks.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeOriginator } from '@1sat/wallet';
import { guardSpendRecipients, recipientsForSheet, releaseSpendRuns, spendSheetSettled } from './spendRecipients';
import { PROMPT_CALLER_GONE_CODE, withCallerGoneSignal } from './promptLiveness';

const script = (byte: string) => `76a914${byte.repeat(20)}88ac`;
type Out = { lockingScript: string; satoshis: number };
type Req = {
  requestID: string;
  type: 'spending';
  originator: string;
  spending: { satoshis: number; lineItems: { type: string; satoshis: number; description: string }[] };
  recipients?: unknown;
  recipientsHash?: string;
};

const site = () => {
  const raised: Req[] = [];
  const answers = new Map<string, (ok: boolean) => void>();
  let seq = 0;
  const manager = {
    createAction: async (args: { outputs: Out[] }, originator?: string) => {
      const req: Req = {
        requestID: `spend:${++seq}`,
        type: 'spending',
        originator: originator ?? '',
        spending: {
          satoshis: 1_000,
          lineItems: args.outputs.map((o) => ({ type: 'output', satoshis: o.satoshis, description: 'x' })),
        },
      };
      const ok = await new Promise<boolean>((r) => {
        answers.set(req.requestID, r);
        raised.push(req);
      });
      if (!ok) throw new Error('Permission denied.');
      return new Promise(() => undefined); // approved, then the build / broadcast hangs
    },
  };
  const w = guardSpendRecipients(manager, { adminOriginator: 'admin', normalize: normalizeOriginator, holdMs: 30 });
  const bind = (r: Req) => {
    const shown = recipientsForSheet('hang.example', r);
    if (shown && 'recipients' in shown) {
      r.recipients = shown.recipients;
      r.recipientsHash = shown.hash;
    }
  };
  return { w, raised, bind, answer: (r: Req, ok: boolean) => answers.get(r.requestID)!(ok) };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => undefined;

describe('payment run hold: answered ends it, a hang after Allow does not block the site', () => {
  test('A approved and stuck building: the look-alike B gets its own sheet with its own payee', async () => {
    const s = site();
    s.w.createAction({ outputs: [{ lockingScript: script('11'), satoshis: 1_000 }] }, 'hang.example').catch(quiet);
    await sleep(5);
    const reqA = s.raised[0];
    s.bind(reqA); // A's sheet is up
    s.w.createAction({ outputs: [{ lockingScript: script('22'), satoshis: 1_000 }] }, 'hang.example').catch(quiet);
    await sleep(60);
    expect(s.raised).toHaveLength(1); // B waits while A's sheet is up (past holdMs: no clock on a sheet)
    s.answer(reqA, true);
    spendSheetSettled(reqA.requestID); // background.ts: A's pending entry settled
    await sleep(5);
    expect(s.raised).toHaveLength(2); // A hangs building, yet B is on screen
    const shownB = recipientsForSheet('hang.example', s.raised[1]);
    expect(shownB && 'recipients' in shownB).toBe(true);
    s.answer(s.raised[1], false);
    releaseSpendRuns();
  });

  test('B waiting behind A stops when its caller goes: it never raises a sheet', async () => {
    const s = site();
    s.w.createAction({ outputs: [{ lockingScript: script('33'), satoshis: 1_000 }] }, 'hang.example').catch(quiet);
    await sleep(5);
    const reqA = s.raised[0];
    s.bind(reqA);
    let leave!: () => void;
    const gone = new Promise<void>((r) => (leave = r));
    const b = s.w.createAction(
      withCallerGoneSignal({ outputs: [{ lockingScript: script('44'), satoshis: 1_000 }] }, gone),
      'hang.example',
    );
    await sleep(5);
    leave();
    await expect(b).rejects.toMatchObject({ code: PROMPT_CALLER_GONE_CODE });
    s.answer(reqA, false);
    await sleep(5);
    expect(s.raised).toHaveLength(1);
    releaseSpendRuns();
  });
});
