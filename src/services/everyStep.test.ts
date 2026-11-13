/**
 * Review of fix/envelope-queue (13 Nov 2026), F2 and F3: Forget site / Revoke all never stops halfway, and a sheet's
 * answer gives every waiting request an outcome.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { rejectStillPending, runEveryStep } from './everyStep';

const background = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
const section = (start: string, end: string) => {
  const i = background.indexOf(start);
  const j = background.indexOf(end, i + start.length);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return background.slice(i, j);
};

describe('runEveryStep', () => {
  test('a step that throws never stops the steps after it; failures are reported at the end, in order', async () => {
    const ran: string[] = [];
    const failed = await runEveryStep(
      [
        ['one', () => void ran.push('one')],
        [
          'envelope',
          async () => {
            ran.push('envelope');
            throw new Error('no Web Locks');
          },
        ],
        ['grants', async () => void ran.push('grants')],
        [
          'other',
          () => {
            ran.push('other');
            throw new Error('sync throw');
          },
        ],
        ['last', () => void ran.push('last')],
      ],
      () => {},
    );
    expect(ran).toEqual(['one', 'envelope', 'grants', 'other', 'last']);
    expect(failed).toEqual(['envelope: no Web Locks', 'other: sync throw']);
  });

  test('all good: nothing reported', async () => {
    expect(await runEveryStep([['a', () => undefined]], () => {})).toEqual([]);
  });
});

describe('rejectStillPending', () => {
  test('rejects only the requests still waiting, once, and forgets them', () => {
    const outcomes: string[] = [];
    const waiting = (id: string) => ({ reject: (e: Error) => void outcomes.push(`${id}: ${e.message}`) });
    const pending = new Map([
      ['a', waiting('a')],
      ['c', waiting('c')],
    ]);
    // 'b' was already settled by its own path (taken out of the map): left alone.
    expect(rejectStillPending(['a', 'b', 'c'], pending, new Error('refused'))).toBe(2);
    expect(outcomes).toEqual(['a: refused', 'c: refused']);
    expect(pending.size).toBe(0);
    expect(rejectStillPending(['a', 'c'], pending, new Error('again'))).toBe(0);
  });
});

describe('background wiring', () => {
  test('F2: Revoke all runs every revoke as a step; envelopes last; failures reported, grants never left', () => {
    const s = section('const processPermissionsRevokeAll', '// PERMISSION RESPONSE HANDLER');
    expect(s).toContain('const failed = await runEveryStep([');
    for (const label of [
      "'site grants'",
      "'basket grants'",
      "'streaming grants'",
      "'other accounts'",
      "'envelope'",
      "'other accounts\\' envelopes'",
    ])
      expect(s).toContain(label);
    expect(s.indexOf("'envelope'")).toBeGreaterThan(s.indexOf("'streaming grants'"));
    expect(s.indexOf("'envelope'")).toBeGreaterThan(s.indexOf("'other accounts'"));
    // No revoke awaited outside the steps (one of them throwing would skip the rest).
    expect(s).not.toContain('await accountContext?.envelopes.close(site);');
    expect(s).not.toContain('await updateStreamState(');
    expect(s).not.toContain('await closeEnvelopeInAccounts(');
    expect(s).toContain('Everything else was revoked, but these steps failed');
  });

  test('F3: a failed envelope fill leaves the approved payment on its normal path; unsettled requests are refused', () => {
    const s = section('// The envelope: only on a sheet carrying a payment the user approved.', 'return true;');
    expect(s).toContain('.fill(site, sats)\n            .catch(');
    expect(s).not.toContain('if (sats > 0) await accountContext.envelopes.fill(site, sats);');
    expect(s).toContain('rejectStillPending(');
    expect(s).toContain('[...result.granted, ...result.denied].map((r) => r.requestID),');
    expect(s).toContain(': workFailed');
  });
});
