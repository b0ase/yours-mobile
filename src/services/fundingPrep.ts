/**
 * Make every satoshi the balance shows spendable before a connected site's createAction funds itself.
 *
 * vexvoid.com, 11 Oct 2026 (5.1.99): a site's inscribe createAction still failed with "Insufficient funds ...
 * 670198 more satoshis are needed, for a total of 670198" (zero inputs) while the wallet showed ~$5, even with the
 * 5.1.95 deposit sweep in place. The wallet-toolbox funder only picks managed change in the 'default' basket
 * (type P2PKH, change, providedBy storage, purpose change, with a BRC-29 derivation; wallet-toolbox
 * allocateChangeInput / isAutoSpendableChangeOutput). The balance the wallet shows is wider
 * (services/depositBalance.ts balanceWithDeposits): that funding balance, plus the deposit basket, plus money
 * the receive guard has seen on chain at our receive addresses that storage has not credited ("arriving",
 * services/receiveGuard.ts). The 5.1.95 sweep only covered the deposit basket, and only outputs whose
 * customInstructions carry a keyID (@1sat/actions sweepDeposit skips the rest, silently, as "swept 0"). Money
 * still "arriving", or sitting in the deposit basket in a shape the sweep skips, is shown but never spendable.
 *
 * So, before funding: sweep deposits, credit anything still arriving (the same receive-guard path the wallet
 * uses after a sync) and sweep again, logging each step with its numbers. If the action still cannot be funded,
 * the error names where the money is instead of the raw toolbox message.
 */
import { DEPOSIT_BASKET, isDepositHeld } from '@1sat/types';

export interface DepositOutput {
  satoshis: number;
  spendable?: boolean;
  tags?: string[];
  customInstructions?: string;
}

export interface FundingWallet {
  /** Managed-change balance: exactly what the funder can spend (wallet-toolbox Wallet.balance). */
  balance(): Promise<number>;
  listOutputs(args: {
    basket: string;
    limit?: number;
    offset?: number;
    includeTags?: boolean;
    includeCustomInstructions?: boolean;
  }): Promise<{ totalOutputs: number; outputs: DepositOutput[] }>;
}

export interface FundingSources {
  wallet: FundingWallet;
  /** Move the deposit basket into managed change (sweepDeposit). */
  sweep: () => Promise<{ swept?: number }>;
  /** Satoshis seen on chain at our receive addresses that storage does not hold yet. */
  arriving: () => number;
  /** Retry crediting those outputs now (the receive guard). Optional: older contexts lack it. */
  creditArriving?: () => Promise<void>;
  /** Restore failed-but-mined actions (services/recoverFailed.ts). Run only when nothing is spendable. */
  recoverFailed?: () => Promise<{ restored: string[] }>;
  log?: (line: string) => void;
}

let lastRecoverAt = 0;
/** Tests only. */
export const resetRecoverThrottle = () => {
  lastRecoverAt = 0;
};

export interface DepositBreakdown {
  /** Deposit outputs the sweep will move. */
  sweepable: number;
  /** Deposit outputs on a short hold (OrdLock purchase funding); the sweep waits for the hold to pass. */
  held: number;
  /** Deposit outputs without the keyID the sweep needs; the balance counts them but the sweep skips them. */
  unsweepable: number;
}

export interface FundingSnapshot extends DepositBreakdown {
  spendable: number;
  arriving: number;
}

const PAGE = 1000;

function hasKeyId(customInstructions?: string): boolean {
  if (!customInstructions) return false;
  try {
    return !!(JSON.parse(customInstructions) as { keyID?: string }).keyID;
  } catch {
    return false;
  }
}

/** Deposit-basket satoshis by what the sweep will do with them. */
export async function depositBreakdown(wallet: FundingWallet, now = Date.now()): Promise<DepositBreakdown> {
  const b: DepositBreakdown = { sweepable: 0, held: 0, unsweepable: 0 };
  for (let offset = 0; ; offset += PAGE) {
    const page = await wallet.listOutputs({
      basket: DEPOSIT_BASKET,
      limit: PAGE,
      offset,
      includeTags: true,
      includeCustomInstructions: true,
    });
    for (const o of page.outputs) {
      if (o.spendable === false) continue;
      const sats = o.satoshis || 0;
      if (!hasKeyId(o.customInstructions)) b.unsweepable += sats;
      else if (isDepositHeld(o.tags, now)) b.held += sats;
      else b.sweepable += sats;
    }
    if (page.outputs.length < PAGE || offset + PAGE >= page.totalOutputs) break;
  }
  return b;
}

export async function fundingSnapshot(src: FundingSources): Promise<FundingSnapshot> {
  const [spendable, deposits] = await Promise.all([
    src.wallet.balance().catch(() => 0),
    depositBreakdown(src.wallet).catch((): DepositBreakdown => ({ sweepable: 0, held: 0, unsweepable: 0 })),
  ]);
  return { spendable, ...deposits, arriving: src.arriving() };
}

const fmt = (s: FundingSnapshot) =>
  `spendable ${s.spendable}, deposits waiting ${s.sweepable} (held ${s.held}, unsweepable ${s.unsweepable}), arriving ${s.arriving} sats`;

/**
 * Sweep deposits and credit arriving money before a createAction funds itself. Never throws: a failed step is
 * logged and the action then funds (or fails) on its own. Returns the snapshot after preparation.
 */
export async function prepareFunding(src: FundingSources): Promise<FundingSnapshot> {
  const log = src.log ?? ((l: string) => console.log(l));
  let snap = await fundingSnapshot(src);
  log(`[funding] before: ${fmt(snap)}`);

  // Nothing spendable: storage may hold a mined transaction as failed, hiding its change ($vexvoid, 11 Oct 2026).
  if (snap.spendable === 0 && src.recoverFailed && Date.now() - lastRecoverAt > 120_000) {
    lastRecoverAt = Date.now();
    try {
      const r = await src.recoverFailed();
      if (r.restored.length) {
        log(`[funding] restored ${r.restored.length} mined transaction(s) storage had marked failed`);
        snap = await fundingSnapshot(src);
        log(`[funding] after restore: ${fmt(snap)}`);
      }
    } catch (err) {
      log(`[funding] restoring failed transactions failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (snap.sweepable > 0) {
    try {
      const r = await src.sweep();
      log(`[funding] swept ${r.swept ?? 0} waiting deposit(s)`);
    } catch (err) {
      log(`[funding] deposit sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (snap.arriving > 0 && src.creditArriving) {
    try {
      await src.creditArriving();
      log('[funding] credited arriving payments (receive guard)');
    } catch (err) {
      log(`[funding] crediting arriving payments failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The receive guard parks what it credits in the deposit basket; move it into spendable funds too.
    try {
      const r = await src.sweep();
      if (r.swept) log(`[funding] swept ${r.swept} newly credited deposit(s)`);
    } catch (err) {
      log(`[funding] sweep after crediting failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (snap.sweepable > 0 || snap.arriving > 0) {
    snap = await fundingSnapshot(src);
    log(`[funding] after: ${fmt(snap)}`);
  }
  return snap;
}

export function isInsufficientFunds(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const code = (err as { code?: string } | null)?.code ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  return name === 'WERR_INSUFFICIENT_FUNDS' || code === 'WERR_INSUFFICIENT_FUNDS' || /Insufficient funds/i.test(msg);
}

const neededFrom = (msg: string) => Number(/for a total of (\d+)/.exec(msg)?.[1] ?? 0);

/**
 * A plain-language reason for an unfunded createAction, naming where the shown balance actually is. Keeps the
 * "Insufficient funds" prefix so sites that match on it still recognise the error.
 */
export function insufficientFundsMessage(err: unknown, snap: FundingSnapshot): string {
  const raw = err instanceof Error ? err.message : String(err);
  const needed = neededFrom(raw);
  const parts = [
    `Insufficient funds: this needs ${needed ? `${needed} sats` : 'more than is spendable'}, and ${snap.spendable} sats are spendable right now.`,
  ];
  if (snap.arriving > 0)
    parts.push(
      `${snap.arriving} sats have arrived at your address but the wallet has not finished adding them; open bWalletX, tap refresh, and try again.`,
    );
  if (snap.sweepable + snap.held > 0)
    parts.push(
      `${snap.sweepable + snap.held} sats of received payments are still being moved into your spendable balance; try again in a minute.`,
    );
  if (snap.unsweepable > 0)
    parts.push(
      `${snap.unsweepable} sats of received payments can't be moved automatically; please email support@bwalletx.com so we can recover them.`,
    );
  if (parts.length === 1) parts.push('Add funds to bWalletX and try again.');
  return parts.join(' ');
}
