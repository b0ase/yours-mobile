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

  test('N1: settles the other side (the permissions manager) once per id still waiting, even if that throws', () => {
    const rejected: string[] = [];
    const managers: string[] = [];
    const pending = new Map([
      ['x', { reject: () => void rejected.push('x') }],
      ['y', { reject: () => void rejected.push('y') }],
    ]);
    const n = rejectStillPending(['x', 'gone', 'y'], pending, new Error('refused'), (id) => {
      managers.push(id);
      if (id === 'x') throw new Error('manager gone');
    });
    expect(n).toBe(2);
    expect(managers).toEqual(['x', 'y']);
    expect(rejected).toEqual(['x', 'y']);
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

  test('N1: unsettled requests are refused on the manager side too (as failUnshownPrompt does)', () => {
    const s = section('// The envelope: only on a sheet carrying a payment the user approved.', 'return true;');
    expect(s).toContain('rejectManagerRequest(wallet, id, err)');
    expect(s).toContain('if (!isReconnectRequestId(id) && !isSealRequestId(id))');
  });

  test('N2: once settling starts, a failure never tells the user to retry; a failed deny never fails the answer', () => {
    const work = section('let settling = false;', 'return true;');
    const all = work.indexOf('await Promise.all([');
    expect(work.lastIndexOf('settling = true;', all)).toBeGreaterThan(0);
    expect(work).toContain('if (settling) return;');
    expect(work.indexOf('if (settling) return;')).toBeLessThan(work.indexOf('workFailed = true;'));
    expect(work).toMatch(/await wallet\?\.denyPermission\(r\.requestID\);\n\s+\} catch \(error\) \{/);
  });

  test('PermissionsManager reloads after a partial Revoke all', () => {
    const page = readFileSync(new URL('../pages/PermissionsManager.tsx', import.meta.url), 'utf8');
    expect(page).toContain("if (typeof response.data?.revokedCount === 'number') {\n          await loadData();");
  });
});
