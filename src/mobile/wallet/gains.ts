/**
 * Realised gains and losses (History › Gains, docs/HISTORY-V2-PLAN.md §4). Pure, no network, unit-tested with
 * worked examples (gains.test.ts).
 *
 *  - 'hmrc' (UK, the default): HMRC share matching for cryptoassets (CRYPTO22200 on; TCGA 1992 s104–s106A).
 *    For each asset, disposals and acquisitions on the same day are each treated as one. A disposal is matched
 *    1. with acquisitions on the same day, then
 *    2. with acquisitions in the 30 days after it (bed and breakfasting), earliest first, earlier disposals first,
 *    3. with the section 104 pool (all other holdings, at average cost).
 *  - 'fifo' (other countries): oldest lots first.
 * Days are the caller's (London calendar day for the UK). Amounts are fiat and already include allowable fees.
 * Anything that cannot be matched is reported with zero cost and flagged, never hidden.
 */

export type Method = 'hmrc' | 'fifo';

export type LedgerEvent = {
  /** Asset key: 'BSV', 'token:<id>', 'nft:<outpoint>'. */
  asset: string;
  /** Name to show (e.g. $NINJAPUNKGIRLS). */
  label: string;
  time: number;
  day: string;
  side: 'acquire' | 'dispose';
  /** In the asset's base unit (sats for BSV, raw token units, 1 for an NFT). */
  qty: number;
  /** Cost (acquire) or proceeds (dispose), fiat. */
  fiat: number;
  txid: string;
  flags?: string[];
};

export type MatchRule = 'same-day' | 'bed-and-breakfast' | 's104' | 'fifo' | 'unmatched';
export type Match = { rule: MatchRule; qty: number; cost: number; acquiredOn?: string };

export type Disposal = {
  asset: string;
  label: string;
  day: string;
  time: number;
  txids: string[];
  qty: number;
  proceeds: number;
  cost: number;
  gain: number;
  matches: Match[];
  flags: string[];
};

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type DayBucket = { day: string; time: number; qty: number; fiat: number; txids: string[]; flags: string[] };

const bucket = (events: LedgerEvent[]) => {
  const m = new Map<string, DayBucket>();
  for (const e of events) {
    const b = m.get(e.day) ?? { day: e.day, time: e.time, qty: 0, fiat: 0, txids: [], flags: [] };
    b.qty += e.qty;
    b.fiat += e.fiat;
    b.time = Math.min(b.time, e.time);
    if (!b.txids.includes(e.txid)) b.txids.push(e.txid);
    for (const f of e.flags ?? []) if (!b.flags.includes(f)) b.flags.push(f);
    m.set(e.day, b);
  }
  return [...m.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
};

/** One asset under the HMRC rules. */
const hmrcAsset = (events: LedgerEvent[]): Disposal[] => {
  const acq = bucket(events.filter((e) => e.side === 'acquire')).map((a) => ({ ...a, left: a.qty }));
  const disp = bucket(events.filter((e) => e.side === 'dispose')).map((d) => ({
    ...d,
    left: d.qty,
    matches: [] as Match[],
  }));
  const acqByDay = new Map(acq.map((a) => [a.day, a]));
  const take = (a: (typeof acq)[number], want: number) => {
    const q = Math.min(want, a.left);
    const cost = a.qty > 0 ? (a.fiat * q) / a.qty : 0;
    a.left -= q;
    return { q, cost };
  };
  // 1. Same day, for every disposal day first (it takes priority over any bed-and-breakfast match).
  for (const d of disp) {
    const a = acqByDay.get(d.day);
    if (!a || a.left <= 0) continue;
    const { q, cost } = take(a, d.left);
    if (q > 0) {
      d.matches.push({ rule: 'same-day', qty: q, cost, acquiredOn: a.day });
      d.left -= q;
    }
  }
  // 2. Bed and breakfasting: acquisitions in the next 30 days, earliest disposal first, earliest acquisition first.
  for (const d of disp) {
    if (d.left <= 0) continue;
    const end = addDays(d.day, 30);
    for (const a of acq) {
      if (d.left <= 0) break;
      if (a.day <= d.day || a.day > end || a.left <= 0) continue;
      const { q, cost } = take(a, d.left);
      if (q > 0) {
        d.matches.push({ rule: 'bed-and-breakfast', qty: q, cost, acquiredOn: a.day });
        d.left -= q;
      }
    }
  }
  // 3. Section 104 pool, walking the days in order.
  let poolQty = 0;
  let poolCost = 0;
  const days = [...new Set([...acq.map((a) => a.day), ...disp.map((d) => d.day)])].sort();
  const dispByDay = new Map(disp.map((d) => [d.day, d]));
  for (const day of days) {
    const d = dispByDay.get(day);
    if (d && d.left > 0) {
      const q = Math.min(d.left, poolQty);
      if (q > 0) {
        const cost = (poolCost * q) / poolQty;
        d.matches.push({ rule: 's104', qty: q, cost });
        poolQty -= q;
        poolCost -= cost;
        d.left -= q;
      }
      if (d.left > 0) {
        d.matches.push({ rule: 'unmatched', qty: d.left, cost: 0 });
        if (!d.flags.includes('no matching acquisition: cost taken as 0'))
          d.flags.push('no matching acquisition: cost taken as 0');
        d.left = 0;
      }
    }
    const a = acqByDay.get(day);
    if (a && a.left > 0) {
      poolQty += a.left;
      poolCost += a.qty > 0 ? (a.fiat * a.left) / a.qty : 0;
      a.left = 0;
    }
  }
  return disp.map((d) => toDisposal(events[0], d, d.matches));
};

/** One asset, first in first out. */
const fifoAsset = (events: LedgerEvent[]): Disposal[] => {
  const sorted = [...events].sort((a, b) => a.time - b.time || (a.side === b.side ? 0 : a.side === 'acquire' ? -1 : 1));
  const lots: { day: string; qty: number; unit: number }[] = [];
  const out: Disposal[] = [];
  for (const e of sorted) {
    if (e.side === 'acquire') {
      if (e.qty > 0) lots.push({ day: e.day, qty: e.qty, unit: e.fiat / e.qty });
      continue;
    }
    let left = e.qty;
    const matches: Match[] = [];
    const flags = [...(e.flags ?? [])];
    while (left > 0 && lots.length) {
      const lot = lots[0];
      const q = Math.min(left, lot.qty);
      matches.push({ rule: 'fifo', qty: q, cost: q * lot.unit, acquiredOn: lot.day });
      lot.qty -= q;
      left -= q;
      if (lot.qty <= 0) lots.shift();
    }
    if (left > 0) {
      matches.push({ rule: 'unmatched', qty: left, cost: 0 });
      flags.push('no matching acquisition: cost taken as 0');
    }
    out.push(toDisposal(e, { day: e.day, time: e.time, qty: e.qty, fiat: e.fiat, txids: [e.txid], flags }, matches));
  }
  return out;
};

const toDisposal = (e: LedgerEvent, d: DayBucket, matches: Match[]): Disposal => {
  const cost = matches.reduce((s, m) => s + m.cost, 0);
  return {
    asset: e.asset,
    label: e.label,
    day: d.day,
    time: d.time,
    txids: d.txids,
    qty: d.qty,
    proceeds: d.fiat,
    cost,
    gain: d.fiat - cost,
    matches,
    flags: d.flags,
  };
};

/** Every disposal, per asset, under the chosen method. */
export const computeGains = (events: LedgerEvent[], method: Method): Disposal[] => {
  const byAsset = new Map<string, LedgerEvent[]>();
  for (const e of events) byAsset.set(e.asset, [...(byAsset.get(e.asset) ?? []), e]);
  const out: Disposal[] = [];
  for (const list of byAsset.values()) out.push(...(method === 'hmrc' ? hmrcAsset(list) : fifoAsset(list)));
  return out.sort((a, b) => a.time - b.time);
};

// ─── Tax years and totals ────────────────────────────────────────────────────

/** UK tax year (6 April to 5 April), e.g. '2026-27'; elsewhere the calendar year. */
export const taxYearOf = (day: string, uk: boolean) => {
  const y = Number(day.slice(0, 4));
  if (!uk) return String(y);
  const start = day.slice(5) >= '04-06' ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};

export type AssetTotal = {
  asset: string;
  label: string;
  disposals: number;
  proceeds: number;
  cost: number;
  gains: number;
  losses: number;
  net: number;
};

export const totalsByAsset = (ds: Disposal[]): AssetTotal[] => {
  const m = new Map<string, AssetTotal>();
  for (const d of ds) {
    const t = m.get(d.asset) ?? {
      asset: d.asset,
      label: d.label,
      disposals: 0,
      proceeds: 0,
      cost: 0,
      gains: 0,
      losses: 0,
      net: 0,
    };
    t.disposals += 1;
    t.proceeds += d.proceeds;
    t.cost += d.cost;
    if (d.gain >= 0) t.gains += d.gain;
    else t.losses += -d.gain;
    t.net += d.gain;
    m.set(d.asset, t);
  }
  return [...m.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
};

/** Shown until the owner has checked Gains against real data (owner, 8 Oct 2026). Remove only on his say-so. */
export const GAINS_BETA = 'Beta: figures may be incomplete. Check against your own records.';

export const NOT_TAX_ADVICE =
  'This is a record of your wallet activity to help you or your accountant. It is not tax advice. Check the figures, and ask a tax adviser if you’re unsure.';

/** London calendar day (UK rules) or UTC day. */
export const dayIn = (ms: number, uk: boolean) =>
  uk
    ? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/London',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(ms)
    : new Date(ms).toISOString().slice(0, 10);
