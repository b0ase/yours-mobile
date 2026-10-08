/**
 * History rows → acquisitions and disposals for gains.ts, and the accountant CSV. Pure.
 *
 * BSV is an asset too: paying BSV for a token disposes of the BSV and acquires the token; selling a token
 * disposes of it and acquires BSV. Rules (docs/HISTORY-V2-PLAN.md §4):
 *  - BSV received: acquired at market value on the day (unless marked "own wallet").
 *  - BSV sent (and fees): disposed of at market value on the day.
 *  - Token / NFT bought: cost = BSV paid + fee; sold: proceeds = BSV received.
 *  - Token / NFT received (airdrop, gift): cost 0 unless the user enters one. Sent away: proceeds 0 unless entered.
 *  - Mint: cost = BSV spent on it.  Listing, cancelling, own-wallet transfers: not disposals.
 */
import { csvField, BOM, type HistoryRow } from './txHistory';
import { GAINS_BETA, NOT_TAX_ADVICE, taxYearOf, type Disposal, type LedgerEvent } from './gains';

export type Overrides = {
  /** txids the user marked as a move between their own wallets. */
  ownWallet: string[];
  /** `${txid}|${assetKey}` → fiat cost (in) or value (out) the user entered. */
  lotValue: Record<string, number>;
};
export const EMPTY_OVERRIDES: Overrides = { ownWallet: [], lotValue: {} };

const OVR_KEY = 'bwx.gains.overrides';
export const loadOverrides = (): Overrides => {
  try {
    const v = JSON.parse(localStorage.getItem(OVR_KEY) ?? 'null') as Partial<Overrides> | null;
    return {
      ownWallet: Array.isArray(v?.ownWallet) ? v.ownWallet.filter((x) => typeof x === 'string') : [],
      lotValue: v?.lotValue && typeof v.lotValue === 'object' ? (v.lotValue as Record<string, number>) : {},
    };
  } catch {
    return { ...EMPTY_OVERRIDES };
  }
};
export const saveOverrides = (o: Overrides) => {
  try {
    localStorage.setItem(OVR_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable */
  }
};

export const assetKeyOf = (r: HistoryRow) => (r.asset ? `${r.asset.kind}:${r.asset.id}` : 'BSV');
const labelOf = (r: HistoryRow) =>
  !r.asset
    ? 'BSV'
    : r.asset.kind === 'nft'
      ? `NFT ${r.asset.id.slice(0, 8)}…${r.asset.id.slice(-4)}`
      : (r.asset.symbol ?? `${r.asset.id.slice(0, 8)}…`);

/**
 * Build the ledger. `fiatPerBsv(row)` gives the price on the row's day (undefined when unknown); `dayOf` the
 * calendar day used for matching.
 */
export const buildLedger = (
  rows: HistoryRow[],
  fiatPerBsv: (r: HistoryRow) => number | undefined,
  dayOf: (ms: number) => string,
  ovr: Overrides = EMPTY_OVERRIDES,
): { events: LedgerEvent[]; warnings: { txid: string; text: string }[] } => {
  const events: LedgerEvent[] = [];
  const warnings: { txid: string; text: string }[] = [];
  const own = new Set(ovr.ownWallet);
  for (const r of [...rows].sort((a, b) => a.time - b.time)) {
    if (own.has(r.txid)) continue;
    const price = fiatPerBsv(r);
    const flags: string[] = [];
    if (price === undefined) flags.push('no price for the day: valued at 0');
    else if (r.usdRateIsCurrent) flags.push('priced at the current rate');
    const val = (sats: number) => ((price ?? 0) * sats) / 1e8;
    const day = dayOf(r.time);
    const ev = (
      asset: string,
      label: string,
      side: LedgerEvent['side'],
      qty: number,
      fiat: number,
      extra: string[] = [],
    ) => {
      if (qty > 0)
        events.push({ asset, label, time: r.time, day, side, qty, fiat, txid: r.txid, flags: [...flags, ...extra] });
    };
    const bsv = (side: LedgerEvent['side'], sats: number) => ev('BSV', 'BSV', side, sats, val(sats));
    const key = assetKeyOf(r);
    const qty = r.asset ? (r.asset.kind === 'nft' ? 1 : Number(r.asset.qty) / 10 ** (r.asset.dec ?? 0)) : 0;
    const assetOk = !!r.asset && r.asset.id !== '' && Number.isFinite(qty) && qty > 0;
    const entered = ovr.lotValue[`${r.txid}|${key}`];
    const spent = Math.max(0, -r.amountSats) + r.feeSats;

    if (r.asset && !assetOk && ['buy', 'sell', 'mint', 'transfer-in', 'transfer-out'].includes(r.type ?? ''))
      warnings.push({ txid: r.txid, text: `${labelOf(r)}: quantity or token unknown, left out` });

    switch (assetOk ? r.type : undefined) {
      case 'buy':
      case 'mint':
        ev(key, labelOf(r), 'acquire', qty, val(spent));
        bsv('dispose', spent);
        continue;
      case 'sell':
        ev(key, labelOf(r), 'dispose', qty, val(Math.max(0, r.amountSats)));
        bsv('acquire', Math.max(0, r.amountSats));
        bsv('dispose', r.feeSats);
        continue;
      case 'transfer-in':
        ev(
          key,
          labelOf(r),
          'acquire',
          qty,
          entered ?? 0,
          entered === undefined ? ['received (airdrop / gift): cost 0'] : [],
        );
        bsv('dispose', r.feeSats);
        continue;
      case 'transfer-out':
        ev(
          key,
          labelOf(r),
          'dispose',
          qty,
          entered ?? 0,
          entered === undefined ? ['sent away: value 0 unless entered'] : [],
        );
        bsv('dispose', spent);
        continue;
      default:
        break;
    }
    // Plain BSV (payments, games, subscriptions, apps, tips, listings, cancels, self).
    if (r.amountSats > 0) {
      if (entered !== undefined) ev('BSV', 'BSV', 'acquire', r.amountSats, entered);
      else bsv('acquire', r.amountSats);
      bsv('dispose', r.feeSats);
    } else bsv('dispose', spent);
  }
  return { events, warnings };
};

// ─── Accountant CSV ──────────────────────────────────────────────────────────

const qtyText = (asset: string, qty: number) => (asset === 'BSV' ? (qty / 1e8).toFixed(8) : String(qty));
const money = (n: number) => n.toFixed(2);

export const GAINS_CSV_COLUMNS = [
  'tax_year',
  'date_of_disposal',
  'asset',
  'asset_id',
  'quantity',
  'currency',
  'disposal_proceeds',
  'allowable_cost',
  'gain_or_loss',
  'matching',
  'acquisition_dates',
  'txids',
  'notes',
] as const;

export const gainsCsv = (ds: Disposal[], opts: { uk: boolean; currency: string; method: string }) => {
  const lines = [csvField(GAINS_BETA), GAINS_CSV_COLUMNS.join(',')];
  for (const d of ds) {
    const rules = [...new Set(d.matches.map((m) => m.rule))].join('+');
    const acquired = [...new Set(d.matches.map((m) => m.acquiredOn).filter(Boolean))].join(' ');
    lines.push(
      [
        taxYearOf(d.day, opts.uk),
        d.day,
        d.label,
        d.asset,
        qtyText(d.asset, d.qty),
        opts.currency,
        money(d.proceeds),
        money(d.cost),
        money(d.gain),
        rules,
        acquired,
        d.txids.join(' '),
        d.flags.join('; '),
      ]
        .map(csvField)
        .join(','),
    );
  }
  lines.push('');
  lines.push(csvField(`Method: ${opts.method}. ${NOT_TAX_ADVICE}`));
  return BOM + lines.join('\r\n') + '\r\n';
};
