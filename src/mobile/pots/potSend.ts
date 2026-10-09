import { LockingScript, OP, P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, Utils } from '@bsv/sdk';
import { OneSatServices } from '@1sat/wallet-browser';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { decrypt } from '../../utils/crypto';
import { parseRecipient, resolveRecipient } from '../names/names';
import type { Payee } from './pots';

/**
 * Paying from a pot without switching to it (POTS-SUBSCRIPTIONS-PLAN.md v1). The session passKey that is
 * present while the wallet is unlocked opens every account's keys (as changePassword does), so the pot's
 * pay key is decrypted in memory for one payment and dropped. Same tx shape as Keys.service sweepLegacy:
 * the pot's P2PKH coins in, the payments out, change back to the pot. Nothing else is touched.
 */

let services: OneSatServices | null = null;
const svc = () => (services ??= new OneSatServices('main'));

const potAccount = (store: ChromeStorageService, potId: string) =>
  store.getAllAccounts().find((a) => a.addresses.identityAddress === potId) ?? null;

type Coin = { txid: string; vout: number; sats: number };

const potCoins = async (address: string): Promise<Coin[]> => {
  // Ask the indexer to catch up on this address first (sweepLegacy does the same).
  for await (const ev of svc().owner.getTxos(address, { refresh: true, limit: 1 })) {
    if (ev.type === 'done' || ev.type === 'error') break;
  }
  const utxos = (await svc().txo.search(`own:${address}`, { unspent: true, sats: true, limit: 0 })) ?? [];
  return utxos
    .map((u) => {
      const [txid, vout] = u.outpoint.split(/[._]/);
      return { txid, vout: parseInt(vout, 10), sats: u.satoshis ?? 0 };
    })
    .filter((c) => c.txid && Number.isFinite(c.vout) && c.sats > 1); // never spend 1-sat outputs (ordinals)
};

/** A pot's spendable BSV in sats (its own P2PKH coins). */
export const potBalanceSats = async (store: ChromeStorageService, potId: string): Promise<number> => {
  const a = potAccount(store, potId);
  if (!a) return 0;
  const coins = await potCoins(a.addresses.bsvAddress);
  return coins.reduce((s, c) => s + c.sats, 0);
};

/**
 * Where a payee is paid: its address, or the address its paymail resolves to. Paymails that only take P2P
 * payments (a fresh destination per payment, submitted to their host) aren't supported for standing orders
 * in v1.
 */
export const payeeAddress = async (p: Payee): Promise<string> => {
  if (p.address) return p.address;
  if (!p.paymail) throw new Error('No payee address');
  const r = await resolveRecipient((u, i) => fetch(u, i), parseRecipient(p.paymail));
  if (r.targetKind === 'address') return r.target;
  throw new Error(`${p.paymail} only takes P2P payments, which subscriptions can’t send yet`);
};

export type PotPayment = { address: string; sats: number };

/** Sign (but don't broadcast) one tx from the pot paying `outputs`. payDue records it before broadcasting. */
export const signFromPot = async (
  store: ChromeStorageService,
  potId: string,
  outputs: PotPayment[],
  memo?: string,
): Promise<{ rawTx: string; txid: string }> => {
  const acct = potAccount(store, potId);
  if (!acct?.encryptedKeys) throw new Error('This pot isn’t on this device');
  const passKey = await store.getPassKey();
  if (!passKey) throw new Error('Unlock the wallet first');
  const keys = JSON.parse(await decrypt(acct.encryptedKeys, passKey)) as { walletWif?: string };
  if (!keys.walletWif) throw new Error('This pot’s keys are incomplete');
  const pk = PrivateKey.fromWif(keys.walletWif);
  const from = acct.addresses.bsvAddress;
  if (pk.toAddress() !== from) throw new Error('Pot key mismatch');

  const need = outputs.reduce((s, o) => s + o.sats, 0);
  const coins = await potCoins(from);
  const have = coins.reduce((s, c) => s + c.sats, 0);
  if (have < need + 50) throw new Error('Not enough in the pot');

  const tx = new Transaction();
  for (const o of outputs) tx.addOutput({ lockingScript: new P2PKH().lock(o.address), satoshis: o.sats });
  // The service's reference (subscribeLink.ts), so it can tie the payment to the account that asked.
  if (memo) tx.addOutput({ lockingScript: memoScript(memo), satoshis: 0 });
  tx.addOutput({ lockingScript: new P2PKH().lock(from), change: true });
  let added = 0;
  for (const c of coins.sort((a, b) => b.sats - a.sats)) {
    const raw = await svc().beef.getRawTx(c.txid);
    if (!raw.length) continue;
    tx.addInput({
      sourceTransaction: Transaction.fromBinary([...raw]),
      sourceOutputIndex: c.vout,
      sequence: 0xffffffff,
      unlockingScriptTemplate: new P2PKH().unlock(pk),
    });
    added += c.sats;
    if (added >= need + 1000) break;
  }
  if (added < need) throw new Error('Not enough in the pot');
  await tx.fee(new SatoshisPerKilobyte(store.getCustomFeeRate()));
  await tx.sign();
  return { rawTx: tx.toHex(), txid: tx.id('hex') };
};

/** OP_FALSE OP_RETURN <memo>: a 0-sat data output. */
export const memoScript = (memo: string) => {
  const data = Utils.toArray(memo, 'utf8');
  if (data.length > 75) throw new Error('Memo too long');
  return new LockingScript([{ op: OP.OP_FALSE }, { op: OP.OP_RETURN }, { op: data.length, data }]);
};

const REFUSED = new Set(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'INVALID', 'MALFORMED']);

/**
 * Broadcast a signed raw tx. Idempotent: sending the same tx again gets its current status (seen / mined),
 * so payDue can safely retry a payment whose first broadcast outcome it never recorded.
 */
export const broadcastRaw = async (rawTx: string): Promise<void> => {
  const r = await svc().submitToStack(Utils.toArray(rawTx, 'hex'));
  if (REFUSED.has(r.txStatus))
    throw new Error(`Payment refused by the network (${r.txStatus}${r.extraInfo ? `: ${r.extraInfo}` : ''})`);
};
