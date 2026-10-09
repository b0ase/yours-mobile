/**
 * Example bMails (owner, 9 Oct 2026: "even 'demo' bMails would give us an idea of what a bMail is in practice").
 *
 * Display only. These are plain objects, never Received/Sent, never written to the mail store, and the screen
 * renders them with an "Example" tag and every money action disabled. Names are fictional.
 * Uses follow docs/BMAIL.md §1 (what people use email for), §6a (delivery options) and §6b (Requests).
 */

import type { MailFilter, SortMode } from './route';

export type StampKind = 'free' | 'penny' | 'priority' | 'reply' | 'signed' | 'paytoopen' | 'none';

export type ExampleMail = {
  id: string;
  box: 'inbox' | 'requests';
  name: string;
  handle: string;
  /** Avatar background. */
  color: string;
  subject: string;
  body: string;
  stamps: StampKind[];
  /** Postage in US cents shown on the stamp chip. */
  cents: number;
  /** Minutes ago. */
  ago: number;
  unread?: boolean;
  friend?: boolean;
  /** A money/sign action the real mail would carry. Always disabled for examples. */
  action?: string;
  /** Requests only: plain facts about a token that came with the note. */
  token?: { symbol: string; holders: number; forwards: number; spreading?: boolean };
  /**
   * Postage paid in PNEE (1 PNEE = 1¢). Display only.
   * TODO(bmail pnee): real PNEE postage is a later phase; real mail is stamped in sats today.
   */
  pnee?: boolean;
  /** Payment attached on top of postage (e.g. a refund paid with the letter), cents. */
  attachedCents?: number;
  /** Amount the mail asks for (an invoice), cents. Not attached; shown as "+ $x invoice". */
  invoiceCents?: number;
  /** Small line under the amount when the default stamp wording is not enough. */
  note?: string;
  /** Tokens riding with the mail. */
  tokens?: TokenAttach[];
  kind?: 'contract' | 'invoice' | 'receipt';
};

export type TokenAttach = { symbol: string; amount: number };

const H = 60;
const D = 24 * H;

export const EXAMPLES: ExampleMail[] = [
  {
    id: 'ex-letter',
    box: 'inbox',
    name: 'Mira Okonkwo',
    handle: '$mira.ok',
    color: '#7A5AF8',
    subject: 'Sunday lunch?',
    body: 'Hey! We are doing a long lunch on Sunday at ours, around 1. Bring nothing but yourself (and maybe that bread). Kids will be feral, you have been warned.\n\nM x',
    stamps: ['free'],
    cents: 0,
    ago: 12,
    unread: true,
    friend: true,
  },
  {
    id: 'ex-intro',
    box: 'inbox',
    name: 'Tobias Venn',
    handle: '$tvenn',
    color: '#2E90FA',
    subject: 'Intro: we build the thing you tweeted about',
    body: 'Hi, I run a two-person studio making offline-first maps. You mentioned wanting map tiles you can pay for per view. We have that working. Fifteen minutes next week?\n\nI put a Priority stamp on this so you know I am not bulk mailing.',
    stamps: ['priority'],
    cents: 3,
    ago: 47,
    unread: true,
  },
  {
    id: 'ex-contract',
    box: 'inbox',
    name: 'Harbour Lane Studio',
    handle: '$harbourlane',
    color: '#F79009',
    subject: 'Offer: illustration licence — sign by Friday',
    body: 'Attached: licence for the three cover illustrations (worldwide, 5 years). Fee £600, paid on signing.\n\nAlso attached: 2,500 $HARBOUR-PRINTS, print credits you can spend in our shop (1 credit = 1 print proof).\n\nSigned delivery: we will see when you open this, and the offer lapses Friday 18:00.',
    stamps: ['signed', 'priority'],
    cents: 3,
    ago: 3 * H,
    unread: true,
    action: 'Review and sign',
    kind: 'contract',
    note: 'Priority stamp · £600 on signing',
    tokens: [{ symbol: 'HARBOUR-PRINTS', amount: 2500 }],
  },
  {
    id: 'ex-invoice',
    box: 'inbox',
    name: 'Pellbrook Plumbing',
    handle: '$pellbrook',
    color: '#12B76A',
    subject: 'Invoice #0412: boiler service',
    body: 'Thanks for having us round on Tuesday.\n\nBoiler annual service ........ $85.00\nPart: pressure valve ......... $27.50\nTotal ........................ $112.50\n\nTap Pay to settle straight from your wallet. A signed receipt comes back automatically.',
    stamps: ['penny'],
    cents: 1,
    ago: 5 * H,
    action: 'Pay $112.50',
    kind: 'invoice',
    invoiceCents: 11250,
  },
  {
    id: 'ex-rsvp',
    box: 'inbox',
    name: 'Juno Aster',
    handle: '$juno',
    color: '#EE46BC',
    subject: 'RSVP: rooftop thing, 24th',
    body: 'Doing a small rooftop evening on the 24th. Can you make it? Just hit reply: yes / no / maybe.\n\nReply is paid, so answering costs you nothing.',
    stamps: ['reply'],
    cents: 5,
    ago: 9 * H,
    action: 'Reply free',
    note: 'Reply paid +1¢',
  },
  {
    id: 'ex-ticket',
    box: 'inbox',
    name: 'Lowfield Festival',
    handle: '$lowfield',
    color: '#F04438',
    subject: 'Your ticket: Lowfield, Saturday',
    body: 'This bMail is your ticket. The ticket token sits in your wallet; show the QR at the gate. Forwarding the mail hands the ticket to a friend.\n\nGates 11:00 · Field B',
    stamps: ['penny'],
    cents: 1,
    ago: D,
    action: 'Show ticket',
    tokens: [{ symbol: 'TICKET-LOWFIELD', amount: 1 }],
    note: 'Penny post · ticket attached',
  },
  {
    id: 'ex-issue',
    box: 'inbox',
    name: 'The Slow Ledger',
    handle: '$slowledger',
    color: '#667085',
    subject: 'Issue 31: the case for paying for attention',
    body: 'This week: why a 1¢ stamp kills bulk mail without hurting anyone real, three small shops taking payments by mail, and a reader letter on reply-paid RSVPs.\n\nYou subscribed at 3 PNEEs an issue (3¢). Stop paying and the issues stop.',
    stamps: ['penny'],
    cents: 3,
    pnee: true,
    note: 'Subscription · paid in PNEE',
    ago: 2 * D,
  },
  {
    id: 'ex-pay-open',
    box: 'inbox',
    name: 'Quill Recruiting',
    handle: '$quillhire',
    color: '#0BA5EC',
    subject: 'A role you might like (paid to open)',
    body: 'We pay you 25¢ just for opening this. If it is not opened in 14 days the payment goes back to us.\n\nSenior mobile engineer, remote, wallet experience a plus.',
    stamps: ['paytoopen'],
    cents: 25,
    note: 'Paid to open',
    ago: 3 * D,
  },
  {
    id: 'ex-spreading',
    box: 'requests',
    name: 'Paper Lanterns',
    handle: '$lanterns',
    color: '#FDB022',
    subject: 'Pass the lantern on',
    body: 'A short poem rides with this token. Keep it, or forward it to someone who needs a light today. Every holder gets the same note.',
    stamps: ['none'],
    cents: 0,
    ago: 30,
    token: { symbol: 'LANTERN', holders: 4812, forwards: 12_930, spreading: true },
    tokens: [{ symbol: 'LANTERN', amount: 1 }],
  },
  {
    id: 'ex-drop-1',
    box: 'requests',
    name: 'Mega Moon Drop',
    handle: '0279a1…c3e0',
    color: '#475467',
    subject: '🚀 FREE 10,000 MOONZ — claim now',
    body: 'Unstamped airdrop. It waits here; keeping it costs nothing, hiding the issuer stops more like it.',
    stamps: ['none'],
    cents: 0,
    ago: 2 * H,
    token: { symbol: 'MOONZ', holders: 61, forwards: 3 },
    tokens: [{ symbol: 'MOONZ', amount: 10_000 }],
  },
  {
    id: 'ex-drop-2',
    box: 'requests',
    name: 'Glowcart Deals',
    handle: '$glowcart',
    color: '#475467',
    subject: '40% off everything this weekend',
    body: 'Unstamped promotion. It stays in Requests unless you keep the sender.',
    stamps: ['none'],
    cents: 0,
    ago: 6 * H,
    token: { symbol: 'GLOW', holders: 220, forwards: 18 },
    tokens: [{ symbol: 'GLOW', amount: 500 }],
  },
  {
    id: 'ex-refund',
    box: 'inbox',
    name: 'Kettle & Crumb',
    handle: '$kettlecrumb',
    color: '#DD2590',
    subject: 'Receipt + refund: double-charged flat white',
    body: 'Sorry, our till charged you twice on Monday. The extra $4.20 is attached to this letter, and here is your signed receipt.\n\nFlat white ........ $4.20\nRefund ........... -$4.20\n\nA loyalty stamp rides along too: ten and the next one is on us.',
    stamps: ['penny'],
    cents: 2,
    pnee: true,
    attachedCents: 420,
    note: '+ $4.20 refund attached',
    kind: 'receipt',
    tokens: [{ symbol: 'KETTLE-STAMP', amount: 1 }],
    ago: 4 * H,
  },
  {
    id: 'ex-pnee-hello',
    box: 'inbox',
    name: 'Ada Brightwater',
    handle: '$adab',
    color: '#875BF7',
    subject: 'Your talk on penny post',
    body: 'Loved the talk. I put 5 PNEEs on this so it would sit near the top. Would you look at a 2-page draft I wrote on stamped mail for small charities?',
    stamps: ['priority'],
    cents: 5,
    pnee: true,
    note: 'Priority stamp · paid in PNEE',
    ago: 90,
    unread: true,
  },
  {
    id: 'ex-reel-drop',
    box: 'requests',
    name: 'Reelhouse',
    handle: '$reelhouse',
    color: '#6172F3',
    subject: 'Your free film night: 1,000 $REELZ',
    body: 'Welcome gift: 1,000 $REELZ, enough for one film night on Reelhouse. Keep it to use it, or hide us and we will not write again.',
    stamps: ['none'],
    cents: 0,
    ago: 3 * H,
    token: { symbol: 'REELZ', holders: 1_204, forwards: 340 },
    tokens: [{ symbol: 'REELZ', amount: 1000 }],
  },
  {
    id: 'ex-pnee-drop',
    box: 'requests',
    name: 'Corner Pantry',
    handle: '$cornerpantry',
    color: '#16B364',
    subject: 'Opening week: 500 PNEEs off your first shop',
    body: 'We opened on Market Street. 500 PNEEs ($5.00) of shopping credit rides with this note; spend it at the till by scanning your wallet.',
    stamps: ['penny'],
    cents: 1,
    pnee: true,
    note: 'Penny post · credit attached',
    ago: 20 * H,
    token: { symbol: 'PNEE', holders: 380, forwards: 41 },
    tokens: [{ symbol: 'PNEE', amount: 500 }],
  },
];

const HIDE_KEY = 'bw-bmail-examples-hidden';

export const examplesHidden = (): boolean => {
  try {
    return globalThis.localStorage?.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
};

export const setExamplesHidden = (v: boolean) => {
  try {
    if (v) globalThis.localStorage?.setItem(HIDE_KEY, '1');
    else globalThis.localStorage?.removeItem(HIDE_KEY);
  } catch {
    /* private mode: shown again next launch */
  }
};

/** Show examples while the user has little real mail of their own. */
export const EXAMPLES_BELOW = 5;

export const agoLabel = (min: number): string =>
  min < 60 ? `${min}m` : min < 24 * 60 ? `${Math.round(min / 60)}h` : `${Math.round(min / (24 * 60))}d`;

// ---- Money and weighting for examples (display only; pure, tested). ----

export const fmtCents = (c: number): string =>
  `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Postage plus any payment attached to the mail, in cents. */
export const totalCents = (e: ExampleMail): number => e.cents + (e.attachedCents ?? 0);

const STAMP_NOTE: Record<StampKind, string> = {
  free: 'Friend · free',
  penny: 'Penny post',
  priority: 'Priority stamp',
  reply: 'Reply paid',
  signed: 'Signed delivery',
  paytoopen: 'Paid to open',
  none: 'Unstamped',
};

/** The big price on the right of a row, plus its small line. */
export const amountOf = (e: ExampleMail): { main: string; eq?: string; note: string } => {
  const c = totalCents(e);
  const stamp = e.stamps.find((k) => k !== 'signed') ?? e.stamps[0] ?? 'none';
  const note = e.invoiceCents ? `+ ${fmtCents(e.invoiceCents)} invoice` : (e.note ?? STAMP_NOTE[stamp]);
  return e.pnee ? { main: `${c} ${c === 1 ? 'PNEE' : 'PNEEs'}`, eq: fmtCents(c), note } : { main: fmtCents(c), note };
};

export const tokenLabel = (t: TokenAttach): string => `${t.amount.toLocaleString('en-US')} $${t.symbol}`;

export const filterExamples = (list: ExampleMail[], f: MailFilter): ExampleMail[] =>
  list.filter((e) =>
    f === 'all'
      ? true
      : f === 'paid'
        ? totalCents(e) > 0
        : f === 'tokens'
          ? !!e.tokens?.length
          : e.kind === (f === 'contracts' ? 'contract' : f === 'invoices' ? 'invoice' : 'receipt'),
  );

export const sortExamples = (list: ExampleMail[], mode: SortMode): ExampleMail[] =>
  (mode === 'friends' ? list.filter((e) => e.friend) : [...list]).sort((a, b) => {
    // Friends always pinned on top, newest first; the rest by the chosen sort.
    if (!!a.friend !== !!b.friend) return a.friend ? -1 : 1;
    if (a.friend) return a.ago - b.ago;
    if (mode === 'newest') return a.ago - b.ago;
    if (mode === 'spreading') return (b.token?.forwards ?? 0) - (a.token?.forwards ?? 0) || a.ago - b.ago;
    return totalCents(b) - totalCents(a) || a.ago - b.ago;
  });
