// bShares: allotment board minute + overpayment term. Pure text, no network, no keys.
//
// KEEP IN STEP with bit-sign src/lib/share-placement-minute.ts (the server generates the minute that is
// stored with the allotment; the wallet uses this copy to preview it for the director before approval).
//
// The minute follows the round-2026-08 Board_Minute_*_NDS documents of The Bitcoin Corporation Ltd:
// "MINUTE OF A DECISION OF THE SOLE DIRECTOR made under section 248", reference BCORP-BM-<date>-<NNN>,
// numbered sections, and an excess-as-premium paragraph worded like BCORP-BM-2026-10-03-010 §4.
// Every number comes from the allotment and the register passed in. Nothing here is a cap-table figure.

/** The term every future offer carries (owner decision 14 Oct 2026). */
export const OVERPAYMENT_TERM =
  'Any excess is refunded in BSV within 14 days, unless you choose to have it treated as share premium.';

/** Days the Company has to refund an excess the investor asked back. */
export const EXCESS_REFUND_DAYS = 14;

export type ExcessChoice = 'refund' | 'premium';
export const EXCESS_CHOICES: readonly ExcessChoice[] = ['refund', 'premium'];
export const isExcessChoice = (v: unknown): v is ExcessChoice => v === 'refund' || v === 'premium';

export type MinuteInput = {
  /**
   * The company, from its bShares company row (never env). refPrefix is the minute reference prefix
   * (default 'BCORP'; other companies use their ticker upper-cased). authorisedArticle names the article
   * that sets the authorised ceiling (default 'Article 19.1', bCorp's); null omits the article citation.
   */
  company: {
    name: string;
    number: string;
    refPrefix?: string;
    authorisedArticle?: string | null;
    recordsArticle?: string | null;
  };
  /** Every serving director (from company_directors). One director → sole-director minute. Defaults to [director]. */
  directors?: { name: string; handle: string }[];
  /** The company's treasury multisig (default 2-of-3, keys held by the director). */
  treasury?: { m: number; n: number };
  /** Allotment date, YYYY-MM-DD. */
  date: string;
  /** Next minute number in the company's sequence (the NNN in BCORP-BM-<date>-NNN). */
  minuteNumber: number;
  director: { name: string; handle: string };
  allottee: { name: string; handle: string };
  offer: {
    id: string;
    offeredAt: string; // YYYY-MM-DD
    closesAt: string; // YYYY-MM-DD
    shares: number;
    pricePence: number;
    gbpPerBsvPence: number;
    rateDate: string;
    sats: number;
    lockMonths: number;
  };
  payment: { txid: string; paidSats: number; excessChoice: ExcessChoice | null };
  register: {
    nominalNanoPounds: number;
    certificate: string;
    holdingBefore: number;
    issuedBefore: number;
    /** Authorised ceiling from the articles (null = none). */
    authorised: number | null;
  };
};

export type Minute = { ref: string; title: string; text: string };

const n = (v: number) => v.toLocaleString('en-GB');
const bsvText = (sats: number) => `${(sats / 1e8).toLocaleString('en-GB', { maximumFractionDigits: 8 })} BSV`;
const gbp = (pence: number) =>
  `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** £ value of `sats` at `gbpPerBsvPence`, in pence, rounded to the penny. */
const penceFor = (sats: number, gbpPerBsvPence: number) => Math.round((sats * gbpPerBsvPence) / 1e8);
/** £ to 6 dp from nano-pounds (nominal values are fractions of a penny). */
const nominal = (nano: number) =>
  `£${(nano / 1e9).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
function longDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
function addDays(iso: string, days: number): string {
  const t = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
function addMonths(iso: string, months: number): string {
  const t = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  t.setUTCMonth(t.getUTCMonth() + months);
  return t.toISOString().slice(0, 10);
}

export const minutePrefix = (p?: string) => {
  const v = (p || 'BCORP').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!v || v.length > 12) throw new Error('minute prefix must be 1–12 letters or digits');
  return v;
};

export const minuteRef = (date: string, minuteNumber: number, prefix?: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('minute date must be YYYY-MM-DD');
  if (!Number.isInteger(minuteNumber) || minuteNumber < 1 || minuteNumber > 999)
    throw new Error('minute number must be 1–999');
  return `${minutePrefix(prefix)}-BM-${date}-${String(minuteNumber).padStart(3, '0')}`;
};

/** Excess over the quoted amount, never negative. */
export const excessSats = (paidSats: number, quotedSats: number) => Math.max(0, paidSats - quotedSats);

/** Refund still owed on an allotment: refund chosen, excess > 0, no refund txid recorded. */
export const excessRefundDue = (o: {
  excessChoice?: ExcessChoice | null;
  excessSats?: number | null;
  excessRefundTxid?: string | null;
}) => o.excessChoice === 'refund' && (o.excessSats ?? 0) > 0 && !o.excessRefundTxid;

export function allotmentMinute(i: MinuteInput): Minute {
  const ref = minuteRef(i.date, i.minuteNumber, i.company.refPrefix);
  const directors = i.directors && i.directors.length ? i.directors : [i.director];
  const sole = directors.length === 1;
  const article = i.company.authorisedArticle === undefined ? 'Article 19.1' : i.company.authorisedArticle;
  const recordsArticle = i.company.recordsArticle === undefined ? 'Article 19.3' : i.company.recordsArticle;
  const treasury = i.treasury ?? { m: 2, n: 3 };
  const { offer, payment, register } = i;
  const excess = excessSats(payment.paidSats, offer.sats);
  if (excess > 0 && !payment.excessChoice) throw new Error('an excess needs the investor’s refund/premium choice');
  const premium = excess > 0 && payment.excessChoice === 'premium';
  const considerationSats = premium ? payment.paidSats : offer.sats;
  const considerationPence = penceFor(considerationSats, offer.gbpPerBsvPence);
  const holdingAfter = register.holdingBefore + offer.shares;
  const issuedAfter = register.issuedBefore + offer.shares;
  if (register.authorised != null && issuedAfter > register.authorised)
    throw new Error('allotment exceeds the authorised share capital');
  const pct = ((holdingAfter / issuedAfter) * 100).toFixed(2);
  const title = `Board Minute — Allotment to ${i.allottee.name} under Offer ${offer.id}`;
  const sections: [string, string[]][] = [];

  sections.push([
    'Background',
    [
      `By share offer ${offer.id} made in bShares on ${longDate(offer.offeredAt)} the Company offered ` +
        `${i.allottee.name} ${n(offer.shares)} ordinary shares of ${nominal(register.nominalNanoPounds)} each at ` +
        `${gbp(offer.pricePence)} per share, payable in Bitcoin SV at ${gbp(offer.gbpPerBsvPence)} per BSV ` +
        `(the rate of ${longDate(offer.rateDate)}), being ${bsvText(offer.sats)}, open until ${longDate(offer.closesAt)}. ` +
        `The offer provided: “${OVERPAYMENT_TERM}”`,
      `The Subscriber accepted the offer in bShares and paid ${bsvText(payment.paidSats)} to the Company’s ` +
        `treasury. Settlement transaction, confirmed on chain:`,
      payment.txid,
    ],
  ]);

  sections.push([
    'The allotment',
    [
      'It was resolved to allot, with effect from today:',
      `Allottee: ${i.allottee.name} ($${i.allottee.handle})`,
      `Consideration: ${bsvText(considerationSats)} (${gbp(considerationPence)}), in specie in Bitcoin SV`,
      `Subscription price: ${gbp(offer.pricePence)} per share`,
      `Shares allotted: ${n(offer.shares)} ordinary shares of ${nominal(register.nominalNanoPounds)} each, fully paid`,
      `Aggregate nominal value: ${nominal(offer.shares * register.nominalNanoPounds)}`,
      `Certificate number: ${register.certificate}`,
      `Holding after allotment: ${n(holdingAfter)} ordinary shares`,
      `Issued capital after allotment: ${n(issuedAfter)} ordinary shares (${nominal(issuedAfter * register.nominalNanoPounds)})`,
      `Resulting percentage: ${pct}%`,
      (register.authorised != null
        ? `The allotment is within the authorised limit of ${n(register.authorised)} ordinary shares` +
          (article ? ` under ${article}` : '') +
          `, and the ${sole ? 'director' : 'board'}`
        : `The ${sole ? 'director' : 'board'}`) +
        ' is authorised to allot under section 550 of the Companies Act 2006, the Company having one class of shares.',
    ],
  ]);

  if (excess > 0) {
    const due = addDays(i.date, EXCESS_REFUND_DAYS);
    sections.push([
      `The payment of ${bsvText(excess)} above the Offer`,
      premium
        ? [
            `The Subscriber paid ${bsvText(payment.paidSats)} against a subscription of ${bsvText(offer.sats)} and, ` +
              'when paying, chose to have the excess treated as share premium. An excess buys no further shares: the ' +
              `${n(offer.shares)} shares are those the Offer fixes.`,
            `It was resolved to accept the whole ${bsvText(payment.paidSats)} as the consideration for the ` +
              `${n(offer.shares)} shares, the ${bsvText(excess)} above the Offer price being premium paid on those shares. ` +
              'It is not refunded, is not a loan, and creates no right to further shares.',
          ]
        : [
            `The Subscriber paid ${bsvText(payment.paidSats)} against a subscription of ${bsvText(offer.sats)} and, ` +
              'when paying, chose to have the excess refunded.',
            `It was resolved that the ${bsvText(excess)} above the Offer price forms no part of the consideration and ` +
              `be refunded in BSV to the Subscriber from the Company’s treasury on or before ${longDate(due)}. ` +
              'It is not a loan and creates no right to further shares.',
          ],
    ]);
  }

  sections.push([
    'Consideration is not cash',
    [
      'The subscription is measured in pounds sterling at the rate fixed in the Offer. The shares are paid up ' +
        'otherwise than in cash within section 583 of the Companies Act 2006, the consideration being Bitcoin SV. ' +
        'Form SH01 shall be completed on that basis.',
    ],
  ]);

  sections.push([
    'The share token',
    [
      `The shares are evidenced by a $403 share token held by the Subscriber, locked 2-of-2 (director and ` +
        `Subscriber) and spendable by the Subscriber alone after ${offer.lockMonths} months. The register of members ` +
        'is the legal title; the token follows the register.',
    ],
  ]);

  sections.push([
    'Direction to file and to record',
    [
      `The ${sole ? 'director is' : 'directors are'} authorised and directed to:`,
      `Enter the Subscriber in the register of members in respect of the shares allotted.`,
      `Issue certificate number ${register.certificate} and the $403 share token to the Subscriber.`,
      `Deliver form SH01 to the Registrar of Companies within one month of allotment under section 555, ` +
        `that is on or before ${longDate(addMonths(i.date, 1))}, recording the consideration as non-cash.`,
      `Reconcile the blockchain records${recordsArticle ? ` maintained under ${recordsArticle}` : ''} to the register.`,
    ],
  ]);

  sections.push([
    'Treasury',
    [
      `The consideration was received at the Company’s treasury, a ${treasury.m}-of-${treasury.n} multisignature output whose keys are ` +
        `held by the ${sole ? 'director' : 'directors'}. The whole of it is investor subscription capital of the Company and is not a ` +
        'director’s loan.',
    ],
  ]);

  const lines: string[] = [
    i.company.name.toUpperCase(),
    `Company Number ${i.company.number}`,
    '',
    sole ? 'MINUTE OF A DECISION OF THE SOLE DIRECTOR' : 'MINUTE OF A MEETING OF THE BOARD OF DIRECTORS',
    'made under section 248 of the Companies Act 2006',
    '',
    `Date: ${longDate(i.date)} · Reference: ${ref}`,
    sole
      ? `Present: ${i.director.name}, sole director`
      : `Present: ${directors.map((d) => d.name).join(', ')} (directors); ${i.director.name} in the chair`,
  ];
  sections.forEach(([heading, paras], k) => {
    lines.push('', `${k + 1}. ${heading}`);
    let sub = 0;
    for (const p of paras) {
      // "Direction" items are numbered k.1, k.2 … like the precedent's §7.
      if (heading.startsWith('Direction') && p !== paras[0]) lines.push(`${k + 1}.${++sub} ${p}`);
      else lines.push(p);
    }
  });
  lines.push(
    '',
    sole ? `Sole Director of ${i.company.name}` : `Chair, for the Board of ${i.company.name}`,
    `${i.director.name} · ${sole ? 'Sole Director' : 'Director, Chair'} · $${i.director.handle}`,
    `Date: ${longDate(i.date)}`,
    '',
    `${i.company.name} · Company Number ${i.company.number}`,
    `${ref} · Retained under s.248 CA 2006 — not filed at Companies House`,
  );
  return { ref, title, text: lines.join('\n') };
}
