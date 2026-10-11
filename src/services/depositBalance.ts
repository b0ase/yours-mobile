/**
 * Money waiting in the deposit basket counts as the user's balance.
 *
 * Owner, 10 Oct 2026: $5 sent to a new account's receive address (13WRxSg…) never showed in the extension,
 * though it sat unspent on chain. The address sync internalizes plain-BSV payments to deposit addresses into
 * the `1sat-deposit` basket, and only a later `sweepDeposit` moves them into the wallet's funding basket.
 * `wallet.balance()` counts the funding basket alone, so while that sweep has not run, or keeps failing,
 * received money is invisible. The balance shown now adds the deposit basket, and the sweep is retried on
 * every unlock (initWallet) so the money also becomes spendable without waiting for the next sync.
 */
import { DEPOSIT_BASKET } from '@1sat/types';
import { arrivingSats } from './receiveGuard';

interface DepositLister {
  listOutputs(args: { basket: string; limit?: number; offset?: number }): Promise<{
    totalOutputs: number;
    outputs: { satoshis: number; spendable?: boolean }[];
  }>;
}

const PAGE = 1000;

/** Satoshis sitting in the deposit basket (received, not yet swept into the funding basket). */
export async function depositBasketSats(wallet: DepositLister): Promise<number> {
  let total = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = await wallet.listOutputs({ basket: DEPOSIT_BASKET, limit: PAGE, offset });
    for (const o of page.outputs) if (o.spendable !== false) total += o.satoshis || 0;
    if (page.outputs.length < PAGE || offset + PAGE >= page.totalOutputs) break;
  }
  return total;
}

interface ActionLister {
  listActions(args: { labels: string[]; includeOutputs?: boolean; limit?: number; offset?: number }): Promise<{
    totalActions: number;
    actions: { status: string; outputs?: { satoshis: number; spendable?: boolean; basket?: string }[] }[];
  }>;
}

const RECENT_ACTIONS = 50;

/**
 * Change from payments still going out.
 *
 * Owner, 11 Oct 2026 ($bMusicX): paying ~$2.50 from $3 showed $0.00 until he left the screen. The toolbox's
 * balance counts spendable 'default' outputs only once their transaction is sending, unproven or completed.
 * A payment the wallet accepted for delayed broadcast stays 'unprocessed' until the Monitor sends it: its
 * inputs already left the balance, its change had not arrived. With $1,000 in the wallet that reads as a
 * drained wallet. This adds back the change of those payments, so the balance only ever drops by what was
 * paid. Unsent work (nosend, unsigned) is not counted: it may never go out.
 */
export async function inFlightChangeSats(wallet: ActionLister): Promise<number> {
  const head = await wallet.listActions({ labels: [], limit: 1 });
  const offset = Math.max(0, head.totalActions - RECENT_ACTIONS);
  const { actions } = await wallet.listActions({ labels: [], includeOutputs: true, limit: RECENT_ACTIONS, offset });
  let total = 0;
  for (const a of actions) {
    if (a.status !== 'unprocessed') continue;
    for (const o of a.outputs ?? []) if (o.basket === 'default' && o.spendable) total += o.satoshis || 0;
  }
  return total;
}

/** Funding balance plus anything still waiting in the deposit basket. A failed deposit read never hides the rest. */
export async function balanceWithDeposits(
  wallet: DepositLister & { balance(): Promise<number> } & Partial<ActionLister>,
): Promise<number> {
  const [funded, waiting, changeOnTheWay] = await Promise.all([
    wallet.balance(),
    depositBasketSats(wallet).catch(() => 0),
    wallet.listActions ? inFlightChangeSats(wallet as ActionLister).catch(() => 0) : 0,
  ]);
  // Plus anything on chain at our receive addresses that storage still lacks (services/receiveGuard.ts).
  return funded + waiting + changeOnTheWay + arrivingSats();
}

/**
 * Before a createAction the wallet funds itself, move waiting deposits into the funding basket.
 *
 * vexvoid.com, 11 Oct 2026: a connected site's inscribe createAction failed with "Insufficient funds ... 670198
 * more satoshis are needed, for a total of 670198" (zero inputs) while the wallet showed ~$5. createAction funds
 * from FUNDING_BASKET ('default') only, and the money sat in the deposit basket, which the balance counts but
 * the funder never reads. So: if anything is waiting there, sweep it first. A failed sweep never blocks the
 * action; the action then fails on its own funding as before. Returns how many deposits were swept.
 */
export async function sweepWaitingDeposits(
  wallet: DepositLister,
  sweep: () => Promise<{ swept?: number }>,
): Promise<number> {
  try {
    if ((await depositBasketSats(wallet)) <= 0) return 0;
    const r = await sweep();
    return r.swept ?? 0;
  } catch (err) {
    console.error('[sweepWaitingDeposits] sweep before createAction failed:', err);
    return 0;
  }
}
