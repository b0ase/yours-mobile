/**
 * Lock BSV: the wallet side. Lock outputs are the same script, basket, tags and key as @1sat/actions
 * lockBsv (so the Wallet's Locks row, auto-claim and unlockBsv all see them). The only difference is
 * that one transaction may also carry the optional receipt inscription (receipt.ts), which lockBsv
 * cannot add. Claiming uses unlockBsv unchanged.
 *
 * Plans (labels, modes, dollar targets) live in localStorage per account; the coins never depend on
 * them. Lose the plan and the locks still show in the Wallet and still claim.
 */
import {
  buildOrdinalCustomInstructions,
  executeTrackedAction,
  listLocks,
  LOCK_BASKET,
  ORDINALS_BASKET,
  P1SAT_PROTOCOL,
  unlockBsv,
  WOC_MAINNET_URL,
  type OneSatContext,
} from '@1sat/actions';
import { buildInscriptionScript, Lock } from '@1sat/templates';
import { P2PKH, PublicKey, Random, Utils } from '@bsv/sdk';
import { buildReceipt, receiptMap, receiptSvg, type ReceiptIdentity, type ReceiptMode } from './receipt';
import { MAX_PIECES, type LockMode, type LockPlan, type PlanPiece } from './schedule';

const LOCK_KEY_ID = 'lock';
const planKey = (account: string) => `bwx.lockPlans.${account}`;

export function loadPlans(account: string): LockPlan[] {
  try {
    return JSON.parse(localStorage.getItem(planKey(account)) || '[]') as LockPlan[];
  } catch {
    return [];
  }
}
export function savePlans(account: string, plans: LockPlan[]) {
  try {
    localStorage.setItem(planKey(account), JSON.stringify(plans));
  } catch {
    // storage full / blocked: the locks themselves are on chain and in the wallet
  }
}

/** The address every lock in this wallet pays to (lockBsv's derived key). */
export async function lockAddress(ctx: OneSatContext): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey({ protocolID: P1SAT_PROTOCOL, keyID: LOCK_KEY_ID, counterparty: 'self', forSelf: true });
  return PublicKey.fromString(publicKey).toAddress();
}

export type CreateLockInput = {
  label: string;
  mode: LockMode;
  pieces: { height: number; sats: number; usdTarget?: number; tail?: boolean }[];
  /** Mint the public receipt inscription in the same transaction. Default off. */
  receipt?: { identity: Omit<ReceiptIdentity, 'address'> & { address: string }; rate?: number };
  usdPerPayout?: number;
  bufferPct?: number;
  pct?: number;
  base?: LockPlan['base'];
  pendingAmounts?: number[];
  frequency?: LockPlan['frequency'];
  customDays?: number;
};

/** Lock outputs (and the receipt) in one transaction. Returns the txid. */
async function lockTx(ctx: OneSatContext, address: string, pieces: CreateLockInput['pieces'], receipt?: { hex: string; ci: string; tags: string[] }) {
  if (pieces.length === 0 || pieces.length > MAX_PIECES) throw new Error(`A lock needs 1 to ${MAX_PIECES} payouts.`);
  const outputs = pieces.map((p) => {
    const script = Lock.lock(address, p.height);
    const d = Lock.decode(script);
    if (!d || d.until !== p.height) throw new Error('Could not build the lock script.');
    return {
      lockingScript: script.toHex(),
      satoshis: p.sats,
      outputDescription: `Lock ${p.sats} sats until block ${d.until}`,
      basket: LOCK_BASKET,
      tags: [`until:${d.until}`],
      customInstructions: JSON.stringify({ protocolID: P1SAT_PROTOCOL, keyID: LOCK_KEY_ID }),
    };
  });
  const all: Parameters<typeof executeTrackedAction>[1]['outputs'] = [...outputs];
  // The receipt comes after the locks (the receipt names them as vout 0..n-1).
  if (receipt) all!.push({ lockingScript: receipt.hex, satoshis: 1, outputDescription: 'Lock receipt', basket: ORDINALS_BASKET, tags: receipt.tags, customInstructions: receipt.ci });
  const res = await executeTrackedAction(
    ctx.wallet,
    { description: `Lock BSV in ${pieces.length} output(s)`, outputs: all, options: { acceptDelayedBroadcast: false, randomizeOutputs: false } },
    undefined,
    undefined,
    undefined,
    { spends: [], permissionScheme: 'lock' },
  );
  if (!res.txid) throw new Error('The wallet did not return a transaction id.');
  return res.txid;
}

/** Lock a schedule. Irreversible once broadcast: the caller must have shown the confirmation step. */
export async function createLock(ctx: OneSatContext, account: string, input: CreateLockInput): Promise<LockPlan> {
  const address = await lockAddress(ctx);
  let receiptOut: { hex: string; ci: string; tags: string[] } | undefined;
  if (input.receipt) {
    const r = buildReceipt({
      mode: (input.mode === 'percent' ? 'bsv' : input.mode) as ReceiptMode,
      pieces: input.pieces,
      lockAddress: address,
      identity: input.receipt.identity,
      rate: input.receipt.rate,
      usdPerPayout: input.usdPerPayout,
      bufferPct: input.bufferPct,
    });
    // The receipt goes to a fresh key of the wallet's own ordinals (as @1sat/actions inscribe does).
    const keyID = `inscribe-${Utils.toHex(Random(8))}`;
    const { publicKey } = await ctx.wallet.getPublicKey({ protocolID: P1SAT_PROTOCOL, keyID, counterparty: 'self', forSelf: true });
    const dest = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress());
    const content = new TextEncoder().encode(receiptSvg(r));
    const tags = ['type:image/svg+xml', 'origin', 'lock-receipt'];
    receiptOut = {
      hex: buildInscriptionScript(dest, content, 'image/svg+xml', receiptMap(r)).toHex(),
      ci: buildOrdinalCustomInstructions({ protocolID: P1SAT_PROTOCOL, keyID, tags, name: 'bWalletX lock receipt' }),
      tags,
    };
  }
  const txid = await lockTx(ctx, address, input.pieces, receiptOut);
  const plan: LockPlan = {
    id: txid,
    label: input.label || 'Lock',
    mode: input.mode,
    txids: [txid],
    createdAt: new Date().toISOString(),
    pieces: input.pieces.map((p, vout) => ({ ...p, vout, txid })),
    usdPerPayout: input.usdPerPayout,
    bufferPct: input.bufferPct,
    pct: input.pct,
    base: input.base,
    receipt: !!input.receipt,
    pendingAmounts: input.pendingAmounts,
    frequency: input.frequency,
    customDays: input.customDays,
  };
  savePlans(account, [plan, ...loadPlans(account)]);
  return plan;
}

/** Add more lock pieces to an existing plan (a dollar-target surplus, or the next percent batch). */
export async function relock(ctx: OneSatContext, account: string, planId: string, pieces: PlanPiece[], pendingAmounts?: number[]) {
  const address = await lockAddress(ctx);
  const txid = await lockTx(ctx, address, pieces);
  const plans = loadPlans(account).map((p) =>
    p.id === planId
      ? { ...p, txids: [...p.txids, txid], pieces: [...p.pieces, ...pieces.map((x, vout) => ({ ...x, vout, txid }))], pendingAmounts }
      : p,
  );
  savePlans(account, plans);
  return txid;
}

/** Outpoints still unspent in the wallet's lock basket. */
export async function walletLockOutpoints(ctx: OneSatContext): Promise<{ outpoint: string; satoshis: number; until: number }[]> {
  const res = await listLocks.execute(ctx, { limit: 10000 });
  if (!('outputs' in res) || !res.outputs) return [];
  return res.outputs.map((o) => ({
    outpoint: o.outpoint.replace('_', '.'),
    satoshis: o.satoshis,
    until: Number.parseInt(o.tags?.find((t) => t.startsWith('until:'))?.slice(6) ?? '0', 10),
  }));
}

/** Mark plan pieces whose output is no longer in the lock basket as claimed. */
export function syncClaimed(plans: LockPlan[], unspent: Set<string>, height: number): LockPlan[] {
  return plans.map((p) => ({
    ...p,
    pieces: p.pieces.map((x) => (x.claimed || unspent.has(`${x.txid}.${x.vout}`) || x.height > height ? x : { ...x, claimed: true })),
  }));
}

/** Claim every matured lock on the account, across all plans, in one transaction (unlockBsv). */
export async function claimMatured(ctx: OneSatContext): Promise<string> {
  const res = await unlockBsv.execute(ctx, {});
  if ('error' in res && res.error) throw new Error(res.error === 'no-matured-locks' ? 'Nothing is ready to claim yet.' : res.error);
  if (!('txid' in res) || !res.txid) throw new Error('The wallet did not return a transaction id.');
  return res.txid;
}

/** Today's BSV/USD for a payout. Fresh only: no cached or guessed price is ever used to pay out. */
export async function freshRate(f: typeof fetch = fetch): Promise<number | null> {
  try {
    const r = await f(`${WOC_MAINNET_URL}/exchangerate`);
    if (!r.ok) return null;
    const rate = Number((await r.json()).rate);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}
