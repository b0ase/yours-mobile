/**
 * PNEE price rounds: five signers each sign priceCents (8 LE) ‖ ts (8 LE) with a Rabin key; a mint needs three
 * of them on one round. The wallet checks every signature before using a round, then picks the three the
 * contract will see (the same rule as bwalletx-bond selectQuorum: drop bad ones, take the middle three by price,
 * order by signer index). The contract uses the median of the three.
 */
import { Hash } from '@bsv/sdk';

export type SignedPrice = { signer: number; priceCents: number; s: string; padding: string };
export type PriceRound = {
  ts: number;
  priceCents: number;
  signed: SignedPrice[];
  /** Set by verifyRound: the three signatures the mint uses, and their median. */
  quorum: SignedPrice[];
  median: number;
};

const le8 = (n: bigint) => {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  return out;
};
export const priceMsg = (priceCents: bigint, ts: bigint) => [...le8(priceCents), ...le8(ts)];

/** 1024-bit hash for Rabin: four chained SHA-256 blocks, read little-endian unsigned. */
export function rabinHash(msg: number[]): bigint {
  const h1 = Hash.sha256(msg);
  const h2 = Hash.sha256(h1);
  const h3 = Hash.sha256(h2);
  const h4 = Hash.sha256(h3);
  const all = [...h1, ...h2, ...h3, ...h4];
  let n = 0n;
  for (let i = all.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(all[i]);
  return n;
}

export function rabinVerify(msg: number[], s: bigint, paddingHex: string, n: bigint): boolean {
  const pad = paddingHex.match(/../g)?.map((x) => parseInt(x, 16)) ?? [];
  return (s * s) % n === rabinHash([...msg, ...pad]) % n;
}

/** Check a round from the signers and pick the quorum. Throws when fewer than 3 signatures are good. */
export function verifyRound(r: Omit<PriceRound, 'quorum' | 'median'>, oracles: bigint[]): PriceRound {
  const ts = BigInt(r.ts);
  const good = (r.signed ?? []).filter(
    (x, i, all) =>
      Number.isInteger(x.signer) &&
      x.signer >= 0 &&
      x.signer < 5 &&
      x.priceCents > 0 &&
      all.findIndex((y) => y.signer === x.signer) === i &&
      rabinVerify(priceMsg(BigInt(x.priceCents), ts), BigInt(x.s), x.padding, oracles[x.signer]),
  );
  if (good.length < 3) throw new Error('Fewer than three price signatures check out. Try again in a minute.');
  const byPrice = [...good].sort((a, b) => a.priceCents - b.priceCents);
  const mid = Math.floor((byPrice.length - 3) / 2);
  const quorum = byPrice.slice(mid, mid + 3).sort((a, b) => a.signer - b.signer);
  const median = [...quorum].sort((a, b) => a.priceCents - b.priceCents)[1].priceCents;
  return { ...r, quorum, median };
}
