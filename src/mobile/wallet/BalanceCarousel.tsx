import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PenLine } from 'lucide-react';
import { useCountUp } from './live/useCountUp';
import './balanceCards.css';

/**
 * MOCKUP ONLY (branch mock/balance-cards, 14 Oct 2026): the wallet card as an Apple-Wallet-style swipe carousel,
 * one card per balance. The BSV card is the real WalletCard, untouched; every other card is MOCK DATA.
 * Nothing here signs, spends or fetches.
 */
export const MOCK_BALANCE_CARDS = true;

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
        startY.current = !sc || sc.scrollTop <= 0 ? e.touches[0].clientY : null;
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
  onTopUp,
  running,
  onRun,
}: {
  c: MockBalance;
  chip: string | null;
  contract: MockContract | null;
  onStop: () => void;
  onTopUp: () => void;
  running?: boolean;
  onRun?: () => void;
}) => {
  const [unit, setUnit] = useState<'own' | 'usd'>('own');
  const [flipped, setFlipped] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
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
          <span>Board minute BCORP-BM-2026-014 · signed with bit-sign</span>
        </div>
      </div>
    );
  if (flipped)
    return (
      <div className={`bw-bc bw-bc-back${turning ? ' is-turning' : ''}`} style={style} onClick={flip}>
        <FlipBtn onFlip={flip} />
        <div className="bw-bc-top">
          <span className="bw-bc-logo">{c.initial}</span>
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
                onTopUp();
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
          <button type="button" className="bw-bc-contact" onClick={contact}>
            Contact {c.contact}
          </button>
        </div>
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
        <span className="bw-bc-logo">{c.initial}</span>
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

type Slot = { id: string; hidden: boolean };

export const BalanceCarousel = ({ bsvCard }: { bsvCard: ReactNode }) => {
  const [cards, setCards] = useState(MOCK);
  const [slots, setSlots] = useState<Slot[]>(() => [
    { id: 'bsv', hidden: false },
    ...MOCK.map((m) => ({ id: m.id, hidden: false })),
    { id: 'topup', hidden: false },
  ]);
  const [topIssuer, setTopIssuer] = useState('bcredits');
  const [running, setRunning] = useState(false);
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
  const [active, setActive] = useState(0);
  const [sheet, setSheet] = useState(false);
  const [spending, setSpending] = useState<string | null>(null);
  const [chip, setChip] = useState<string | null>(null);
  const [contract, setContract] = useState<MockContract | null>(null);
  const demoRef = useRef<{ tick: number | null; end: number | null; back: number }>({ tick: null, end: null, back: 0 });
  const track = useRef<HTMLDivElement>(null);
  const visible = slots.filter((s) => !s.hidden);

  const goTo = useCallback((i: number) => {
    const el = track.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  }, []);

  const onScroll = () => {
    const el = track.current;
    if (!el || !el.clientWidth) return;
    setActive(Math.round(el.scrollLeft / el.clientWidth));
  };

  // Long-press anywhere on the carousel opens the reorder/hide sheet.
  const press = useRef<number | null>(null);
  const startPress = () => {
    press.current = window.setTimeout(() => setSheet(true), 600);
  };
  const endPress = () => {
    if (press.current !== null) window.clearTimeout(press.current);
    press.current = null;
  };

  // Demo: b spends 2 credits per reply every 3 s for ~20 s on $mandala; the card follows the money, then returns.
  const stopDemo = () => {
    const d = demoRef.current;
    if (d.tick !== null) window.clearInterval(d.tick);
    if (d.end !== null) window.clearTimeout(d.end);
    d.tick = d.end = null;
    setSpending(null);
    setChip(null);
    setContract(null);
    goTo(d.back);
  };
  const demo = () => {
    if (spending) return;
    const idx = visible.findIndex((s) => s.id === 'bcredits');
    if (idx < 0) return;
    demoRef.current.back = active;
    setSpending('bcredits');
    setChip('b · 2 bCredits/reply');
    setContract({ what: 'Ask b replies', rate: '2 bCredits per reply', startedAt: Date.now(), spent: 0 });
    goTo(idx);
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

  const move = (id: string, d: -1 | 1) =>
    setSlots((s) => {
      const i = s.findIndex((x) => x.id === id);
      const j = i + d;
      if (j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const nameOf = (id: string) =>
    id === 'bsv' ? 'BSV' : id === 'topup' ? 'TOP-UP' : (cards.find((c) => c.id === id)?.name ?? id);
  const openTopUp = (id: string) => {
    setTopIssuer(id);
    const i = visible.findIndex((s) => s.id === 'topup');
    if (i >= 0) goTo(i);
  };
  const paid = (id: string, amount: number) => {
    const i = visible.findIndex((s) => s.id === id);
    if (i >= 0) goTo(i);
    window.setTimeout(
      () => setCards((cs) => cs.map((c) => (c.id === id ? { ...c, balance: c.balance + amount } : c))),
      600,
    );
  };

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
          setSheet(true);
        }}
      >
        {visible.map((s) => (
          <div className="bw-bcar-slide" key={s.id}>
            {s.id === 'bsv' ? (
              <div className="bw-bcar-bsv">{bsvCard}</div>
            ) : s.id === 'topup' ? (
              <div className="bw-bcar-mockwrap">
                <TopUpCard issuer={topIssuer} setIssuer={setTopIssuer} onPaid={paid} />
              </div>
            ) : (
              <div className="bw-bcar-mockwrap">
                <MockCard
                  c={cards.find((c) => c.id === s.id)!}
                  chip={spending === s.id ? chip : null}
                  contract={spending === s.id ? contract : null}
                  onStop={stopDemo}
                  onTopUp={() => openTopUp(s.id)}
                  running={s.id === 'mandala' ? running : undefined}
                  onRun={s.id === 'mandala' ? () => setRunning((x) => !x) : undefined}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="bw-bcar-dots" aria-label={`Card ${active + 1} of ${visible.length}`}>
        {visible.map((s, i) => (
          <button
            type="button"
            key={s.id}
            aria-label={nameOf(s.id)}
            className={i === active ? 'is-on' : undefined}
            onClick={() => goTo(i)}
          />
        ))}
      </div>
      <div className="bw-bcar-demo">
        <button type="button" onClick={demo} disabled={!!spending}>
          {spending ? 'b is spending…' : 'Demo spend (mock)'}
        </button>
      </div>
      {sheet && (
        <Layer sheet onClose={() => setSheet(false)}>
          <div className="bw-bcar-sheet bw-layer-scroll">
            <h3>Cards</h3>
            {slots.map((s, i) => (
              <div className="bw-bcar-row" key={s.id}>
                <span className={s.hidden ? 'is-hidden' : undefined}>{nameOf(s.id)}</span>
                <button type="button" disabled={i === 0} onClick={() => move(s.id, -1)}>
                  ↑
                </button>
                <button type="button" disabled={i === slots.length - 1} onClick={() => move(s.id, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  disabled={s.id === 'bsv'}
                  onClick={() => setSlots((x) => x.map((y) => (y.id === s.id ? { ...y, hidden: !y.hidden } : y)))}
                >
                  {s.hidden ? 'Show' : 'Hide'}
                </button>
              </div>
            ))}
            <button type="button" className="bw-bcar-done" onClick={() => setSheet(false)}>
              Done
            </button>
          </div>
        </Layer>
      )}
    </div>
  );
};
