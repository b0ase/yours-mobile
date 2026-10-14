import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
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
  /** Full one-page agreement (replaces the short terms sheet). */
  agreement?: Agreement;
};

type Agreement = {
  title: string;
  issuer: string;
  parties: [string, string];
  clauses: [string, string][];
  primary: string;
};

const SIG_A = 'M6 34 C18 8 26 44 38 22 S56 10 62 30 C68 44 80 14 92 26 S118 38 128 18 L152 22';
const SIG_B = 'M8 28 C14 12 22 12 24 30 C26 44 40 6 50 24 S70 40 84 20 C94 8 102 36 116 28 S140 14 154 30';
const FlipBtn = ({ onFlip }: { onFlip: () => void }) => (
  <button
    type="button"
    className="bw-flipbtn"
    aria-label="Flip card"
    onClick={(e) => {
      e.stopPropagation();
      onFlip();
    }}
  >
    <span>
      <RotateCw size={18} strokeWidth={2.4} />
    </span>
  </button>
);

const Sig = ({ d, label }: { d: string; label: string }) => (
  <span className="bw-ag-sig">
    <svg viewBox="0 0 160 50" aria-label={`${label} signature`}>
      <path d={d} />
    </svg>
    <small>{label}</small>
  </span>
);

const AgreementSheet = ({ a, onClose }: { a: Agreement; onClose: () => void }) => (
  <div className="bw-ag" onClick={(e) => e.stopPropagation()}>
    <div className="bw-ag-mock">MOCK · not a real agreement</div>
    <h2>{a.title}</h2>
    <div className="bw-ag-parties">
      <span>
        <b>Between</b> {a.parties[0]}
      </span>
      <span>
        <b>and</b> {a.parties[1]}
      </span>
    </div>
    <ol>
      {a.clauses.map(([h, t]) => (
        <li key={h}>
          <b>{h}.</b> {t}
        </li>
      ))}
    </ol>
    <div className="bw-ag-sigs">
      <Sig d={SIG_A} label={a.issuer} />
      <Sig d={SIG_B} label="You" />
    </div>
    <div className="bw-ag-meta">
      <span>Dated 14 October 2026</span>
      <span>On chain: txid 7f3c…e21a (agreement hash, placeholder)</span>
    </div>
    <div className="bw-ag-btns">
      <button type="button" className="is-primary" onClick={() => window.alert(`MOCK: ${a.primary} would run here.`)}>
        {a.primary}
      </button>
      <button type="button" onClick={() => window.alert('MOCK: the signed PDF would download here.')}>
        Download PDF
      </button>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  </div>
);

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
    name: '$mandala credits',
    issuer: 'GorillaPool (Root) · accepts BSV',
    unit: 'credits',
    balance: 1240,
    usdPer: 0.01,
    colour: '#1f6f5c',
    ink: '#e8fff6',
    initial: 'M',
    about: 'Prepaid credits for agents and compute on mandala.computer. Bought with BSV.',
    backLines: [
      'Mandala: cloud computers for agents (mandala.computer).',
      'You get: a hosted agent VM, billed per compute-hour. 1 credit = 1¢ · 100 credits ≈ 1 VM-hour.',
      'Balance 1,240 credits (~12 VM-hours). Accepts BSV.',
    ],
    contact: 'Root',
    agreement: {
      title: 'Mandala Credits: service agreement',
      issuer: 'GorillaPool',
      parties: ['GorillaPool (issuer, mandala.computer)', 'You (identity key 03ab…f9, paymail $you)'],
      primary: 'Sign & top up',
      clauses: [
        ['What you’re buying', 'Hosted agent computer time on mandala.computer.'],
        ['Price', '1 Mandala credit = 1p, paid in BSV. 100 credits ≈ 1 VM-hour.'],
        ['How you’re charged', 'Per minute while your machine runs, shown live on your card.'],
        [
          'Stopping',
          'Tap Stop on the card: billing and the service stop at once, and unused credits stay yours to use later.',
        ],
        [
          'Support',
          'Contact GorillaPool from the card. If the service isn’t delivered, credits for that time are returned.',
        ],
        ['Refunds and expiry', 'Credits don’t expire. They are non-refundable except where the law requires.'],
        ['Your keys', 'GorillaPool never holds your keys. Only the credits you top up sit with the issuer.'],
      ],
    },
    contractTitle: 'You and GorillaPool (Root)',
    contractTerms: [
      'Issuer: GorillaPool (Root), operator of Mandala.',
      'Price: 1 credit = $0.01, bought with BSV.',
      'What a credit buys: 1/100 of an hour on a hosted agent VM (compute, storage, network included).',
      'Refunds: unused credits refundable on request to Root.',
      'How to stop: tap Stop; the VM is paused and billing ends at once.',
    ],
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
}: {
  c: MockBalance;
  chip: string | null;
  contract: MockContract | null;
  onStop: () => void;
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
  const big = unit === 'own' ? fmtNum(count.value) : fmtUsd(count.value * c.usdPer);
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
                window.alert('MOCK: top-up would open here.');
              }}
            >
              Top up
            </button>
          )}
          {c.contractTerms && (
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
          <div
            className="bw-bcar-sheet-bg"
            onClick={(e) => {
              e.stopPropagation();
              setSheetOpen(false);
            }}
          >
            <div className="bw-bcar-sheet bw-bc-contract" onClick={(e) => e.stopPropagation()}>
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
          </div>
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
        {unit === 'own' && <span className="bw-bc-unitword"> {c.unit}</span>}
      </button>
      <div className="bw-bc-bottom">
        <span className="bw-bc-sub">
          {c.locked ? (
            <span className="bw-bc-lock">🔒 Locked · shares</span>
          ) : chip ? (
            <span className="bw-bc-chip">{chip}</span>
          ) : (
            <>
              {small}
              {c.lockLine && <span className="bw-bc-lockline">{c.lockLine}</span>}
            </>
          )}
        </span>
        <span className="bw-wcard-unit" role="group" aria-label="Balance unit" onClick={(e) => e.stopPropagation()}>
          <button type="button" className={unit === 'usd' ? 'is-on' : undefined} onClick={() => setUnit('usd')}>
            $
          </button>
          <button type="button" className={unit === 'own' ? 'is-on' : undefined} onClick={() => setUnit('own')}>
            {ownLabel}
          </button>
        </span>
      </div>
    </div>
  );
};

type Slot = { id: string; hidden: boolean };

export const BalanceCarousel = ({ bsvCard }: { bsvCard: ReactNode }) => {
  const [cards, setCards] = useState(MOCK);
  const [slots, setSlots] = useState<Slot[]>(() => [
    { id: 'bsv', hidden: false },
    ...MOCK.map((m) => ({ id: m.id, hidden: false })),
  ]);
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
  const nameOf = (id: string) => (id === 'bsv' ? 'BSV' : (cards.find((c) => c.id === id)?.name ?? id));

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
              <div className="bw-bcar-bsv">
                {bsvCard}
                <FlipBtn onFlip={() => track.current?.querySelector<HTMLElement>('.bw-bcar-bsv .bw-wcard')?.click()} />
              </div>
            ) : (
              <div className="bw-bcar-mockwrap">
                <MockCard
                  c={cards.find((c) => c.id === s.id)!}
                  chip={spending === s.id ? chip : null}
                  contract={spending === s.id ? contract : null}
                  onStop={stopDemo}
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
        <div className="bw-bcar-sheet-bg" onClick={() => setSheet(false)}>
          <div className="bw-bcar-sheet" onClick={(e) => e.stopPropagation()}>
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
        </div>
      )}
    </div>
  );
};
