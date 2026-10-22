// The partnership's SHARED ACCOUNT (owner, 22 Oct 2026: "multisig in the wallet for partners"). Plain BSV held in
// bare M-of-N multisig outputs over the partners' keys, under the agreement's rule (2 of 3, unanimous…):
//
//   OP_m <k1> … <kn> OP_n OP_CHECKMULTISIG     keys sorted, the SAME per-partnership keys as Partnership shares
//
// P2SH isn't allowed on BSV, so the account has no address: partners pay in from their wallets (any amount, one
// approval sheet). Spending is a proposal: the account's own coins in, the payment out, change back to the account,
// the network fee taken from the change. No separate fee input, so there is nothing for the proposer to pre-fund.
//
// The card a partner approves is computed from the transaction itself (checkAccountProposal), never from the
// proposal's own words: one P2PKH payment to the named address for exactly the named amount, every other output
// back to this account, a sane fee. A partner's wallet refuses to sign anything else.
//
// Recovery, no server: seed → partner key; the agreement record (partners' keys + rule) → the script; any
// script-hash lookup (WhatsOnChain) lists the account's unspent outputs. Requests travel as text (any channel).
//
// Pure: no network, no keys held. Tests: accountRules.test.ts.
import { LockingScript, OP, P2PKH, Script, Transaction, UnlockingScript, Utils } from '@bsv/sdk';
import { FEE_RATE_SATS_PER_KB, MIN_FEE_SATS, type Keyset } from './partnerLock';
import { mergeSignatures, proposalTx, type Signable } from './multisig';

/** Refuse any proposal whose network fee is above this (a normal one is a few hundred sats). */
export const MAX_FEE_SATS = 20_000;
/** The account never holds or spends 1-sat outputs (ordinals, tokens live at 1 sat). */
export const MIN_COIN_SATS = 2;
export const REQUEST_PREFIX = 'bwx-shared-account-request:';

const smallInt = (n: number) => OP.OP_1 + n - 1;

/** The account's locking script: bare m-of-n over the sorted partner keys (keysetFor already sorts and checks). */
export function accountScript(keyset: Keyset): LockingScript {
  const s = new Script().writeOpCode(smallInt(keyset.m));
  for (const k of keyset.pubKeys) s.writeBin(Utils.toArray(k, 'hex'));
  s.writeOpCode(smallInt(keyset.pubKeys.length)).writeOpCode(OP.OP_CHECKMULTISIG);
  return new LockingScript(s.chunks);
}

export type AccountCoin = { sourceTx: Transaction; vout: number };

export type AccountProposal = Signable & {
  v: 1;
  type: 'shared-account';
  partnershipId: string;
  proposalId: string;
  /** Plain words: "Pay $ann 120,000 sats". Display only; the card is recomputed from the transaction. */
  summary: string;
  payTo: { label: string; address: string };
  sats: number;
  proposedBy: string;
  createdAt: string;
};

export type AccountCard = {
  label: string;
  address: string;
  sats: number;
  change: number;
  fee: number;
  m: number;
  n: number;
};

const coinSats = (c: AccountCoin) => c.sourceTx.outputs[c.vout]?.satoshis ?? 0;

/** Estimated size of an account payment (bytes): m signatures per input, payment + optional change. */
export function accountTxBytes(m: number, inputs: number, n: number, withChange: boolean): number {
  const scriptLen = 3 + n * 34;
  const ins = inputs * (41 + 3 + 1 + m * 73);
  const outs = 34 + (withChange ? 9 + 3 + scriptLen : 0);
  return 10 + ins + outs;
}

const feeOf = (bytes: number) => Math.max(MIN_FEE_SATS, Math.ceil((bytes * FEE_RATE_SATS_PER_KB) / 1000));

/**
 * Picks coins (largest first) and works out the change. Throws in plain words when the account can't cover it.
 * Change under MIN_COIN_SATS goes to the fee rather than leaving a 1-sat output behind.
 */
export function planAccountPayment(
  keyset: Keyset,
  coins: AccountCoin[],
  sats: number,
): { inputs: AccountCoin[]; change: number; fee: number } {
  if (!Number.isSafeInteger(sats) || sats < 1) throw new Error('Enter an amount above 0');
  const script = accountScript(keyset).toHex();
  const usable = coins
    .filter((c) => c.sourceTx.outputs[c.vout]?.lockingScript.toHex() === script && coinSats(c) >= MIN_COIN_SATS)
    .sort((a, b) => coinSats(b) - coinSats(a));
  const total = usable.reduce((t, c) => t + coinSats(c), 0);
  const inputs: AccountCoin[] = [];
  let have = 0;
  for (const c of usable) {
    inputs.push(c);
    have += coinSats(c);
    const fee = feeOf(accountTxBytes(keyset.m, inputs.length, keyset.pubKeys.length, true));
    if (have >= sats + fee) {
      const change = have - sats - fee;
      return change >= MIN_COIN_SATS ? { inputs, change, fee } : { inputs, change: 0, fee: fee + change };
    }
  }
  const need = sats + feeOf(accountTxBytes(keyset.m, Math.max(1, usable.length), keyset.pubKeys.length, true));
  throw new Error(
    `The shared account holds ${total.toLocaleString('en-US')} sats; this needs ${need.toLocaleString('en-US')}.`,
  );
}

/** Builds the unsigned proposal (extended format so every partner can sign without fetching anything). */
export function buildAccountProposal(a: {
  partnershipId: string;
  proposalId: string;
  keyset: Keyset;
  coins: AccountCoin[];
  payTo: { label: string; address: string };
  sats: number;
  proposedBy: string;
  summary: string;
  now?: Date;
}): AccountProposal {
  const plan = planAccountPayment(a.keyset, a.coins, a.sats);
  const tx = new Transaction();
  for (const c of plan.inputs)
    tx.addInput({ sourceTransaction: c.sourceTx, sourceOutputIndex: c.vout, sequence: 0xffffffff });
  tx.addOutput({ lockingScript: new P2PKH().lock(a.payTo.address), satoshis: a.sats });
  if (plan.change > 0) tx.addOutput({ lockingScript: accountScript(a.keyset), satoshis: plan.change });
  for (const i of tx.inputs) i.unlockingScript = new UnlockingScript(); // empty until signed (EF needs a value)
  return {
    v: 1,
    type: 'shared-account',
    partnershipId: a.partnershipId,
    proposalId: a.proposalId,
    summary: a.summary,
    payTo: a.payTo,
    sats: a.sats,
    proposedBy: a.proposedBy.toLowerCase(),
    createdAt: (a.now ?? new Date()).toISOString(),
    txEF: tx.toHexEF(),
    locked: plan.inputs.map((_, index) => ({ index, m: a.keyset.m, pubKeys: [...a.keyset.pubKeys] })),
    sigs: {},
  };
}

/**
 * What a partner is approving, computed from the transaction. Throws (and the wallet refuses to sign) unless:
 * every input is this account's coin and declared under this keyset; there is exactly one payment output, a P2PKH
 * to `payTo.address` for exactly `sats`; every other output pays back to this account; the fee is sane.
 */
export function checkAccountProposal(p: AccountProposal, keyset: Keyset): AccountCard {
  if (p?.v !== 1 || p.type !== 'shared-account') throw new Error('Not a shared account request');
  if (p.fee) throw new Error('A shared account payment has no separate fee input');
  if (!Number.isSafeInteger(p.sats) || p.sats < 1) throw new Error('The amount is not valid');
  const script = accountScript(keyset).toHex();
  const want = keyset.pubKeys.join();
  const tx = proposalTx(p);
  if (!tx.inputs.length) throw new Error('This request spends nothing');
  if (p.locked.length !== tx.inputs.length) throw new Error('Every input must be a shared account coin');
  let inSats = 0;
  tx.inputs.forEach((input, i) => {
    const src = input.sourceTransaction?.outputs[input.sourceOutputIndex];
    if (!src || src.lockingScript.toHex() !== script)
      throw new Error('This request spends something that is not the shared account');
    const l = p.locked.find((x) => x.index === i);
    if (!l || l.m !== keyset.m || l.pubKeys.join() !== want)
      throw new Error('This request uses a different partner key set');
    inSats += src.satoshis ?? 0;
  });
  const payScript = new P2PKH().lock(p.payTo.address).toHex();
  let payments = 0;
  let change = 0;
  let outSats = 0;
  for (const o of tx.outputs) {
    const hex = o.lockingScript.toHex();
    const v = o.satoshis ?? 0;
    outSats += v;
    if (hex === script) change += v;
    else if (hex === payScript && v === p.sats) payments++;
    else throw new Error('This request pays somewhere the card does not show');
  }
  if (payments !== 1) throw new Error('This request must pay the named address exactly once');
  const fee = inSats - outSats;
  if (fee <= 0) throw new Error('This request has no network fee');
  if (fee > MAX_FEE_SATS) throw new Error(`The network fee (${fee.toLocaleString('en-US')} sats) is too high`);
  return {
    label: p.payTo.label,
    address: p.payTo.address,
    sats: p.sats,
    change,
    fee,
    m: keyset.m,
    n: keyset.pubKeys.length,
  };
}

/** Requests travel as one line of text: copy, paste into any chat, paste back. */
export const exportAccountRequest = (p: AccountProposal) =>
  REQUEST_PREFIX + Utils.toBase64(Utils.toArray(JSON.stringify(p), 'utf8'));

/** Reads a pasted request and checks it against this partnership's keyset (throws in plain words). */
export function importAccountRequest(text: string, keyset: Keyset, partnershipId: string): AccountProposal {
  const t = text.trim();
  if (!t.startsWith(REQUEST_PREFIX)) throw new Error('That is not a shared account request');
  let p: AccountProposal;
  try {
    p = JSON.parse(Utils.toUTF8(Utils.toArray(t.slice(REQUEST_PREFIX.length), 'base64'))) as AccountProposal;
  } catch {
    throw new Error('That request is damaged. Ask for it again.');
  }
  if (p.partnershipId !== partnershipId) throw new Error('That request is for a different partnership');
  if (typeof p.txEF !== 'string' || !Array.isArray(p.locked) || typeof p.sigs !== 'object' || !p.sigs)
    throw new Error('That request is damaged. Ask for it again.');
  checkAccountProposal(p, keyset);
  return { ...p, sigs: {} } as AccountProposal;
}

/**
 * Adds a pasted copy to the requests this wallet already has: a new request is kept with only its verified
 * signatures; a known one gains the verified signatures it was missing.
 */
export function absorbRequest(have: AccountProposal[], incoming: AccountProposal, text: string): AccountProposal[] {
  const raw = JSON.parse(
    Utils.toUTF8(Utils.toArray(text.trim().slice(REQUEST_PREFIX.length), 'base64')),
  ) as AccountProposal;
  const i = have.findIndex((h) => h.proposalId === incoming.proposalId);
  if (i < 0) return [...have, mergeSignatures(incoming, raw)];
  const next = [...have];
  next[i] = mergeSignatures(have[i], raw);
  return next;
}
