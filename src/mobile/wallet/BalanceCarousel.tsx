import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PenLine } from 'lucide-react';
import { useCountUp } from './live/useCountUp';
import { useNavigate } from 'react-router-dom';
import { PLACEMENT_ENABLED, STORE_BUILD } from '../storeBuild';
import { MNEE_ICON_URL } from '../../utils/constants';
import { setWalletKind } from './walletKind';
import { rememberedTicketIds } from './walletTickets';
import { TokenIcon } from '../exchange/TokenIcon';
import { tokenDirectory } from '../market/indexer';
import './balanceCards.css';

/**
 * MOCKUP ONLY (branch mock/balance-cards, 14 Oct 2026): the wallet card as an Apple-Wallet-style swipe carousel,
 * one card per balance. The BSV card is the real WalletCard, untouched; every other card is MOCK DATA.
 * Nothing here signs, spends or fetches.
 */
/** Mock only, and never in store builds. */
export const MOCK_BALANCE_CARDS = !STORE_BUILD;

export type MockBalance = {
  id: string;
  name: string;
  issuer: string;
  /** Unit word shown in place of BSV: "credits", "PNEEs", "tokens". */
  unit: string;
  balance: number;
  /** Mock $ value of one unit. */
  usdPer: number;
  colour: string;
  ink: string;
  initial: string;
  /** What the balance is for (shown on the back when no contract runs). */
  about: string;
  /** Board minute reference on a locked share card's back. */
  boardRef?: string;
  /** Shares locked in 2-of-2 multisig: never spendable, never ticks, never followed. */
  locked?: boolean;
  contact: string;
  /** Back-of-card lines (the service, or the lock), shown when no contract is running. */
  backLines?: string[];
  /** Second line on the front, e.g. the locked collateral behind PNEEs. */
  lockLine?: string;
  /** "View contract" sheet. */
  contractTitle?: string;
  contractTerms?: string[];
  /** BSV-21 icon outpoint (tokens): drawn with the Exchange's TokenIcon. */
  icon?: string | null;
  /** A full image URL for the logo (MNEE). */
  iconUrl?: string;
  /** Extra back-of-card buttons (mock actions). */
  backButtons?: string[];
  /** Balance is in dollars ($1 = $1 credit): shown as "$18.40", no unit switch. */
  dollars?: boolean;
  /** Full one-page agreement (replaces the short terms sheet). */
  agreement?: Agreement;
};

type Agreement = {
  title: string;
  issuer: string;
  parties: [string, string];
  clauses: [string, string][];
  primary: string;
  /** NDS documentRef and the file name for "Save contract". */
  ref: string;
  file: string;
};

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The agreement as an NDS instrument (bit-sign's signable HTML): manifest + data-sig-anchor per signer. */
const ndsHtml = (a: Agreement) => {
  const manifest = {
    nds: '1.0',
    documentTitle: `${a.title} (MOCK)`,
    documentRef: a.ref,
    canonical: { algo: 'sha-256', over: 'rendered-pdf' },
    resolution: 'dom-anchor',
    signatureFields: [
      { id: 'issuer', role: 'Issuer', name: a.parties[0], party: 'issuer', required: true, order: 1 },
      { id: 'holder', role: 'Customer', name: 'You', party: 'customer', signerHandle: 'you', required: true, order: 2 },
    ],
  };
  const sig = (d: string) =>
    `<svg viewBox="0 0 160 50" width="200" height="56"><path d="${d}" fill="none" stroke="#1a1a8c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)} (MOCK)</title>
<script type="application/npg-sig-manifest+json">
${JSON.stringify(manifest, null, 2)}
</script>
<style>
body{margin:0;background:#0b0b0d;font-family:'Times New Roman',serif;font-size:16px;line-height:1.5;color:#111}
.sheet{background:#fff;margin:12px;padding:20px 18px;border-radius:6px;border-top:4px solid #ffd24d}
.mock{font-family:system-ui,sans-serif;font-weight:800;font-size:12px;letter-spacing:.06em;color:#c0262c;border:1px solid #c0262c;border-radius:6px;padding:3px 8px;display:inline-block}
h1{font-size:21px;margin:12px 0 4px}.ref{font-size:12px;color:#555;font-family:ui-monospace,Menlo,monospace}
.parties{border-top:1px solid #ccc;border-bottom:1px solid #ccc;padding:8px 0;margin:10px 0}
ol{padding-left:22px}li{margin-bottom:8px}
.execution{display:flex;flex-direction:column;gap:18px;margin-top:18px}
.sig-line{border-bottom:1px solid #000;min-height:56px}.sig-caption{font-size:13px;color:#333}
.meta{font-size:12px;color:#555;font-family:ui-monospace,Menlo,monospace;margin-top:14px}
</style></head><body><div class="sheet">
<div class="mock">MOCK · not a real agreement</div>
<h1>${esc(a.title)}</h1><div class="ref">${esc(a.ref)}</div>
<div class="parties"><b>Between</b> ${esc(a.parties[0])}<br><b>and</b> ${esc(a.parties[1])}</div>
<ol>${a.clauses.map(([h, t]) => `<li><b>${esc(h)}.</b> ${esc(t)}</li>`).join('')}</ol>
<div class="execution">
<div class="sig-block"><div class="sig-line" data-sig-anchor="issuer">${sig(SIG_A)}</div><div class="sig-caption">For ${esc(a.issuer)} (issuer)</div></div>
<div class="sig-block"><div class="sig-line" data-sig-anchor="holder">${sig(SIG_B)}</div><div class="sig-caption">You · $you</div></div>
</div>
<div class="meta">Dated 14 October 2026<br>On chain: txid 7f3c…e21a (agreement hash, placeholder)</div>
</div></body></html>`;
};

const SIG_A = 'M6 34 C18 8 26 44 38 22 S56 10 62 30 C68 44 80 14 92 26 S118 38 128 18 L152 22';
const SIG_B = 'M8 28 C14 12 22 12 24 30 C26 44 40 6 50 24 S70 40 84 20 C94 8 102 36 116 28 S140 14 154 30';
const FlipBtn = ({ onFlip }: { onFlip: () => void }) => (
  <button
    type="button"
    className="bw-wcard-penflip"
    aria-label="Flip card"
    title="Flip card"
    onClick={(e) => {
      e.stopPropagation();
      onFlip();
    }}
  >
    <PenLine size={20} aria-hidden="true" />
  </button>
);

/**
 * Top layer for every mock sheet: portalled to <body> above the TopNav, tab bar, bApp frame, Feed and the wallet
 * overlay (2147483000–2147483500). Locks background scroll; Close, Escape, the back gesture and a swipe down dismiss.
 */
const Layer = ({ onClose, children, sheet = false }: { onClose: () => void; children: ReactNode; sheet?: boolean }) => {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const body = document.body;
    const prev = body.style.overflow;
    body.style.overflow = 'hidden';
    let popped = false;
    try {
      window.history.pushState({ bwMockLayer: true }, '');
    } catch {
      /* ignore */
    }
    const onPop = () => {
      popped = true;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      body.style.overflow = prev;
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      if (!popped && (window.history.state as { bwMockLayer?: boolean } | null)?.bwMockLayer) window.history.back();
    };
  }, []);
  const startY = useRef<number | null>(null);
  return createPortal(
    <div
      className={`bw-layer${sheet ? ' is-sheet' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onTouchStart={(e) => {
        const sc = (e.target as HTMLElement).closest('.bw-layer-scroll');
        const onTile = (e.target as HTMLElement).closest('.bw-eg-tile');
        startY.current = !onTile && (!sc || sc.scrollTop <= 0) ? e.touches[0].clientY : null;
      }}
      onTouchEnd={(e) => {
        if (startY.current !== null && e.changedTouches[0].clientY - startY.current > 120) onClose();
        startY.current = null;
      }}
    >
      {children}
    </div>,
    document.body,
  );
};

const AgreementSheet = ({ a, onClose }: { a: Agreement; onClose: () => void }) => {
  const html = ndsHtml(a);
  const save = () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = a.file;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
  };
  return (
    <Layer onClose={onClose}>
      <div className="bw-ag">
        <div className="bw-ag-grab" />
        <iframe className="bw-ag-doc" title={a.title} sandbox="" srcDoc={html} />
        <div className="bw-ag-btns">
          <button
            type="button"
            className="is-primary"
            onClick={() => window.alert(`MOCK: ${a.primary} would run here.`)}
          >
            {a.primary}
          </button>
          <button type="button" onClick={save}>
            Save contract (.nds.html)
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Layer>
  );
};

export type MockContract = { what: string; rate: string; startedAt: number; spent: number };

const MOCK: MockBalance[] = [
  {
    id: 'mnee',
    name: 'MNEE',
    issuer: 'MNEE · USD stablecoin on BSV',
    unit: 'MNEE',
    dollars: true,
    balance: 0,
    usdPer: 1,
    colour: '#0b5d4b',
    ink: '#eafff7',
    initial: 'M',
    iconUrl: MNEE_ICON_URL,
    about: 'MNEE is a US dollar stablecoin on BSV: 1 MNEE = $1.',
    backLines: [
      'MNEE is a US dollar stablecoin on BSV: 1 MNEE = $1.',
      'Send it like cash to a $handle or address; fees are paid in MNEE.',
      'Balance shown from this wallet (read only).',
    ],
    backButtons: ['Send', 'Receive'],
    contact: 'MNEE',
  },
  {
    id: 'bcredits',
    name: 'bCredits',
    issuer: 'b · The Bitcoin Corporation',
    unit: 'bCredits',
    balance: 820,
    usdPer: 0.0127,
    colour: '#0b0b0d',
    ink: '#ffd24d',
    initial: 'b',
    about: 'Credits for Ask b. 1 bCredit = 1p.',
    backLines: [
      'Ask b: replies, fixes and builds in chat.',
      '1 bCredit = 1p · b charges cost × 1.35 per reply.',
      'Balance 820 bCredits (£8.20).',
    ],
    contact: 'b',
    contractTitle: 'You and The Bitcoin Corporation (b)',
    contractTerms: [
      'Issuer: The Bitcoin Corporation Ltd, operating b.',
      'Price: 1 bCredit = 1p (GBP), bought with BSV.',
      'What a bCredit buys: b’s model cost for a reply × 1.35, rounded up to whole bCredits.',
      'Refunds: unused bCredits refundable to your wallet in BSV at the day’s rate.',
      'How to stop: tap Stop on this card; b stops at once and charges nothing further.',
    ],
  },
  {
    id: 'mandala',
    name: 'Mandala credit',
    issuer: 'GorillaPool (Root) · mandala.computer',
    unit: 'Mandala credit',
    dollars: true,
    balance: 18.4,
    usdPer: 1,
    colour: '#1f6f5c',
    ink: '#e8fff6',
    initial: 'M',
    about: 'Dollar credit for cloud computers for agents on mandala.computer. $1 paid = $1 credit.',
    backLines: [
      'Mandala: cloud computers for agents (mandala.computer).',
      'Runtime: $0.12/hour · billed per active second. Nothing is charged while your computer is stopped or suspended.',
      'Storage: $0.10/GB-month for retained disks and snapshots.',
      'Fund with a card, MNEE ($1 = $1) or BSV at the live rate. Limits are separate from your balance.',
    ],
    contact: 'Root',
    agreement: {
      title: 'Mandala Credits: service agreement',
      issuer: 'GorillaPool',
      parties: ['GorillaPool (issuer, mandala.computer)', 'You (identity key 03ab…f9, paymail $you)'],
      primary: 'Sign & top up',
      ref: 'MANDALA-SA-2026-10-14-MOCK',
      file: 'Mandala_Credits_Agreement_MOCK_NDS.html',
      clauses: [
        ['What you’re buying', 'Hosted agent computer time on mandala.computer, plus storage you choose to keep.'],
        [
          'Price',
          'Credit is in dollars: $1 paid = $1 credit. Runtime example: $0.12/hour. No monthly fee to try the API.',
        ],
        [
          'How you’re charged',
          'Per active second of allocated runtime, shown live on your card. Nothing is charged while your computer is stopped or suspended.',
        ],
        [
          'Storage',
          'Retained disks and snapshots are charged separately at $0.10/GB-month, under the published storage policy.',
        ],
        [
          'Limits',
          'Resource limits are set separately from your balance: a positive balance doesn’t buy unlimited resources.',
        ],
        [
          'Stopping',
          'Tap Stop on the card: billing and the service stop at once, and unused credit stays yours to use later.',
        ],
        [
          'Support',
          'Contact GorillaPool from the card. If the service isn’t delivered, credit for that time is returned.',
        ],
        ['Funding', 'Top up by card first; MNEE at $1 = $1 and BSV at the live rate are also accepted.'],
        ['Refunds and expiry', 'Credit doesn’t expire. It is non-refundable except where the law requires.'],
        ['Your keys', 'GorillaPool never holds your keys. Only the credit you top up sits with the issuer.'],
      ],
    },
  },
  {
    id: 'pnee',
    name: 'PNEEs',
    issuer: 'bWalletX · stable pennies',
    unit: 'PNEEs',
    balance: 5000,
    usdPer: 0.01,
    colour: '#ffd24d',
    ink: '#111',
    initial: 'P',
    about: 'Stable pennies: 1 PNEE = 1¢.',
    lockLine: '🔒 1,000,000 sats locked backing 5,000 PNEEs',
    backLines: [
      'Locked: 1,000,000 sats (0.01 BSV) in your PNEE lock.',
      'Minted against it: 5,000 PNEEs ($50), within the 10× collateral rule.',
      'Unlocks after block 997,000 (~6 months), or early by returning the 5,000 PNEEs. You can always recover your locked BSV with your own key, without our server.',
    ],
    contact: 'bWalletX',
    agreement: {
      title: 'PNEEs: stable pennies lock agreement',
      issuer: 'The Bitcoin Corporation',
      parties: ['The Bitcoin Corporation Ltd (PNEE issuer)', 'You (identity key 03ab…f9, paymail $you)'],
      primary: 'Lock & mint',
      ref: 'PNEE-LOCK-2026-10-14-MOCK',
      file: 'PNEE_Lock_Agreement_MOCK_NDS.html',
      clauses: [
        ['What you lock', 'BSV into a time-lock under your own key. Example: 1,000,000 sats.'],
        [
          'What you get',
          'PNEEs minted against it, with the locked BSV worth at least 10× the PNEEs minted. Example: 5,000 PNEEs; 1 PNEE = 1¢.',
        ],
        ['Unlock', 'After block ~997,000, or early by returning the PNEEs minted against the lock.'],
        [
          'Your keys',
          'The lock key comes from your own 12 words. You can always recover your locked BSV yourself, without our server.',
        ],
        ['Risks', 'BSV’s price moves. Only lock what you can afford to lose.'],
        ['Support', 'Contact bWalletX from the card.'],
      ],
    },
    contractTitle: 'Your PNEE lock (stable pennies)',
    contractTerms: [
      'Collateral: 1,000,000 sats locked on-chain in a script only your key can spend.',
      'Minted: 5,000 PNEEs; 1 PNEE = 1¢. Locked BSV is worth at least 10× the PNEEs minted against it.',
      'Unlock: after block 997,000, or earlier by burning the PNEEs minted against the lock.',
      'Recovery: your seed derives the lock key; you can always recover your locked BSV yourself, without our server.',
      'Risk: lock only what you can afford to lose; test with small amounts.',
    ],
  },
  {
    id: 'bcorp',
    name: '$bcorp shares',
    issuer: 'The Bitcoin Corporation',
    unit: 'shares',
    balance: 52000,
    usdPer: 0.0004,
    colour: '#16161a',
    ink: '#ffd24d',
    initial: 'b',
    about: 'Shares in The Bitcoin Corporation Ltd.',
    locked: true,
    contact: 'bitcoin-corp.com',
    boardRef: 'BCORP-BM-2026-014',
  },
  {
    id: 'sh-acme',
    name: 'Example Robotics Ltd shares',
    issuer: 'Example Robotics Ltd (fake company)',
    unit: 'shares',
    balance: 1200,
    usdPer: 0.5,
    colour: '#2a2350',
    ink: '#ffd24d',
    initial: 'E',
    about: 'Mock shares in a made-up company.',
    locked: true,
    contact: 'example-robotics.test',
    boardRef: 'EXRB-BM-2026-003',
  },
  {
    id: 'sh-teapot',
    name: 'Sample Teapot plc shares',
    issuer: 'Sample Teapot plc (fake company)',
    unit: 'shares',
    balance: 300,
    usdPer: 1.2,
    colour: '#3b2412',
    ink: '#ffd24d',
    initial: 'S',
    about: 'Mock shares in a made-up company.',
    locked: true,
    contact: 'sample-teapot.test',
    boardRef: 'STPT-BM-2026-011',
  },
];

const fmtNum = (n: number) => Math.round(n).toLocaleString('en-US');
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

const MockCard = ({
  c,
  chip,
  contract,
  onStop,
  onPaid,
  running,
  onRun,
}: {
  c: MockBalance;
  chip: string | null;
  contract: MockContract | null;
  onStop: () => void;
  onPaid: (id: string, amount: number) => void;
  running?: boolean;
  onRun?: () => void;
}) => {
  const [unit, setUnit] = useState<'own' | 'usd'>('own');
  const [flipped, setFlipped] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  const [turning, setTurning] = useState(false);
  const flip = () => {
    setTurning(true);
    window.setTimeout(() => setFlipped((f) => !f), 220);
    window.setTimeout(() => setTurning(false), 440);
  };
  const contact = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    window.alert(`MOCK: this would open a support chat with ${c.contact}.`);
  };
  const count = useCountUp(c.balance, !c.locked);
  const big = c.dollars
    ? `$${count.value.toFixed(running ? 4 : 2)}`
    : unit === 'own'
      ? fmtNum(count.value)
      : fmtUsd(count.value * c.usdPer);
  const small = unit === 'own' ? fmtUsd(count.value * c.usdPer) : `${fmtNum(count.value)} ${c.unit}`;
  const toggle = () => setUnit((u) => (u === 'own' ? 'usd' : 'own'));
  const ownLabel = c.unit === 'PNEEs' ? 'PNEEs' : c.unit;
  const style = { ['--bc-bg' as string]: c.colour, ['--bc-ink' as string]: c.ink };
  if (flipped && c.locked)
    return (
      <div className={`bw-bc bw-bc-back${turning ? ' is-turning' : ''}`} style={style} onClick={flip}>
        <FlipBtn onFlip={flip} />
        <div className="bw-bc-top">
          <span className="bw-bc-logo">🔒</span>
          <span className="bw-bc-head">
            <b>{fmtNum(c.balance)} shares · Restricted, not for sale</b>
            <small>2-of-2 multisig: director + you · or you alone after block 1,023,000 (~12 months)</small>
          </span>
          <span className="bw-bc-mock">MOCK</span>
        </div>
        <div className="bw-bc-sigs">
          <span>
            <svg viewBox="0 0 160 50" aria-label="Director signature">
              <path d="M6 34 C18 8 26 44 38 22 S56 10 62 30 C68 44 80 14 92 26 S118 38 128 18 L152 22" />
            </svg>
            <small>Director</small>
          </span>
          <span>
            <svg viewBox="0 0 160 50" aria-label="Holder signature">
              <path d="M8 28 C14 12 22 12 24 30 C26 44 40 6 50 24 S70 40 84 20 C94 8 102 36 116 28 S140 14 154 30" />
            </svg>
            <small>Holder</small>
          </span>
        </div>
        <div className="bw-bc-terms">
          <span>Board minute {c.boardRef ?? 'BCORP-BM-2026-014'} · signed with bit-sign</span>
        </div>
      </div>
    );
  if (flipped)
    return (
      <div className={`bw-bc bw-bc-back${turning ? ' is-turning' : ''}`} style={style} onClick={flip}>
        <FlipBtn onFlip={flip} />
        <div className="bw-bc-top">
          <Logo c={c} size={34} className="bw-bc-logo" />
          <span className="bw-bc-head">
            <b>{contract ? contract.what : c.name}</b>
            <small>{c.issuer}</small>
          </span>
          <span className="bw-bc-mock">MOCK</span>
        </div>
        {contract ? (
          <div className="bw-bc-terms">
            <span>
              <b>{contract.rate}</b> · started {ago(contract.startedAt)}
            </span>
            <span>
              Spent so far:{' '}
              <b>
                {contract.spent} {c.unit}
              </b>
            </span>
          </div>
        ) : (
          <div className="bw-bc-terms">
            {(c.backLines ?? [c.about]).map((l) => (
              <span key={l}>{l}</span>
            ))}
          </div>
        )}
        <div className="bw-bc-actions">
          {contract ? (
            <button
              type="button"
              className="bw-bc-stop"
              onClick={(e) => {
                e.stopPropagation();
                setFlipped(false);
                onStop();
              }}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="bw-bc-stop is-top"
              onClick={(e) => {
                e.stopPropagation();
                setTopUpOpen(true);
              }}
            >
              Top up
            </button>
          )}
          {(c.contractTerms || c.agreement) && (
            <button
              type="button"
              className="bw-bc-contact"
              onClick={(e) => {
                e.stopPropagation();
                setSheetOpen(true);
              }}
            >
              View contract
            </button>
          )}
          {c.backButtons?.map((b) => (
            <button
              type="button"
              key={b}
              className="bw-bc-contact"
              onClick={(e) => {
                e.stopPropagation();
                window.alert(`MOCK: ${b} ${c.name} opens the wallet’s ${b} screen here.`);
              }}
            >
              {b}
            </button>
          ))}
          <button type="button" className="bw-bc-contact" onClick={contact}>
            Contact {c.contact}
          </button>
        </div>
        {topUpOpen && (
          <TopUpForm
            c={c}
            onClose={() => setTopUpOpen(false)}
            onPaid={(amount) => {
              setTopUpOpen(false);
              setFlipped(false);
              onPaid(c.id, amount);
            }}
          />
        )}
        {sheetOpen && c.agreement && <AgreementSheet a={c.agreement} onClose={() => setSheetOpen(false)} />}
        {sheetOpen && !c.agreement && (
          <Layer sheet onClose={() => setSheetOpen(false)}>
            <div className="bw-bcar-sheet bw-bc-contract bw-layer-scroll">
              <span className="bw-bc-mock">MOCK · placeholder terms</span>
              <h3>{c.contractTitle}</h3>
              <ul>
                {c.contractTerms?.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <div className="bw-bc-signlines">
                <span>{c.issuer.split(' ·')[0]}: ____________</span>
                <span>You: ____________</span>
              </div>
              <small>Dated 14 October 2026</small>
              <button type="button" className="bw-bcar-done" onClick={() => setSheetOpen(false)}>
                Close
              </button>
            </div>
          </Layer>
        )}
      </div>
    );
  return (
    <div className={`bw-bc${turning ? ' is-turning' : ''}`} onClick={flip} style={style}>
      <FlipBtn onFlip={flip} />
      <div className="bw-bc-top">
        <Logo c={c} size={34} className="bw-bc-logo" />
        <span className="bw-bc-head">
          <b>{c.name}</b>
          <small>{c.issuer}</small>
        </span>
        <span className="bw-bc-mock">MOCK</span>
      </div>
      <button
        type="button"
        className={`bw-bc-amt${count.dir && count.flashKey ? ` bw-live-flash-${count.dir}` : ''}`}
        key={count.flashKey}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        {big}
        {(c.dollars || unit === 'own') && <span className="bw-bc-unitword"> {c.unit}</span>}
      </button>
      <div className="bw-bc-bottom">
        <span className="bw-bc-sub">
          {c.locked ? (
            <span className="bw-bc-lock">🔒 Locked · shares</span>
          ) : chip ? (
            <span className="bw-bc-chip">{chip}</span>
          ) : onRun ? (
            <button
              type="button"
              className={`bw-bc-run${running ? ' is-on' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onRun();
              }}
            >
              {running ? '● Running · $0.12/hour · billed per second' : 'Suspended · not charging (tap to run)'}
            </button>
          ) : (
            <>
              {small}
              {c.lockLine && <span className="bw-bc-lockline">{c.lockLine}</span>}
            </>
          )}
        </span>
        {!c.dollars && (
          <span className="bw-wcard-unit" role="group" aria-label="Balance unit" onClick={(e) => e.stopPropagation()}>
            <button type="button" className={unit === 'usd' ? 'is-on' : undefined} onClick={() => setUnit('usd')}>
              $
            </button>
            <button type="button" className={unit === 'own' ? 'is-on' : undefined} onClick={() => setUnit('own')}>
              {ownLabel}
            </button>
          </span>
        )}
      </div>
    </div>
  );
};

const GBP_PER_BSV = 327; // mock rate
const USD_PER_GBP = 1.27; // mock rate
type Chunk = { label: string; gbp: number; get: number; getText: string };
const chunksFor = (id: string): Chunk[] => {
  if (id === 'mandala')
    return [5, 10, 20, 50].map((d) => ({
      label: `$${d}`,
      gbp: d / USD_PER_GBP,
      get: d,
      getText: `$${d} Mandala credit`,
    }));
  if (id === 'mnee')
    return [5, 10, 20, 50].map((d) => ({ label: `$${d}`, gbp: d / USD_PER_GBP, get: d, getText: `${d} MNEE ($${d})` }));
  if (id !== 'bcredits' && id !== 'pnee')
    return [1, 5, 10, 20].map((p) => ({ label: `£${p}`, gbp: p, get: p * 100, getText: `${p * 100} tokens` }));
  return [1, 5, 10, 20].map((p) => {
    const get = id === 'pnee' ? Math.round(p * USD_PER_GBP * 100) : p * 100;
    return { label: `£${p}`, gbp: p, get, getText: `${fmtNum(get)} ${id === 'pnee' ? 'PNEEs' : 'bCredits'}` };
  });
};
const TOPUP_ISSUERS: [string, string, string][] = [
  ['bcredits', 'bCredits', 'The Bitcoin Corporation'],
  ['mandala', '$mandala', 'GorillaPool (Root)'],
  ['pnee', 'PNEEs', 'The Bitcoin Corporation'],
];

const TopUpCard = ({
  issuer,
  setIssuer,
  onPaid,
}: {
  issuer: string;
  setIssuer: (id: string) => void;
  onPaid: (id: string, amount: number) => void;
}) => {
  const [flipped, setFlipped] = useState(false);
  const [turning, setTurning] = useState(false);
  const [pick, setPick] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const chunks = chunksFor(issuer);
  const ch = chunks[Math.min(pick, chunks.length - 1)];
  const bsv = (ch.gbp / GBP_PER_BSV).toFixed(4);
  const payee = TOPUP_ISSUERS.find((t) => t[0] === issuer)![2];
  const flip = () => {
    setTurning(true);
    window.setTimeout(() => setFlipped((f) => !f), 220);
    window.setTimeout(() => setTurning(false), 440);
  };
  if (flipped)
    return (
      <div className={`bw-bc bw-bc-back bw-tu${turning ? ' is-turning' : ''}`} onClick={flip}>
        <FlipBtn onFlip={flip} />
        <div className="bw-tu-title">TOP-UP · terms</div>
        <div className="bw-bc-terms">
          <span>bCredits: 1p each. They don’t expire.</span>
          <span>Non-refundable except where the law requires.</span>
          <span>Maximum £20 per top-up.</span>
          <span>$mandala chunks are an example; PNEEs are 1¢ each.</span>
        </div>
        <span className="bw-bc-mock">MOCK</span>
      </div>
    );
  return (
    <div className={`bw-bc bw-tu${turning ? ' is-turning' : ''}`} onClick={flip}>
      <FlipBtn onFlip={flip} />
      <div className="bw-tu-title">
        <span className="bw-tu-plus">+</span> TOP-UP <span className="bw-bc-mock">MOCK</span>
      </div>
      <div className="bw-tu-chips" onClick={(e) => e.stopPropagation()}>
        {TOPUP_ISSUERS.map(([id, label]) => (
          <button
            type="button"
            key={id}
            className={issuer === id ? 'is-on' : undefined}
            onClick={() => {
              setIssuer(id);
              setPick(1);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="bw-tu-chunks" onClick={(e) => e.stopPropagation()}>
        {chunks.map((k, i) => (
          <button type="button" key={k.label} className={i === pick ? 'is-on' : undefined} onClick={() => setPick(i)}>
            <b>{k.label}</b>
            <small>→ {k.getText}</small>
            <small>≈ {(k.gbp / GBP_PER_BSV).toFixed(4)} BSV</small>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="bw-tu-go"
        onClick={(e) => {
          e.stopPropagation();
          setConfirm(true);
        }}
      >
        Top up {ch.label}
      </button>
      {confirm && (
        <Layer sheet onClose={() => setConfirm(false)}>
          <div className="bw-bcar-sheet bw-layer-scroll">
            <span className="bw-bc-mock">MOCK · no payment is made</span>
            <h3>Confirm top-up</h3>
            <p className="bw-tu-confirm">
              Pay ≈{bsv} BSV to {payee} for {ch.getText}.
            </p>
            <button
              type="button"
              className="bw-bcar-done"
              onClick={() => {
                setConfirm(false);
                onPaid(issuer, ch.get);
              }}
            >
              Confirm
            </button>
            <button type="button" className="bw-tu-cancel" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </Layer>
      )}
    </div>
  );
};

/** Per-card top-up: full screen in the issuer's colour, only that credit's chunks and terms. */
const TopUpForm = ({
  c,
  onClose,
  onPaid,
}: {
  c: MockBalance;
  onClose: () => void;
  onPaid: (amount: number) => void;
}) => {
  const chunks = chunksFor(c.id);
  const [pick, setPick] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const ch = chunks[pick];
  const bsv = (ch.gbp / GBP_PER_BSV).toFixed(4);
  const payee = c.issuer.split(' ·')[0];
  const terms =
    c.id === 'mandala'
      ? ['$1 paid = $1 credit. Amounts are an example.', 'Credit doesn’t expire.', 'Billed per active second.']
      : ['1p each. They don’t expire.', 'Non-refundable except where the law requires.', 'Maximum £20 per top-up.'];
  return (
    <Layer onClose={onClose}>
      <div
        className="bw-tuf bw-layer-scroll"
        style={{ ['--bc-bg' as string]: c.colour, ['--bc-ink' as string]: c.ink }}
      >
        <div className="bw-ag-grab" />
        <div className="bw-bc-top">
          <Logo c={c} size={34} className="bw-bc-logo" />
          <span className="bw-bc-head">
            <b>Top up {c.name}</b>
            <small>{c.issuer}</small>
          </span>
          <span className="bw-bc-mock">MOCK</span>
        </div>
        <div className="bw-tuf-chunks">
          {chunks.map((k, i) => (
            <button type="button" key={k.label} className={i === pick ? 'is-on' : undefined} onClick={() => setPick(i)}>
              <b>{k.label}</b>
              <span>→ {k.getText}</span>
              <small>≈ {(k.gbp / GBP_PER_BSV).toFixed(4)} BSV</small>
            </button>
          ))}
        </div>
        <ul className="bw-tuf-terms">
          {terms.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        {confirm ? (
          <div className="bw-tuf-confirm">
            <p>
              Pay ≈{bsv} BSV to {payee} for {ch.getText}.
            </p>
            <button type="button" className="bw-tuf-go" onClick={() => onPaid(ch.get)}>
              Confirm
            </button>
            <button type="button" className="bw-tuf-sec" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <button type="button" className="bw-tuf-go" onClick={() => setConfirm(true)}>
              Top up {ch.label}
            </button>
            <button type="button" className="bw-tuf-sec" onClick={onClose}>
              Close
            </button>
          </>
        )}
      </div>
    </Layer>
  );
};

/* ---------- Baskets (iPhone-style folders) ---------- */

const TOKEN_SEED: [string, string, string][] = [
  ['DIVVY', '#3a7bd5', '#fff'],
  ['MONEYBUTTON', '#e5484d', '#fff'],
  ['KWEG', '#7c3aed', '#fff'],
  ['NPG', '#e11d74', '#fff'],
  ['CHERRY', '#b91c1c', '#fff'],
  ['REPO', '#0f766e', '#fff'],
  ['1SHOT', '#f97316', '#111'],
  ['NERD', '#16a34a', '#fff'],
  ['DNSDEX', '#0ea5e9', '#111'],
  ['FLOOP', '#facc15', '#111'],
  ['TRIBE', '#a16207', '#fff'],
  ['KINTSUGI', '#1c1917', '#ffd24d'],
];
const TOKENS: MockBalance[] = TOKEN_SEED.map(([t, colour, ink], i) => ({
  id: `tok-${t.toLowerCase()}`,
  name: `$${t}`,
  issuer: 'BSV-21 token',
  unit: 'tokens',
  balance: 1000 * (i + 3) + 250 * i,
  usdPer: 0.0005 * (i + 1),
  colour,
  ink,
  initial: t[0],
  about: `$${t} tokens held in this wallet (mock).`,
  contact: `$${t.toLowerCase()}`,
}));
const tokenCard = (id: string, sym: string, icon: string | null, balance: number, mock: boolean): MockBalance => ({
  id: `tok-${id}`,
  name: `$${sym}`,
  issuer: mock ? 'Exchange token · mock balance' : 'BSV-21 token · in your wallet',
  unit: 'tokens',
  balance,
  usdPer: 0.0005,
  colour: '#16161a',
  ink: '#ffd24d',
  initial: (sym[0] ?? '?').toUpperCase(),
  icon,
  about: mock ? `$${sym}: a live Exchange token, shown with a mock balance.` : `$${sym} held in this wallet.`,
  contact: `$${sym.toLowerCase()}`,
});

/** The wallet's own BSV-21 balances, read-only from its per-account cache (wallet/tokenCache.ts). */
const readHeldTokens = (): MockBalance[] => {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith('bwallet:bsv21-cache:')) continue;
      const list = JSON.parse(localStorage.getItem(k) ?? '[]') as {
        id?: string;
        sym?: string;
        icon?: string | null;
        dec?: number;
        all?: { confirmed?: string | number };
      }[];
      const held = list
        .filter((t) => t.id && Number(t.all?.confirmed ?? 0) > 0)
        .map((t) =>
          tokenCard(
            t.id!,
            t.sym || t.id!.slice(0, 6),
            t.icon ?? null,
            Number(t.all!.confirmed) / 10 ** (t.dec ?? 0),
            false,
          ),
        );
      if (held.length) return held;
    }
  } catch {
    /* no cache */
  }
  return [];
};

type Item = { kind: 'card'; id: string } | { kind: 'basket'; id: string; name: string; members: string[] };
type Layout = { row: Item[]; hidden: string[] };
const LAYOUT_KEY = 'bw-mock-balance-layout-v3';
const SEED: Layout = {
  row: [
    { kind: 'card', id: 'bsv' },
    { kind: 'basket', id: 'b-credits', name: 'Credits', members: ['bcredits', 'mandala'] },
    { kind: 'card', id: 'mnee' },
    { kind: 'card', id: 'pnee' },
    { kind: 'card', id: 'tickets' },
    { kind: 'basket', id: 'b-shares', name: 'Shares', members: ['bcorp', 'sh-acme', 'sh-teapot'] },
    { kind: 'basket', id: 'b-tokens', name: 'Tokens', members: [] },
    { kind: 'card', id: 'topup' },
  ],
  hidden: [],
};
const loadLayout = (): Layout => {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as Layout | null;
    if (v && Array.isArray(v.row) && Array.isArray(v.hidden)) return v;
  } catch {
    /* private mode etc. */
  }
  return SEED;
};
const saveLayout = (l: Layout) => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* ignore */
  }
};
const defaultBasketName = (ids: string[]) =>
  ids.every((i) => i.startsWith('tok-')) ? 'Tokens' : ids.some((i) => i.startsWith('tok-')) ? 'Basket' : 'Credits';

/** A card's logo: real token icons via the Exchange's TokenIcon (gold initial only if the image fails). */
const Logo = ({ c, size, className }: { c: MockBalance | undefined; size: number; className: string }) =>
  c?.iconUrl ? (
    <span className={`${className} is-icon`}>
      <img src={c.iconUrl} alt="" width={size} height={size} style={{ borderRadius: '50%' }} />
    </span>
  ) : c && c.icon !== undefined ? (
    <span className={`${className} is-icon`}>
      <TokenIcon icon={c.icon} sym={c.name} size={size} />
    </span>
  ) : (
    <span className={className} style={c ? { background: c.colour, color: c.ink } : undefined}>
      {c?.initial ?? '₿'}
    </span>
  );

const MiniLogo = ({ c }: { c: MockBalance | undefined }) =>
  c ? <Logo c={c} size={14} className="bw-mini" /> : <span className="bw-mini is-bsv">₿</span>;

/* ---------- KYC gate for Shares (mirrors bit-sign: start → Veriff → approved → wallet KYC certificate) ---------- */
const KYC_KEY = 'bw-mock-kyc-verified';
const kycOk = () => {
  try {
    return localStorage.getItem(KYC_KEY) === '1';
  } catch {
    return false;
  }
};
const setKyc = (v: boolean) => {
  try {
    if (v) localStorage.setItem(KYC_KEY, '1');
    else localStorage.removeItem(KYC_KEY);
  } catch {
    /* ignore */
  }
};

const KycGate = ({ onDone, onClose }: { onDone: () => void; onClose: () => void }) => {
  const [step, setStep] = useState<'gate' | 'start' | 'check' | 'verified' | 'cert' | 'investor'>('gate');
  const [ticks, setTicks] = useState({ soph: false, hnw: false });
  useEffect(() => {
    if (step === 'check') {
      const t = window.setTimeout(() => setStep('verified'), 1800);
      return () => window.clearTimeout(t);
    }
    if (step === 'verified') {
      const t = window.setTimeout(() => setStep('cert'), 1200);
      return () => window.clearTimeout(t);
    }
  }, [step]);
  const finish = () => {
    setKyc(true);
    onDone();
  };
  return (
    <Layer onClose={onClose}>
      <div className="bw-kyc bw-layer-scroll">
        <span className="bw-bc-mock">MOCK · demo only, no ID is checked</span>
        {step === 'gate' && (
          <>
            <div className="bw-kyc-lock">🔒</div>
            <h2>Shares are for verified holders.</h2>
            <p>Verify who you are once to see and manage shares.</p>
            <button type="button" className="bw-tuf-go" onClick={() => setStep('start')}>
              Verify with Veriff
            </button>
            <button type="button" className="bw-tuf-sec" onClick={onClose}>
              Not now
            </button>
          </>
        )}
        {step !== 'gate' && (
          <ol className="bw-kyc-steps">
            <li className={step === 'start' ? 'is-on' : 'is-done'}>Start</li>
            <li className={step === 'check' ? 'is-on' : step === 'start' ? '' : 'is-done'}>Veriff check (demo)</li>
            <li className={step === 'verified' || step === 'cert' || step === 'investor' ? 'is-done' : ''}>
              Verified ✓
            </li>
          </ol>
        )}
        {step === 'start' && (
          <>
            <p>We’ll open Veriff to check a photo ID and a selfie. It takes about two minutes.</p>
            <button type="button" className="bw-tuf-go" onClick={() => setStep('check')}>
              Start the ID check
            </button>
          </>
        )}
        {step === 'check' && <p className="bw-kyc-wait">Veriff check (demo)… checking your ID</p>}
        {(step === 'verified' || step === 'cert') && (
          <>
            <h2>Verified ✓</h2>
            {step === 'cert' && (
              <>
                <p>
                  Your wallet now holds a KYC certificate from bit-sign (mock). Apps can check it without seeing your
                  documents.
                </p>
                <button type="button" className="bw-tuf-go" onClick={() => setStep('investor')}>
                  Continue
                </button>
                <button type="button" className="bw-tuf-sec" onClick={finish}>
                  Skip, open Shares
                </button>
              </>
            )}
          </>
        )}
        {step === 'investor' && (
          <>
            <h2>Self-certify as an investor (demo)</h2>
            <p>Tick any statement that applies to you. This is a mock; nothing is recorded.</p>
            <label className="bw-kyc-check">
              <input
                type="checkbox"
                checked={ticks.soph}
                onChange={(e) => setTicks({ ...ticks, soph: e.target.checked })}
              />
              I’m a self-certified sophisticated investor
            </label>
            <label className="bw-kyc-check">
              <input
                type="checkbox"
                checked={ticks.hnw}
                onChange={(e) => setTicks({ ...ticks, hnw: e.target.checked })}
              />
              I’m a high net worth individual
            </label>
            <button type="button" className="bw-tuf-go" onClick={finish}>
              Open Shares
            </button>
          </>
        )}
      </div>
    </Layer>
  );
};

const BasketCard = ({
  b,
  cards,
  onOpen,
}: {
  b: Extract<Item, { kind: 'basket' }>;
  cards: MockBalance[];
  onOpen: () => void;
}) => {
  const [flipped, setFlipped] = useState(false);
  const [turning, setTurning] = useState(false);
  const flip = () => {
    setTurning(true);
    window.setTimeout(() => setFlipped((f) => !f), 220);
    window.setTimeout(() => setTurning(false), 440);
  };
  const members = b.members.map((m) => cards.find((c) => c.id === m)).filter((c): c is MockBalance => !!c);
  const usd = members.reduce((t, c) => t + c.balance * c.usdPer, 0);
  if (flipped)
    return (
      <div className={`bw-bc bw-bc-back bw-bk${turning ? ' is-turning' : ''}`} onClick={flip}>
        <FlipBtn onFlip={flip} />
        <div className="bw-tu-title">{b.name}</div>
        <div className="bw-bk-list">
          {members.map((c) => (
            <span key={c.id}>
              <MiniLogo c={c} /> {c.name}
              <b>
                {c.dollars ? `$${c.balance.toFixed(2)}` : fmtNum(c.balance)} {c.dollars ? '' : c.unit}
              </b>
            </span>
          ))}
        </div>
      </div>
    );
  return (
    <div
      className={`bw-bc bw-bk${turning ? ' is-turning' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <FlipBtn onFlip={flip} />
      <div className="bw-bc-top">
        <span className="bw-bk-grid">
          {members.slice(0, 9).map((c) => (
            <MiniLogo key={c.id} c={c} />
          ))}
        </span>
        <span className="bw-bc-head">
          <b>
            {b.name}
            {b.id === 'b-shares' && kycOk() && <span className="bw-kyc-tick"> ✓ Verified</span>}
          </b>
          <small>
            {members.length} cards · basket <span className="bw-bc-mock">MOCK</span>
          </small>
        </span>
      </div>
      <div className="bw-bc-amt">≈ {fmtUsd(usd)}</div>
      <div className="bw-bc-sub">≈ combined at mock rates · tap to open</div>
    </div>
  );
};

type CardHooks = {
  chipFor: (id: string) => string | null;
  contractFor: (id: string) => MockContract | null;
  onStop: () => void;
  onPaid: (id: string, amount: number) => void;
  running: boolean;
  onRun: () => void;
};

const renderCard = (c: MockBalance, h: CardHooks) => (
  <MockCard
    c={c}
    chip={h.chipFor(c.id)}
    contract={h.contractFor(c.id)}
    onStop={h.onStop}
    onPaid={h.onPaid}
    running={c.id === 'mandala' ? h.running : undefined}
    onRun={c.id === 'mandala' ? h.onRun : undefined}
  />
);

const BasketView = ({
  b,
  cards,
  hooks,
  onClose,
  onRename,
}: {
  b: Extract<Item, { kind: 'basket' }>;
  cards: MockBalance[];
  hooks: CardHooks;
  onClose: () => void;
  onRename: (name: string) => void;
}) => {
  const [open, setOpen] = useState<string | null>(null);
  const members = b.members.map((m) => cards.find((c) => c.id === m)).filter((c): c is MockBalance => !!c);
  const card = open ? members.find((m) => m.id === open) : undefined;
  return (
    <Layer onClose={onClose}>
      <div className="bw-bkv bw-layer-scroll">
        <div className="bw-ag-grab" />
        <input
          className="bw-bkv-name"
          value={b.name}
          onChange={(e) => onRename(e.target.value)}
          aria-label="Basket name"
        />
        {card ? (
          <>
            <div className="bw-bkv-card">{renderCard(card, hooks)}</div>
            <button type="button" className="bw-tuf-sec" onClick={() => setOpen(null)}>
              Back to {b.name}
            </button>
          </>
        ) : (
          <div className="bw-bkv-grid">
            {members.map((c) => (
              <button type="button" key={c.id} onClick={() => setOpen(c.id)}>
                <Logo c={c} size={56} className="bw-bkv-tile" />
                <small>{c.name}</small>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="bw-tuf-sec" onClick={onClose}>
          Close
        </button>
      </div>
    </Layer>
  );
};

/** Jiggle mode: drag a card onto another to make a basket, onto a basket to add it, or out of a basket. */
const EditGrid = ({
  layout,
  cards,
  onChange,
  onDone,
  onResetKyc,
}: {
  layout: Layout;
  cards: MockBalance[];
  onChange: (l: Layout) => void;
  onDone: () => void;
  onResetKyc: () => void;
}) => {
  const [openB, setOpenB] = useState<string | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    from: string | null;
    x: number;
    y: number;
    sx: number;
    sy: number;
  } | null>(null);
  const nameOf = (id: string) =>
    id === 'bsv'
      ? 'BSV'
      : id === 'topup'
        ? 'TOP-UP'
        : id === 'tickets'
          ? 'Tickets'
          : (cards.find((c) => c.id === id)?.name ?? id);
  const card = (id: string) => cards.find((c) => c.id === id);

  const drop = (srcId: string, from: string | null, target: string | null) => {
    if (target === srcId) return;
    const row = layout.row.map((it) => (it.kind === 'basket' ? { ...it, members: [...it.members] } : it));
    // take the source out
    let src: Item | undefined;
    if (from) {
      const b = row.find((i) => i.id === from);
      if (b?.kind === 'basket') b.members = b.members.filter((m) => m !== srcId);
      src = { kind: 'card', id: srcId };
    } else {
      const i = row.findIndex((it) => it.id === srcId);
      src = row[i];
      row.splice(i, 1);
    }
    if (!src) return;
    if (target === '__out' || target === null) {
      row.push(src);
    } else {
      const ti = row.findIndex((it) => it.id === target);
      const t = row[ti];
      if (!t) row.push(src);
      else if (t.kind === 'basket') {
        if (src.kind === 'card') t.members.push(src.id);
        else t.members.push(...src.members);
      } else if (src.kind === 'card' && t.id !== 'bsv' && t.id !== 'topup' && src.id !== 'bsv' && src.id !== 'topup') {
        const members = [t.id, src.id];
        row[ti] = { kind: 'basket', id: `b-${Date.now()}`, name: defaultBasketName(members), members };
      } else row.splice(ti, 0, src);
    }
    // a basket with fewer than 2 cards dissolves
    const clean: Item[] = [];
    for (const it of row) {
      if (it.kind === 'basket' && it.members.length < 2) {
        if (it.members.length === 1) clean.push({ kind: 'card', id: it.members[0] });
        if (openB === it.id) setOpenB(null);
      } else clean.push(it);
    }
    onChange({ ...layout, row: clean });
  };

  // Hold ~0.25 s to pick a tile up; a quick move first is a scroll (so long grids scroll freely).
  const pending = useRef<{ id: string; from: string | null; sx: number; sy: number; t: number } | null>(null);
  const start = (id: string, from: string | null) => (e: React.PointerEvent) => {
    const sx = e.clientX;
    const sy = e.clientY;
    const t = window.setTimeout(() => {
      if (id !== 'bsv') setDrag({ id, from, x: sx, y: sy, sx, sy });
    }, 250);
    pending.current = { id, from, sx, sy, t };
  };
  const moveP = (e: React.PointerEvent) => {
    const p = pending.current;
    if (p && !drag && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) {
      window.clearTimeout(p.t);
      pending.current = null;
    }
    if (drag) {
      setDrag({ ...drag, x: e.clientX, y: e.clientY });
      // Auto-scroll the grid when a held tile nears the top or bottom edge.
      const sc = (e.currentTarget as HTMLElement).closest('.bw-eg');
      const h = window.innerHeight;
      if (sc && e.clientY < 90) sc.scrollTop -= (90 - e.clientY) / 3;
      else if (sc && e.clientY > h - 90) sc.scrollTop += (e.clientY - (h - 90)) / 3;
    }
  };
  // While a tile is held, stop the page scrolling under the finger.
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    const stop = (ev: TouchEvent) => ev.preventDefault();
    document.addEventListener('touchmove', stop, { passive: false });
    return () => document.removeEventListener('touchmove', stop);
  }, [dragging]);
  // Reorder within the row, or within an open basket (iPhone style: drop in a gap or on a tile's edge).
  const reorder = (srcId: string, scope: string | null, targetId: string, after: boolean) => {
    const place = <T,>(list: T[], key: (t: T) => string) => {
      const i = list.findIndex((t) => key(t) === srcId);
      if (i < 0) return list;
      const n = [...list];
      const [x] = n.splice(i, 1);
      let j = n.findIndex((t) => key(t) === targetId);
      if (j < 0) return list;
      if (after) j += 1;
      n.splice(j, 0, x);
      return n;
    };
    if (scope)
      onChange({
        ...layout,
        row: layout.row.map((it) =>
          it.id === scope && it.kind === 'basket' ? { ...it, members: place(it.members, (m) => m) } : it,
        ),
      });
    else onChange({ ...layout, row: place(layout.row, (it) => it.id) });
  };
  const end = (e: React.PointerEvent) => {
    const p = pending.current;
    if (p) window.clearTimeout(p.t);
    pending.current = null;
    if (!drag) {
      if (p && p.from === null && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < 8) {
        const it = layout.row.find((i) => i.id === p.id);
        if (it?.kind === 'basket' && (it.id !== 'b-shares' || kycOk())) setOpenB(it.id);
      }
      return;
    }
    const d = drag;
    setDrag(null);
    const x = e.clientX;
    const y = e.clientY;
    if (Math.hypot(x - d.sx, y - d.sy) < 6) {
      if (d.from === null) {
        const it = layout.row.find((i) => i.id === d.id);
        if (it?.kind === 'basket' && (it.id !== 'b-shares' || kycOk())) setOpenB(it.id);
      }
      return;
    }
    const out = document.elementsFromPoint(x, y).some((el) => (el as HTMLElement).dataset?.drop === '__out');
    if (out && d.from) return drop(d.id, d.from, '__out');
    const scope = d.from ?? 'row';
    const tiles = Array.from(document.querySelectorAll<HTMLElement>(`[data-tile][data-scope="${scope}"]`)).filter(
      (el) => el.dataset.tile !== d.id,
    );
    if (!tiles.length) return;
    let best = tiles[0];
    let bestD = Infinity;
    for (const el of tiles) {
      const b = el.getBoundingClientRect();
      const dist = Math.hypot(x - (b.left + b.width / 2), y - (b.top + b.height / 2));
      if (dist < bestD) {
        bestD = dist;
        best = el;
      }
    }
    const b = best.getBoundingClientRect();
    const inside = x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    const middle = inside && Math.abs(x - (b.left + b.width / 2)) < b.width * 0.22;
    const target = best.dataset.tile!;
    // Onto the middle of another tile in the row: make or join a basket. Anywhere else: move into that gap.
    if (middle && !d.from) drop(d.id, null, target);
    else reorder(d.id, d.from, target, x > b.left + b.width / 2);
  };
  const basket = layout.row.find((i) => i.id === openB);
  const tile = (id: string, from: string | null, label: string, logo: ReactNode) => (
    <div
      key={id}
      data-tile={id}
      data-scope={from ?? 'row'}
      className={`bw-eg-tile${drag?.id === id ? ' is-drag' : ''}${layout.hidden.includes(id) ? ' is-hidden' : ''}`}
      onPointerDown={start(id, from)}
      onPointerMove={moveP}
      onPointerUp={end}
      onPointerCancel={() => {
        if (pending.current) window.clearTimeout(pending.current.t);
        pending.current = null;
        setDrag(null);
      }}
      style={drag?.id === id ? { transform: 'scale(1.1)', zIndex: 3 } : undefined}
    >
      {logo}
      <small>{label}</small>
      {!from && id !== 'bsv' && (
        <button
          type="button"
          className="bw-eg-hide"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() =>
            onChange({
              ...layout,
              hidden: layout.hidden.includes(id) ? layout.hidden.filter((h) => h !== id) : [...layout.hidden, id],
            })
          }
        >
          {layout.hidden.includes(id) ? '+' : '–'}
        </button>
      )}
    </div>
  );
  return (
    <Layer onClose={onDone}>
      <div className="bw-eg bw-layer-scroll">
        <div className="bw-eg-head">
          <b>Edit cards</b>
          <span className="bw-bc-mock">MOCK</span>
          <button type="button" onClick={onDone}>
            Done
          </button>
        </div>
        <p className="bw-eg-hint">
          Drag a card into a gap to move it; drop it onto another card to make a basket. Tap a basket to open it; drag a
          card out to take it out. – hides a card.
        </p>
        <div className="bw-eg-grid">
          {layout.row.map((it) =>
            it.kind === 'basket'
              ? tile(
                  it.id,
                  null,
                  it.name,
                  <span className="bw-eg-folder">
                    {it.members.slice(0, 9).map((m) => (
                      <MiniLogo key={m} c={card(m)} />
                    ))}
                  </span>,
                )
              : tile(
                  it.id,
                  null,
                  nameOf(it.id),
                  it.id === 'topup' ? (
                    <span className="bw-eg-logo is-top">+</span>
                  ) : it.id === 'tickets' ? (
                    <span className="bw-eg-logo is-top">🎟</span>
                  ) : it.id === 'bsv' ? (
                    <span className="bw-eg-logo is-bsv">₿</span>
                  ) : (
                    <Logo c={card(it.id)} size={56} className="bw-eg-logo" />
                  ),
                ),
          )}
        </div>
        {basket?.kind === 'basket' && (
          <div className="bw-eg-open">
            <input
              className="bw-bkv-name"
              value={basket.name}
              aria-label="Basket name"
              onChange={(e) =>
                onChange({
                  ...layout,
                  row: layout.row.map((i) => (i.id === basket.id ? { ...basket, name: e.target.value } : i)),
                })
              }
            />
            <div className="bw-eg-grid">
              {basket.members.map((m) =>
                tile(m, basket.id, nameOf(m), <Logo c={card(m)} size={56} className="bw-eg-logo" />),
              )}
            </div>
            <div className="bw-eg-out" data-drop="__out">
              Drag here to take a card out of {basket.name}
            </div>
          </div>
        )}
        <button type="button" className="bw-tuf-sec" onClick={() => onChange(SEED)}>
          Reset to the example layout
        </button>
        <button type="button" className="bw-tuf-sec" onClick={onResetKyc}>
          Reset verification (mock)
        </button>
      </div>
    </Layer>
  );
};

/* ---------- Tickets card ---------- */
type TicketRow = { id: string; name: string; opens: string; when: string };
const MOCK_TICKETS: TicketRow[] = [
  { id: 'm1', name: 'Lounge pass', opens: 'The Lounge (always-on Space)', when: 'Live now' },
  { id: 'm2', name: 'VexVoid listening party', opens: 'VexVoid’s Space · Fri 8pm', when: 'Fri 17 Oct' },
  { id: 'm3', name: 'Frogger room', opens: '$FROGGER holders’ room', when: 'Any time' },
];
/** Real tickets when this device knows them (wallet token cache ∩ remembered ticket ids), else the mock list. */
const readTickets = (): { rows: TicketRow[]; real: boolean } => {
  try {
    const ids = new Set(rememberedTicketIds());
    if (ids.size)
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith('bwallet:bsv21-cache:')) continue;
        const list = JSON.parse(localStorage.getItem(k) ?? '[]') as { id?: string; sym?: string }[];
        const rows = list
          .filter((t) => t.id && ids.has(t.id))
          .map((t) => ({
            id: t.id!,
            name: `$${t.sym ?? t.id!.slice(0, 6)}`,
            opens: `$${t.sym ?? ''} room`,
            when: 'Any time',
          }));
        if (rows.length) return { rows, real: true };
      }
  } catch {
    /* no cache */
  }
  return { rows: MOCK_TICKETS, real: false };
};

const TicketsCard = () => {
  const [{ rows, real }] = useState(readTickets);
  const [flipped, setFlipped] = useState(false);
  const [turning, setTurning] = useState(false);
  const flip = () => {
    setTurning(true);
    window.setTimeout(() => setFlipped((f) => !f), 220);
    window.setTimeout(() => setTurning(false), 440);
  };
  const openPage = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    setWalletKind('tickets');
    window.setTimeout(() => window.scrollBy({ top: 420, behavior: 'smooth' }), 80);
  };
  const next = rows[0];
  if (flipped)
    return (
      <div className={`bw-bc bw-bc-back bw-tk${turning ? ' is-turning' : ''}`} onClick={flip}>
        <FlipBtn onFlip={flip} />
        <div className="bw-tu-title">Your tickets</div>
        <div className="bw-bk-list">
          {rows.map((t) => (
            <span key={t.id}>
              🎟 {t.name}
              <b>{t.opens}</b>
            </span>
          ))}
        </div>
        <button type="button" className="bw-bc-contact" onClick={openPage}>
          Open Tickets
        </button>
      </div>
    );
  return (
    <div className={`bw-bc bw-tk${turning ? ' is-turning' : ''}`} onClick={flip}>
      <FlipBtn onFlip={flip} />
      <div className="bw-bc-top">
        <span className="bw-bc-logo">🎟</span>
        <span className="bw-bc-head">
          <b>Tickets</b>
          <small>Space and room passes</small>
        </span>
        {!real && <span className="bw-bc-mock">MOCK</span>}
      </div>
      <div className="bw-bc-amt">
        {rows.length}
        <span className="bw-bc-unitword"> {rows.length === 1 ? 'ticket' : 'tickets'}</span>
      </div>
      <div className="bw-bc-sub">
        {next ? (
          <>
            Next: <b>{next.name}</b> · {next.when}
          </>
        ) : (
          'No tickets yet'
        )}
      </div>
    </div>
  );
};

/* ---------- Time Machine: every card in a 3D stack receding into space ---------- */
type TmCard = { key: string; title: string; sub: string; colour: string; ink: string; logo: ReactNode };
const reducedMotionTm = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
const TimeMachine = ({
  cards,
  start,
  onPick,
  onClose,
  onEdit,
}: {
  cards: TmCard[];
  start: number;
  onPick: (i: number) => void;
  onClose: () => void;
  onEdit: () => void;
}) => {
  const [focus, setFocus] = useState(start);
  const [reduced] = useState(reducedMotionTm);
  const t0 = useRef<{ y: number; f: number } | null>(null);
  const clamp = (f: number) => Math.max(0, Math.min(cards.length - 1, f));
  return (
    <Layer onClose={onClose}>
      <div
        className={`bw-tm${reduced ? ' is-flat' : ''}`}
        onWheel={(e) => setFocus((f) => clamp(f + e.deltaY / 240))}
        onTouchStart={(e) => (t0.current = { y: e.touches[0].clientY, f: focus })}
        onTouchMove={(e) => {
          if (!t0.current || reduced) return;
          setFocus(clamp(t0.current.f + (t0.current.y - e.touches[0].clientY) / 120));
        }}
        onTouchEnd={() => {
          t0.current = null;
          if (!reduced) setFocus((f) => Math.round(f));
        }}
      >
        <div className="bw-tm-stars" />
        <div className="bw-tm-head">
          <b>All cards</b>
          <span>
            <button type="button" onClick={onEdit}>
              Edit
            </button>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </span>
        </div>
        <div className="bw-tm-stage">
          {cards.map((c, i) => {
            const o = i - focus;
            const style = reduced
              ? undefined
              : {
                  transform: `translate(-50%, -50%) translate3d(0, ${-o * 46}px, ${-o * 260}px) scale(${o < 0 ? 1 - o * 0.25 : 1})`,
                  opacity: o < -0.9 ? 0 : Math.max(0, 1 - o * 0.16),
                  zIndex: 1000 - Math.round(o * 10),
                  pointerEvents: (o < -0.5 ? 'none' : 'auto') as 'none' | 'auto',
                  filter: o > 0.5 ? `brightness(${Math.max(0.45, 1 - o * 0.1)})` : undefined,
                };
            return (
              <button
                type="button"
                key={c.key}
                className="bw-tm-card"
                style={{ ...style, background: c.colour, color: c.ink }}
                onClick={() => (reduced || Math.abs(o) < 0.5 ? onPick(i) : setFocus(i))}
              >
                <span className="bw-tm-logo">{c.logo}</span>
                <span className="bw-tm-text">
                  <b>{c.title}</b>
                  <small>{c.sub}</small>
                </span>
              </button>
            );
          })}
        </div>
        <p className="bw-tm-hint">Swipe up and down to fly through · tap a card to land on it</p>
      </div>
    </Layer>
  );
};

export const BalanceCarousel = ({ bsvCard }: { bsvCard: ReactNode }) => {
  const navigate = useNavigate();
  const [cards, setCards] = useState<MockBalance[]>(MOCK);
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const setLayout = (l: Layout) => {
    setLayoutState(l);
    saveLayout(l);
  };
  const [topIssuer, setTopIssuer] = useState('bcredits');
  const [running, setRunning] = useState(false);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState(false);
  const [openBasket, setOpenBasket] = useState<string | null>(null);
  const [spending, setSpending] = useState<string | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const [contract, setContract] = useState<MockContract | null>(null);
  const demoRef = useRef<{ tick: number | null; end: number | null; back: string }>({
    tick: null,
    end: null,
    back: 'bsv',
  });
  const track = useRef<HTMLDivElement>(null);

  // Tokens basket: the wallet's real BSV-21 holdings (read-only, from its cache), topped up with live Exchange
  // tokens (real icons, mock balances) to ~60 so the basket shows scale. The 12 fake tokens only if both fail.
  useEffect(() => {
    let live = true;
    const held = readHeldTokens();
    const fill = (extra: MockBalance[]) => {
      if (!live) return;
      const seen = new Set(held.map((t) => t.id));
      const list = [...held, ...extra.filter((t) => !seen.has(t.id))].slice(0, Math.max(held.length, 60));
      const tokens = list.length ? list : TOKENS;
      setCards([...MOCK, ...tokens]);
      setLayoutState((l) => {
        const ids = new Set(tokens.map((t) => t.id));
        const placed = new Set<string>();
        const row = l.row
          .map((it) => {
            if (it.kind !== 'basket') return it;
            const members = it.members.filter((m) => !m.startsWith('tok-') || ids.has(m));
            members.forEach((m) => placed.add(m));
            return { ...it, members };
          })
          .filter((it) => it.kind !== 'card' || !it.id.startsWith('tok-') || ids.has(it.id));
        row.forEach((it) => it.kind === 'card' && placed.add(it.id));
        const missing = tokens.map((t) => t.id).filter((id) => !placed.has(id));
        const tb = row.find((it) => it.id === 'b-tokens');
        const next: Layout = {
          ...l,
          row:
            tb?.kind === 'basket'
              ? row.map((it) =>
                  it.id === 'b-tokens' && it.kind === 'basket' ? { ...it, members: [...it.members, ...missing] } : it,
                )
              : [...row, { kind: 'basket', id: 'b-tokens', name: 'Tokens', members: missing }],
        };
        saveLayout(next);
        return next;
      });
    };
    tokenDirectory()
      .then((dir) =>
        fill(
          [...dir]
            .filter((t) => t.icon && t.sym)
            .sort((a, b) => b.outputs - a.outputs)
            .slice(0, 80)
            .map((t, i) => tokenCard(t.id, t.sym, t.icon, 1000 + ((i * 7919) % 50000), true)),
        ),
      )
      .catch(() => fill([]));
    return () => {
      live = false;
    };
  }, []);

  // MNEE: the wallet's real balance (BsvWallet shares the last fetch), read only.
  useEffect(() => {
    const read = () => {
      try {
        const v = Number(localStorage.getItem('bwallet:mnee-balance') ?? 'NaN');
        if (Number.isFinite(v)) setCards((cs) => cs.map((c) => (c.id === 'mnee' ? { ...c, balance: v } : c)));
      } catch {
        /* storage unavailable */
      }
    };
    read();
    window.addEventListener('bwallet:mnee-balance', read);
    return () => window.removeEventListener('bwallet:mnee-balance', read);
  }, []);

  // Mandala bills per active second while running (mock: $0.12/hour), nothing while suspended.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(
      () =>
        setCards((cs) =>
          cs.map((c) => (c.id === 'mandala' ? { ...c, balance: Math.max(0, c.balance - 0.12 / 3600) } : c)),
        ),
      1000,
    );
    return () => window.clearInterval(t);
  }, [running]);

  const basketOf = (id: string) =>
    layout.row.find((i): i is Extract<Item, { kind: 'basket' }> => i.kind === 'basket' && i.members.includes(id));
  // Slides: the layout minus hidden items; a card spending from inside a basket comes to the front.
  type Slide = { key: string; item: Item; from?: string };
  const slides: Slide[] = layout.row.filter((i) => !layout.hidden.includes(i.id)).map((i) => ({ key: i.id, item: i }));
  const spendingBasket = spending ? basketOf(spending) : undefined;
  if (spending && spendingBasket)
    slides.unshift({ key: `live-${spending}`, item: { kind: 'card', id: spending }, from: spendingBasket.name });
  const indexOf = (id: string) => {
    const i = slides.findIndex((s) => s.item.id === id);
    if (i >= 0) return i;
    const b = basketOf(id);
    return b ? slides.findIndex((s) => s.item.id === b.id) : -1;
  };

  const goTo = useCallback((i: number) => {
    const el = track.current;
    if (!el || i < 0) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }, []);
  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    setActive(Math.round(el.scrollLeft / el.clientWidth));
  };

  // Long-press anywhere on the carousel enters jiggle/edit mode.
  const press = useRef<number | null>(null);
  const startPress = () => {
    press.current = window.setTimeout(() => setTm(true), 600);
  };
  const endPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };

  const backRef = useRef<string | null>(null);
  const stopDemo = () => {
    const d = demoRef.current;
    if (d.tick !== null) window.clearInterval(d.tick);
    if (d.end !== null) window.clearTimeout(d.end);
    d.tick = d.end = null;
    setSpending(null);
    setChip(null);
    setContract(null);
    backRef.current = d.back;
  };
  // After the live slide is removed, return to the card we came from.
  useEffect(() => {
    if (spending || !backRef.current) return;
    const id = backRef.current;
    backRef.current = null;
    window.setTimeout(() => goTo(indexOf(id)), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spending]);

  // Demo: b spends 2 bCredits per reply every 3 s for ~20 s; the card follows the money, then returns.
  const demo = () => {
    if (spending) return;
    demoRef.current.back = slides[active]?.item.id ?? 'bsv';
    setOpenBasket(null);
    setSpending('bcredits');
    setChip('b · 2 bCredits/reply');
    setContract({ what: 'Ask b replies', rate: '2 bCredits per reply', startedAt: Date.now(), spent: 0 });
    window.setTimeout(() => goTo(indexOf('bcredits') >= 0 && basketOf('bcredits') ? 0 : indexOf('bcredits')), 50);
    let n = 0;
    demoRef.current.tick = window.setInterval(() => {
      n += 1;
      setCards((cs) => cs.map((c) => (c.id === 'bcredits' ? { ...c, balance: Math.max(0, c.balance - 2) } : c)));
      setContract((k) => (k ? { ...k, spent: k.spent + 2 } : k));
      if (n >= 7) {
        if (demoRef.current.tick !== null) window.clearInterval(demoRef.current.tick);
        demoRef.current.tick = null;
        demoRef.current.end = window.setTimeout(stopDemo, 1200);
      }
    }, 3000);
  };

  useEffect(
    () => () => {
      endPress();
      const d = demoRef.current;
      if (d.tick !== null) window.clearInterval(d.tick);
      if (d.end !== null) window.clearTimeout(d.end);
    },
    [],
  );

  const paid = (id: string, amount: number) => {
    goTo(indexOf(id));
    window.setTimeout(
      () => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, balance: c.balance + amount } : c))),
      600,
    );
  };
  const hooks: CardHooks = {
    chipFor: (id) => (spending === id ? chip : null),
    contractFor: (id) => (spending === id ? contract : null),
    onStop: stopDemo,
    onPaid: paid,
    running,
    onRun: () => setRunning((x) => !x),
  };
  const nameOf = (id: string) =>
    id === 'bsv'
      ? 'BSV'
      : id === 'topup'
        ? 'TOP-UP'
        : id === 'tickets'
          ? 'Tickets'
          : (cards.find((c) => c.id === id)?.name ?? id);
  const bOpen = layout.row.find((i) => i.id === openBasket);
  const [gateFor, setGateFor] = useState<string | null>(null);
  const [, bump] = useState(0);
  const [tm, setTm] = useState(false);
  const tmCards: TmCard[] = slides.map(({ key, item }) => {
    if (item.id === 'bsv')
      return { key, title: 'BSV', sub: 'Your wallet', colour: '#16161a', ink: '#ffd24d', logo: '₿' };
    if (item.id === 'topup')
      return { key, title: 'TOP-UP', sub: 'Buy credits', colour: '#1a1608', ink: '#ffd24d', logo: '+' };
    if (item.id === 'tickets')
      return { key, title: 'Tickets', sub: 'Space and room passes', colour: '#2a1036', ink: '#ffd24d', logo: '🎟' };
    if (item.kind === 'basket')
      return {
        key,
        title: item.name,
        sub: `${item.members.length} cards`,
        colour: '#23200f',
        ink: '#ffd24d',
        logo: (
          <span className="bw-bk-grid">
            {item.members.slice(0, 9).map((m) => (
              <MiniLogo key={m} c={cards.find((c) => c.id === m)} />
            ))}
          </span>
        ),
      };
    const c = cards.find((x) => x.id === item.id);
    return {
      key,
      title: c?.name ?? item.id,
      sub: c ? (c.dollars ? `$${c.balance.toFixed(2)}` : `${fmtNum(c.balance)} ${c.unit}`) : '',
      colour: c?.colour ?? '#16161a',
      ink: c?.ink ?? '#ffd24d',
      logo: <Logo c={c} size={34} className="bw-bc-logo" />,
    };
  });
  // Shares: the mock Veriff KYC gate first, then the real bShares bApp (/m/bshares) instead of the mock basket.
  const openShares = () => (PLACEMENT_ENABLED ? navigate('/m/bshares') : setOpenBasket('b-shares'));
  const openGuarded = (id: string) =>
    id === 'b-shares' ? (kycOk() ? openShares() : setGateFor(id)) : setOpenBasket(id);

  return (
    <div className="bw-bcar">
      <div
        ref={track}
        className="bw-bcar-track"
        onScroll={onScroll}
        onTouchStart={startPress}
        onTouchEnd={endPress}
        onTouchMove={endPress}
        onContextMenu={(e) => {
          e.preventDefault();
          setTm(true);
        }}
      >
        {slides.map(({ key, item, from }) => (
          <div className="bw-bcar-slide" key={key}>
            {item.id === 'bsv' ? (
              <div className="bw-bcar-bsv">{bsvCard}</div>
            ) : item.id === 'tickets' ? (
              <div className="bw-bcar-mockwrap">
                <TicketsCard />
              </div>
            ) : item.id === 'topup' ? (
              <div className="bw-bcar-mockwrap">
                <TopUpCard issuer={topIssuer} setIssuer={setTopIssuer} onPaid={paid} />
              </div>
            ) : item.kind === 'basket' ? (
              <div className="bw-bcar-mockwrap">
                <BasketCard b={item} cards={cards} onOpen={() => openGuarded(item.id)} />
              </div>
            ) : (
              <div className="bw-bcar-mockwrap">
                {from && <span className="bw-bcar-from">from {from}</span>}
                {renderCard(cards.find((c) => c.id === item.id)!, hooks)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="bw-bcar-dots" aria-label={`Card ${active + 1} of ${slides.length}`}>
        {slides.map((s, i) => (
          <button
            type="button"
            key={s.key}
            aria-label={s.item.kind === 'basket' ? s.item.name : nameOf(s.item.id)}
            className={`${i === active ? 'is-on' : ''}${s.item.kind === 'basket' ? ' is-basket' : ''}`}
            onClick={() => goTo(i)}
          />
        ))}
      </div>
      <div className="bw-bcar-demo">
        <button type="button" onClick={demo} disabled={!!spending}>
          {spending ? 'b is spending…' : 'Demo spend (mock)'}
        </button>
        <button type="button" onClick={() => setEditing(true)}>
          Edit cards
        </button>
      </div>
      {bOpen?.kind === 'basket' && (
        <BasketView
          b={bOpen}
          cards={cards}
          hooks={hooks}
          onClose={() => setOpenBasket(null)}
          onRename={(name) =>
            setLayout({ ...layout, row: layout.row.map((i) => (i.id === bOpen.id ? { ...bOpen, name } : i)) })
          }
        />
      )}
      {editing && (
        <EditGrid
          layout={layout}
          cards={cards}
          onChange={setLayout}
          onDone={() => setEditing(false)}
          onResetKyc={() => {
            setKyc(false);
            bump((n) => n + 1);
          }}
        />
      )}
      {tm && (
        <TimeMachine
          cards={tmCards}
          start={active}
          onClose={() => setTm(false)}
          onEdit={() => {
            setTm(false);
            setEditing(true);
          }}
          onPick={(i) => {
            setTm(false);
            window.setTimeout(() => goTo(i), 60);
          }}
        />
      )}
      {gateFor && (
        <KycGate
          onClose={() => setGateFor(null)}
          onDone={() => {
            const id = gateFor;
            setGateFor(null);
            setEditing(false);
            if (id === 'b-shares') openShares();
            else setOpenBasket(id);
          }}
        />
      )}
    </div>
  );
};
