// bTrust seed-only recovery: find every inheritance lock from the recovery phrase alone, no plan file, no server.
//
// Derivation (BRC-42 self-derivation under the BRC-43 protocol [1, 'btrust']):
//   owner key for lock slot i   keyID 'owner' (i = 0, the key bTrust has always used) or 'owner <i>' (i >= 1)
//   heir key (same for all)     keyID 'heir'
// A seed always gives the same keys, so every bTrust lock the seed owns has a known owner key.
//
// Finding the locks: the lock script is not a standard address, so funding and every check-in also pay a
// 1-sat P2PKH "beacon" to the owner key's own address. The scan derives slot 0, 1, 2… , asks WhatsOnChain
// for each address's history and stops after `gapLimit` empty slots in a row (like a BIP44 gap limit). In
// every transaction it finds, it decodes any output that is a bTrust lock for that owner key: the script
// itself carries the heir keys and both heights, so the plan rebuilds from the chain (only the heirs'
// names are lost; a saved plan file fills them back in).

import { Lock } from '@1sat/templates';
import { OP, P2PKH, PublicKey, Script, Transaction, Utils, type LockingScript } from '@bsv/sdk';
import { GATE_KEY, inheritanceLock, validatePlan, type InheritancePlan } from './inheritance';

export const ownerKeyID = (index = 0) => {
  if (!Number.isInteger(index) || index < 0) throw new Error('lock slot must be a whole number');
  return index === 0 ? 'owner' : `owner ${index}`;
};
export const heirKeyID = () => 'heir';

export const DEFAULT_GAP_LIMIT = 5;
export const MAX_SLOTS = 200;

/** The beacon output: P2PKH to the owner key's own address (spendable by the owner, 1 sat). */
export const beaconScript = (ownerPubKey: string): LockingScript =>
  new P2PKH().lock(PublicKey.fromString(ownerPubKey).toAddress());

export const beaconAddress = (ownerPubKey: string) => PublicKey.fromString(ownerPubKey).toAddress();

const hexOf = (c: { data?: number[] } | undefined) => (c?.data ? Utils.toHex(c.data) : '');

/**
 * Rebuild the plan from a lock script found on chain, or null if it is not a bTrust inheritance lock.
 * The result is only returned when inheritanceLock(plan) is byte-for-byte the same script.
 */
export function planFromScript(script: Script, names?: string[]): InheritancePlan | null {
  try {
    const c = script.chunks;
    if (c[0]?.op !== OP.OP_IF || c[2]?.op !== OP.OP_CHECKSIG || c[5]?.op !== OP.OP_2 || c[9]?.op !== OP.OP_3)
      return null;
    const ownerPubKey = hexOf(c[1]);
    const heirKeys = [hexOf(c[6]), hexOf(c[7]), hexOf(c[8])];
    // Gate Lock starts at chunk 11; its length does not depend on the height, so measure it with a dummy.
    const n = Lock.lock(GATE_KEY.toPublicKey().toAddress(), 1).chunks.length;
    const gate = Lock.decode(new Script(c.slice(11, 11 + n)));
    const lead = Lock.decode(new Script(c.slice(12 + n, 12 + 2 * n)));
    if (!gate || !lead) return null;
    const plan = validatePlan({
      v: 1,
      ownerPubKey,
      heirs: heirKeys.map((pubKey, i) => ({ name: names?.[i]?.trim() || `Heir ${i + 1}`, pubKey })),
      heirsHeight: gate.until,
      leadHeight: lead.until,
    });
    return inheritanceLock(plan).toHex() === script.toHex() ? plan : null;
  } catch {
    return null;
  }
}

export type FoundLock = {
  slot: number;
  txid: string;
  vout: number;
  sats: number;
  plan: InheritancePlan;
  spent: boolean;
  /** The funding transaction, needed to sign a check-in or claim. */
  tx: Transaction;
};

/** bTrust lock outputs in `tx` owned by `ownerPubKey`. */
export function locksInTx(tx: Transaction, ownerPubKey: string) {
  const out: { vout: number; sats: number; plan: InheritancePlan }[] = [];
  tx.outputs.forEach((o, vout) => {
    const plan = planFromScript(o.lockingScript);
    if (plan && plan.ownerPubKey === ownerPubKey && (o.satoshis ?? 0) > 0)
      out.push({ vout, sats: o.satoshis ?? 0, plan });
  });
  return out;
}

/** Chain access the scan needs. wocChain() is the default; tests pass a fake. */
export type ChainReader = {
  /** txids that touched this address (confirmed and unconfirmed). */
  history: (address: string) => Promise<string[]>;
  rawTx: (txid: string) => Promise<string>;
  /** Which of these vouts of txid are spent. */
  spent: (txid: string, vouts: number[]) => Promise<Set<number>>;
};

/** Public key for a bTrust keyID, from the wallet (getPublicKey) or a local KeyDeriver. */
export type OwnerKeys = (keyID: string) => Promise<string>;

/**
 * Seed-only scan. Derives owner slots 0, 1, 2…, reads each beacon address's history and returns every bTrust
 * lock found (spent ones too, so the history is complete). Stops after `gapLimit` slots in a row with no history.
 */
export async function scanForLocks(
  keys: OwnerKeys,
  chain: ChainReader,
  { gapLimit = DEFAULT_GAP_LIMIT, maxSlots = MAX_SLOTS } = {},
): Promise<{ locks: FoundLock[]; nextSlot: number }> {
  const locks: FoundLock[] = [];
  let gap = 0;
  let lastUsed = -1;
  for (let slot = 0; slot < maxSlots && gap < gapLimit; slot++) {
    const pub = await keys(ownerKeyID(slot));
    const txids = [...new Set(await chain.history(beaconAddress(pub)))];
    if (!txids.length) {
      gap++;
      continue;
    }
    gap = 0;
    lastUsed = slot;
    for (const txid of txids) {
      const tx = Transaction.fromHex(await chain.rawTx(txid));
      const found = locksInTx(tx, pub);
      if (!found.length) continue;
      const spent = await chain.spent(
        txid,
        found.map((f) => f.vout),
      );
      for (const f of found) locks.push({ slot, txid, ...f, spent: spent.has(f.vout), tx });
    }
  }
  return { locks, nextSlot: lastUsed + 1 };
}

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** WhatsOnChain reader (public API, no account): the same source bwalletx.com/lock/verify uses. */
export function wocChain(fetcher: typeof fetch = fetch): ChainReader {
  const get = async (url: string, init?: RequestInit) => {
    for (let i = 0; ; i++) {
      const r = await fetcher(url, init).catch((e: unknown) => {
        if (i >= 3) throw e;
        return null;
      });
      if (r && (r.status !== 429 || i >= 3)) return r;
      await new Promise((res) => setTimeout(res, 800 * 2 ** i));
    }
  };
  const txids = (j: unknown): string[] => {
    const rows = Array.isArray(j) ? j : ((j as { result?: unknown[] })?.result ?? []);
    return rows.map((r) => (r as { tx_hash?: string }).tx_hash).filter((t): t is string => !!t);
  };
  return {
    history: async (address) => {
      const out: string[] = [];
      for (const kind of ['confirmed', 'unconfirmed']) {
        const r = await get(`${WOC}/address/${address}/${kind}/history`);
        if (r.status === 404) continue;
        if (!r.ok) throw new Error('Could not read the chain. Try again in a minute.');
        out.push(...txids(await r.json()));
      }
      return out;
    },
    rawTx: async (txid) => {
      const r = await get(`${WOC}/tx/${txid}/hex`);
      if (!r.ok) throw new Error('Transaction not found.');
      return (await r.text()).trim();
    },
    spent: async (txid, vouts) => {
      const r = await get(`${WOC}/utxos/spent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ utxos: vouts.map((vout) => ({ txid, vout })) }),
      });
      if (!r.ok) throw new Error('Could not read spent status.');
      const rows = (await r.json()) as { utxo: { vout: number }; spentIn?: unknown }[];
      return new Set(rows.filter((x) => x.spentIn).map((x) => x.utxo.vout));
    },
  };
}

/** Broadcast a signed transaction through WhatsOnChain. Returns the txid. */
export async function broadcast(tx: Transaction, fetcher: typeof fetch = fetch): Promise<string> {
  const r = await fetcher(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txhex: tx.toHex() }),
  });
  const text = (await r.text()).trim();
  if (!r.ok) throw new Error(`Broadcast failed: ${text.slice(0, 200)}`);
  return text.replace(/"/g, '');
}

/**
 * Find the live lock for a plan file (what an heir has): read the owner's beacon address from the plan's
 * owner key and return the unspent output that is exactly this plan's lock, if any.
 */
export async function findPlanLock(plan: InheritancePlan, chain: ChainReader): Promise<FoundLock | null> {
  const want = inheritanceLock(plan).toHex();
  for (const txid of [...new Set(await chain.history(beaconAddress(plan.ownerPubKey)))]) {
    const tx = Transaction.fromHex(await chain.rawTx(txid));
    const vouts = tx.outputs.flatMap((o, v) => (o.lockingScript.toHex() === want && o.satoshis ? [v] : []));
    if (!vouts.length) continue;
    const spent = await chain.spent(txid, vouts);
    const vout = vouts.find((v) => !spent.has(v));
    if (vout !== undefined)
      return { slot: -1, txid, vout, sats: tx.outputs[vout].satoshis ?? 0, plan, spent: false, tx };
  }
  return null;
}
