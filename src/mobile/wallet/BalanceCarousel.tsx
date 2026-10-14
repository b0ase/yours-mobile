import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
};

export type MockContract = { what: string; rate: string; startedAt: number; spent: number };

const MOCK: MockBalance[] = [
  {
    id: 'mandala',
    name: '$mandala credits',
    issuer: 'GorillaPool · Mandala · accepts BSV',
    unit: 'credits',
    balance: 1240,
    usdPer: 0.01,
    colour: '#1f6f5c',
    ink: '#e8fff6',
    initial: 'M',
    about: 'Prepaid credits for agents and compute on mandala.computer. Bought with BSV.',
    contact: 'mandala.computer',
  },
  {
    id: 'pnee',
    name: 'PNEEs',
    issuer: 'bWalletX · penny notes',
    unit: 'PNEEs',
    balance: 386,
    usdPer: 0.01,
    colour: '#ffd24d',
    ink: '#111',
    initial: 'P',
    about: 'Penny notes: 1 PNEE = 1¢, spend anywhere bWalletX pays.',
    contact: 'bwalletx.com',
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
        <div className="bw-bc-top">
          <span className="bw-bc-logo">🔒</span>
          <span className="bw-bc-head">
            <b>{fmtNum(c.balance)} shares · Restricted, not for sale</b>
            <small>2-of-2 multisig: director + you · or you alone after block 968,400 (~12 months)</small>
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
            <span>{c.about}</span>
            <span>No live contract.</span>
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
          <button type="button" className="bw-bc-contact" onClick={contact}>
            Contact {c.contact}
          </button>
        </div>
      </div>
    );
  return (
    <div className={`bw-bc${turning ? ' is-turning' : ''}`} onClick={flip} style={style}>
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
            small
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
    const idx = visible.findIndex((s) => s.id === 'mandala');
    if (idx < 0) return;
    demoRef.current.back = active;
    setSpending('mandala');
    setChip('b · 2 credits/reply');
    setContract({ what: 'b on mandala.computer', rate: '2 credits per reply', startedAt: Date.now(), spent: 0 });
    goTo(idx);
    let n = 0;
    demoRef.current.tick = window.setInterval(() => {
      n += 1;
      setCards((cs) => cs.map((c) => (c.id === 'mandala' ? { ...c, balance: Math.max(0, c.balance - 2) } : c)));
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
              bsvCard
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
