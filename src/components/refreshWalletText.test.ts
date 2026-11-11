import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { needsLookSummary, nextStep, syncFailureText } from './refreshWalletText';

// Owner, 11 Nov 2026: REFRESH WALLET ended "1 thing needs a look" with no word of what, and the sync row said only
// "An internal error has occurred." (1Sat's backup server's answer for any non-wallet error).
describe('REFRESH WALLET plain words', () => {
  test('the bare internal error names the 1Sat backup and says the coins are safe', () => {
    const t = syncFailureText('An internal error has occurred.');
    expect(t).toContain('backup (1Sat');
    expect(t).toContain('nothing was sent');
    expect(t).not.toContain('internal error');
  });

  test('connection failures say "Couldn\'t reach your backup (1Sat)"', () => {
    for (const raw of [
      'WalletStorageClient rpcCall: network error 502',
      'Failed to fetch',
      'the backup did not answer in time',
      'the backup took too long',
    ])
      expect(syncFailureText(raw)).toStartWith("Couldn't reach your backup (1Sat)");
    expect(syncFailureText('backup storage is not connected')).toStartWith("Couldn't connect to your backup (1Sat)");
  });

  test('a 507 from the backup is the storage fee, not "internal error"', () => {
    expect(syncFailureText('WalletStorageClient rpcCall: network error 507')).toContain('storage fee');
    expect(nextStep('sync', 'WalletStorageClient rpcCall: network error 507')).toContain('support');
  });

  test('anything else still gets a plain sentence', () => {
    expect(syncFailureText('something odd')).toStartWith("Couldn't sync with your other devices.");
    expect(syncFailureText(undefined)).toStartWith("Couldn't sync with your other devices.");
  });

  test('"needs a look" names each row and its next step', () => {
    const one = needsLookSummary([
      {
        key: 'sync',
        title: 'Sync with my other devices',
        text: syncFailureText('An internal error has occurred.'),
        raw: 'An internal error has occurred.',
      },
    ]);
    expect(one.heading).toBe('1 thing needs a look');
    expect(one.lines).toHaveLength(1);
    expect(one.lines[0]).toStartWith('Sync with my other devices: ');
    expect(one.lines[0]).toContain('REFRESH WALLET again later');

    const two = needsLookSummary([
      { key: 'resync', title: 'Resync coins', text: 'Wallet services are not ready yet.' },
      { key: 'missing', title: 'Rescan the chain', text: 'We found 0.01 BSV…', found: true },
    ]);
    expect(two.heading).toBe('2 things need a look');
    expect(two.lines[1]).toBe('Rescan the chain: Check the coins below and tap Add it back.');

    expect(needsLookSummary([])).toEqual({ heading: 'All checked. Your coins are safe.', lines: [] });
  });

  test('the checklist shows the summary lines and keeps the raw error behind Details', () => {
    const src = readFileSync(join(import.meta.dir, 'HomeShortcuts.tsx'), 'utf8');
    expect(src).toContain('needsLookSummary(');
    expect(src).toContain('look.lines.map');
    expect(src).toContain('syncFailureText(raw)');
    expect(src).toContain("'Details'");
    expect(src).toContain('{s.raw}');
  });
});
