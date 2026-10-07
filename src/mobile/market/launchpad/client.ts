/**
 * BlastPad trade client, ported from tokenblaster.lol src/lib/launch/client.ts (`trade`). The server
 * proposes the trade (prepareTrade); validatePlan rebuilds every output from our own curve maths and
 * the pool's on-chain coins and refuses anything else; the user confirms the checked outputs; then
 * executeTrade builds, re-checks (matchesPlan + the sell payout) and signs. Every request goes to the
 * absolute BlastPad base URL.
 */
import { Beef, PublicKey, Transaction, UnlockingScript, Utils, type WalletInterface } from '@bsv/sdk';
import { ONESAT, bsv21, noteFor, tokenCoins, tokenSpends } from './tokens';
import { exactBsv, exactTokens } from './curve';
import { matchesPlan, type TradePlan } from './shape';
import { BLASTPAD } from './api';
import { logInWalletApp } from '../../wallet/connectionLog';
import { PlanError, checkSellPayout, minimums, payoutOutput, validatePlan, type CheckedPlan } from './validate';

/** The trader: the active account's in-app BRC-100 wallet, its BSV address and identity key. */
export type Wallet = { client: WalletInterface; address: string; publicKey: string };

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(`${BLASTPAD}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ error: `Server answered ${r.status}.` }));
  if (!r.ok || j.error) throw Object.assign(new Error(j.error ?? `Server answered ${r.status}.`), { status: r.status });
  return j as T;
}

async function freshTokenKey(wallet: WalletInterface, id: string) {
  const keyID = `${id}-${Date.now()}`; // the 1Sat wallets' own key pattern for token coins
  const { publicKey } = await wallet.getPublicKey({ protocolID: ONESAT, keyID, counterparty: 'self' });
  return { keyID, address: PublicKey.fromString(publicKey).toAddress() };
}

export type TradeResult = { txid: string; graduated: boolean };

type Coin = { id: string; sym: string; icon?: string | null; routeAddress?: string | null };

/** A server plan that passed validatePlan, waiting for the user's Confirm. */
export type PreparedTrade = {
  w: Wallet;
  coin: Coin;
  side: 'buy' | 'sell';
  amount: bigint;
  plan: TradePlan;
  checked: CheckedPlan;
  minSats: bigint;
  buyKey: { keyID: string; address: string } | null;
  sellCoins: { outpoint: string; amt: bigint; protocolID: [0 | 1 | 2, string]; keyID: string }[];
  walletBeef?: number[];
};

const cancel = (lease: string) => post('/api/launch/trade', { step: 'cancel', lease }).catch(() => undefined);

/**
 * Ask the server for a plan to buy with `amount` sats (fees included) or sell `amount` tokens, and
 * check it (validatePlan). `slippageBps` limits how much worse than the board's `sold` (the quote the
 * user saw) the fill may be. Retries while another trade holds the pool. Throws (and releases the
 * pool) if the plan is not exactly the curve trade.
 */
export async function prepareTrade(
  w: Wallet,
  coin: Coin,
  side: 'buy' | 'sell',
  amount: bigint,
  sold: bigint,
  slippageBps: number,
  onStatus?: (s: string) => void,
): Promise<PreparedTrade> {
  const { minTokens, minSats } = minimums(side, sold, amount, slippageBps);

  let buyKey: { keyID: string; address: string } | null = null;
  const sellCoins: PreparedTrade['sellCoins'] = [];
  let walletBeef: number[] | undefined;
  if (side === 'buy') buyKey = await freshTokenKey(w.client, coin.id);
  else {
    const { coins, beef } = await tokenCoins(w.client, true);
    const mine = coins.filter((c) => c.id === coin.id && c.keyID && c.noted).sort((a, b) => (b.amt > a.amt ? 1 : -1));
    let sum = BigInt(0);
    for (const c of mine) {
      if (sum >= amount) break;
      sellCoins.push({
        outpoint: c.outpoint.replace('.', '_'),
        amt: c.amt,
        protocolID: c.protocolID ?? ONESAT,
        keyID: c.keyID!,
      });
      sum += c.amt;
    }
    if (sum < amount) throw new Error(`Your wallet holds ${sum.toLocaleString()} $${coin.sym}.`);
    walletBeef = beef;
  }

  onStatus?.('Quoting…');
  let plan: TradePlan | null = null;
  for (let tries = 0; !plan; tries++) {
    try {
      ({ plan } = await post<{ plan: TradePlan }>('/api/launch/trade', {
        step: 'prepare',
        token: coin.id,
        side,
        amount: amount.toString(),
        trader: w.address,
        to: buyKey?.address,
        coins: sellCoins.map((c) => c.outpoint),
        minTokens: minTokens.toString(),
        minSats: minSats.toString(),
      }));
    } catch (e) {
      if ((e as { status?: number }).status === 409 && tries < 20) {
        onStatus?.('Another trade is settling on this coin. Waiting…');
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
  try {
    const checked = validatePlan(plan, {
      side,
      coinId: coin.id,
      amount,
      boardSold: sold,
      slippageBps,
      buyAddress: buyKey?.address,
      routeAddress: coin.routeAddress ?? null,
      mine: [w.address],
    });
    return { w, coin, side, amount, plan, checked, minSats, buyKey, sellCoins, walletBeef };
  } catch (e) {
    await cancel(plan.lease);
    throw e;
  }
}

/** The user said no (or the quote went stale): release the pool. */
export const cancelTrade = (p: PreparedTrade) => cancel(p.plan.lease);

/** Sign and send a checked plan. */
export async function executeTrade(p: PreparedTrade, onStatus?: (s: string) => void): Promise<TradeResult> {
  const { w, coin, side, amount, plan, checked, buyKey, sellCoins, walletBeef } = p;
  try {
    if (plan.expires && plan.expires - 5_000 < Date.now()) throw new Error('This quote expired. Quote again.');
    const q = checked.quote;
    const beef = Beef.fromString(plan.beef, 'hex');
    if (walletBeef) beef.mergeBeef(walletBeef);
    const outputs: Parameters<WalletInterface['createAction']>[0]['outputs'] = plan.outputs.map((o, i) => ({
      lockingScript: o.script,
      satoshis: o.sats,
      outputDescription: `${o.what}: ${exactBsv(BigInt(o.sats))}`.slice(0, 120),
      ...(side === 'buy' && i === 0
        ? {
            basket: 'bsv21',
            tags: [`bsv21:${coin.id}`],
            customInstructions: noteFor(coin.id, q.tokens, coin.sym, 0, buyKey!.keyID, coin.icon),
          }
        : {}),
    }));
    if (side === 'sell') {
      // The payout, explicitly to this account's own address (not left to the wallet's change).
      const pay = payoutOutput(w.address, q.userSats);
      outputs.push({
        lockingScript: pay.script,
        satoshis: Number(pay.sats),
        outputDescription: `Your BSV from the sale: ${exactBsv(pay.sats)}`,
      });
    }
    const sellTotal = sellCoins.reduce((n, c) => n + c.amt, BigInt(0));
    if (side === 'sell' && sellTotal > amount) {
      const ch = await freshTokenKey(w.client, coin.id);
      const left = sellTotal - amount;
      outputs.push({
        lockingScript: bsv21(coin.id, left, ch.address).toHex(),
        satoshis: 1,
        outputDescription: `The rest of your $${coin.sym}: ${exactTokens(left)}`,
        basket: 'bsv21',
        tags: [`bsv21:${coin.id}`],
        customInstructions: noteFor(coin.id, left, coin.sym, 0, ch.keyID, coin.icon),
      });
    }
    // Exact amounts (no rounding): what the wallet records and shows for this action.
    const n = exactTokens(q.tokens);
    const bsv = exactBsv(q.userSats);
    onStatus?.('Approve in your wallet…');
    const created = await w.client.createAction({
      description:
        side === 'buy'
          ? `Buy ${n} $${coin.sym} on the TokenBlaster curve for ${bsv} incl. curve fees, plus network fee`
          : `Sell ${n} $${coin.sym} to the TokenBlaster curve for ${bsv} after curve fees`,
      inputBEEF: beef.toBinary(),
      inputs: [
        ...plan.inputs.map((i, k) => ({
          outpoint: i.outpoint.replace('_', '.'),
          unlockingScriptLength: 108,
          inputDescription: k === 0 ? 'BlastPad pool tokens' : 'BlastPad pool BSV',
        })),
        ...sellCoins.map((c) => ({
          outpoint: c.outpoint.replace('_', '.'),
          unlockingScriptLength: 108,
          inputDescription: `your ${exactTokens(c.amt)} $${coin.sym}`,
        })),
      ],
      outputs,
      labels: ['tokenblaster', 'launch'],
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false },
    });
    const signable = created.signableTransaction;
    if (!signable) throw new Error('The wallet did not return a transaction to sign.');
    let sent = false;
    try {
      const tx = Transaction.fromAtomicBEEF(signable.tx);
      const m = matchesPlan(tx, plan);
      if (!m.ok) throw new PlanError(`Refusing to sign: the wallet changed the trade (${m.why}).`);
      if (side === 'sell' && !checkSellPayout(tx.outputs, plan.outputs.length, w.address, p.minSats))
        throw new PlanError('Refusing to sign: the sale does not pay you.');
      onStatus?.('Pool signing…');
      const { spends: pool } = await post<{ spends: Record<number, string> }>('/api/launch/trade', {
        step: 'sign',
        lease: plan.lease,
        tx: Utils.toHex(signable.tx),
      });
      const spends: Record<number, { unlockingScript: string }> = {};
      for (const [i, s] of Object.entries(pool)) {
        const k = Number(i);
        if (!(k >= 0 && k < plan.inputs.length)) throw new PlanError('Refusing to sign: the pool signed inputs it does not own.');
        spends[k] = { unlockingScript: s };
      }
      const base = plan.inputs.length;
      Object.assign(
        spends,
        await tokenSpends(
          w.client,
          tx,
          sellCoins.map((c, k) => ({ index: base + k, protocolID: c.protocolID, keyID: c.keyID })),
        ),
      );
      onStatus?.('Sending…');
      const done = await w.client.signAction({ reference: signable.reference, spends });
      sent = true;
      // History › Connections: in-wallet apps don't pass through background.ts, so log here.
      logInWalletApp('tokenblaster', 'createAction', {
        txid: done.txid ?? tx.id('hex'),
        sats: side === 'buy' ? Number(q.userSats) : 0,
        description: `${side} $${coin.sym}`,
      });
      let finalTx: number[];
      if (done.tx) finalTx = Array.from(done.tx);
      else {
        tx.inputs.forEach(
          (inp, i) => spends[i] && (inp.unlockingScript = UnlockingScript.fromHex(spends[i].unlockingScript)),
        );
        finalTx = tx.toAtomicBEEF();
      }
      return await post<TradeResult>('/api/launch/trade', {
        step: 'commit',
        lease: plan.lease,
        tx: Utils.toHex(finalTx),
      });
    } catch (e) {
      if (!sent) await w.client.abortAction({ reference: signable.reference }).catch(() => undefined);
      // Once the wallet has sent it, the pool books it when the quote expires (reconcile).
      throw e;
    }
  } catch (e) {
    await cancel(plan.lease);
    throw e;
  }
}

/** Prepare, check and execute in one go (no confirmation step). */
export async function trade(
  w: Wallet,
  coin: Coin,
  side: 'buy' | 'sell',
  amount: bigint,
  sold: bigint,
  slippageBps: number,
  onStatus?: (s: string) => void,
): Promise<TradeResult> {
  return executeTrade(await prepareTrade(w, coin, side, amount, sold, slippageBps, onStatus), onStatus);
}
