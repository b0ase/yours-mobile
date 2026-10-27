/**
 * Exchange › Tokens card board (27 Oct 2026): per-token facts, trust badges and an open fair-launch score.
 *
 * Badges come only from data the wallet checks itself:
 *  - the deploy transaction's raw bytes (GorillaPool /tx/<txid>/raw): hashed and compared with the token id's
 *    txid, then read for the deployer's address (the P2PKH after the deploy+mint inscription) and for a
 *    committed bWallet launch curve (tokenPage.curveFromTx, which verifies the curve hash);
 *  - the BSV-21 supply, decimals and deploy height in that same deploy inscription and GorillaPool's token row;
 *  - holder balances (GorillaPool `/holders`, the endpoint the token page already uses). Tokens sitting at a
 *    known burn address (utils/constants KNOWN_BURN_ADDRESSES) can never be spent, so they count as burned.
 *
 * Nothing here shows a server's own claims ("graduated", "rewards paid", "backed by") as fact. Badges that need
 * data the wallet can't check yet (token locks per token, holder payouts, fee splits) are simply not shown.
 * Copy rule: facts only, no "returns", "profit", "yield" or "moon" wording.
 */
import { Transaction, Utils } from '@bsv/sdk';
import { KNOWN_BURN_ADDRESSES } from '../../utils/constants';
import { cached } from '../market/indexer';
import { curveFromTx, parseTopHolders, type TopHolder } from '../market/tokenPage';

const GP = 'https://ordinals.gorillapool.io/api';
const op_ = (id: string) => id.replace('.', '_');

// ── facts ────────────────────────────────────────────────────────────────────

export type BoardFacts = {
  /** Total minted, base units. */
  supply: bigint;
  dec: number;
  /** Block the token was deployed in (0 unknown). */
  height: number;
  holders: number | null;
  /** Top holders, largest first (burn addresses included; the score separates them). */
  top: TopHolder[];
  /** Who received the deploy+mint output, read from the verified deploy tx; null when it isn't a plain address. */
  deployer: string | null;
  /** The deploy tx carries a verified bWallet launch curve. */
  curve: boolean;
};

/** GorillaPool's token row → supply, decimals, height and holder count; null when malformed. */
export const parseTokenRow = (body: unknown): Pick<BoardFacts, 'supply' | 'dec' | 'height' | 'holders'> | null => {
  if (!body || typeof body !== 'object') return null;
  const b = body as { amt?: unknown; dec?: unknown; height?: unknown; accounts?: unknown };
  const amt = String(b.amt ?? '');
  if (!/^\d{1,20}$/.test(amt)) return null;
  const dec = Number(b.dec ?? 0);
  const height = Number(b.height ?? 0);
  const acc = b.accounts;
  return {
    supply: BigInt(amt),
    dec: Number.isInteger(dec) && dec >= 0 && dec <= 18 ? dec : 0,
    height: Number.isInteger(height) && height > 0 ? height : 0,
    holders: typeof acc === 'number' && Number.isFinite(acc) && acc >= 0 ? acc : null,
  };
};

/** The deploy output's owner: the P2PKH that follows the inscription envelope (…OP_ENDIF DUP HASH160 <20> EQUALVERIFY CHECKSIG). */
export const deployerOf = (tx: Transaction, vout: number): string | null => {
  const c = tx.outputs[vout]?.lockingScript.chunks;
  if (!c || c.length < 5) return null;
  const t = c.slice(-5);
  const pkh = t[2].data;
  if (t[0].op !== 0x76 || t[1].op !== 0xa9 || !pkh || pkh.length !== 20 || t[3].op !== 0x88 || t[4].op !== 0xac)
    return null;
  return Utils.toBase58Check(pkh, [0]);
};

/** Raw deploy tx → deployer + curve, after checking the bytes hash to the token id's txid. */
export const deployFacts = (raw: number[], tokenId: string): { deployer: string | null; curve: boolean } | null => {
  const [txid, v] = op_(tokenId).split('_');
  try {
    const tx = Transaction.fromBinary(raw);
    if (tx.id('hex') !== txid.toLowerCase()) return null;
    return { deployer: deployerOf(tx, Number(v)), curve: !!curveFromTx(tx) };
  } catch {
    return null;
  }
};

type Fetch = (url: string) => Promise<Response>;
const defaultFetch: Fetch = (url) => fetch(url, { signal: AbortSignal.timeout(8_000) });

/** Everything a card needs, cached 10 minutes (the deploy part never changes). Null when the token row is missing. */
export const boardFacts = (tokenId: string, f: Fetch = defaultFetch): Promise<BoardFacts | null> =>
  cached(
    `board:${op_(tokenId)}`,
    async () => {
      const id = op_(tokenId);
      const enc = encodeURIComponent(id);
      const [row, top, deploy] = await Promise.all([
        f(`${GP}/bsv20/id/${enc}`)
          .then(async (r) => (r.ok ? parseTokenRow(await r.json()) : null))
          .catch(() => null),
        f(`${GP}/bsv20/id/${enc}/holders?limit=20&offset=0`)
          .then(async (r) => (r.ok ? parseTopHolders(await r.json()) : []))
          .catch(() => [] as TopHolder[]),
        cached(
          `deploy:${id}`,
          () =>
            f(`${GP}/tx/${id.split('_')[0]}/raw`)
              .then(async (r) => (r.ok ? deployFacts([...new Uint8Array(await r.arrayBuffer())], id) : null))
              .catch(() => null),
          24 * 60 * 60_000,
        ),
      ]);
      if (!row) return null;
      // A 0 count with no holder rows means the indexer doesn't track this token's balances: unknown, not 0.
      const holders = row.holders === 0 && !top.length ? null : row.holders;
      return { ...row, holders, top, deployer: deploy?.deployer ?? null, curve: deploy?.curve ?? false };
    },
    10 * 60_000,
  );

// ── derived numbers ──────────────────────────────────────────────────────────

export type Derived = {
  /** Share of supply at burn addresses (0–1). */
  burnedPct: number;
  burned: bigint;
  /** Supply minus burned. */
  circulating: bigint;
  /** Top-10 non-burn holders' share of circulating (0–1); null when holders are unknown. */
  top10Pct: number | null;
  /**
   * Deployer's share of circulating (0–1). When the deployer isn't in the top 20 their share is at most the
   * 20th holder's, so that upper bound is used. Null when the deployer is unknown.
   */
  devPct: number | null;
};

const BURN = new Set(KNOWN_BURN_ADDRESSES);
const share = (a: bigint, b: bigint) => (b > 0n ? Number((a * 1_000_000n) / b) / 1_000_000 : 0);

export const derive = (f: BoardFacts): Derived => {
  const burned = f.top.filter((h) => BURN.has(h.address)).reduce((s, h) => s + h.amt, 0n);
  const circulating = f.supply > burned ? f.supply - burned : 0n;
  const live = f.top.filter((h) => !BURN.has(h.address));
  const top10Pct = live.length
    ? share(
        live.slice(0, 10).reduce((s, h) => s + h.amt, 0n),
        circulating,
      )
    : null;
  let devPct: number | null = null;
  if (f.deployer && live.length) {
    const dev = live.find((h) => h.address === f.deployer);
    if (dev) devPct = share(dev.amt, circulating);
    else if (f.top.length >= 20) devPct = share(live[live.length - 1].amt, circulating);
    else devPct = 0; // the list is complete and the deployer isn't on it
  }
  return { burnedPct: share(burned, f.supply), burned, circulating, top10Pct, devPct };
};

// ── fair-launch score ────────────────────────────────────────────────────────

export type ScorePart = { id: string; label: string; max: number; points: number; note: string };
export type FairScore = { total: number; parts: ScorePart[] };

/** The formula, word for word, for the "How it's scored" sheet. */
export const SCORE_RULES: { id: string; label: string; max: number; rule: string }[] = [
  {
    id: 'spread',
    label: 'Spread',
    max: 30,
    rule: 'Top 10 holders own 30% or less of circulating supply: 30. Falls in a straight line to 0 at 100%.',
  },
  {
    id: 'dev',
    label: 'Deployer',
    max: 25,
    rule: 'The address that received the minted supply holds 0%: 25. Falls in a straight line to 0 at 20% or more. Unknown deployer: 0.',
  },
  {
    id: 'holders',
    label: 'Holders',
    max: 20,
    rule: '20 × log10(holders) ÷ 3, so 10 holders = 6.7, 100 = 13.3, 1,000 or more = 20.',
  },
  {
    id: 'curve',
    label: 'Launch curve',
    max: 15,
    rule: 'The deploy transaction commits to a launch curve the wallet verifies: 15. Otherwise 0.',
  },
  {
    id: 'burned',
    label: 'Burned',
    max: 10,
    rule: '10% or more of supply sits at a burn address: 10. Less: in proportion.',
  },
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.01 ? 2 : 1).replace(/\.0+$/, '')}%`;
const round1 = (x: number) => Math.round(x * 10) / 10;

export const fairScore = (f: BoardFacts, d: Derived = derive(f)): FairScore => {
  const spread = d.top10Pct === null ? 0 : 30 * (1 - clamp01((d.top10Pct - 0.3) / 0.7));
  const dev = d.devPct === null ? 0 : 25 * (1 - clamp01(d.devPct / 0.2));
  const holders = f.holders && f.holders > 1 ? 20 * clamp01(Math.log10(f.holders) / 3) : 0;
  const curve = f.curve ? 15 : 0;
  const burned = 10 * clamp01(d.burnedPct / 0.1);
  const parts: ScorePart[] = [
    {
      id: 'spread',
      label: 'Spread',
      max: 30,
      points: round1(spread),
      note: d.top10Pct === null ? 'Holders unknown' : `Top 10 hold ${pct(d.top10Pct)}`,
    },
    {
      id: 'dev',
      label: 'Deployer',
      max: 25,
      points: round1(dev),
      note: d.devPct === null ? 'Deployer unknown' : `Deployer holds ${d.devPct === 0 ? '0%' : pct(d.devPct)}`,
    },
    {
      id: 'holders',
      label: 'Holders',
      max: 20,
      points: round1(holders),
      note: f.holders === null ? 'Unknown' : `${f.holders.toLocaleString('en-US')} holders`,
    },
    {
      id: 'curve',
      label: 'Launch curve',
      max: 15,
      points: curve,
      note: f.curve ? 'Verified on chain' : 'None committed',
    },
    { id: 'burned', label: 'Burned', max: 10, points: round1(burned), note: `${pct(d.burnedPct)} of supply` },
  ];
  return { total: Math.round(parts.reduce((s, p) => s + p.points, 0)), parts };
};

// ── badges ───────────────────────────────────────────────────────────────────

export type Badge = { id: string; label: string; detail: string };

/** Short amount: 316M, 1.2B, 4.5K (whole tokens). */
export const shortAmount = (base: bigint, dec: number): string => {
  const n = Number(base) / 10 ** dec;
  const u: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [v, s] of u) if (n >= v) return `${(n / v).toFixed(n / v >= 100 ? 0 : 1).replace(/\.0$/, '')}${s}`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
};

/** Only what the facts prove. Every badge carries the check behind it. */
export const badges = (f: BoardFacts, d: Derived = derive(f)): Badge[] => {
  const out: Badge[] = [];
  if (f.curve)
    out.push({
      id: 'curve',
      label: 'Launch curve committed',
      detail: 'The deploy transaction commits to a launch curve; the wallet checked its hash.',
    });
  if (d.burned > 0n)
    out.push({
      id: 'burned',
      label: `${shortAmount(d.burned, f.dec)} burned`,
      detail: `${pct(d.burnedPct)} of supply sits at a burn address no one can spend from.`,
    });
  if (d.devPct !== null && d.devPct === 0)
    out.push({
      id: 'dev0',
      label: 'Deployer holds 0%',
      detail: 'The address that received the minted supply no longer holds any of it.',
    });
  else if (d.devPct !== null && d.devPct < 0.05)
    out.push({
      id: 'devlow',
      label: `Deployer holds <${d.devPct < 0.01 ? 1 : 5}%`,
      detail: `The address that received the minted supply holds ${pct(d.devPct)} of circulating supply.`,
    });
  if (d.top10Pct !== null && d.top10Pct <= 0.5)
    out.push({
      id: 'spread',
      label: 'Wide spread',
      detail: `The top 10 holders own ${pct(d.top10Pct)} of circulating supply.`,
    });
  return out;
};

/** "3d", "5h", "12m" from a block count (10-minute blocks). */
export const ageLabel = (blocks: number): string => {
  if (!(blocks >= 0)) return '';
  const mins = blocks * 10;
  if (mins < 60) return `${Math.max(1, mins)}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  if (mins < 60 * 24 * 60) return `${Math.round(mins / 1440)}d`;
  return `${Math.round(mins / 43200)}mo`;
};

/** Market cap label: "$54.2K", "$2.5B"; BSV when the rate is unknown. */
export const capLabel = (sats: number, rate: number): string => {
  const usd = rate > 0 ? (sats / 1e8) * rate : null;
  const v = usd ?? sats / 1e8;
  const u: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  let out = v < 1 ? v.toPrecision(2) : v.toFixed(2);
  for (const [n, sfx] of u)
    if (v >= n) {
      out = `${(v / n).toFixed(v / n >= 100 ? 0 : 1).replace(/\.0$/, '')}${sfx}`;
      break;
    }
  return usd === null ? `${out} BSV` : `$${out}`;
};

// ── market cap (only for a live market) ──────────────────────────────────────

/** 30 days of 10-minute blocks. */
export const MONTH_BLOCKS = 30 * 144;
/** At least this much traded in 30 days (0.05 BSV) before a market cap is shown. */
export const MIN_MONTH_VOLUME_SATS = 5_000_000;
/** Never show a market cap above 1,000,000 BSV (all BSV that will ever exist is 21M). */
export const MAX_CAP_SATS = 1_000_000 * 1e8;

export type CapView =
  | { kind: 'cap'; sats: number }
  /** Too few or too old trades for a market cap: the last price and its age in blocks (null: unknown tip). */
  | { kind: 'thin'; lastSatsPerToken: number; ageBlocks: number | null }
  | { kind: 'none' };

/**
 * Market cap = last trade × circulating, but only when there were at least 3 trades in the last 30 days and the
 * last one is under 30 days old, at least 0.05 BSV traded in those 30 days, and the result is no more than
 * 1,000,000 BSV. One stale or tiny trade can't set a market cap. With no chain tip, the market is "thin".
 */
export const marketCap = (
  trades: readonly { height: number; satsPerToken: number; totalSats?: number }[],
  tip: number,
  circulating: bigint,
  dec: number,
): CapView => {
  if (!trades.length) return { kind: 'none' };
  const last = trades[trades.length - 1];
  if (!(tip > 0)) return { kind: 'thin', lastSatsPerToken: last.satsPerToken, ageBlocks: null };
  const age = Math.max(0, tip - last.height);
  const recent = trades.filter((t) => t.height > tip - MONTH_BLOCKS);
  const volume = recent.reduce((n, t) => n + (t.totalSats ?? 0), 0);
  const thin: CapView = { kind: 'thin', lastSatsPerToken: last.satsPerToken, ageBlocks: age };
  if (recent.length < 3 || age >= MONTH_BLOCKS || volume < MIN_MONTH_VOLUME_SATS) return thin;
  const sats = Math.round((last.satsPerToken * Number(circulating)) / 10 ** dec);
  return sats > MAX_CAP_SATS ? thin : { kind: 'cap', sats };
};

/** Show a 24h % only with at least 2 trades in the window. */
export const showChange = (change: number | null, trades24h: number): boolean => change !== null && trades24h >= 2;

/** Board order: 24h volume, then holders (never market cap). */
export const boardOrder = (
  a: { volume: number; holders: number | null },
  b: { volume: number; holders: number | null },
): number => b.volume - a.volume || (b.holders ?? -1) - (a.holders ?? -1);
