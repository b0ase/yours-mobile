/**
 * PNEE vault arithmetic, the same integer maths the contract runs (bwalletx-bond BondVault), for what the wallet
 * shows before it asks for a signature. 1 PNEE = 1 cent. Prices are integer cents per BSV.
 */
import { PNEE } from './script';

export const SATS_PER_BSV = 100_000_000n;

/** Collateral value in cents at `priceCents` (floor, as on-chain). */
export const valueCents = (sats: bigint, priceCents: bigint) => (sats * priceCents) / SATS_PER_BSV;

/** Most PNEEs the vault may have outstanding at this price: value × 100 ≥ debt × unit × minRatio. */
export const maxPnee = (sats: bigint, priceCents: bigint) =>
  (valueCents(sats, priceCents) * 100n) / (PNEE.unitCents * PNEE.minRatioPct);

/** PNEEs that can still be minted now (0 if the vault is too small or already at 10x). */
export function mintable(sats: bigint, priceCents: bigint, debt: bigint): bigint {
  if (valueCents(sats, priceCents) < PNEE.minVaultCents) return 0n;
  const room = maxPnee(sats, priceCents) - debt;
  return room > 0n ? room : 0n;
}

/** Would minting `amount` more pass the contract's checks? */
export const mintOk = (sats: bigint, priceCents: bigint, debt: bigint, amount: bigint) =>
  amount > 0n && amount <= mintable(sats, priceCents, debt);

/** Ratio in percent (floor), or null with no PNEEs outstanding. */
export const ratioPct = (sats: bigint, priceCents: bigint, debt: bigint): number | null =>
  debt === 0n ? null : Number((valueCents(sats, priceCents) * 100n) / (debt * PNEE.unitCents));

/** Below the floor, anyone may close the vault: value × 100 < debt × unit × 150. */
export const belowFloor = (sats: bigint, priceCents: bigint, debt: bigint) =>
  debt > 0n && valueCents(sats, priceCents) * 100n < debt * PNEE.unitCents * PNEE.liqRatioPct;

/** BSV price (cents) at which the vault reaches the floor, or null with no PNEEs. */
export function floorPriceCents(sats: bigint, debt: bigint): bigint | null {
  if (debt === 0n || sats === 0n) return null;
  // smallest price p with value(p)*100 >= debt*unit*150 → p = ceil(debt*unit*150*1e8 / (100*sats))
  const num = debt * PNEE.unitCents * PNEE.liqRatioPct * SATS_PER_BSV;
  const den = 100n * sats;
  return (num + den - 1n) / den;
}

/** Sats someone closing a vault below the floor takes: BSV worth the PNEEs plus the 10% discount. */
export const closerSats = (debt: bigint, priceCents: bigint) =>
  (debt * PNEE.unitCents * (100n + PNEE.liqDiscountPct) * SATS_PER_BSV) / (100n * priceCents);

export type Health = 'empty' | 'ok' | 'near' | 'below';
/** Vault health: 'near' within 50 points above the floor (under 200%). */
export function health(sats: bigint, priceCents: bigint, debt: bigint): Health {
  if (debt === 0n) return 'empty';
  if (belowFloor(sats, priceCents, debt)) return 'below';
  const r = ratioPct(sats, priceCents, debt)!;
  return r < Number(PNEE.liqRatioPct) + 50 ? 'near' : 'ok';
}

/** "$12.34" from cents. */
export const fmtCents = (c: bigint | number) => {
  const n = typeof c === 'bigint' ? c : BigInt(Math.round(c));
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? '-' : ''}$${(a / 100n).toLocaleString('en-US')}.${(a % 100n).toString().padStart(2, '0')}`;
};

/** "1.23456789 BSV" from sats, exact. */
export const fmtSats = (s: bigint | number) => {
  const n = typeof s === 'bigint' ? s : BigInt(s);
  return `${n / SATS_PER_BSV}.${(n % SATS_PER_BSV).toString().padStart(8, '0')} BSV`;
};

/** The live line on the lock sheet. */
export const backsUpToLine = (sats: bigint, priceCents: bigint) =>
  `Your ${fmtCents(valueCents(sats, priceCents))} of BSV can back up to ${fmtCents(maxPnee(sats, priceCents) * PNEE.unitCents)} of PNEEs`;

/** Price age in words: "12 s", "4 min", "2 h". */
export const ageText = (sec: number) =>
  sec < 90
    ? `${Math.max(0, Math.round(sec))} s`
    : sec < 5400
      ? `${Math.round(sec / 60)} min`
      : `${Math.round(sec / 3600)} h`;
