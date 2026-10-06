/**
 * BlastPad trade client, ported from tokenblaster.lol src/lib/launch/client.ts (`trade` only; logic
 * unchanged). The server proposes the trade; before the wallet sees it the plan is checked against
 * our own quote (same curve code), and before anything is signed the wallet's transaction is checked
 * against the plan (matchesPlan). Every request goes to the absolute BlastPad base URL.
 */
import { Beef, P2PKH, PublicKey, Transaction, UnlockingScript, Utils, type WalletInterface } from '@bsv/sdk';
import { ONESAT, bsv21, noteFor, tokenCoins, tokenSpends } from './tokens';
import { exactBsv, exactTokens, quoteBuy, quoteSell } from './curve';
import { matchesPlan, type TradePlan } from './shape';
import { BLASTPAD } from './api';

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

/**
 * Buy with `amount` sats (fees included) or sell `amount` tokens. `slippageBps` limits how much
 * worse than `sold` (the board's view) the fill may be. Retries while another trade holds the pool.
 */
export async function trade(
  w: Wallet,
  coin: { id: string; sym: string; icon?: string | null },
  side: 'buy' | 'sell',
  amount: bigint,
  sold: bigint,
  slippageBps: number,
  onStatus?: (s: string) => void,
): Promise<TradeResult> {
  const expect = side === 'buy' ? quoteBuy(sold, amount) : quoteSell(sold, amount);
  const minTokens = side === 'buy' ? (expect.tokens * BigInt(10_000 - slippageBps)) / BigInt(10_000) : BigInt(0);
  const minSats = side === 'sell' ? (expect.userSats * BigInt(10_000 - slippageBps)) / BigInt(10_000) : BigInt(0);

  let buyKey: { keyID: string; address: string } | null = null;
  const sellCoins: { outpoint: string; amt: bigint; protocolID: [0 | 1 | 2, string]; keyID: string }[] = [];
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
    // Check the server's plan against our own quote before the wallet sees it.
    const q = plan.quote;
    if (side === 'buy') {
      if (BigInt(q.tokens) < minTokens) throw new Error('The price moved past your slippage limit.');
      if (!plan.outputs[0].script.endsWith(new P2PKH().lock(buyKey!.address).toHex()))
        throw new Error('The tokens are not going to your wallet. Refusing.');
    } else if (BigInt(q.userSats) < minSats) throw new Error('The price moved past your slippage limit.');

    const beef = Beef.fromString(plan.beef, 'hex');
    if (walletBeef) beef.mergeBeef(walletBeef);
    const outputs: Parameters<WalletInterface['createAction']>[0]['outputs'] = plan.outputs.map((o, i) => ({
      lockingScript: o.script,
      satoshis: o.sats,
      outputDescription: `${o.what}: ${exactBsv(BigInt(o.sats))}`,
      ...(side === 'buy' && i === 0
        ? {
            basket: 'bsv21',
            tags: [`bsv21:${coin.id}`],
            customInstructions: noteFor(coin.id, BigInt(q.tokens), coin.sym, 0, buyKey!.keyID, coin.icon),
          }
        : {}),
    }));
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
    const n = exactTokens(BigInt(q.tokens));
    const bsv = exactBsv(BigInt(q.userSats));
    onStatus?.('Approve in your wallet…');
    const created = await w.client.createAction({
      description:
        side === 'buy'
          ? `Buy ${n} $${coin.sym} on the TokenBlaster curve for ${bsv} incl. curve fees, plus network fee`
          : `Sell ${n} $${coin.sym} to the TokenBlaster curve for ${bsv} after curve fees`,
      inputBEEF: beef.toBinary(),
      inputs: [
        ...plan.inputs.map((i) => ({
          outpoint: i.outpoint.replace('_', '.'),
          unlockingScriptLength: 108,
          inputDescription: i.what,
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
      if (!m.ok) throw new Error(`The wallet changed the trade (${m.why}).`);
      onStatus?.('Pool signing…');
      const { spends: pool } = await post<{ spends: Record<number, string> }>('/api/launch/trade', {
        step: 'sign',
        lease: plan.lease,
        tx: Utils.toHex(signable.tx),
      });
      const spends: Record<number, { unlockingScript: string }> = {};
      for (const [i, s] of Object.entries(pool)) spends[Number(i)] = { unlockingScript: s };
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
    await post('/api/launch/trade', { step: 'cancel', lease: plan.lease }).catch(() => undefined);
    throw e;
  }
}
