import { useSyncExternalStore } from 'react';
import { formatFiat, type Fx } from '../../utils/displayCurrency';
import { cardBsv, loadCardUnit, saveCardUnit, type CardUnit } from './walletCardText';

/**
 * What a balance card is worth (owner, 15 Oct 2026): every card shows money, in the display currency or in BSV,
 * never a raw token count. A card's value is kept in two parts so the sum is exact in either unit: `usd` for
 * dollar-pegged amounts (MNEE, PNEEs, bCredits) and `sats` for amounts priced in BSV (tokens at their last sale).
 * Holdings with no price add nothing and are counted in `unpriced`, so the card says "N unpriced" instead of guessing.
 */
export type CardValue = { usd: number; sats: number; unpriced: number };

export const EMPTY_VALUE: CardValue = { usd: 0, sats: 0, unpriced: 0 };

/** One holding: an amount in whole units, priced in US$ each (pegged) or in sats each (last sale), or neither. */
export type PricedHolding = { amount: number; usdEach?: number | null; satsEach?: number | null };

const pos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Sums holdings into one card value. Zero amounts are ignored (they are neither worth anything nor unpriced). */
export const sumHoldings = (holdings: readonly PricedHolding[]): CardValue => {
  const v = { usd: 0, sats: 0, unpriced: 0 };
  for (const h of holdings) {
    if (!pos(h.amount)) continue;
    if (pos(h.usdEach)) v.usd += h.amount * h.usdEach;
    else if (pos(h.satsEach)) v.sats += h.amount * h.satsEach;
    else v.unpriced += 1;
  }
  return v;
};

/**
 * The card's total in US$ and in sats, at `usdPerBsv`. A part that needs the BSV price to convert makes that
 * total unknown (null) while there is no price; the other total is still exact.
 */
export const cardTotals = (v: CardValue, usdPerBsv: number): { usd: number | null; sats: number | null } => {
  const rate = pos(usdPerBsv) ? usdPerBsv : 0;
  return {
    usd: v.sats > 0 && !rate ? null : v.usd + (rate ? (v.sats * rate) / 1e8 : 0),
    sats: v.usd > 0 && !rate ? null : v.sats + (rate ? (v.usd / rate) * 1e8 : 0),
  };
};

/** The card's main line: "$1.40" / "£1.10" in the display currency, or "BSV 0.0001"; "—" when it cannot be known. */
export const cardValueText = (v: CardValue, unit: CardUnit, usdPerBsv: number, fx: Fx): string => {
  const t = cardTotals(v, usdPerBsv);
  if (unit === 'bsv') return t.sats === null ? '—' : cardBsv(t.sats);
  return t.usd === null ? '—' : formatFiat(t.usd, fx, { small: true });
};

/** "2 unpriced" under the amount, or '' when every holding has a price. */
export const unpricedNote = (v: CardValue): string => (v.unpriced > 0 ? `${v.unpriced} unpriced` : '');

/**
 * A balance in its own units (owner, 16 Oct 2026): every token card shows this line directly under its value,
 * e.g. "1,000 SCAM". Thousand separators, at most `decimals` places (trailing zeros dropped), and compact notation
 * from a million up ("1.2M", "3.4B", "5T"). A count of 1 drops a plural "s" ("1 PNEE", "3 PNEEs").
 */
export const formatTokenAmount = (amount: number, symbol: string, decimals = 0): string => {
  const n = Number.isFinite(amount) ? amount : 0;
  const abs = Math.abs(n);
  const dec = Math.max(0, Math.min(8, Math.floor(decimals)));
  let num: string;
  if (abs >= 1e6) {
    const steps: [number, string][] = [
      [1e12, 'T'],
      [1e9, 'B'],
      [1e6, 'M'],
    ];
    const [div, suffix] = steps.find(([d]) => abs >= d) ?? [1e6, 'M'];
    let scaled = Math.round((abs / div) * 10) / 10;
    let sfx = suffix;
    if (scaled >= 1000 && sfx !== 'T') {
      scaled = 1;
      sfx = sfx === 'M' ? 'B' : 'T';
    }
    num = `${n < 0 ? '-' : ''}${scaled.toLocaleString('en-US', { maximumFractionDigits: 1 })}${sfx}`;
  } else {
    num = n.toLocaleString('en-US', { maximumFractionDigits: dec, minimumFractionDigits: 0 });
  }
  const sym = abs === 1 && /[A-Za-z]s$/.test(symbol) && symbol.length > 2 ? symbol.slice(0, -1) : symbol;
  return sym ? `${num} ${sym}` : num;
};

/** True when a card has nothing priced: its big line is then the token amount and "No price yet" sits under it. */
export const hasNoPrice = (v: CardValue): boolean => v.usd <= 0 && v.sats <= 0 && v.unpriced > 0;

/** A bCredit is 1p: its US$ value at `usdPerGbp` (null while no GBP rate is known). */
export const creditsUsd = (credits: number, usdPerGbp: number | null): number | null =>
  credits > 0 ? (pos(usdPerGbp) ? (credits / 100) * usdPerGbp : null) : 0;

// The shared fiat/BSV switch (the BSV card's own setting, bw-card-unit): flipping it on any card flips them all.
const unitSubs = new Set<() => void>();
let unitNow: CardUnit | null = null;
export const getCardUnit = (): CardUnit => (unitNow ??= loadCardUnit());
export const setCardUnit = (u: CardUnit) => {
  unitNow = u;
  saveCardUnit(u);
  unitSubs.forEach((f) => f());
};
const subscribeUnit = (f: () => void) => {
  unitSubs.add(f);
  return () => {
    unitSubs.delete(f);
  };
};
export const useCardUnit = (): CardUnit => useSyncExternalStore(subscribeUnit, getCardUnit, getCardUnit);

// Held BSV-21 tokens (id + whole units), published by the screen that already reads them (DefaultTokenCards).
export type Held = { id: string; amount: number };
let held: Held[] | null = null;
const heldSubs = new Set<() => void>();
export const publishHeldTokens = (rows: Held[]) => {
  held = rows;
  heldSubs.forEach((f) => f());
};
const getHeld = () => held;
export const useHeldTokens = (): Held[] | null =>
  useSyncExternalStore(
    (f) => {
      heldSubs.add(f);
      return () => {
        heldSubs.delete(f);
      };
    },
    getHeld,
    getHeld,
  );
