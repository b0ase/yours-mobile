/**
 * PNEE pots: pure helpers for paying PNEEs (BSV-21, 1 unit = 1¢) from a pot's own key. potSend.ts does the network
 * and signing; this picks which token outputs may be spent.
 *
 * An output is spent only when (1) the token overlay reports it 'valid' (one invalid input in a transfer would burn
 * the valid ones alongside it, as sweepBsv21 guards), and (2) its P2PKH suffix pays the pot key itself: the same key
 * check repairUnsignableTokenOutputs (tokenSendHeal.ts, PR #121) does, so a send never fails on an input this key
 * can't sign.
 */

export type PneeCandidate = {
  outpoint: string;
  /** Token units in the output. */
  amt: bigint;
  /** Locking script hex (inscription + P2PKH). */
  scriptHex: string;
  /** Overlay state: valid, spent, queued, unknown. */
  state?: string;
};

/** hash160 (hex) a script's trailing P2PKH pays, or null when it doesn't end in P2PKH. */
export const p2pkhSuffixHash = (scriptHex: string): string | null => {
  const m = /76a914([0-9a-f]{40})88ac$/i.exec(scriptHex);
  return m ? m[1].toLowerCase() : null;
};

export type PneePick =
  | { ok: true; inputs: PneeCandidate[]; total: bigint; change: bigint }
  | { ok: false; reason: string; spendable: bigint };

/** Largest valid, own-key outputs first until `need` units are covered. */
export const pickPneeInputs = (cands: PneeCandidate[], potHash160: string, need: bigint): PneePick => {
  const own = cands
    .filter(
      (c) => c.state === 'valid' && c.amt > BigInt(0) && p2pkhSuffixHash(c.scriptHex) === potHash160.toLowerCase(),
    )
    .sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0));
  const spendable = own.reduce((n, c) => n + c.amt, BigInt(0));
  if (need <= BigInt(0)) return { ok: false, reason: 'Nothing to pay', spendable };
  const inputs: PneeCandidate[] = [];
  let total = BigInt(0);
  for (const c of own) {
    if (total >= need) break;
    inputs.push(c);
    total += c.amt;
  }
  if (total < need) {
    const waiting = cands.some((c) => c.state === 'queued' || c.state === 'unknown' || c.state === undefined);
    return {
      ok: false,
      reason: waiting ? 'Not enough PNEEs in the pot ready to spend yet' : 'Not enough PNEEs in the pot',
      spendable,
    };
  }
  return { ok: true, inputs, total, change: total - need };
};

/** Spendable PNEE units (valid on the overlay, own key) as dollars. */
export const pneeUnitsToUsd = (units: bigint | number) => Number(units) / 100;
