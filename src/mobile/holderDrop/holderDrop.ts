/**
 * Airdrop to holders (roadmap, 16 Oct 2026): an issuer sends a token, or BSV, to every holder of a BSV-21 token
 * in one go. The drops land in recipients' bMail like any other airdrop (an optional note travels in each tx).
 *
 * Steps, all pure here so they are unit-tested (holderDrop.test.ts):
 *   1. Snapshot: the holder list from the GorillaPool / 1Sat holders API, keyed on the token ID (never a ticker).
 *   2. Filter: drop burn addresses, the sender's own addresses, malformed addresses and (optionally) holders
 *      under a minimum holding.
 *   3. Amount: a fixed amount each, or a budget split pro-rata to holdings (largest-remainder rounding: the sum
 *      is exactly the budget, never more, and nobody gets less than the minimum output).
 *   4. Batches of N outputs, one transaction per batch.
 *   5. Progress: a plan records each batch's txid, so an interrupted drop resumes where it stopped.
 *   6. Receipt: CSV of recipients, amounts and txids.
 */
import validate from 'bitcoin-address-validation';

export const HOLDERS_API = 'https://ordinals.gorillapool.io/api/bsv20/id';
/** Page size the holders API returns at most. */
export const HOLDERS_PAGE = 100;
/** Safety cap on the snapshot (pages × page size). A drop to more holders is split by the issuer. */
export const MAX_HOLDERS = 5000;
export const DEFAULT_BATCH = 50;
export const MAX_BATCH = 100;

/** Addresses that can never spend: the well-known eater address and the all-zero hash160. */
export const BURN_ADDRESSES: readonly string[] = [
  '1BitcoinEaterAddressDontSendf59kuE',
  '1111111111111111111114oLvT2',
  '1CounterpartyXXXXXXXXXXXXXXXUWLpVr',
];

export type Holder = { address: string; amt: bigint };
export type DropAsset = { kind: 'token'; tokenId: string; dec: number; symbol: string } | { kind: 'bsv' };
export type Recipient = { address: string; holding: bigint; amount: bigint };

export const TOKEN_ID_RE = /^[0-9a-f]{64}[_.]\d+$/i;
/** Canonical `txid_vout` form of a BSV-21 token ID, or null when it is not one (a ticker is not an ID). */
export const normTokenId = (raw: string): string | null => {
  const t = raw.trim();
  return TOKEN_ID_RE.test(t) ? t.replace('.', '_').toLowerCase() : null;
};

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Parse one page of the holders API. Rows that are not `{address, amt}` with a whole-number amount are skipped. */
export const parseHolders = (body: unknown): Holder[] => {
  if (!Array.isArray(body)) throw new Error('The holders list could not be read.');
  const out: Holder[] = [];
  for (const row of body) {
    if (!row || typeof row !== 'object') continue;
    const { address, amt } = row as { address?: unknown; amt?: unknown };
    if (typeof address !== 'string' || !address) continue;
    const s = typeof amt === 'number' ? (Number.isSafeInteger(amt) ? String(amt) : '') : String(amt ?? '');
    if (!/^\d+$/.test(s)) continue;
    out.push({ address, amt: BigInt(s) });
  }
  return out;
};

/** Every holder of a token (atomic amounts), paging until a short page. Throws on a bad ID or a failed request. */
export const fetchHolders = async (f: Fetch, tokenId: string, max = MAX_HOLDERS): Promise<Holder[]> => {
  const id = normTokenId(tokenId);
  if (!id) throw new Error('Enter a BSV-21 token ID (txid_vout), not a ticker.');
  const all: Holder[] = [];
  for (let offset = 0; offset < max; offset += HOLDERS_PAGE) {
    const r = await f(`${HOLDERS_API}/${id}/holders?limit=${HOLDERS_PAGE}&offset=${offset}`);
    if (!r.ok) throw new Error(`The holders list is unavailable (HTTP ${r.status}). Try again later.`);
    const page = parseHolders(await r.json());
    all.push(...page);
    if (page.length < HOLDERS_PAGE) return all;
  }
  throw new Error(`This token has more than ${max} holders. Raise the minimum holding to narrow the list.`);
};

export type SnapshotFilter = { exclude: readonly string[]; minHolding?: bigint };
export type SnapshotResult = {
  holders: Holder[];
  skipped: { burn: number; sender: number; invalid: number; belowMin: number; empty: number };
};

/**
 * Filter a raw snapshot: merge duplicate rows, then drop burn addresses, the sender's addresses (`exclude`),
 * addresses that aren't valid mainnet P2PKH-style addresses, zero holdings and holdings under `minHolding`.
 * Sorted by holding (largest first), then address, so a plan is the same for the same snapshot.
 */
export const filterHolders = (raw: readonly Holder[], filter: SnapshotFilter): SnapshotResult => {
  const merged = new Map<string, bigint>();
  for (const h of raw) merged.set(h.address, (merged.get(h.address) ?? 0n) + h.amt);
  const exclude = new Set(filter.exclude.filter(Boolean));
  const burn = new Set(BURN_ADDRESSES);
  const skipped = { burn: 0, sender: 0, invalid: 0, belowMin: 0, empty: 0 };
  const holders: Holder[] = [];
  for (const [address, amt] of merged) {
    if (burn.has(address)) skipped.burn++;
    else if (exclude.has(address)) skipped.sender++;
    else if (!validate(address)) skipped.invalid++;
    else if (amt <= 0n) skipped.empty++;
    else if (filter.minHolding && amt < filter.minHolding) skipped.belowMin++;
    else holders.push({ address, amt });
  }
  holders.sort((a, b) => (a.amt === b.amt ? (a.address < b.address ? -1 : 1) : a.amt > b.amt ? -1 : 1));
  return { holders, skipped };
};

/** The same fixed amount to every holder. */
export const allocateFixed = (holders: readonly Holder[], each: bigint): Recipient[] => {
  if (each <= 0n) throw new Error('The amount each must be more than zero.');
  return holders.map((h) => ({ address: h.address, holding: h.amt, amount: each }));
};

/**
 * Split `budget` pro-rata to holdings. Each share is floored, then the leftover units go one each to the largest
 * remainders, so the total is exactly `budget` (no overspend, nothing lost to rounding). A holder whose share would
 * be under `minOut` (dust) is dropped and the budget is re-split among the rest, until every share is ≥ minOut.
 */
export const allocateProRata = (holders: readonly Holder[], budget: bigint, minOut = 1n): Recipient[] => {
  if (budget <= 0n) throw new Error('The total to send must be more than zero.');
  if (minOut < 1n) minOut = 1n;
  let pool = holders.filter((h) => h.amt > 0n);
  for (;;) {
    if (!pool.length) return [];
    const total = pool.reduce((s, h) => s + h.amt, 0n);
    const rows = pool.map((h, i) => {
      const num = budget * h.amt;
      return { h, i, share: num / total, rem: num % total };
    });
    let left = budget - rows.reduce((s, r) => s + r.share, 0n);
    const byRem = [...rows].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
    for (const r of byRem) {
      if (left <= 0n) break;
      r.share += 1n;
      left -= 1n;
    }
    const dust = rows.filter((r) => r.share < minOut);
    if (!dust.length) return rows.map((r) => ({ address: r.h.address, holding: r.h.amt, amount: r.share }));
    // Drop every holder under the minimum this round and re-split the budget among the rest.
    const cut = new Set(dust.map((r) => r.h.address));
    pool = pool.filter((h) => !cut.has(h.address));
  }
};

export const sumAmounts = (rs: readonly { amount: bigint }[]) => rs.reduce((s, r) => s + r.amount, 0n);

/** Split recipients into batches of at most `size` outputs (one transaction each). */
export const toBatches = <T>(items: readonly T[], size = DEFAULT_BATCH): T[][] => {
  const n = Math.max(1, Math.min(MAX_BATCH, Math.floor(size) || DEFAULT_BATCH));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};

// ─── Cost preview ────────────────────────────────────────────────────────────

/** Estimated tx bytes: overhead + inputs + outputs (token transfer outputs are larger than plain P2PKH). */
export const batchBytes = (outputs: number, kind: DropAsset['kind'], inputs = 3) =>
  10 + 148 * inputs + (kind === 'token' ? 120 : 34) * outputs + 34 * 2 /* change + fee/note */ + 80;

export const minerFeeSats = (bytes: number, satsPerKb: number) => Math.max(1, Math.ceil((bytes * satsPerKb) / 1000));

export type DropPreview = {
  holders: number;
  batches: number;
  /** Total sent to holders, in the asset's atomic units (sats for BSV). */
  total: bigint;
  /** Miner fees, all batches (estimate). */
  minerFee: number;
  /** Token indexer fees, all batches (fee_per_output × (outputs + change)). 0 for BSV. */
  indexerFee: number;
  /** Sats that leave the wallet: BSV total (if BSV) + fees + the 1-sat token outputs. */
  satsOut: bigint;
};

export const previewDrop = (
  recipients: readonly Recipient[],
  asset: DropAsset,
  opts: { batchSize: number; satsPerKb: number; feePerOutput?: number },
): DropPreview => {
  const batches = toBatches(recipients, opts.batchSize);
  let minerFee = 0;
  let indexerFee = 0;
  for (const b of batches) {
    minerFee += minerFeeSats(batchBytes(b.length, asset.kind), opts.satsPerKb);
    if (asset.kind === 'token' && opts.feePerOutput && opts.feePerOutput > 0)
      indexerFee += opts.feePerOutput * (b.length + 1);
  }
  const total = sumAmounts(recipients);
  const tokenSats = asset.kind === 'token' ? BigInt(recipients.length) : 0n;
  const satsOut = (asset.kind === 'bsv' ? total : 0n) + BigInt(minerFee + indexerFee) + tokenSats;
  return { holders: recipients.length, batches: batches.length, total, minerFee, indexerFee, satsOut };
};

// ─── Resumable plan ──────────────────────────────────────────────────────────

/**
 * `started` is set just before a batch is signed and cleared by its result. A batch still `started` after a
 * restart may have been broadcast: the sheet asks the issuer to check History before sending it again.
 */
export type PlanBatch = { recipients: Recipient[]; txid?: string; error?: string; started?: number };
export type DropPlan = {
  id: string;
  createdAt: number;
  snapshotTokenId: string;
  asset: DropAsset;
  mode: 'fixed' | 'prorata';
  note?: string;
  batches: PlanBatch[];
};

export const makePlan = (p: Omit<DropPlan, 'batches'> & { recipients: Recipient[]; batchSize: number }): DropPlan => {
  const { recipients, batchSize, ...rest } = p;
  return { ...rest, batches: toBatches(recipients, batchSize).map((r) => ({ recipients: r })) };
};

/** Index of the next batch to send, or -1 when every batch has a txid. */
export const nextBatch = (plan: DropPlan) => plan.batches.findIndex((b) => !b.txid);
export const isDone = (plan: DropPlan) => nextBatch(plan) === -1;
export const sentCount = (plan: DropPlan) => plan.batches.reduce((n, b) => n + (b.txid ? b.recipients.length : 0), 0);

/** A copy of the plan with batch `i` marked as being sent now. */
export const startBatch = (plan: DropPlan, i: number, now = Date.now()): DropPlan => ({
  ...plan,
  batches: plan.batches.map((b, j) => (j !== i || b.txid ? b : { recipients: b.recipients, started: now })),
});

/** Index of a batch interrupted mid-send (started, no result), or -1. */
export const interruptedBatch = (plan: DropPlan) => plan.batches.findIndex((b) => !b.txid && !!b.started);

/** A copy of the plan with batch `i` marked sent (txid) or failed (error). A sent batch is never overwritten. */
export const recordBatch = (plan: DropPlan, i: number, r: { txid: string } | { error: string }): DropPlan => ({
  ...plan,
  batches: plan.batches.map((b, j) =>
    j !== i || b.txid
      ? b
      : 'txid' in r
        ? { recipients: b.recipients, txid: r.txid }
        : { recipients: b.recipients, error: r.error },
  ),
});

// Plans are kept as JSON with bigints as strings.
export const serializePlan = (plan: DropPlan) =>
  JSON.stringify(plan, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));

export const parsePlan = (raw: string | null | undefined): DropPlan | null => {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw, (_k, v: unknown) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as DropPlan;
    if (!p || typeof p.id !== 'string' || !Array.isArray(p.batches) || !p.asset) return null;
    return p;
  } catch {
    return null;
  }
};

// ─── Receipt ─────────────────────────────────────────────────────────────────

/** Atomic units → decimal string (no float maths). */
export const formatUnits = (v: bigint, dec: number) => {
  if (dec <= 0) return v.toString();
  const s = v.toString().padStart(dec + 1, '0');
  const whole = s.slice(0, -dec);
  const frac = s.slice(-dec).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
};

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Receipt CSV: one row per recipient with the batch, amount, holding and txid ("" while unsent). */
export const receiptCsv = (plan: DropPlan, holdingDec: number) => {
  const unit = plan.asset.kind === 'bsv' ? 'sats' : plan.asset.symbol || plan.asset.tokenId;
  const dec = plan.asset.kind === 'bsv' ? 0 : plan.asset.dec;
  const rows = [['batch', 'address', `amount (${unit})`, 'holding', 'txid', 'status'].map(csvCell).join(',')];
  plan.batches.forEach((b, i) => {
    for (const r of b.recipients)
      rows.push(
        [
          String(i + 1),
          r.address,
          formatUnits(r.amount, dec),
          formatUnits(r.holding, holdingDec),
          b.txid ?? '',
          b.txid ? 'sent' : b.error ? 'failed' : 'pending',
        ]
          .map(csvCell)
          .join(','),
      );
  });
  return rows.join('\n') + '\n';
};
