/**
 * What the wallet shows before each PNEE chain action: exact sats and exact PNEEs, and what happens. The sheet
 * (PneeConfirmSheet) renders these lines as they are; tests pin them. Mechanics only, no promises.
 */
import { PNEE } from './script';
import { belowFloor, fmtCents, fmtSats, maxPnee, mintable, ratioPct, valueCents } from './math';

export type ConfirmLine = { label: string; value: string };
export type Confirm = { title: string; lines: ConfirmLine[]; note: string; button: string };

const pnee = (n: bigint) => `${n.toLocaleString('en-US')} PNEE${n === 1n ? '' : 's'} (${fmtCents(n * PNEE.unitCents)})`;
const pct = (r: number | null) => (r == null ? 'no PNEEs minted' : `${r.toLocaleString('en-US')}%`);

export function lockConfirm(sats: bigint, priceCents: bigint): Confirm {
  return {
    title: 'Lock BSV in a PNEE vault',
    lines: [
      { label: 'You lock', value: `${sats.toLocaleString('en-US')} sats (${fmtSats(sats)})` },
      { label: 'Worth now', value: fmtCents(valueCents(sats, priceCents)) },
      { label: 'Can back up to', value: pnee(maxPnee(sats, priceCents)) },
      { label: 'Owner', value: 'a key of this wallet' },
    ],
    note: 'The BSV stays in your vault until you close it by burning the PNEEs it minted. Below 150%, anyone may close it by burning its PNEEs and taking BSV worth them plus 10%; the rest comes back to you.',
    button: 'Lock',
  };
}

export function mintConfirm(sats: bigint, debt: bigint, amount: bigint, priceCents: bigint): Confirm {
  return {
    title: 'Mint PNEEs',
    lines: [
      { label: 'You mint', value: pnee(amount) },
      {
        label: 'Vault holds',
        value: `${sats.toLocaleString('en-US')} sats (${fmtCents(valueCents(sats, priceCents))})`,
      },
      { label: 'PNEEs after', value: pnee(debt + amount) },
      { label: 'Ratio after', value: pct(ratioPct(sats, priceCents, debt + amount)) },
      { label: 'Still mintable after', value: pnee(mintable(sats, priceCents, debt + amount)) },
      { label: 'Price used', value: `${fmtCents(priceCents)} per BSV (3 of 5 signers)` },
    ],
    note: 'To close this vault later you burn exactly the PNEEs it minted.',
    button: 'Mint',
  };
}

export function topUpConfirm(sats: bigint, debt: bigint, addSats: bigint, priceCents: bigint): Confirm {
  return {
    title: 'Add BSV to the vault',
    lines: [
      { label: 'You add', value: `${addSats.toLocaleString('en-US')} sats (${fmtSats(addSats)})` },
      { label: 'Vault after', value: `${(sats + addSats).toLocaleString('en-US')} sats` },
      { label: 'Ratio after', value: pct(ratioPct(sats + addSats, priceCents, debt)) },
    ],
    note: 'Added BSV stays in the vault until it is closed.',
    button: 'Add',
  };
}

export function closeConfirm(sats: bigint, debt: bigint): Confirm {
  return {
    title: 'Close the vault',
    lines: [
      { label: 'You burn', value: pnee(debt) },
      { label: 'You unlock', value: `${sats.toLocaleString('en-US')} sats (${fmtSats(sats)}), less the network fee` },
    ],
    note: 'Burned PNEEs are gone for good. The BSV comes back to this wallet.',
    button: 'Burn and close',
  };
}

export function sendConfirm(amount: bigint, to: string): Confirm {
  return {
    title: 'Send PNEEs',
    lines: [
      { label: 'You send', value: pnee(amount) },
      { label: 'To', value: `${to.slice(0, 10)}…${to.slice(-6)}` },
    ],
    note: 'They accept it in Wallet › PNEEs. Sent PNEEs can’t be called back.',
    button: 'Send',
  };
}

/** Health line on the vault card: ratio, the 150% floor and how old the vault's last price round is. */
export function healthLines(sats: bigint, debt: bigint, priceCents: bigint, lastRoundAgeSec: number): ConfirmLine[] {
  return [
    { label: 'Ratio', value: pct(ratioPct(sats, priceCents, debt)) },
    {
      label: 'Floor',
      value: `${PNEE.liqRatioPct}%${belowFloor(sats, priceCents, debt) ? ' (below: anyone may close it)' : ''}`,
    },
    { label: 'Last price round', value: `${Math.round(lastRoundAgeSec / 60)} min ago` },
  ];
}
