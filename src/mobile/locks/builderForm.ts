/**
 * New Lock builder form rules. Locks are irreversible, so the builder starts
 * with every amount EMPTY (placeholders only) and nothing can be reviewed or
 * confirmed until the user has typed real values.
 */

export const PREVIEW_LABEL = 'This lock will take';
export const PREVIEW_NOTE = 'Preview — nothing is locked yet';

/** Amount fields start empty; placeholders show an example instead. */
export const EMPTY_AMOUNTS = { amountBsv: '', usdPer: '', bsvPer: '', pct: '', count: '' } as const;

export const PLACEHOLDERS = {
  amountBsv: 'e.g. 0.1',
  usdPer: 'e.g. 10',
  bsvPer: 'e.g. 0.01',
  pct: 'e.g. 1',
  count: 'e.g. 30',
} as const;

export interface BuilderValues {
  kind: 'gradual' | 'once';
  gmode: 'usd' | 'bsv' | 'percent';
  until: 'count' | 'end';
  amountBsv: string;
  usdPer: string;
  bsvPer: string;
  pct: string;
  count: string;
}

const positive = (s: string) => s.trim() !== '' && Number.isFinite(Number(s)) && Number(s) > 0;

/** True only when every amount the current mode needs has been entered. */
export function valuesEntered(v: BuilderValues): boolean {
  if (v.kind === 'once') return positive(v.amountBsv);
  if (v.gmode === 'percent') return positive(v.amountBsv) && positive(v.pct);
  const per = v.gmode === 'usd' ? positive(v.usdPer) : positive(v.bsvPer);
  return per && (v.until === 'end' || positive(v.count));
}
