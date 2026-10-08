/**
 * New Lock templates. A template only fills the builder when tapped (the builder still starts empty),
 * and once one is used Review stays disabled until the user ticks "I have checked these values".
 * Templates never skip the 0.01 BSV caution: Review applies needsSizeCheck to whatever is entered.
 *
 * Copy rule: a lock releases the user's own BSV. No interest, yield or returns wording.
 */
import type { CurveKind } from './curves';
import type { Frequency } from './schedule';

export const TEMPLATE_NOTE = 'Template: check the values';
export const TEMPLATE_CONFIRM = 'I have checked these values';

export type TemplateValues = {
  label: string;
  kind: 'gradual' | 'once';
  gmode?: 'usd' | 'bsv' | 'percent';
  /** Days from today: the unlock date (once) or the first payout (gradual). */
  startInDays?: number;
  /** Exact unlock date (once), overriding startInDays. */
  unlockOn?: Date;
  frequency?: Frequency;
  customDays?: number;
  count?: number;
  amountBsv?: string;
  usdPer?: string;
  bsvPer?: string;
  curve?: { kind: CurveKind; steep?: string; custom?: string };
};

export type LockTemplate = { id: string; name: string; blurb: string; values: (now: Date) => TemplateValues };

/** The next `day`/`month` (1-based month) strictly after `now`, minus `before` days. */
export function nextDeadline(now: Date, month: number, day: number, before = 3): Date {
  let d = new Date(now.getFullYear(), month - 1, day, 12);
  d.setDate(d.getDate() - before);
  if (d.getTime() <= now.getTime()) {
    d = new Date(now.getFullYear() + 1, month - 1, day, 12);
    d.setDate(d.getDate() - before);
  }
  return d;
}

export const TEMPLATES: LockTemplate[] = [
  {
    id: 'pension',
    name: 'Pension',
    blurb: 'Locked until a date, then monthly. Example: $100 a month for 5 years, from 3 years out.',
    values: () => ({
      label: 'Pension',
      kind: 'gradual',
      gmode: 'usd',
      frequency: 'monthly',
      startInDays: 3 * 365,
      count: 60,
      usdPer: '100',
    }),
  },
  {
    id: 'savings',
    name: 'Savings goal',
    blurb: 'One unlock date, e.g. a holiday fund or a house deposit.',
    values: () => ({ label: 'Holiday fund', kind: 'once', startInDays: 180, amountBsv: '0.005' }),
  },
  {
    id: 'rainy',
    name: 'Rainy-day fund',
    blurb: 'A fixed amount released every month.',
    values: () => ({
      label: 'Rainy-day fund',
      kind: 'gradual',
      gmode: 'bsv',
      frequency: 'monthly',
      startInDays: 30,
      count: 12,
      bsvPer: '0.0005',
    }),
  },
  {
    id: 'allowance',
    name: 'Allowance',
    blurb: 'Small weekly payouts, like pocket money.',
    values: () => ({
      label: 'Allowance',
      kind: 'gradual',
      gmode: 'bsv',
      frequency: 'weekly',
      startInDays: 7,
      count: 12,
      bsvPer: '0.0002',
    }),
  },
  {
    id: 'coupons',
    name: 'Coupons',
    blurb: 'Your own BSV released in regular coupons, with the rest at the end.',
    values: () => ({
      label: 'Coupons',
      kind: 'gradual',
      gmode: 'bsv',
      frequency: 'custom',
      customDays: 91,
      startInDays: 91,
      count: 8,
      bsvPer: '0.001',
      curve: { kind: 'custom', custom: '5, 5, 5, 5, 5, 5, 5, 65' },
    }),
  },
  {
    id: 'tax',
    name: 'Tax pot',
    blurb: 'Unlocks just before a tax deadline you choose (example: 31 January, UK self-assessment).',
    values: (now) => ({ label: 'Tax pot', kind: 'once', unlockOn: nextDeadline(now, 1, 31), amountBsv: '0.005' }),
  },
  {
    id: 'salary',
    name: 'Salary',
    blurb: 'A fixed dollar target every month.',
    values: () => ({
      label: 'Salary',
      kind: 'gradual',
      gmode: 'usd',
      frequency: 'monthly',
      startInDays: 30,
      count: 12,
      usdPer: '1',
    }),
  },
  {
    id: 'spend-down',
    name: 'Spend-down',
    blurb: 'More early, then less: front-loaded monthly payouts.',
    values: () => ({
      label: 'Spend-down',
      kind: 'gradual',
      gmode: 'bsv',
      frequency: 'monthly',
      startInDays: 30,
      count: 12,
      bsvPer: '0.0005',
      curve: { kind: 'front', steep: '3' },
    }),
  },
];

/** Words a template must never use: locks release the user's own coins, nothing is earned. */
export const FORBIDDEN_WORDS =
  /\b(interest|yield|yields|return|returns|apy|apr|profit|earn|earns|earning|dividend|gains?)\b/i;

/** Review is allowed only with real values entered and, after a template, an explicit check. */
export const reviewAllowed = (entered: boolean, templateUsed: boolean, checked: boolean) =>
  entered && (!templateUsed || checked);
