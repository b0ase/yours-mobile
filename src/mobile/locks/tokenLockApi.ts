/**
 * Token locks (BSV-21), the wallet half. See tokenLocks.ts for the script.
 *
 * Lock: @1sat/actions sendBsv21 with the time-lock script as the recipient's lockingScript, so token
 * selection, overlay checks, change, the overlay fee and the overlay submission are the same code as a
 * normal token send. The optional receipt inscription rides in the same transaction (withExtraOutput).
 * The lock output is deliberately NOT put in a wallet basket: nothing in the wallet (BSV lock
 * auto-claim, token sends) can spend it by accident. The record list is the wallet's own memory of it;
 * the chain and the seed are enough to get it back.
 *
 * Unlock: spend the lock output (nLockTime = its height, sequence 0) with the seed-derived lock key,
 * back into an ordinary BSV-21 output in the wallet's token basket, then submit to the overlay.
 */
import {
  BSV21_BASKET,
  P1SAT_PROTOCOL,
  bsv21FilterTags,
  buildBsv21CustomInstructions,
  executeTrackedAction,
  sendBsv21,
  ORDINALS_BASKET,
  type OneSatContext,
} from '@1sat/actions';
import { BSV21 } from '@1sat/templates';
import { P2PKH, PublicKey, Transaction } from '@bsv/sdk';
import { withExtraOutput } from '../airdrops/note';
import { receiptOutput } from './lockApi';
import { buildReceipt, type ReceiptIdentity, type TokenRef } from './receipt';
import {
  TOKEN_LOCK_KEY_ID,
  canUnlock,
  decodeTokenLock,
  loadTokenLocks,
  saveTokenLocks,
  tokenLockScript,
  tokenUnlockLength,
  type TokenLockRecord,
} from './tokenLocks';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';

/** The wallet's token-lock address (seed-derived; never the BSV lock key). */
export async function tokenLockAddress(ctx: OneSatContext): Promise<string> {
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID: TOKEN_LOCK_KEY_ID,
    counterparty: 'self',
    forSelf: true,
  });
  return PublicKey.fromString(publicKey).toAddress();
}

const KEY_CI = JSON.stringify({ protocolID: P1SAT_PROTOCOL, keyID: TOKEN_LOCK_KEY_ID, counterparty: 'self' });

export type CreateTokenLockInput = {
  token: { id: string; sym?: string; dec: number; icon?: string };
  amt: bigint;
  until: number;
  label: string;
  /** Mint the receipt inscription in the same transaction. */
  receipt?: Omit<ReceiptIdentity, 'address'> & { address: string };
  /** false = lock even when the BSV-21 overlay is not tracking this token (e.g. a new launchpad coin). */
  validateOverlay: boolean;
};

export class TokenLockError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Lock tokens. Irreversible once broadcast: the caller must have shown the confirmation step. */
export async function createTokenLock(
  ctx: OneSatContext,
  account: string,
  input: CreateTokenLockInput,
  cs?: ChromeStorageService,
): Promise<TokenLockRecord> {
  const lockAddress = await tokenLockAddress(ctx);
  const script = tokenLockScript(input.token.id, input.amt, lockAddress, input.until);
  const token: TokenRef = { id: input.token.id, amt: String(input.amt), dec: input.token.dec, sym: input.token.sym };
  let wallet = ctx.wallet;
  if (input.receipt) {
    const r = buildReceipt({
      mode: 'date',
      // The lock is the first output (sendBsv21 puts recipients first and never shuffles).
      pieces: [{ height: input.until, sats: 1 }],
      lockAddress,
      identity: input.receipt,
      token,
      label: input.label,
    });
    const out = await receiptOutput(ctx, r);
    wallet = withExtraOutput(ctx.wallet, {
      lockingScript: out.hex,
      satoshis: 1,
      outputDescription: 'Token lock receipt',
      basket: ORDINALS_BASKET,
      tags: out.tags,
      customInstructions: out.ci,
    } as Parameters<typeof withExtraOutput>[1]);
  }
  const res = await sendBsv21.execute(
    { ...ctx, wallet },
    {
      tokenId: input.token.id,
      recipients: [{ amount: input.amt, destination: { lockingScript: script.toHex() } }],
      validateOverlay: input.validateOverlay,
    },
  );
  if ('error' in res && res.error) throw new TokenLockError(res.error, res.error);
  const txid = 'txid' in res ? res.txid : undefined;
  if (!txid) throw new TokenLockError('no-txid', 'The wallet did not return a transaction id.');
  // Find the lock output in the signed transaction rather than assuming its position.
  let vout = 0;
  try {
    const tx = 'tx' in res && res.tx ? Transaction.fromAtomicBEEF(Array.from(res.tx as ArrayLike<number>)) : null;
    const i = tx?.outputs.findIndex((o) => o.lockingScript.toHex() === script.toHex()) ?? -1;
    if (i >= 0) vout = i;
  } catch {
    // keep vout 0 (sendBsv21's order); the verifier reads the chain anyway
  }
  const rec: TokenLockRecord = {
    outpoint: `${txid}.${vout}`,
    tokenId: input.token.id,
    sym: input.token.sym,
    dec: input.token.dec,
    amt: String(input.amt),
    until: input.until,
    label: input.label.trim() || 'Token lock',
    lockAddress,
    createdAt: new Date().toISOString(),
    receipt: !!input.receipt,
  };
  saveTokenLocks(account, [rec, ...loadTokenLocks(account, cs)], cs);
  return rec;
}

/**
 * Unlock a matured token lock back into the wallet's tokens. Everything it needs comes from the chain
 * (the lock transaction) and the seed (the lock key); the record only says which outpoint to look at.
 */
export async function unlockTokenLock(
  ctx: OneSatContext,
  account: string,
  rec: Pick<TokenLockRecord, 'outpoint'> & Partial<TokenLockRecord>,
  cs?: ChromeStorageService,
): Promise<string> {
  if (!ctx.services) throw new Error('The wallet services are not ready.');
  const [txid, voutStr] = rec.outpoint.split('.');
  const vout = Number(voutStr);
  const beef = await ctx.services.getBeefForTxid(txid);
  const source = beef.findTxid(txid)?.tx;
  const out = source?.outputs[vout];
  if (!out) throw new Error('Could not load the lock transaction.');
  const lock = decodeTokenLock(out.lockingScript);
  if (!lock) throw new Error('That output is not a token lock.');
  if (lock.address !== (await tokenLockAddress(ctx))) throw new Error('This lock belongs to another wallet.');
  const height = await ctx.services.chaintracks.currentHeight();
  if (!canUnlock(lock.until, height)) throw new Error(`Locked until block ${lock.until}.`);

  let details: Awaited<ReturnType<typeof ctx.services.bsv21.getTokenDetails>> | undefined;
  try {
    details = await ctx.services.bsv21.getTokenDetails(lock.tokenId, { fresh: true });
  } catch {
    details = undefined;
  }
  const keyID = `${lock.tokenId}-${Date.now()}`;
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID,
    counterparty: 'self',
    forSelf: true,
  });
  const dest = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress());
  const sym = details?.token.sym ?? rec.sym;
  const dec = details?.token.dec ?? rec.dec ?? 0;
  const outputs: {
    lockingScript: string;
    satoshis: number;
    outputDescription: string;
    basket?: string;
    tags?: string[];
    customInstructions?: string;
  }[] = [
    {
      lockingScript: BSV21.transfer(lock.tokenId, lock.amt).lock(dest).toHex(),
      satoshis: 1,
      outputDescription: `Unlocked ${sym || 'tokens'}`,
      basket: BSV21_BASKET,
      tags: bsv21FilterTags({ tokenId: lock.tokenId }),
      customInstructions: buildBsv21CustomInstructions({
        token: { id: lock.tokenId, op: 'transfer', sym, dec, icon: details?.token.icon, amt: String(lock.amt) },
        protocolID: P1SAT_PROTOCOL,
        keyID,
        counterparty: 'self',
      }),
    },
  ];
  const feeAddr = details?.status?.fee_address;
  const feePer = details?.status?.fee_per_output;
  if (typeof feeAddr === 'string' && feeAddr && typeof feePer === 'number' && feePer > 0)
    outputs.push({
      lockingScript: new P2PKH().lock(feeAddr).toHex(),
      satoshis: feePer,
      outputDescription: 'Overlay processing fee',
      tags: ['fee:overlay'],
    });
  const inputBEEF = beef.toBinary();
  const outpoint = `${txid}.${vout}`;
  const result = await executeTrackedAction(
    ctx.wallet,
    {
      description: `Unlock ${sym || 'tokens'}`,
      inputBEEF,
      inputs: [
        {
          outpoint,
          inputDescription: 'Locked tokens',
          unlockingScriptLength: tokenUnlockLength(out.lockingScript),
          sequenceNumber: 0,
        },
      ],
      outputs,
      lockTime: lock.until,
      options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
    },
    undefined,
    inputBEEF,
    undefined,
    { spends: [{ outpoint, customInstructions: KEY_CI }], permissionScheme: 'bsv21' },
  );
  if (!result.txid) throw new Error('The wallet did not return a transaction id.');
  if (result.tx) {
    try {
      await ctx.services.overlay.submitBsv21(result.tx, lock.tokenId);
    } catch {
      // the overlay also picks it up from the chain; the tokens are already back in the wallet
    }
  }
  const list = loadTokenLocks(account, cs).map((r) =>
    r.outpoint === outpoint ? { ...r, unlockedTxid: result.txid } : r,
  );
  saveTokenLocks(account, list, cs);
  return result.txid;
}
