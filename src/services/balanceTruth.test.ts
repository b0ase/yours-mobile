import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import {
  STALE_SYNC_MS,
  UNSENT_GRACE_MS,
  arrivingFromAdmissions,
  heldPayments,
  nextDeviceSyncHealth,
  truthLines,
  type BalanceTruth,
  type TruthStore,
} from './balanceTruth';
import { createDeviceSync } from './deviceSync';
import { BalanceTruthView } from '../components/BalanceTruthLines';

const NOW = new Date('2026-11-13T12:00:00Z').getTime();
const sats = (n: number) => `${n.toLocaleString('en-US')} sats`;
const html = (t: BalanceTruth | null, o: { hideAmounts?: boolean } = {}) =>
  renderToStaticMarkup(createElement(BalanceTruthView, { lines: truthLines(t, sats, NOW, o), fmt: sats }));

const clean: BalanceTruth = { held: [], arrivingSats: 0, syncApplies: true, sync: { okAt: NOW - 4 * 60_000 } };

describe('the balance card tells the truth in lines (plan fix 5, 13 Nov 2026)', () => {
  test('one unsent payment and one coin arriving: a line each, the sync line calm', () => {
    const t: BalanceTruth = {
      ...clean,
      held: [
        {
          txid: 'a'.repeat(64),
          description: 'Theme: Gold Rush',
          status: 'nosend',
          sats: 61_000,
          createdAt: NOW - 86_400_000,
        },
      ],
      arrivingSats: 250_000,
    };
    const lines = truthLines(t, sats, NOW);
    expect(lines.map((l) => l.text)).toEqual([
      'Held by an unsent payment: 61,000 sats',
      'Arriving from your other device: 250,000 sats',
      'Synced with your other devices 4 min ago',
    ]);
    const out = html(t);
    expect(out).toContain('Held by an unsent payment: 61,000 sats');
    expect(out).toContain('Arriving from your other device: 250,000 sats');
    expect(out).toContain('Synced with your other devices 4 min ago');
    expect(out).not.toContain('role="alert"');
    // Two held payments read as a count.
    const two = truthLines({ ...t, held: [...t.held, { ...t.held[0], txid: 'b'.repeat(64), sats: 1_000 }] }, sats, NOW);
    expect(two[0].text).toBe('Held by 2 unsent payments: 62,000 sats');
  });

  test('a stale or stuck sync turns the line red with the last good time', () => {
    const okAt = new Date(2026, 10, 8, 14, 5).getTime();
    const stale = truthLines({ ...clean, sync: { okAt } }, sats, NOW);
    expect(stale).toEqual([{ kind: 'sync', text: 'Not synced since 8 Nov, 14:05', warn: true }]);
    expect(html({ ...clean, sync: { okAt } })).toContain('role="alert"');
    // Just under 6 h: still calm.
    expect(truthLines({ ...clean, sync: { okAt: NOW - STALE_SYNC_MS + 60_000 } }, sats, NOW)[0]).toMatchObject({
      warn: false,
      text: 'Synced with your other devices 5 h ago',
    });
    // A pull that goes through while its pass from the start has stopped moving: red at once.
    const recent = NOW - 10 * 60_000;
    expect(truthLines({ ...clean, sync: { okAt: recent, stuck: true } }, sats, NOW)[0]).toMatchObject({ warn: true });
    // Never a good pull, failing 6 h: said so.
    expect(truthLines({ ...clean, sync: { failingSince: NOW - STALE_SYNC_MS } }, sats, NOW)[0]).toMatchObject({
      text: 'Not synced with your other devices yet',
      warn: true,
    });
  });

  test('nothing shows when all is clean', () => {
    expect(truthLines({ ...clean, syncApplies: false }, sats, NOW)).toEqual([]);
    expect(html({ ...clean, syncApplies: false })).toBe('');
    expect(html({ ...clean, sync: null })).toBe('');
    expect(html(null)).toBe('');
    // No other device or backup: the sync line hides, whatever is stored.
    expect(truthLines({ ...clean, syncApplies: false, sync: { okAt: 1 } }, sats, NOW)).toEqual([]);
    // A payment that holds nothing, a short failure: nothing.
    expect(
      truthLines(
        {
          ...clean,
          syncApplies: false,
          held: [{ txid: 'c'.repeat(64), description: '', status: 'nosend', sats: 0, createdAt: NOW }],
          sync: { okAt: NOW - 60_000, failingSince: NOW - 60_000 },
        },
        sats,
        NOW,
      ),
    ).toEqual([]);
    // Balance hidden: the money lines go, the sync line stays.
    const held = [{ txid: 'd'.repeat(64), description: '', status: 'nosend', sats: 9, createdAt: 0 }];
    const hidden = truthLines({ ...clean, arrivingSats: 5, held }, sats, NOW, { hideAmounts: true });
    expect(hidden.map((l) => l.kind)).toEqual(['sync']);
  });
});

/** A device store with transactions and outputs, as StorageIdb answers the partial reads used here. */
const fakeStore = (
  txs: { transactionId: number; txid: string; status: string; description?: string; created_at: Date }[],
  outs: {
    transactionId: number;
    vout: number;
    txid: string;
    satoshis: number;
    spendable: boolean;
    change?: boolean;
    spentBy?: number | null;
    userId?: number;
  }[],
): TruthStore => ({
  findTransactions: async ({ partial }) =>
    txs.filter((t) => (partial.status === undefined || t.status === partial.status) && partial.userId === 1),
  findOutputs: async ({ partial }) =>
    outs.filter(
      (o) =>
        (partial.spentBy === undefined || o.spentBy === partial.spentBy) &&
        (partial.transactionId === undefined || o.transactionId === partial.transactionId) &&
        (partial.txid === undefined || o.txid === partial.txid) &&
        (partial.vout === undefined || o.vout === partial.vout),
    ),
});

describe('what the background reads for the lines (device store, read only)', () => {
  test('a held payment counts its inputs, less its own change the headline already counts; a fresh one waits', async () => {
    const old = new Date(NOW - 3 * 86_400_000);
    const store = fakeStore(
      [
        { transactionId: 446, txid: 'e'.repeat(64), status: 'nosend', description: 'bWalletX theme', created_at: old },
        {
          transactionId: 447,
          txid: 'f'.repeat(64),
          status: 'unsigned',
          created_at: new Date(NOW - UNSENT_GRACE_MS + 1_000),
        },
        {
          transactionId: 448,
          txid: '1'.repeat(64),
          status: 'unprocessed',
          description: 'Queued',
          created_at: new Date(NOW - 600_000),
        },
        { transactionId: 449, txid: '2'.repeat(64), status: 'completed', created_at: old },
      ],
      [
        // tx 446 spends two coins and has 10,000 sats of spendable change (counted in the headline already).
        { transactionId: 10, vout: 0, txid: '9'.repeat(64), satoshis: 50_000, spendable: false, spentBy: 446 },
        { transactionId: 11, vout: 1, txid: '8'.repeat(64), satoshis: 21_000, spendable: false, spentBy: 446 },
        { transactionId: 446, vout: 0, txid: 'e'.repeat(64), satoshis: 1_000, spendable: false },
        { transactionId: 446, vout: 1, txid: 'e'.repeat(64), satoshis: 10_000, spendable: true, change: true },
        // tx 447 is under the grace: skipped.
        { transactionId: 12, vout: 0, txid: '7'.repeat(64), satoshis: 5_000, spendable: false, spentBy: 447 },
        // tx 448: 3,000 in, no change.
        { transactionId: 13, vout: 0, txid: '6'.repeat(64), satoshis: 3_000, spendable: false, spentBy: 448 },
        // a completed payment's input: never held.
        { transactionId: 14, vout: 0, txid: '5'.repeat(64), satoshis: 99_000, spendable: false, spentBy: 449 },
      ],
    );
    const held = await heldPayments(store, 1, NOW);
    expect(held.map((h) => [h.status, h.sats, h.description])).toEqual([
      ['unprocessed', 3_000, 'Queued'],
      ['nosend', 61_000, 'bWalletX theme'],
    ]);
  });

  test('arriving: admission coins this device holds back, not ones admitted, spent, or already counted as arriving', async () => {
    const store = fakeStore(
      [],
      [
        { transactionId: 20, vout: 0, txid: 'a1'.padEnd(64, '0'), satoshis: 250_000, spendable: false, spentBy: null },
        { transactionId: 21, vout: 0, txid: 'b1'.padEnd(64, '0'), satoshis: 7_000, spendable: true },
        { transactionId: 22, vout: 0, txid: 'c1'.padEnd(64, '0'), satoshis: 8_000, spendable: false, spentBy: 30 },
        { transactionId: 23, vout: 1, txid: 'd1'.padEnd(64, '0'), satoshis: 9_000, spendable: false, spentBy: null },
      ],
    );
    const total = await arrivingFromAdmissions(
      store,
      1,
      [
        { kind: 'coin', txid: 'a1'.padEnd(64, '0'), vout: 0 },
        { kind: 'coin', txid: 'a1'.padEnd(64, '0'), vout: 0 }, // listed twice: counted once
        { kind: 'coin', txid: 'b1'.padEnd(64, '0'), vout: 0 }, // admitted since
        { kind: 'coin', txid: 'c1'.padEnd(64, '0'), vout: 0 }, // spent
        { kind: 'coin', txid: 'd1'.padEnd(64, '0'), vout: 1 }, // its sweep is counted as arriving by the receive guard
        { kind: 'coin', txid: 'e1'.padEnd(64, '0'), vout: 0 }, // no row here yet
        { kind: 'tx', txid: 'f1'.padEnd(64, '0') },
      ],
      ['D1'.padEnd(64, '0'), undefined],
    );
    expect(total).toBe(250_000);
  });
});

describe('the last device-sync pull is recorded for the sync line', () => {
  test('ok, stuck and failed pulls', () => {
    expect(nextDeviceSyncHealth(undefined, { ok: true }, 100)).toEqual({ okAt: 100 });
    expect(nextDeviceSyncHealth({ okAt: 100 }, { ok: false, error: 'timeout' }, 200)).toEqual({
      okAt: 100,
      failingSince: 200,
      error: 'timeout',
    });
    expect(nextDeviceSyncHealth({ okAt: 100, failingSince: 200 }, { ok: false, error: 'x' }, 300)).toMatchObject({
      failingSince: 200,
    });
    // A pull that went through on a stuck pass keeps the last good time.
    expect(nextDeviceSyncHealth({ okAt: 100 }, { ok: true, stuck: true }, 400)).toEqual({ okAt: 100, stuck: true });
    expect(nextDeviceSyncHealth({ okAt: 100, stuck: true }, { ok: true }, 500)).toEqual({ okAt: 500 });
  });

  test('deviceSync reports a pull that went through, and a pull that failed, never a push failure as a pull', async () => {
    const seen: unknown[] = [];
    let pushFails = false;
    let pullFails = false;
    const sync = createDeviceSync({
      applies: () => true,
      ensureBackup: async () => true,
      pull: async () => {
        if (pullFails) throw new Error('backup did not answer in time');
      },
      push: async () => {
        if (pushFails) throw new Error('push broke');
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
      onPull: (r) => seen.push(r),
    });
    await sync.syncNow();
    expect(seen).toEqual([{ ok: true }]);
    expect(sync.state().lastPullOkAt).toBeGreaterThan(0);
    pushFails = true;
    await sync.syncNow();
    expect(seen).toEqual([{ ok: true }, { ok: true }]);
    pullFails = true;
    await sync.syncNow();
    expect(seen[2]).toEqual({ ok: false, error: 'backup did not answer in time' });
  });

  test('the phone card and the extension both show the lines; the phone build hides the extension copy', () => {
    const card = readFileSync(new URL('../mobile/wallet/WalletCard.tsx', import.meta.url), 'utf8');
    const ext = readFileSync(new URL('../pages/BsvWallet.tsx', import.meta.url), 'utf8');
    const mobile = readFileSync(new URL('../../vite.config.mobile.ts', import.meta.url), 'utf8');
    expect(card).toContain('<BalanceTruthLines');
    expect(ext).toContain('{balanceKnown && (\n            <BalanceTruthLines');
    expect(mobile).toContain("'{false && balanceKnown && (\\n            <BalanceTruthLines'");
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toContain("case 'BALANCE_TRUTH':");
    expect(bg).toContain("'BALANCE_TRUTH',");
  });
});
