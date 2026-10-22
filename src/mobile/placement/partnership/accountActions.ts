// Shared account wallet actions, all through the BRC-100 wallet (keys never leave it). Each runs only when the
// partner taps a button; tests never broadcast. The pure rules are in accountRules.ts.
import type { OneSatContext } from '@1sat/actions';
import { createChainReader } from '../../../sweep/chainReads';
import { UNBOUND_NAME, opnsBinding, parseRecipient, resolveRecipient } from '../../names/names';
import { broadcastRaw } from '../../pots/potSend';
import { partnerKey } from './actions';
import { addSignatures, finalize, inputsFor, proposalTx, sighash, toChecksig } from './multisig';
import { PARTNER_LOCK_PROTOCOL, partnerKeyId, type Keyset } from './partnerLock';
import {
  MIN_COIN_SATS,
  accountScript,
  buildAccountProposal,
  checkAccountProposal,
  type AccountCoin,
  type AccountProposal,
} from './accountRules';

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
let reader: ReturnType<typeof createChainReader> | null = null;
const chain = () => (reader ??= createChainReader());

/** The account's spendable coins (script-hash lookup), each with its source transaction. */
export async function sharedAccountCoins(keyset: Keyset): Promise<AccountCoin[]> {
  const utxos = await chain().scriptUnspent(accountScript(keyset).toHex());
  const coins = utxos.filter((u) => u.sats >= MIN_COIN_SATS);
  return Promise.all(coins.map(async (u) => ({ sourceTx: await chain().getTx(u.txid), vout: u.vout })));
}

export async function sharedAccountBalance(keyset: Keyset): Promise<number> {
  const utxos = await chain().scriptUnspent(accountScript(keyset).toHex());
  return utxos.filter((u) => u.sats >= MIN_COIN_SATS).reduce((t, u) => t + u.sats, 0);
}

/** Pay into the shared account from this wallet. One approval sheet. */
export async function payIntoSharedAccount(ctx: OneSatContext, keyset: Keyset, sats: number): Promise<string> {
  if (!Number.isSafeInteger(sats) || sats < MIN_COIN_SATS) throw new Error('Enter an amount above 0');
  const r = await ctx.wallet.createAction({
    description: 'Pay into the shared account',
    outputs: [
      {
        lockingScript: accountScript(keyset).toHex(),
        satoshis: sats,
        outputDescription: 'Partnership shared account',
      },
    ],
    labels: ['bwx-partnership'],
    options: { randomizeOutputs: false },
  });
  if (!r.txid) throw new Error('The payment was not sent');
  return r.txid;
}

/** A $handle, paymail or address → the address the payment goes to (P2P-only paymails can't be paid from here). */
export async function resolvePayee(input: string): Promise<{ label: string; address: string }> {
  const parsed = parseRecipient(input);
  if (parsed.kind === 'empty') throw new Error('Say who to pay');
  if (parsed.kind === 'invalid') throw new Error(parsed.reason);
  const r = await resolveRecipient((u, i) => fetch(u, i), parsed);
  if (opnsBinding(r) === 'unbound') throw new Error(UNBOUND_NAME);
  if (r.targetKind !== 'address')
    throw new Error(`${input.trim()} only takes P2P payments, which the shared account can’t send yet`);
  return { label: input.trim(), address: r.target };
}

/** Sign every input this partner can sign, after checking the card. Returns the updated proposal. */
export async function approveSharedPayment(
  ctx: OneSatContext,
  p: AccountProposal,
  keyset: Keyset,
): Promise<AccountProposal> {
  checkAccountProposal(p, keyset); // refuses anything the card doesn't show
  const myKey = await partnerKey(ctx, p.partnershipId);
  const mine = inputsFor(p, myKey);
  if (!mine.length) throw new Error('Your key is not on this shared account');
  const tx = proposalTx(p);
  const sigs: Record<number, string> = {};
  for (const i of mine) {
    const { signature } = await ctx.wallet.createSignature({
      hashToDirectlySign: sighash(tx, i),
      protocolID: PARTNER_LOCK_PROTOCOL,
      keyID: partnerKeyId(p.partnershipId),
      counterparty: 'self',
    });
    sigs[i] = hex(toChecksig(signature));
  }
  return addSignatures(p, myKey, sigs);
}

/** Propose a payment from the shared account; the proposer approves it straight away (their own signatures). */
export async function proposeSharedPayment(
  ctx: OneSatContext,
  a: { partnershipId: string; keyset: Keyset; to: string; sats: number; proposalId: string },
): Promise<AccountProposal> {
  const payTo = await resolvePayee(a.to);
  const [coins, me] = await Promise.all([sharedAccountCoins(a.keyset), partnerKey(ctx, a.partnershipId)]);
  const p = buildAccountProposal({
    partnershipId: a.partnershipId,
    proposalId: a.proposalId,
    keyset: a.keyset,
    coins,
    payTo,
    sats: a.sats,
    proposedBy: me,
    summary: `Pay ${payTo.label} ${a.sats.toLocaleString('en-US')} sats`,
  });
  return approveSharedPayment(ctx, p, a.keyset);
}

/** Once enough partners have approved: check, finalize (refuses otherwise) and broadcast. Safe to repeat. */
export async function sendSharedPayment(p: AccountProposal, keyset: Keyset): Promise<string> {
  checkAccountProposal(p, keyset);
  const { rawTx, txid } = finalize(p);
  await broadcastRaw(rawTx); // idempotent: a repeat gets the tx's current status
  return txid;
}
