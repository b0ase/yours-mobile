/**
 * Creator vesting, the wallet side. Runs only after Allow on the launch approval sheet (lock) or a Claim tap
 * (claim). Every transaction is built by the creator's own BRC-100 wallet and signed with keys derived from their
 * seed; before anything is signed, the wallet's transaction is checked against what we asked for (fail closed).
 * No bWalletX server is involved: the receipt is read from chain (the deploy output's spender, via WhatsOnChain).
 */
import type { OneSatContext } from '@1sat/actions';
import { Lock } from '@1sat/templates';
import { PublicKey, Script, Transaction, type WalletInterface, type WalletProtocol } from '@bsv/sdk';
import { ONESAT, bsv21, noteFor, tokenCoins, tokenOutputTags, tokenSpends } from '../../market/launchpad/tokens';
import {
  VEST_BASKET,
  VEST_KEY_ID,
  VEST_PROTOCOL,
  buildVestReceipt,
  verifyVestingTx,
  vestReceiptScript,
  vestSchedule,
  vestTrancheScript,
  type VerifiedVesting,
  type VestPlan,
} from './vesting';
import { withTokenKeyCheck } from '../../../services/tokenSpendGuard';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';
const norm = (op: string) => op.replace('.', '_');

/** The address every vesting lock in this wallet pays to (seed-derived: [0,'onesat'] / 'vest' / self). */
export async function vestAddress(wallet: WalletInterface): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({
    protocolID: VEST_PROTOCOL,
    keyID: VEST_KEY_ID,
    counterparty: 'self',
  });
  return PublicKey.fromString(publicKey).toAddress();
}

async function freshTokenKey(wallet: WalletInterface, id: string) {
  const keyID = `${id}-${Date.now()}`; // the 1Sat wallets' own key pattern for token coins
  const { publicKey } = await wallet.getPublicKey({ protocolID: ONESAT, keyID, counterparty: 'self' });
  return { keyID, address: PublicKey.fromString(publicKey).toAddress() };
}

const currentHeight = async (ctx: OneSatContext): Promise<number> => {
  const h = await ctx.services?.chaintracks.currentHeight().catch(() => 0);
  if (!h || !Number.isInteger(h) || h <= 0) throw new Error('Could not read the current block height. Try again.');
  return h;
};

export type VestStart = { tokenId: string; sym: string; supply: bigint; decimals?: number; icon?: string | null };

const planKey = (tokenId: string) => `bwx.vestPlan.${norm(tokenId)}`;
/** The plan chosen at launch, kept on this device so a failed lock can be retried later with the same terms. */
export const saveVestPlan = (tokenId: string, p: VestPlan) => {
  try {
    localStorage.setItem(planKey(tokenId), JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
};
export const savedVestPlan = (tokenId: string): VestPlan | null => {
  try {
    const p = JSON.parse(localStorage.getItem(planKey(tokenId)) || 'null') as VestPlan | null;
    return p && typeof p.keepBps === 'number' ? p : null;
  } catch {
    return null;
  }
};

/** This wallet's unspent deploy output for the token (the whole supply), or null. */
export async function heldDeploy(ctx: OneSatContext, tokenId: string) {
  const id = norm(tokenId);
  const { coins } = await tokenCoins(ctx.wallet, true);
  return coins.find((c) => norm(c.outpoint) === id && c.id === id && !!c.keyID) ?? null;
}

/** Token page › "Lock my share now": the launch's vesting transaction, for a coin whose deploy output is still unspent. */
export async function lockVestingLater(ctx: OneSatContext, tokenId: string, plan: VestPlan): Promise<VerifiedVesting> {
  const d = await heldDeploy(ctx, tokenId);
  if (!d) throw new Error("Your wallet does not hold this coin's untouched supply, so it cannot be locked here.");
  return lockVesting(ctx, { tokenId, sym: d.sym ?? '', supply: d.amt, decimals: d.dec, icon: d.icon }, plan);
}

/**
 * Moves the creator's kept share from the deploy output into the tranche locks, with the receipt, in one
 * transaction that spends the deploy output. The rest of the supply goes back to the creator as a normal coin.
 * Returns the txid. Throws (nothing signed) if the wallet's transaction is not exactly the plan.
 */
export async function lockVesting(ctx: OneSatContext, t: VestStart, plan: VestPlan): Promise<VerifiedVesting> {
  // F-3: the deploy output's record is checked (key, tracking tag) before it is spent.
  return withTokenKeyCheck(ctx, norm(t.tokenId), () => lockVestingOnce(ctx, t, plan));
}

async function lockVestingOnce(ctx: OneSatContext, t: VestStart, plan: VestPlan): Promise<VerifiedVesting> {
  const w = ctx.wallet;
  const tokenId = norm(t.tokenId);
  const startHeight = await currentHeight(ctx);
  const tranches = vestSchedule(t.supply, plan, startHeight);
  if (tranches.length === 0) throw new Error('Nothing to lock.');
  const lockAddress = await vestAddress(w);

  // The deploy output (the whole supply), found the way the 1Sat wallets list token coins. A fresh deploy can take
  // a moment to show in the basket.
  let found: Awaited<ReturnType<typeof tokenCoins>> | null = null;
  let deploy: Awaited<ReturnType<typeof tokenCoins>>['coins'][number] | undefined;
  for (let tries = 0; tries < 5 && !deploy; tries++) {
    if (tries) await new Promise((r) => setTimeout(r, 1500));
    found = await tokenCoins(w, true);
    deploy = found.coins.find((c) => norm(c.outpoint) === tokenId && c.id === tokenId);
  }
  if (!found || !deploy || !deploy.keyID) throw new Error('Could not find the new coin in your wallet yet. Try again.');
  if (deploy.amt !== t.supply) throw new Error('The coin in your wallet is not the whole supply; nothing was locked.');

  const kept = tranches.reduce((n, x) => n + x.amt, 0n);
  const rest = t.supply - kept;
  const receipt = buildVestReceipt({ tokenId, sym: t.sym, supply: t.supply, plan, startHeight, lockAddress, tranches });
  const scripts = tranches.map((x) => vestTrancheScript(tokenId, x.amt, lockAddress, x.height).toHex());
  const restKey = rest > 0n ? await freshTokenKey(w, tokenId) : null;
  const restScript = restKey ? bsv21(tokenId, rest, restKey.address).toHex() : null;
  const receiptHex = vestReceiptScript(receipt).toHex();

  const outputs: Parameters<WalletInterface['createAction']>[0]['outputs'] = [
    ...tranches.map((x, i) => ({
      lockingScript: scripts[i],
      satoshis: 1,
      outputDescription: `Vesting: ${x.amt} $${t.sym} until block ${x.height}`.slice(0, 120),
      basket: VEST_BASKET,
      tags: [`vest:${tokenId}`, `until:${x.height}`],
      customInstructions: JSON.stringify({
        protocolID: VEST_PROTOCOL,
        keyID: VEST_KEY_ID,
        tokenId,
        sym: t.sym,
        amt: x.amt.toString(),
        until: x.height,
        ...(t.icon ? { icon: t.icon } : {}),
      }),
    })),
    ...(restKey && restScript
      ? [
          {
            lockingScript: restScript,
            satoshis: 1,
            outputDescription: `Your unlocked $${t.sym}`,
            basket: 'bsv21',
            tags: tokenOutputTags(tokenId),
            customInstructions: noteFor(tokenId, rest, t.sym, t.decimals, restKey.keyID, t.icon),
          },
        ]
      : []),
    { lockingScript: receiptHex, satoshis: 0, outputDescription: 'Creator vesting receipt' },
  ];

  const created = await w.createAction({
    description: `Lock ${kept} $${t.sym} for creator vesting (${tranches.length} tranches)`.slice(0, 120),
    inputBEEF: found.beef,
    inputs: [
      { outpoint: deploy.outpoint.replace('_', '.'), unlockingScriptLength: 108, inputDescription: `$${t.sym} supply` },
    ],
    outputs,
    labels: ['launch', 'vesting'],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false },
  });
  const signable = created.signableTransaction;
  if (!signable) throw new Error('The wallet did not return a transaction to sign.');
  let sent = false;
  try {
    const tx = Transaction.fromAtomicBEEF(signable.tx);
    // Fail closed: exactly our outputs first, in order, and the deploy output among the inputs.
    const want = [...scripts, ...(restScript ? [restScript] : []), receiptHex];
    want.forEach((h, i) => {
      if (tx.outputs[i]?.lockingScript.toHex() !== h)
        throw new Error('Refusing to sign: the wallet changed the vesting outputs.');
    });
    const idx = tx.inputs.findIndex(
      (i) => `${i.sourceTXID ?? i.sourceTransaction?.id('hex')}_${i.sourceOutputIndex}` === norm(deploy!.outpoint),
    );
    if (idx < 0) throw new Error('Refusing to sign: the deploy output is missing.');
    // The same check anyone runs on the public receipt, before we sign.
    const checked = verifyVestingTx(tx, tokenId);
    if (typeof checked === 'string') throw new Error(`Refusing to sign: ${checked}`);
    const spends = await tokenSpends(w, tx, [
      { index: idx, protocolID: (deploy.protocolID ?? ONESAT) as WalletProtocol, keyID: deploy.keyID },
    ]);
    const done = await w.signAction({ reference: signable.reference, spends });
    sent = true;
    return { ...checked, txid: done.txid ?? checked.txid };
  } catch (e) {
    if (!sent) await w.abortAction({ reference: signable.reference }).catch(() => undefined);
    throw e;
  }
}

export type VestRow = {
  outpoint: string;
  tokenId: string;
  sym: string;
  amt: bigint;
  until: number;
  icon?: string;
};

/** This wallet's vesting tranches (all tokens, or one), read from the wallet's own basket. */
export async function listVesting(ctx: OneSatContext, tokenId?: string): Promise<VestRow[]> {
  const r = await ctx.wallet.listOutputs({
    basket: VEST_BASKET,
    includeTags: true,
    includeCustomInstructions: true,
    include: 'locking scripts',
    limit: 1000,
    ...(tokenId ? { tags: [`vest:${norm(tokenId)}`], tagQueryMode: 'any' as const } : {}),
  });
  const rows: VestRow[] = [];
  for (const o of r.outputs) {
    if (o.spendable === false) continue;
    let ci: Record<string, unknown> = {};
    try {
      ci = o.customInstructions ? JSON.parse(o.customInstructions) : {};
    } catch {
      continue;
    }
    const id = typeof ci.tokenId === 'string' ? ci.tokenId : '';
    const amt = typeof ci.amt === 'string' && /^\d+$/.test(ci.amt) ? BigInt(ci.amt) : 0n;
    const until = Number(ci.until);
    // The script is the source of truth: it must be exactly the lock its note claims.
    if (!id || amt <= 0n || !Number.isInteger(until) || !o.lockingScript) continue;
    const d = Lock.decode(Script.fromHex(o.lockingScript));
    if (!d || d.until !== until) continue;
    if (vestTrancheScript(id, amt, d.address, until).toHex() !== o.lockingScript) continue;
    rows.push({
      outpoint: o.outpoint,
      tokenId: id,
      sym: typeof ci.sym === 'string' ? ci.sym : '',
      amt,
      until,
      ...(typeof ci.icon === 'string' ? { icon: ci.icon } : {}),
    });
  }
  return rows.sort((a, b) => a.until - b.until);
}

/**
 * Claims every matured tranche of one token: one transaction, the tranches' tokens back to a normal coin in this
 * wallet. nLockTime = the latest tranche height (≤ the chain tip), nSequence 0, each tranche unlocked by the 1Sat
 * Lock template with the seed-derived vest key. Returns the txid.
 */
export async function claimVesting(ctx: OneSatContext, tokenId: string): Promise<{ txid: string; amt: bigint }> {
  const w = ctx.wallet;
  const id = norm(tokenId);
  const height = await currentHeight(ctx);
  const due = (await listVesting(ctx, id)).filter((r) => r.until <= height);
  if (due.length === 0) throw new Error('Nothing has unlocked yet.');
  const full = await w.listOutputs({
    basket: VEST_BASKET,
    include: 'entire transactions',
    tags: [`vest:${id}`],
    tagQueryMode: 'any',
    limit: 1000,
  });
  if (!full.BEEF) throw new Error('The wallet could not provide the locked coins.');
  const sum = due.reduce((n, r) => n + r.amt, 0n);
  const sym = due[0].sym;
  const key = await freshTokenKey(w, id);
  const out = bsv21(id, sum, key.address).toHex();
  const lockTime = Math.max(...due.map((r) => r.until));
  const created = await w.createAction({
    description: `Claim ${sum} unlocked $${sym} (creator vesting)`.slice(0, 120),
    inputBEEF: full.BEEF,
    inputs: due.map((r) => ({
      outpoint: r.outpoint.replace('_', '.'),
      unlockingScriptLength: 1205,
      sequenceNumber: 0,
      inputDescription: `Vesting tranche, block ${r.until}`,
    })),
    outputs: [
      {
        lockingScript: out,
        satoshis: 1,
        outputDescription: `Unlocked $${sym}`,
        basket: 'bsv21',
        tags: tokenOutputTags(id),
        customInstructions: noteFor(id, sum, sym, undefined, key.keyID, due[0].icon),
      },
    ],
    lockTime,
    labels: ['vesting', 'claim'],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false },
  });
  const signable = created.signableTransaction;
  if (!signable) throw new Error('The wallet did not return a transaction to sign.');
  let sent = false;
  try {
    const tx = Transaction.fromAtomicBEEF(signable.tx);
    if (tx.outputs[0]?.lockingScript.toHex() !== out)
      throw new Error('Refusing to sign: the wallet changed the claim.');
    if (tx.lockTime !== lockTime || lockTime > height) throw new Error('Refusing to sign: wrong lock time.');
    const unlock = Lock.unlockWithWallet(w, VEST_PROTOCOL, VEST_KEY_ID, 'self');
    const spends: Record<number, { unlockingScript: string; sequenceNumber: number }> = {};
    for (const r of due) {
      const i = tx.inputs.findIndex(
        (x) => `${x.sourceTXID ?? x.sourceTransaction?.id('hex')}_${x.sourceOutputIndex}` === norm(r.outpoint),
      );
      if (i < 0 || (tx.inputs[i].sequence ?? 0xffffffff) === 0xffffffff)
        throw new Error('Refusing to sign: a tranche input is missing or final.');
      spends[i] = { unlockingScript: (await unlock.sign(tx, i)).toHex(), sequenceNumber: 0 };
    }
    const done = await w.signAction({ reference: signable.reference, spends });
    sent = true;
    return { txid: done.txid ?? tx.id('hex'), amt: sum };
  } catch (e) {
    if (!sent) await w.abortAction({ reference: signable.reference }).catch(() => undefined);
    throw e;
  }
}

/**
 * The public receipt, for anyone: the transaction that spent the token's deploy output, checked by
 * verifyVestingTx. null = no creator vesting (the deploy output is unspent, or its spender is not a vesting tx).
 */
export async function fetchVesting(tokenId: string, f: typeof fetch = fetch): Promise<VerifiedVesting | null> {
  const [txid, vout] = norm(tokenId).split('_');
  if (!/^[0-9a-f]{64}$/i.test(txid ?? '') || !/^\d+$/.test(vout ?? '')) return null;
  const spent = await f(`${WOC}/tx/${txid}/${vout}/spent`).catch(() => null);
  if (!spent || !spent.ok) return null;
  const j = (await spent.json().catch(() => null)) as { txid?: string } | null;
  if (!j?.txid || !/^[0-9a-f]{64}$/i.test(j.txid)) return null;
  const hex = await f(`${WOC}/tx/${j.txid}/hex`)
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
  if (!/^[0-9a-f]+$/i.test(hex.trim())) return null;
  let tx: Transaction;
  try {
    tx = Transaction.fromHex(hex.trim());
  } catch {
    return null;
  }
  if (tx.id('hex') !== j.txid) return null;
  const v = verifyVestingTx(tx, tokenId);
  return typeof v === 'string' ? null : v;
}

export const vestTxUrl = (txid: string) => `https://whatsonchain.com/tx/${txid}`;
