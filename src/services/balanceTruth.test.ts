import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import {
  ATTEMPT_OVERDUE_MS,
  STALE_SYNC_MS,
  STUCK_SHOW_MS,
  TRUTH_MIN_GAP_MS,
  UNSENT_GRACE_MS,
  arrivingFromAdmissions,
  askDue,
  heldPayments,
  nextDeviceSyncHealth,
  truthLines,
  type BalanceTruth,
  type HeldPayment,
  type TruthStore,
} from './balanceTruth';
import { passLooksStuck } from './fullPass';
import { createDeviceSync } from './deviceSync';
import { BalanceTruthLines, BalanceTruthView, HELD_NOTE } from '../components/BalanceTruthLines';
import { TruthLinesOn } from '../components/truthLinesContext';

const NOW = new Date('2026-11-13T12:00:00Z').getTime();
const sats = (n: number) => `${n.toLocaleString('en-US')} sats`;
const html = (t: BalanceTruth | null, o: { hideAmounts?: boolean; announce?: boolean } = {}) =>
  renderToStaticMarkup(
    createElement(BalanceTruthView, { lines: truthLines(t, sats, NOW, o), fmt: sats, announce: o.announce }),
  );

const clean: BalanceTruth = { held: [], arrivingSats: 0, syncApplies: true, sync: { okAt: NOW - 4 * 60_000 } };
const pay = (over: Partial<HeldPayment> = {}): HeldPayment => ({
  txid: 'a'.repeat(64),
  description: 'Theme: Gold Rush',
  status: 'nosend',
  sats: 61_000,
  createdAt: NOW - 86_400_000,
  count: 1,
  ...over,
});

describe('the balance card tells the truth in lines (plan fix 5, 13 Nov 2026)', () => {
  test('one unsent payment and one coin arriving: a line each, the sync line calm', () => {
    const t: BalanceTruth = { ...clean, held: [pay()], arrivingSats: 250_000 };
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
    // Two held payments read as a count; a chain of two counts as two.
    expect(truthLines({ ...t, held: [pay(), pay({ txid: 'b'.repeat(64), sats: 1_000 })] }, sats, NOW)[0].text).toBe(
      'Held by 2 unsent payments: 62,000 sats',
    );
    expect(truthLines({ ...t, held: [pay({ count: 2 })] }, sats, NOW)[0].text).toBe(
      'Held by 2 unsent payments: 61,000 sats',
    );
  });

  test('a stuck sync, or a stale one with a failed pull since, turns the line red with the last good time', () => {
    const okAt = new Date(2026, 10, 8, 14, 5).getTime();
    const failedSince = truthLines({ ...clean, sync: { okAt, failingSince: okAt + 60_000 } }, sats, NOW);
    expect(failedSince).toEqual([{ kind: 'sync', text: 'Not synced since 8 Nov, 14:05', warn: true }]);
    // Just under 6 h, failing: still calm (back-off retries).
    expect(
      truthLines({ ...clean, sync: { okAt: NOW - STALE_SYNC_MS + 60_000, failingSince: NOW - 60_000 } }, sats, NOW)[0],
    ).toMatchObject({ warn: false, text: 'Synced with your other devices 5 h ago' });
    // A pull that goes through while its pass from the start has stopped moving: red at once.
    expect(truthLines({ ...clean, sync: { okAt: NOW - 10 * 60_000, stuck: true } }, sats, NOW)[0]).toMatchObject({
      warn: true,
    });
    // Never a good pull, failing 6 h: said so.
    expect(truthLines({ ...clean, sync: { failingSince: NOW - STALE_SYNC_MS } }, sats, NOW)[0]).toMatchObject({
      text: 'Not synced with your other devices yet',
      warn: true,
    });
  });

  test('review 3: age alone is not a fault: an old pull with no attempt since stays calm', () => {
    const okAt = NOW - 9 * 3_600_000;
    expect(truthLines({ ...clean, sync: { okAt } }, sats, NOW)[0]).toEqual({
      kind: 'sync',
      text: 'Synced with your other devices 9 h ago',
      warn: false,
    });
    // A failure from before that pull doesn't count.
    expect(truthLines({ ...clean, sync: { okAt, failingSince: okAt - 1 } }, sats, NOW)[0]).toMatchObject({
      warn: false,
    });
    // A newer writer's attempt (fix 3's periodic pull) that never finished: red; one still within its time: calm.
    expect(
      truthLines({ ...clean, sync: { okAt, attemptAt: NOW - ATTEMPT_OVERDUE_MS - 1 } }, sats, NOW)[0],
    ).toMatchObject({ warn: true });
    expect(truthLines({ ...clean, sync: { okAt, attemptAt: NOW - 60_000 } }, sats, NOW)[0]).toMatchObject({
      warn: false,
    });
    // Unknown and malformed fields are tolerated.
    const odd = { okAt: NOW - 60_000, attemptAt: 'soon', failingSince: null, nextPullAt: NOW + 1, periodicMs: 9 };
    expect(truthLines({ ...clean, sync: odd as unknown as BalanceTruth['sync'] }, sats, NOW)[0]).toMatchObject({
      warn: false,
      text: 'Synced with your other devices 1 min ago',
    });
  });

  test('nothing shows when all is clean', () => {
    expect(truthLines({ ...clean, syncApplies: false }, sats, NOW)).toEqual([]);
    expect(html({ ...clean, syncApplies: false })).toBe('');
    expect(html({ ...clean, sync: null })).toBe('');
    expect(html(null)).toBe('');
    expect(truthLines({ ...clean, syncApplies: false, sync: { okAt: 1 } }, sats, NOW)).toEqual([]);
    expect(
      truthLines(
        { ...clean, syncApplies: false, held: [pay({ sats: 0 })], sync: { okAt: NOW - 60_000, failingSince: NOW } },
        sats,
        NOW,
      ),
    ).toEqual([]);
    // Balance hidden: the money lines go, the sync line stays.
    const hidden = truthLines({ ...clean, arrivingSats: 5, held: [pay({ sats: 9 })] }, sats, NOW, {
      hideAmounts: true,
    });
    expect(hidden.map((l) => l.kind)).toEqual(['sync']);
  });

  test('review 6 + 9: softer held copy; no alert role; polite announcements only after the first answer', () => {
    expect(HELD_NOTE).not.toMatch(/Not sent/);
    expect(HELD_NOTE).toBe('Waiting to be confirmed sent. Its coins stay set aside until it confirms or is released.');
    const red = { ...clean, sync: { okAt: NOW - 10 * 60_000, stuck: true } };
    expect(html(red)).not.toContain('role="alert"');
    expect(html(red)).not.toContain('aria-live');
    expect(html(red, { announce: true })).toContain('aria-live="polite"');
  });

  test('review 7 + 9: the All cards copy renders no lines and asks nothing; balance-change asks are throttled', () => {
    let asked = 0;
    const send = async () => {
      asked++;
      return { success: true, data: clean };
    };
    const off = renderToStaticMarkup(
      createElement(TruthLinesOn.Provider, { value: false }, createElement(BalanceTruthLines, { fmt: sats, send })),
    );
    expect(off).toBe('');
    expect(asked).toBe(0);
    const carousel = readFileSync(new URL('../mobile/wallet/BalanceCarousel.tsx', import.meta.url), 'utf8');
    expect(carousel).toContain('<TruthLinesOn.Provider value={false}>{bsvCard}</TruthLinesOn.Provider>');
    expect(askDue(1_000, 1_000 + TRUTH_MIN_GAP_MS - 1)).toBe(false);
    expect(askDue(1_000, 1_000 + TRUTH_MIN_GAP_MS)).toBe(true);
    const comp = readFileSync(new URL('../components/BalanceTruthLines.tsx', import.meta.url), 'utf8');
    expect(comp).toContain("addEventListener('visibilitychange', onVis)");
  });
});

type Tx = { transactionId: number; txid: string; status: string; description?: string; created_at: Date };
type Out = {
  transactionId: number;
  vout: number;
  txid: string;
  satoshis: number;
  spendable: boolean;
  change?: boolean;
  spentBy?: number | null;
};
/** A device store with transactions and outputs, as StorageIdb answers the partial reads used here. */
const fakeStore = (txs: Tx[], outs: Out[]): TruthStore => ({
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

const OLD = new Date(NOW - 3 * 86_400_000);
const T = (c: string) => c.repeat(64);

describe('what the background reads for the lines (device store, read only)', () => {
  test('a held payment counts its inputs, less its own change the headline already counts; a fresh one waits', async () => {
    const store = fakeStore(
      [
        { transactionId: 446, txid: T('e'), status: 'nosend', description: 'bWalletX theme', created_at: OLD },
        { transactionId: 447, txid: T('f'), status: 'unsigned', created_at: new Date(NOW - UNSENT_GRACE_MS + 1_000) },
        {
          transactionId: 448,
          txid: T('1'),
          status: 'unprocessed',
          description: 'Queued',
          created_at: new Date(NOW - 600_000),
        },
        { transactionId: 449, txid: T('2'), status: 'completed', created_at: OLD },
      ],
      [
        { transactionId: 10, vout: 0, txid: T('9'), satoshis: 50_000, spendable: false, spentBy: 446 },
        { transactionId: 11, vout: 1, txid: T('8'), satoshis: 21_000, spendable: false, spentBy: 446 },
        { transactionId: 446, vout: 0, txid: T('e'), satoshis: 1_000, spendable: false },
        { transactionId: 446, vout: 1, txid: T('e'), satoshis: 10_000, spendable: true, change: true },
        { transactionId: 12, vout: 0, txid: T('7'), satoshis: 5_000, spendable: false, spentBy: 447 },
        { transactionId: 13, vout: 0, txid: T('6'), satoshis: 3_000, spendable: false, spentBy: 448 },
        { transactionId: 14, vout: 0, txid: T('5'), satoshis: 99_000, spendable: false, spentBy: 449 },
      ],
    );
    const held = await heldPayments(store, 1, NOW);
    expect(held.map((h) => [h.status, h.sats, h.description, h.count])).toEqual([
      ['unprocessed', 3_000, 'Queued', 1],
      ['nosend', 61_000, 'bWalletX theme', 1],
    ]);
  });

  test('review 2: a chain of unsent payments (B spends A’s change) counts once', async () => {
    // A: 100,000 in, 60,000 change spent by B. B: that change in, 20,000 paid away, 39,000 spendable change (in the
    // headline). Held = 100,000 - 39,000 = 61,000. Per-payment sums gave 100,000 + 21,000 = 121,000.
    const store = fakeStore(
      [
        { transactionId: 500, txid: T('a'), status: 'nosend', description: 'Site step 1', created_at: OLD },
        { transactionId: 501, txid: T('b'), status: 'nosend', description: 'Site step 2', created_at: OLD },
      ],
      [
        { transactionId: 40, vout: 0, txid: T('c'), satoshis: 100_000, spendable: false, spentBy: 500 },
        { transactionId: 500, vout: 1, txid: T('a'), satoshis: 60_000, spendable: false, change: true, spentBy: 501 },
        { transactionId: 501, vout: 0, txid: T('b'), satoshis: 20_000, spendable: false },
        { transactionId: 501, vout: 1, txid: T('b'), satoshis: 39_000, spendable: true, change: true },
      ],
    );
    const held = await heldPayments(store, 1, NOW);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ sats: 61_000, count: 2, description: 'Site step 1', txid: T('a') });
    expect(truthLines({ ...clean, held }, sats, NOW)[0].text).toBe('Held by 2 unsent payments: 61,000 sats');
    // The chain is shown when any of it is past the grace (A old, B just made).
    const young = fakeStore(
      [
        { transactionId: 500, txid: T('a'), status: 'nosend', created_at: OLD },
        { transactionId: 501, txid: T('b'), status: 'unsigned', created_at: new Date(NOW - 1_000) },
      ],
      [
        { transactionId: 40, vout: 0, txid: T('c'), satoshis: 100_000, spendable: false, spentBy: 500 },
        { transactionId: 500, vout: 1, txid: T('a'), satoshis: 60_000, spendable: false, change: true, spentBy: 501 },
      ],
    );
    expect((await heldPayments(young, 1, NOW)).map((h) => h.sats)).toEqual([100_000]);
  });

  test('review 5: an input the headline already counts as arriving is not held again', async () => {
    const store = fakeStore(
      [{ transactionId: 600, txid: T('d'), status: 'unsigned', created_at: OLD }],
      [
        { transactionId: 41, vout: 0, txid: T('4'), satoshis: 70_000, spendable: false, spentBy: 600 },
        { transactionId: 42, vout: 2, txid: T('3'), satoshis: 5_000, spendable: false, spentBy: 600 },
      ],
    );
    expect((await heldPayments(store, 1, NOW, [`${T('4')}.0`]))[0].sats).toBe(5_000);
    expect(await heldPayments(store, 1, NOW, [`${T('4')}_0`, `${T('3')}.2`])).toEqual([]);
  });

  test('arriving: admission coins this device holds back, not ones admitted, spent, or already counted as arriving', async () => {
    const pad = (s: string) => s.padEnd(64, '0');
    const store = fakeStore(
      [],
      [
        { transactionId: 20, vout: 0, txid: pad('a1'), satoshis: 250_000, spendable: false, spentBy: null },
        { transactionId: 21, vout: 0, txid: pad('b1'), satoshis: 7_000, spendable: true },
        { transactionId: 22, vout: 0, txid: pad('c1'), satoshis: 8_000, spendable: false, spentBy: 30 },
        { transactionId: 23, vout: 1, txid: pad('d1'), satoshis: 9_000, spendable: false, spentBy: null },
        { transactionId: 24, vout: 3, txid: pad('e2'), satoshis: 4_000, spendable: false, spentBy: null },
      ],
    );
    const entries = [
      { kind: 'coin' as const, txid: pad('a1'), vout: 0 },
      { kind: 'coin' as const, txid: pad('a1'), vout: 0 }, // listed twice: counted once
      { kind: 'coin' as const, txid: pad('b1'), vout: 0 }, // admitted since
      { kind: 'coin' as const, txid: pad('c1'), vout: 0 }, // spent
      { kind: 'coin' as const, txid: pad('d1'), vout: 1 }, // its sweep is counted as arriving (spender tag)
      { kind: 'coin' as const, txid: pad('e2'), vout: 3 }, // review 1: itself an untagged arriving entry
      { kind: 'coin' as const, txid: pad('e1'), vout: 0 }, // no row here yet
      { kind: 'tx' as const, txid: pad('f1') },
    ];
    expect(
      await arrivingFromAdmissions(store, 1, entries, {
        outpoints: [`${pad('E2')}_3`],
        spenders: [pad('D1'), undefined],
      }),
    ).toBe(250_000);
    // Review 1: without the outpoint check the untagged arriving coin was counted twice (headline + this line).
    expect(await arrivingFromAdmissions(store, 1, entries, { outpoints: [], spenders: [pad('d1')] })).toBe(254_000);
  });
});

describe('the last device-sync pull is recorded for the sync line', () => {
  test('ok, stuck and failed pulls; other writers’ fields are kept', () => {
    expect(nextDeviceSyncHealth(undefined, { ok: true }, 100)).toEqual({ okAt: 100 });
    expect(nextDeviceSyncHealth({ okAt: 100 }, { ok: false, error: 'timeout' }, 200)).toEqual({
      okAt: 100,
      failingSince: 200,
      error: 'timeout',
    });
    expect(nextDeviceSyncHealth({ okAt: 100, failingSince: 200 }, { ok: false, error: 'x' }, 300)).toMatchObject({
      failingSince: 200,
    });
    expect(nextDeviceSyncHealth({ okAt: 100 }, { ok: true, stuck: true }, 400)).toEqual({ okAt: 100, stuck: true });
    expect(nextDeviceSyncHealth({ okAt: 100, stuck: true, failingSince: 1, error: 'e' }, { ok: true }, 500)).toEqual({
      okAt: 500,
    });
    // Fix 3's periodic pull may add fields to the same record: never dropped.
    expect(nextDeviceSyncHealth({ okAt: 100, attemptAt: 450, nextPullAt: 900 }, { ok: true }, 500)).toEqual({
      okAt: 500,
      attemptAt: 450,
      nextPullAt: 900,
    });
  });

  test('review 4: stuck is read from the pass as it stands after the pull, not a stale mark', () => {
    const row = (counts: number, progressKey: string, stuckMs: number) => ({
      syncStateId: 1,
      when: undefined,
      syncMap: JSON.stringify({
        transaction: { count: counts },
        bwxFullPass: { startedAt: 1, progressKey, stuckMs },
      }),
    });
    // The pre-pull check saw no movement for 20 min; the pull then moved the offsets: not stuck.
    expect(passLooksStuck(row(70, 'transaction:63', 20 * 60_000), STUCK_SHOW_MS)).toBe(false);
    // The pull left them where they were: stuck.
    expect(passLooksStuck(row(63, 'transaction:63', 20 * 60_000), STUCK_SHOW_MS)).toBe(true);
    // Not long enough, or not a pass from the start of ours: not stuck.
    expect(passLooksStuck(row(63, 'transaction:63', 60_000), STUCK_SHOW_MS)).toBe(false);
    expect(passLooksStuck(undefined, STUCK_SHOW_MS)).toBe(false);
    const wiring = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
    expect(wiring).toContain(
      'stuck = passLooksStuck(await syncStateFor(own as never, identityKey, backupSik), STUCK_SHOW_MS);',
    );
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

  test('wiring: phone card and extension show the lines; the phone hides the extension copy; the ask waits for the wallet', () => {
    const card = readFileSync(new URL('../mobile/wallet/WalletCard.tsx', import.meta.url), 'utf8');
    const ext = readFileSync(new URL('../pages/BsvWallet.tsx', import.meta.url), 'utf8');
    const mobile = readFileSync(new URL('../../vite.config.mobile.ts', import.meta.url), 'utf8');
    expect(card).toContain('<BalanceTruthLines');
    expect(ext).toContain('{balanceKnown && (\n            <BalanceTruthLines');
    expect(mobile).toContain("'{false && balanceKnown && (\\n            <BalanceTruthLines'");
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    const handler = bg.slice(bg.indexOf("case 'BALANCE_TRUTH':"), bg.indexOf("case 'BALANCE_TRUTH':") + 900);
    expect(handler).toContain('await ensureWallet(true);');
    expect(handler).not.toContain('still opening');
    expect(bg).toContain("'BALANCE_TRUTH',");
  });
});
