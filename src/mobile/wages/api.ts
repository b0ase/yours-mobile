import type { WalletInterface } from '@bsv/sdk';
import { myKey, openMail, sendMail } from '../bmail/client';
import { wocProof, type ProofFetcher } from '../bmail/delivery';
import type { Sealed } from '../bmail/envelope';
import type { Received } from '../bmail/store';
import { addDispute, addStatement, notePayment, setPaymentStatus, type Ledger } from './ledger';
import {
  lineLabel,
  parseWagePart,
  signDispute,
  signStatement,
  verifyDispute,
  verifyStatement,
  type PayStatement,
  type StatementInput,
} from './statement';
import { loadWages, saveWages, type WagesState } from './store';

/**
 * Wages over bMail. The statement is a sealed part of the letter (encrypted to the worker, never on chain) and the
 * net pay is the letter's postage: one BRC-29 payment to the worker, made in the same send (bmail/client.ts sendMail),
 * so the statement and its payment always arrive together. The statement hash is not published anywhere.
 */
export type Send = typeof sendMail;
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export const statementLetter = (s: PayStatement): Sealed => ({
  subject: `${s.replaces ? 'Corrected pay' : 'Pay'} statement ${s.period.start} to ${s.period.end}`,
  body: [
    `${s.payerName || 'Your payer'} paid you ${usd(s.netCents)} for ${s.period.start} to ${s.period.end}.`,
    `Gross ${usd(s.grossCents)}.`,
    ...s.deductions.map((d) => `${d.label}: ${usd(d.cents)} (${d.basis}).`),
    s.note,
    'Open bWalletX › Settings › Pay to see it, check it or dispute a line.',
  ]
    .filter(Boolean)
    .join('\n'),
  wage: { kind: 'statement', statement: s },
});

/** Payer: sign the statement, send it with the net pay, and keep both in the payer's ledger. */
export const payWorker = async (
  wallet: WalletInterface,
  input: StatementInput & { paySats?: number },
  deps: { send?: Send; now?: number } = {},
): Promise<PayStatement> => {
  const s = await signStatement(wallet, input, deps.now);
  // `paySats` < netSats is a part payment (the statement still says what is due).
  const sats = Math.min(input.paySats ?? s.netSats, s.netSats);
  const sent = await (deps.send ?? sendMail)(wallet, {
    to: s.worker,
    toLabel: s.workerPaymail || s.worker.slice(0, 10),
    sealed: statementLetter(s),
    sats,
    replyPaidSats: 0,
  });
  const me = await myKey(wallet);
  update(me, (l) => {
    let n = addStatement(l, s);
    if (sent.txid) n = notePayment(n, { txid: sent.txid, sats, statementId: s.id, status: 'pending', at: sent.at });
    return n;
  });
  return s;
};

/** Worker: sign a dispute of one line and send it to the payer (no payment). */
export const disputeLine = async (
  wallet: WalletInterface,
  s: PayStatement,
  input: { line: string; cents: number; reason: string },
  deps: { send?: Send; now?: number } = {},
) => {
  const d = await signDispute(wallet, { statementId: s.id, ...input }, deps.now);
  await (deps.send ?? sendMail)(wallet, {
    to: s.payer,
    toLabel: s.payerName || s.payer.slice(0, 10),
    sealed: {
      subject: `Pay dispute ${s.period.start} to ${s.period.end}`,
      body: `I dispute "${lineLabel(s, d.line)}" (${usd(d.cents)}): ${d.reason}`,
      wage: { kind: 'dispute', dispute: d },
    },
    sats: 0,
    replyPaidSats: 0,
  });
  update(await myKey(wallet), (l) => addDispute(l, d));
  return d;
};

/**
 * Read pay parts out of received bMail. Each letter is opened once (ids kept in `scanned`). A statement counts only
 * when signed by the sender and addressed to me; its postage is the payment: verified → pending, a postage that did
 * not verify → uncertain. A dispute counts only when the worker on my statement signed it and sent it.
 */
export const ingestMail = async (
  me: string,
  received: Received[],
  open: (r: Received) => Promise<Sealed>,
  st: WagesState,
): Promise<WagesState> => {
  let ledger = st.ledger;
  const scanned = new Set(st.scanned);
  for (const r of received) {
    if (scanned.has(r.id) || r.erased) continue;
    scanned.add(r.id);
    let sealed: Sealed;
    try {
      sealed = r.opened ?? (await open(r));
    } catch {
      continue;
    }
    const part = parseWagePart(sealed.wage);
    if (!part) continue;
    if (part.kind === 'statement') {
      const s = part.statement;
      if (s.payer !== r.from || s.worker !== me || !verifyStatement(s)) continue;
      ledger = addStatement(ledger, s);
      const p = r.env.postage;
      if (p)
        ledger = notePayment(ledger, {
          txid: p.txid,
          sats: r.verifiedSats > 0 ? r.verifiedSats : p.sats,
          statementId: s.id,
          status: r.verifiedSats > 0 ? 'pending' : 'uncertain',
          at: r.at,
        });
    } else {
      const d = part.dispute;
      const s = ledger.statements.find((x) => x.id === d.statementId);
      if (!s || s.payer !== me || d.worker !== r.from || !verifyDispute(d)) continue;
      ledger = addDispute(ledger, d);
    }
  }
  return { ledger, scanned: [...scanned] };
};

/** Late confirmation: a payment with a Merkle proof is confirmed (status only ever goes up). */
export const checkConfirmations = async (l: Ledger, proof: ProofFetcher = wocProof()): Promise<Ledger> => {
  let out = l;
  for (const p of l.payments.filter((x) => x.status !== 'confirmed')) {
    if (await proof(p.txid).catch(() => null)) out = setPaymentStatus(out, p.txid, 'confirmed');
  }
  return out;
};

const update = (me: string, f: (l: Ledger) => Ledger) => {
  const st = loadWages(me);
  saveWages(me, { ...st, ledger: f(st.ledger) });
};

/** Refresh: read new mail, check confirmations, save. */
export const refreshWages = async (wallet: WalletInterface, received: Received[], proof?: ProofFetcher) => {
  const me = await myKey(wallet);
  const st = await ingestMail(me, received, (r) => openMail(wallet, r.env), loadWages(me));
  const next = { ...st, ledger: await checkConfirmations(st.ledger, proof) };
  saveWages(me, next);
  return next;
};
