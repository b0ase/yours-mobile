import { beforeEach, describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, type WalletInterface } from '@bsv/sdk';
import { isReservedProtocol } from '../../services/reservedProtocols';
import type { Sealed } from '../bmail/envelope';
import type { Received } from '../bmail/store';
import { bytesToSealed, sealedToBytes } from '../bmail/envelope';
import { checkConfirmations, disputeLine, ingestMail, payWorker, type Send } from './api';
import { addStatement, closeDispute, emptyLedger, notePayment, payCsv, periods, totalsOf } from './ledger';
import { PAY_PROTOCOL, signStatement, statementHash, verifyDispute, verifyStatement } from './statement';
import { loadWages } from './store';

// Synthetic pay periods between two wallets (brief HWPE §7). Mail goes through a fake relay; payments are fake txids.
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
};

const payerW = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface;
const workerW = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface;
const key = async (w: WalletInterface) => (await w.getPublicKey({ identityKey: true })).publicKey.toLowerCase();
const RATE = 50; // $50 per BSV: $1 = 2,000,000 sats

let box: Received[] = [];
let n = 0;
/** Fake relay: delivers the letter, and the postage arrives verified unless `bad` (uncertain transfer). */
const relay =
  (from: string, opts: { bad?: boolean } = {}): Send =>
  async (_w, a) => {
    const id = (++n).toString(16).padStart(32, '0');
    const txid = a.sats > 0 ? id.padStart(64, 'a') : undefined;
    const sealed = bytesToSealed(sealedToBytes(a.sealed));
    box.push({
      id,
      from,
      at: Date.now(),
      verifiedSats: txid && !opts.bad ? a.sats : 0,
      env: {
        t: 'bmail',
        v: 1,
        id,
        from,
        to: a.to,
        at: Date.now(),
        sealed: '',
        ...(txid
          ? { postage: { txid, sats: a.sats, outputIndex: 0, beef: '', derivationPrefix: '', derivationSuffix: '' } }
          : {}),
      },
      opened: sealed,
    });
    return {
      id,
      to: a.to,
      toLabel: a.toLabel,
      at: Date.now(),
      subject: '',
      body: '',
      sats: a.sats,
      replyPaidSats: 0,
      txid,
    };
  };
const openFail = async (): Promise<Sealed> => {
  throw new Error('should use the opened copy');
};

let payer = '';
let worker = '';
const base = () => ({
  payerName: 'Acme Ltd',
  worker,
  workerPaymail: 'sam@bwalletx.com',
  period: { start: '2026-10-01', end: '2026-10-15' },
  grossCents: 100_000,
  deductions: [
    { label: 'Platform fee', cents: 10_000, basis: '10% of gross' },
    { label: 'Equipment', cents: 5_000, basis: 'Laptop hire, 15 days at $3.33' },
  ],
  note: 'Thanks for the first half of October.',
  usdPerBsv: RATE,
});
const workerSync = async () => {
  const st = await ingestMail(worker, box, openFail, loadWages(worker));
  mem.set(`bw-wages:${worker}`, JSON.stringify(st));
  return st.ledger;
};
const payerSync = async () => {
  const st = await ingestMail(payer, box, openFail, loadWages(payer));
  mem.set(`bw-wages:${payer}`, JSON.stringify(st));
  return st.ledger;
};

beforeEach(async () => {
  mem.clear();
  box = [];
  payer = await key(payerW);
  worker = await key(workerW);
});

describe('pay statements', () => {
  test('signed as canonical JSON by the payer; any change breaks it; protocol is wallet-only', async () => {
    const s = await signStatement(payerW, base());
    expect(s.netCents).toBe(85_000);
    expect(s.netSats).toBe(1_700_000_000);
    expect(verifyStatement(s)).toBe(true);
    expect(verifyStatement(JSON.parse(JSON.stringify(s)))).toBe(true);
    expect(verifyStatement({ ...s, netCents: 95_000 })).toBe(false);
    expect(verifyStatement({ ...s, deductions: [s.deductions[0]] })).toBe(false);
    expect(verifyStatement({ ...s, payer: worker })).toBe(false);
    expect(statementHash(s)).toMatch(/^[0-9a-f]{64}$/);
    expect(isReservedProtocol(PAY_PROTOCOL)).toBe(true);
  });

  test('sums that do not add up are refused', async () => {
    await expect(signStatement(payerW, { ...base(), grossCents: 0 })).rejects.toThrow();
    await expect(
      signStatement(payerW, { ...base(), period: { start: '2026-10-15', end: '2026-10-01' } }),
    ).rejects.toThrow();
    await expect(
      signStatement(payerW, { ...base(), deductions: [{ label: 'Fee', cents: 200_000, basis: 'x' }] }),
    ).rejects.toThrow();
    await expect(
      signStatement(payerW, { ...base(), deductions: [{ label: 'Fee', cents: 1, basis: '' }] }),
    ).rejects.toThrow();
  });

  test('full payment: pending, then confirmed by a late confirmation; nothing left to do', async () => {
    await payWorker(payerW, base(), { send: relay(payer) });
    let l = await workerSync();
    let [v] = periods(l);
    expect(v.pendingCents).toBe(85_000);
    expect(v.receivedCents).toBe(0);
    expect(v.next).toBe('network');
    l = await checkConfirmations(l, async () => ({}) as never);
    [v] = periods(l);
    expect(v.receivedCents).toBe(85_000);
    expect(v.pendingCents).toBe(0);
    expect(v.next).toBe('nobody');
    // The payer's own ledger holds the same statement and payment.
    expect(periods(loadWages(payer).ledger)[0].pendingCents).toBe(85_000);
  });

  test('partial payment: the shortfall is still owed and the payer acts next', async () => {
    await payWorker(payerW, { ...base(), paySats: 1_000_000_000 }, { send: relay(payer) }); // $500 of $850
    const [v] = periods(await workerSync());
    expect(v.pendingCents).toBe(50_000);
    expect(v.outstandingCents).toBe(35_000);
    expect(v.next).toBe('payer');
  });

  test('duplicate notice: the same payment arriving twice is allocated once', async () => {
    await payWorker(payerW, base(), { send: relay(payer) });
    box.push({ ...box[0], id: 'f'.repeat(32) }); // relay redelivers under a new id
    await workerSync();
    const l = await workerSync(); // and a second sync
    expect(l.payments).toHaveLength(1);
    expect(periods(l)[0].pendingCents).toBe(85_000);
  });

  test('a notice cannot move an allocated payment to another statement or period', async () => {
    const a = await signStatement(payerW, base());
    const b = await signStatement(payerW, { ...base(), period: { start: '2026-10-16', end: '2026-10-31' } });
    let l = addStatement(addStatement(emptyLedger(), a), b);
    const txid = 'b'.repeat(64);
    l = notePayment(l, { txid, sats: a.netSats, statementId: a.id, status: 'pending', at: 1 });
    l = notePayment(l, { txid, sats: a.netSats, statementId: b.id, status: 'confirmed', at: 2 });
    expect(l.payments).toEqual([{ txid, sats: a.netSats, statementId: a.id, status: 'pending', at: 1 }]);
    // a status can never go down
    l = notePayment(l, { txid, sats: a.netSats, statementId: a.id, status: 'confirmed', at: 3 });
    l = notePayment(l, { txid, sats: a.netSats, statementId: a.id, status: 'uncertain', at: 4 });
    expect(l.payments[0].status).toBe('confirmed');
  });

  test('uncertain transfer: shown as pending but flagged, and the payer acts next', async () => {
    await payWorker(payerW, base(), { send: relay(payer, { bad: true }) });
    const l = await workerSync();
    const [v] = periods(l);
    expect(l.payments[0].status).toBe('uncertain');
    expect(v.uncertainCents).toBe(85_000);
    expect(v.receivedCents).toBe(0);
    expect(v.next).toBe('payer');
    expect(totalsOf([v]).pendingCents).toBe(85_000);
  });

  test('disputed deduction, then a correction: the original is kept, a payment never closes the dispute', async () => {
    const s = await payWorker(payerW, base(), { send: relay(payer) });
    let wl = await workerSync();
    const d = await disputeLine(
      workerW,
      s,
      { line: 'deduction:1', cents: 5_000, reason: 'No laptop was supplied' },
      { send: relay(worker) },
    );
    expect(verifyDispute(d)).toBe(true);
    // Payer receives the signed dispute.
    let pl = await payerSync();
    expect(pl.disputes).toHaveLength(1);
    expect(periods(pl)[0].next).toBe('payer');
    wl = loadWages(worker).ledger;
    expect(periods(wl)[0].disputedCents).toBe(5_000);
    // A payment (the payer tops up without a correction) does not close it.
    wl = await checkConfirmations(wl, async () => ({}) as never);
    wl = notePayment(wl, { txid: 'c'.repeat(64), sats: 100, statementId: s.id, status: 'confirmed', at: 9 });
    expect(wl.disputes[0].state).toBe('open');
    mem.set(`bw-wages:${worker}`, JSON.stringify({ ...loadWages(worker), ledger: wl }));
    // Correction: a new signed statement that references the original, paying the $50 difference.
    const fix = await payWorker(
      payerW,
      { ...base(), deductions: [base().deductions[0]], replaces: s.id, paySats: 100_000_000 },
      { send: relay(payer) },
    );
    wl = await workerSync();
    const [v] = periods(wl);
    expect(v.statement.id).toBe(fix.id);
    expect(v.history.map((x) => x.id)).toEqual([s.id]);
    expect(wl.statements.find((x) => x.id === s.id)).toEqual(s); // never overwritten
    expect(v.dueCents).toBe(90_000);
    expect(wl.disputes[0].state).toBe('answered');
    expect(v.next).toBe('worker');
    wl = closeDispute(wl, d.id);
    const [w] = periods(wl);
    expect(w.disputedCents).toBe(0);
    expect(w.outstandingCents).toBe(0);
    // The payer sees the correction answered the dispute too.
    pl = loadWages(payer).ledger;
    expect(pl.disputes[0].state).toBe('answered');
  });

  test('a dispute from someone other than the worker is ignored', async () => {
    const s = await payWorker(payerW, base(), { send: relay(payer) });
    const stranger = new ProtoWallet(PrivateKey.fromRandom()) as unknown as WalletInterface;
    await disputeLine(stranger, s, { line: 'gross', cents: 1, reason: 'x' }, { send: relay(await key(stranger)) });
    expect((await payerSync()).disputes).toHaveLength(0);
  });

  test('a statement forged by someone other than the sender is ignored', async () => {
    const s = await signStatement(payerW, base());
    box.push({
      id: 'e'.repeat(32),
      from: worker,
      at: 1,
      verifiedSats: 0,
      env: { t: 'bmail', v: 1, id: 'e'.repeat(32), from: worker, to: worker, at: 1, sealed: '' },
      opened: { subject: '', body: '', wage: { kind: 'statement', statement: s } },
    });
    expect((await workerSync()).statements).toHaveLength(0);
  });

  test('split across two periods: two statements, two payments, each in its own period', async () => {
    await payWorker(
      payerW,
      { ...base(), period: { start: '2026-09-25', end: '2026-09-30' }, grossCents: 30_000, deductions: [] },
      { send: relay(payer) },
    );
    await payWorker(
      payerW,
      { ...base(), period: { start: '2026-10-01', end: '2026-10-05' }, grossCents: 20_000, deductions: [] },
      { send: relay(payer) },
    );
    const l = await workerSync();
    const vs = periods(l);
    expect(vs.map((v) => [v.statement.period.start, v.pendingCents])).toEqual([
      ['2026-10-01', 20_000],
      ['2026-09-25', 30_000],
    ]);
    expect(new Set(l.payments.map((p) => p.statementId)).size).toBe(2);
    expect(totalsOf(vs).pendingCents).toBe(50_000);
  });

  test('CSV export lists every version, line, payment and dispute', async () => {
    const s = await payWorker(payerW, base(), { send: relay(payer) });
    await workerSync();
    await disputeLine(
      workerW,
      s,
      { line: 'deduction:0', cents: 10_000, reason: 'Fee is 5%, "not 10%"' },
      { send: relay(worker) },
    );
    const csv = payCsv(loadWages(worker).ledger);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('period_start,period_end,statement_id');
    expect(lines).toHaveLength(1 + 4 + 1 + 1); // header, gross+2 deductions+net, payment, dispute
    expect(csv).toContain('"Fee is 5%, ""not 10%"""');
    expect(csv).toContain('-$100.00');
  });
});
