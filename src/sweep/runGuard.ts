import { Transaction } from '@bsv/sdk';

/**
 * Run NFTs (jigs) must never be spent as plain sats: a Run jig is an ordinary P2PKH output whose Run state lives
 * in an OP_RETURN of the tx that made it, so a value-only sweep or fee spend destroys the NFT for good (owner,
 * 17 Oct 2026: RelayX collections). RelayX jig dust is 1 sat (2023), 273 (2022) or 546 sats, so every output of
 * those sizes is checked against its source tx for the Run marker, and held back when the tx can't be read.
 */
export const RUN_JIG_SATS = 273;
/** Output sizes a Run jig can have: these are checked before any sweep. */
export const JIG_DUST = new Set([1, 273, 546]);

/** OP_FALSE OP_RETURN PUSH3 "run". */
const RUN_PREFIX = [0x00, 0x6a, 0x03, 0x72, 0x75, 0x6e];

export const isRunJig = (o: { satoshis?: number; events?: readonly string[] }): boolean =>
  o.satoshis === RUN_JIG_SATS ||
  (o.events ?? []).some((e) => /^(type|app|proto|protocol):run\b/i.test(e) || e === 'run');

/** Does this raw tx carry a Run payload (an output starting OP_FALSE OP_RETURN "run")? */
export function isRunTx(raw: readonly number[] | Uint8Array): boolean {
  const tx = Transaction.fromBinary([...raw]);
  return tx.outputs.some((o) => {
    const b = o.lockingScript.toBinary();
    return b.length >= RUN_PREFIX.length && RUN_PREFIX.every((x, i) => b[i] === x);
  });
}

/**
 * The txids among `txids` that are Run txs, plus those that could not be read. Callers hold back outputs from
 * both: an unreadable source tx is never assumed safe to sweep.
 */
export async function runOrUnknownTxids(
  txids: readonly string[],
  getRawTx: (txid: string) => Promise<readonly number[] | Uint8Array>,
  concurrency = 6,
): Promise<Set<string>> {
  const out = new Set<string>();
  const queue = [...new Set(txids)];
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        const raw = await getRawTx(t);
        if (!raw.length || isRunTx(raw)) out.add(t);
      } catch {
        out.add(t);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
