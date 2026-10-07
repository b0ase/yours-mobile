/**
 * Ported from tokenblaster.lol src/lib/tokens.ts, src/lib/tokenLoad.ts and src/lib/gun.ts: only what
 * the BlastPad trade client needs (reading the wallet's BSV-21 coins the 1Sat way, the note a
 * token coin carries, signing token inputs, the BSV-21 transfer script). Logic unchanged.
 */
import {
  Beef,
  Hash,
  P2PKH,
  Script,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletInterface,
  type WalletProtocol,
} from '@bsv/sdk';

export const ONESAT: WalletProtocol = [0, 'onesat'];

const hex = (s: string) => Utils.toHex(Utils.toArray(s, 'utf8'));

/** A BSV-21 transfer inscription locked to `address` (gun.ts bsv21). */
export const bsv21 = (id: string, amt: bigint, address: string) =>
  Script.fromASM(
    `OP_0 OP_IF ${hex('ord')} OP_1 ${hex('application/bsv-20')} OP_0 ${hex(JSON.stringify({ p: 'bsv-20', op: 'transfer', id, amt: amt.toString() }))} OP_ENDIF ${new P2PKH().lock(address).toASM()}`,
  );

/** The note the 1Sat wallets write on a token coin (bsv21 basket): the wallet counts it from this. */
export const noteFor = (
  id: string,
  amt: bigint,
  sym: string,
  dec: number | undefined,
  keyID: string,
  icon?: string | null,
) =>
  JSON.stringify({
    id,
    amt: amt.toString(),
    op: 'transfer',
    sym,
    ...(dec !== undefined ? { dec: String(dec) } : {}),
    ...(icon ? { icon } : {}), // the wallet draws the token's icon from this
    protocolID: ONESAT,
    keyID,
    counterparty: 'self',
  });

const SIGHASH = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;

/** Unlocking scripts for the wallet's own token coins at the given input indexes (createSignature). */
export async function tokenSpends(
  wallet: WalletInterface,
  tx: Transaction,
  use: { index: number; protocolID: WalletProtocol; keyID: string }[],
): Promise<Record<number, { unlockingScript: string }>> {
  const spends: Record<number, { unlockingScript: string }> = {};
  const keys = new Map<string, string>(); // one getPublicKey per key, not per coin
  for (const u of use) {
    const i = u.index;
    const input = tx.inputs[i];
    const src = input.sourceTransaction!.outputs[input.sourceOutputIndex];
    const preimage = TransactionSignature.format({
      sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: src.satoshis ?? 1,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== i),
      inputIndex: i,
      outputs: tx.outputs,
      inputSequence: input.sequence ?? 0xffffffff,
      subscript: src.lockingScript,
      lockTime: tx.lockTime,
      scope: SIGHASH,
    });
    const digest = Hash.sha256(Hash.sha256(preimage));
    const { signature } = await wallet.createSignature({
      hashToDirectlySign: digest,
      protocolID: u.protocolID,
      keyID: u.keyID,
      counterparty: 'self',
    });
    const k = JSON.stringify([u.protocolID, u.keyID]);
    if (!keys.has(k))
      keys.set(
        k,
        (await wallet.getPublicKey({ protocolID: u.protocolID, keyID: u.keyID, counterparty: 'self' })).publicKey,
      );
    const publicKey = keys.get(k)!;
    const sig = [...signature, SIGHASH];
    const pub = Utils.toArray(publicKey, 'hex');
    spends[i] = {
      unlockingScript: new UnlockingScript([
        { op: sig.length, data: sig },
        { op: pub.length, data: pub },
      ]).toHex(),
    };
  }
  return spends;
}

/** One BSV-21 coin in a 1Sat-style wallet (Yours v5, bWallet, bWalletX). */
export type TokenCoin = {
  outpoint: string;
  id: string;
  amt: bigint;
  sym?: string;
  dec?: number;
  icon?: string;
  protocolID?: [0 | 1 | 2, string];
  keyID?: string;
  lockingScript?: string;
  /** The coin's note carries its amount: the wallet counts it. Without, the wallet can't see it. */
  noted: boolean;
};

const norm = (op: string) => op.replace('.', '_');

/**
 * Every spendable token coin in the wallet, read the way the 1Sat wallets read them: the `bsv21`
 * basket (and its legacy name), 500 at a time; token id and amount from each coin's
 * customInstructions, then its tags, then the deploy outpoint, then the inscription itself.
 */
export async function tokenCoins(
  wallet: WalletInterface,
  withScripts = false,
): Promise<{ coins: TokenCoin[]; beef?: number[] }> {
  const coins: TokenCoin[] = [];
  const beef = new Beef();
  for (const basket of ['bsv21', 'p 1sat bsv21']) {
    for (let offset = 0; offset < 20000; offset += 500) {
      const r = await wallet
        .listOutputs({
          basket,
          include: withScripts ? 'entire transactions' : 'locking scripts',
          includeTags: true,
          includeCustomInstructions: true,
          limit: 500,
          offset,
        })
        .catch(() => null);
      if (!r) break;
      if (withScripts && r.BEEF) beef.mergeBeef(Array.from(r.BEEF)); // every page's source txs, for spending
      for (const o of r.outputs) {
        if (o.spendable === false || !o.outpoint) continue;
        let ci: Record<string, unknown> = {};
        try {
          ci = o.customInstructions ? JSON.parse(o.customInstructions) : {};
        } catch {
          /* not JSON */
        }
        const tags = o.tags ?? [];
        const ins = inscriptionJson(o.lockingScript ?? '');
        const tagId = tags.find((t) => t.startsWith('bsv21:') && t !== 'bsv21:deploy' && t !== 'bsv21:auth')?.slice(6);
        const isDeploy = tags.includes('bsv21:deploy') || ins?.op === 'deploy+mint';
        const id = (typeof ci.id === 'string' && ci.id) || tagId || ins?.id || (isDeploy ? o.outpoint : '');
        const amt = (typeof ci.amt === 'string' && ci.amt) || ins?.amt;
        if (!id || tags.includes('bsv21:auth')) continue;
        if (!amt && !withScripts) continue; // whole-tx mode: amount comes from the tx below
        coins.push({
          outpoint: o.outpoint,
          id: norm(id),
          amt: BigInt(amt ?? 0),
          sym: typeof ci.sym === 'string' ? ci.sym : undefined,
          dec: ci.dec !== undefined ? Number(ci.dec) : undefined,
          icon: typeof ci.icon === 'string' ? ci.icon : undefined,
          protocolID: Array.isArray(ci.protocolID) ? (ci.protocolID as [0 | 1 | 2, string]) : undefined,
          keyID: typeof ci.keyID === 'string' ? ci.keyID : undefined,
          lockingScript: o.lockingScript,
          noted: typeof ci.amt === 'string' && ci.amt !== '0',
        });
      }
      if (r.outputs.length < 500) break;
    }
  }
  // With whole transactions the wallet leaves out lockingScript: read the amount from the tx itself.
  if (withScripts) {
    for (const c of coins) {
      if (c.amt > BigInt(0)) continue;
      const [txid, vout] = c.outpoint.split(/[._]/);
      const script = beef.findTxid(txid)?.tx?.outputs[Number(vout)]?.lockingScript.toHex();
      const ins = script ? inscriptionJson(script) : null;
      if (ins?.amt) c.amt = BigInt(ins.amt);
      if (script) c.lockingScript = script;
    }
  }
  return { coins: coins.filter((c) => c.amt > BigInt(0)), beef: withScripts ? beef.toBinary() : undefined };
}

/** The `{"p":"bsv-20",…}` JSON inside an ordinal inscription locking script (hex). */
function inscriptionJson(hex: string): { op?: string; id?: string; amt?: string } | null {
  if (!hex) return null;
  let text = '';
  for (let i = 0; i + 1 < hex.length; i += 2) text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  const m = text.match(/\{"p":"bsv-20"[^}]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
